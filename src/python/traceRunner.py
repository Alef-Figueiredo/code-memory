import json
import os
import runpy
import sys
import traceback


TARGET = os.path.abspath(sys.argv[1])
TARGET_DIR = os.path.dirname(TARGET)
PROTOCOL_STDOUT = sys.stdout


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


def tracer(frame, event, arg):
    if event == "line" and os.path.abspath(frame.f_code.co_filename) == TARGET:
        emit({
            "type": "paused",
            "line": frame.f_lineno
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
        runpy.run_path(TARGET, run_name="__main__")
        sys.settrace(None)
        emit({
            "type": "done",
            "exitCode": 0
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
