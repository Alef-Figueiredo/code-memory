import json
import types
import os
import runpy
import sys
import traceback


TARGET = os.path.abspath(sys.argv[1])
TARGET_DIR = os.path.dirname(TARGET)
PROTOCOL_STDOUT = sys.stdout
IGNORED_VARIABLES = {
    "__builtins__",
    "__cached__",
    "__doc__",
    "__file__",
    "__loader__",
    "__name__",
    "__package__",
    "__spec__"
}


def emit(payload):
    PROTOCOL_STDOUT.write(json.dumps(payload) + "\n")
    PROTOCOL_STDOUT.flush()


class JsonTextWriter:
    def __init__(self, stream_name):
        self.stream_name = stream_name

    def write(self, text):
        if text:
            emit({
                "type": "output",
                "stream": self.stream_name,
                "text": text
            })
        return len(text)

    def flush(self):
        PROTOCOL_STDOUT.flush()


def read_command():
    line = sys.stdin.readline()

    if not line:
        raise SystemExit(0)

    try:
        payload = json.loads(line)
        return payload.get("command", "step")
    except json.JSONDecodeError:
        return line.strip()


def safe_repr(value):
    try:
        text = repr(value)
    except Exception:
        text = f"<unrepresentable {type(value).__name__}>"

    if len(text) > 120:
        return text[:117] + "..."

    return text


def serialize_value(value):
    primitive_types = (str, int, float, bool, type(None))

    if isinstance(value, primitive_types):
        serializable = value
    else:
        serializable = None

    return {
        "type": type(value).__name__,
        "value": serializable,
        "repr": safe_repr(value)
    }


def should_include_variable(name, value):
    if name in IGNORED_VARIABLES or name.startswith("__"):
        return False

    if isinstance(value, types.ModuleType):
        return False

    return True


def collect_variables(mapping, scope):
    variables = {}

    for name, value in mapping.items():
        if should_include_variable(name, value):
            variables[name] = {
                "name": name,
                "scope": scope,
                **serialize_value(value)
            }

    return variables


def collect_call_stack(frame):
    frames = []
    current = frame

    while current:
        if os.path.abspath(current.f_code.co_filename) == TARGET:
            function_name = current.f_code.co_name
            frames.append({
                "name": "module" if function_name == "<module>" else function_name,
                "line": current.f_lineno,
                "variables": collect_variables(current.f_locals, "local")
            })

        current = current.f_back

    frames.reverse()
    return frames


def build_execution_state(frame):
    if frame.f_locals is frame.f_globals:
        variables = collect_variables(frame.f_globals, "global")
    else:
        variables = collect_variables(frame.f_globals, "global")
        variables.update(collect_variables(frame.f_locals, "local"))

    return {
        "currentLine": frame.f_lineno,
        "variables": variables,
        "callStack": collect_call_stack(frame),
        "heap": []
    }


def build_module_execution_state(namespace):
    return {
        "currentLine": None,
        "variables": collect_variables(namespace, "global"),
        "callStack": [],
        "heap": []
    }


def tracer(frame, event, arg):
    if event == "line" and os.path.abspath(frame.f_code.co_filename) == TARGET:
        emit({
            "type": "paused",
            "line": frame.f_lineno,
            "state": build_execution_state(frame)
        })

        command = read_command()

        if command in ("stop", "quit"):
            raise SystemExit(0)

    return tracer


def main():
    sys.path.insert(0, TARGET_DIR)
    sys.stdout = JsonTextWriter("stdout")
    sys.stderr = JsonTextWriter("stderr")

    try:
        sys.settrace(tracer)
        namespace = runpy.run_path(TARGET, run_name="__main__")
        sys.settrace(None)
        emit({
            "type": "done",
            "exitCode": 0,
            "state": build_module_execution_state(namespace)
        })
    except SystemExit as exc:
        sys.settrace(None)
        code = exc.code if isinstance(exc.code, int) else 0
        emit({
            "type": "done",
            "exitCode": code
        })
        raise
    except BaseException:
        sys.settrace(None)
        emit({
            "type": "error",
            "message": "".join(traceback.format_exc())
        })
        raise SystemExit(1)


if __name__ == "__main__":
    main()
