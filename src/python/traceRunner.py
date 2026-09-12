import json
import os
import runpy
import sys
import traceback
import types


TARGET = os.path.abspath(sys.argv[1])
TARGET_DIR = os.path.dirname(TARGET)
PROTOCOL_STDOUT = sys.stdout
MAX_REPR_LENGTH = 120
MAX_COLLECTION_ITEMS = 8
MAX_OBJECT_DEPTH = 3
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
IGNORED_VALUE_TYPES = (
    types.ModuleType,
    types.FunctionType,
    types.BuiltinFunctionType,
    types.MethodType,
    type
)
HEAP_IDS = {}
NEXT_HEAP_ID = 1


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

    if len(text) > MAX_REPR_LENGTH:
        return text[:MAX_REPR_LENGTH - 3] + "..."

    return text


def is_primitive(value):
    return isinstance(value, (str, int, float, bool, type(None)))


def should_include_variable(name, value):
    if name in IGNORED_VARIABLES or name.startswith("__"):
        return False

    if isinstance(value, IGNORED_VALUE_TYPES):
        return False

    return True


def get_heap_id(value):
    global NEXT_HEAP_ID

    object_key = id(value)

    if object_key not in HEAP_IDS:
        HEAP_IDS[object_key] = f"object-{NEXT_HEAP_ID}"
        NEXT_HEAP_ID += 1

    return HEAP_IDS[object_key]


class ExecutionStateBuilder:
    def __init__(self):
        self.heap_objects = {}
        self.references = []
        self.visiting = set()

    def build_from_frame(self, frame):
        stack_frames = self.collect_stack_frames(frame)
        variables = self.collect_visible_variables(stack_frames)

        return self.build_state(
            current_line=frame.f_lineno,
            variables=variables,
            stack_frames=stack_frames
        )

    def build_from_namespace(self, namespace):
        variables = self.collect_variables(namespace, "global")

        for variable in variables.values():
            self.add_variable_reference("module", None, variable)

        return self.build_state(
            current_line=None,
            variables=variables,
            stack_frames=[]
        )

    def build_state(self, current_line, variables, stack_frames):
        heap_objects = list(self.heap_objects.values())

        return {
            "currentLine": current_line,
            "variables": variables,
            "callStack": [
                {
                    "name": frame["name"],
                    "line": frame["line"],
                    "variables": frame["variables"]
                }
                for frame in stack_frames
            ],
            "heap": heap_objects,
            "stackFrames": stack_frames,
            "heapObjects": heap_objects,
            "references": self.references
        }

    def collect_stack_frames(self, frame):
        frames = []
        current = frame

        while current:
            if os.path.abspath(current.f_code.co_filename) == TARGET:
                frame_id = f"frame-{id(current)}"
                variables = self.collect_variables(current.f_locals, "local")
                parameters = self.collect_parameters(current, variables)

                frames.append({
                    "id": frame_id,
                    "name": "module" if current.f_code.co_name == "<module>" else current.f_code.co_name,
                    "line": current.f_lineno,
                    "parameters": parameters,
                    "variables": variables
                })

                for variable in variables.values():
                    self.add_variable_reference(
                        frame_name="module" if current.f_code.co_name == "<module>" else current.f_code.co_name,
                        frame_id=frame_id,
                        variable=variable
                    )

            current = current.f_back

        frames.reverse()
        return frames

    def collect_visible_variables(self, stack_frames):
        variables = {}

        for frame in stack_frames:
            for name, variable in frame["variables"].items():
                variables[name] = variable

        return variables

    def collect_parameters(self, frame, variables):
        code = frame.f_code
        count = code.co_argcount + code.co_kwonlyargcount
        names = code.co_varnames[:count]
        return [variables[name] for name in names if name in variables]

    def collect_variables(self, mapping, scope):
        variables = {}

        for name, value in mapping.items():
            if should_include_variable(name, value):
                variables[name] = {
                    "name": name,
                    "scope": scope,
                    **self.describe_value(value)
                }

        return variables

    def describe_value(self, value, depth=0):
        base = {
            "type": type(value).__name__,
            "repr": safe_repr(value),
            "value": value if is_primitive(value) else None
        }

        if is_primitive(value):
            return {
                **base,
                "kind": "primitive",
                "target": None
            }

        target = self.collect_heap_object(value, depth)

        return {
            **base,
            "kind": "reference",
            "target": target
        }

    def collect_heap_object(self, value, depth=0):
        object_id = get_heap_id(value)

        if object_id in self.heap_objects and object_id in self.visiting:
            return object_id

        if object_id not in self.heap_objects:
            self.heap_objects[object_id] = {
                "id": object_id,
                "type": type(value).__name__,
                "repr": safe_repr(value),
                "address": hex(id(value)),
                "fields": [],
                "items": []
            }
        else:
            self.heap_objects[object_id].update({
                "type": type(value).__name__,
                "repr": safe_repr(value),
                "address": hex(id(value)),
                "fields": [],
                "items": []
            })

        if depth >= MAX_OBJECT_DEPTH or object_id in self.visiting:
            return object_id

        self.visiting.add(object_id)
        heap_object = self.heap_objects[object_id]

        if isinstance(value, dict):
            heap_object["items"] = self.describe_mapping_items(object_id, value, depth)
        elif isinstance(value, (list, tuple)):
            heap_object["items"] = self.describe_sequence_items(object_id, value, depth)
        elif isinstance(value, (set, frozenset)):
            heap_object["items"] = self.describe_sequence_items(object_id, list(value), depth)
        elif hasattr(value, "__dict__"):
            heap_object["fields"] = self.describe_object_fields(object_id, value, depth)

        self.visiting.remove(object_id)
        return object_id

    def describe_mapping_items(self, owner_id, value, depth):
        items = []

        for index, (key, item_value) in enumerate(value.items()):
            if index >= MAX_COLLECTION_ITEMS:
                break

            key_description = self.describe_value(key, depth + 1)
            value_description = self.describe_value(item_value, depth + 1)
            item = {
                "name": safe_repr(key),
                "index": index,
                "key": key_description,
                "value": value_description
            }
            items.append(item)
            self.add_heap_reference(owner_id, f"[{safe_repr(key)}]", value_description)

        return items

    def describe_sequence_items(self, owner_id, value, depth):
        items = []

        for index, item_value in enumerate(value[:MAX_COLLECTION_ITEMS]):
            value_description = self.describe_value(item_value, depth + 1)
            item = {
                "name": str(index),
                "index": index,
                "value": value_description
            }
            items.append(item)
            self.add_heap_reference(owner_id, f"[{index}]", value_description)

        return items

    def describe_object_fields(self, owner_id, value, depth):
        fields = []

        for name, item_value in sorted(vars(value).items()):
            if name.startswith("__"):
                continue

            value_description = self.describe_value(item_value, depth + 1)
            field = {
                "name": name,
                "value": value_description
            }
            fields.append(field)
            self.add_heap_reference(owner_id, f".{name}", value_description)

        return fields

    def add_variable_reference(self, frame_name, frame_id, variable):
        if variable.get("kind") != "reference" or not variable.get("target"):
            return

        self.references.append({
            "kind": "variable",
            "source": variable["name"],
            "sourceLabel": f"{frame_name}.{variable['name']}",
            "frameId": frame_id,
            "target": variable["target"]
        })

    def add_heap_reference(self, owner_id, member_name, value_description):
        if value_description.get("kind") != "reference" or not value_description.get("target"):
            return

        self.references.append({
            "kind": "heap",
            "source": f"{owner_id}{member_name}",
            "sourceLabel": f"{owner_id}{member_name}",
            "target": value_description["target"]
        })


def build_execution_state(frame):
    return ExecutionStateBuilder().build_from_frame(frame)


def build_module_execution_state(namespace):
    return ExecutionStateBuilder().build_from_namespace(namespace)


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

        if command == "continue":
            sys.settrace(None)
            return None

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