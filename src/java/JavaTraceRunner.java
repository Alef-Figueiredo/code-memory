import com.sun.jdi.AbsentInformationException;
import com.sun.jdi.ArrayReference;
import com.sun.jdi.Bootstrap;
import com.sun.jdi.ClassType;
import com.sun.jdi.Field;
import com.sun.jdi.IncompatibleThreadStateException;
import com.sun.jdi.Location;
import com.sun.jdi.Method;
import com.sun.jdi.ObjectReference;
import com.sun.jdi.PrimitiveValue;
import com.sun.jdi.ReferenceType;
import com.sun.jdi.StackFrame;
import com.sun.jdi.StringReference;
import com.sun.jdi.ThreadReference;
import com.sun.jdi.Value;
import com.sun.jdi.VirtualMachine;
import com.sun.jdi.VMDisconnectedException;
import com.sun.jdi.connect.Connector;
import com.sun.jdi.connect.LaunchingConnector;
import com.sun.jdi.event.BreakpointEvent;
import com.sun.jdi.event.ClassPrepareEvent;
import com.sun.jdi.event.Event;
import com.sun.jdi.event.EventQueue;
import com.sun.jdi.event.EventSet;
import com.sun.jdi.event.StepEvent;
import com.sun.jdi.event.VMDeathEvent;
import com.sun.jdi.event.VMDisconnectEvent;
import com.sun.jdi.request.BreakpointRequest;
import com.sun.jdi.request.ClassPrepareRequest;
import com.sun.jdi.request.EventRequest;
import com.sun.jdi.request.EventRequestManager;
import com.sun.jdi.request.StepRequest;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.tools.JavaCompiler;
import javax.tools.ToolProvider;

public class JavaTraceRunner {
    private static final int MAX_REPR_LENGTH = 120;
    private static final int MAX_ARRAY_ITEMS = 8;
    private static final int MAX_OBJECT_DEPTH = 3;
    private static final String INTERNAL_MAIN_BREAKPOINT = "codeMemory.internalMainBreakpoint";

    private final Path targetPath;
    private final Path workingDirectory;
    private final String sourceFileName;
    private final List<Integer> breakpointLines;
    private final BufferedReader input;
    private final Map<Long, String> objectIds = new HashMap<>();
    private final Map<String, Map<String, Object>> heapObjects = new LinkedHashMap<>();
    private final List<Map<String, Object>> references = new ArrayList<>();
    private final Set<Long> visitingObjects = new HashSet<>();
    private final Set<String> installedBreakpoints = new HashSet<>();
    private final Set<EventRequest> internalRequests = Collections.newSetFromMap(new IdentityHashMap<>());

    private Path buildDirectory;
    private String mainClassName;
    private VirtualMachine virtualMachine;
    private Map<String, Object> lastState;
    private boolean doneEmitted;

    public JavaTraceRunner(String[] args) {
        if (args.length < 1) {
            throw new IllegalArgumentException("Usage: JavaTraceRunner <file.java> [cwd] [--breakpoints=1,2]");
        }

        this.targetPath = Paths.get(args[0]).toAbsolutePath().normalize();
        this.workingDirectory = args.length >= 2
            ? Paths.get(args[1]).toAbsolutePath().normalize()
            : this.targetPath.getParent();
        this.sourceFileName = this.targetPath.getFileName().toString();
        this.breakpointLines = parseBreakpoints(args);
        this.input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    }

    public static void main(String[] args) {
        try {
            new JavaTraceRunner(args).run();
        } catch (Throwable error) {
            emit(mapOf(
                "type", "error",
                "message", stackTrace(error)
            ));
            System.exit(1);
        }
    }

    private void run() throws Exception {
        compileTarget();
        launchTarget();
        pumpTargetOutput(virtualMachine.process().getInputStream(), "stdout");
        pumpTargetOutput(virtualMachine.process().getErrorStream(), "stderr");
        configureClassPrepareRequest();
        virtualMachine.resume();
        eventLoop();
    }

    private void compileTarget() throws IOException {
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        if (compiler == null) {
            throw new IllegalStateException("javac is required. Configure codeMemory.javacPath to point to a JDK compiler.");
        }

        buildDirectory = Files.createTempDirectory("code-memory-target-");
        mainClassName = detectMainClassName();
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        int exitCode = compiler.run(
            null,
            output,
            output,
            "-g",
            "-d",
            buildDirectory.toString(),
            targetPath.toString()
        );

        if (exitCode != 0) {
            throw new IllegalStateException("Could not compile Java source.\n" + output.toString(StandardCharsets.UTF_8));
        }
    }

    private String detectMainClassName() throws IOException {
        String source = Files.readString(targetPath, StandardCharsets.UTF_8);
        Matcher matcher = Pattern
            .compile("(?m)^\\s*package\\s+([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)\\s*;")
            .matcher(source);
        String packageName = matcher.find() ? matcher.group(1) : "";
        String simpleName = sourceFileName.replaceFirst("\\.java$", "");
        return packageName.isEmpty() ? simpleName : packageName + "." + simpleName;
    }

    private void launchTarget() throws Exception {
        LaunchingConnector connector = Bootstrap.virtualMachineManager().defaultConnector();
        Map<String, Connector.Argument> arguments = connector.defaultArguments();
        arguments.get("main").setValue(mainClassName);
        arguments.get("options").setValue("-classpath " + quote(buildDirectory.toString()) + " -Duser.dir=" + quote(workingDirectory.toString()));
        arguments.get("suspend").setValue("true");
        virtualMachine = connector.launch(arguments);
    }

    private String quote(String value) {
        if (value.indexOf(' ') >= 0) {
            return "\"" + value + "\"";
        }

        return value;
    }

    private void configureClassPrepareRequest() {
        ClassPrepareRequest request = virtualMachine.eventRequestManager().createClassPrepareRequest();
        try {
            request.addSourceNameFilter(sourceFileName);
        } catch (UnsupportedOperationException ignored) {
            request.addClassFilter(mainClassName + "*");
        }
        request.enable();
    }

    private void eventLoop() throws Exception {
        EventQueue queue = virtualMachine.eventQueue();
        boolean connected = true;

        while (connected) {
            EventSet eventSet;
            try {
                eventSet = queue.remove();
            } catch (VMDisconnectedException disconnected) {
                emitDone(exitCode(), lastState);
                break;
            }

            boolean shouldResume = true;

            for (Event event : eventSet) {
                if (event instanceof ClassPrepareEvent) {
                    configureReferenceType(((ClassPrepareEvent) event).referenceType());
                } else if (event instanceof BreakpointEvent) {
                    shouldResume = handleBreakpoint((BreakpointEvent) event);
                } else if (event instanceof StepEvent) {
                    shouldResume = handleStep((StepEvent) event);
                } else if (event instanceof VMDeathEvent || event instanceof VMDisconnectEvent) {
                    emitDone(exitCode(), lastState);
                    connected = false;
                    shouldResume = false;
                }

                if (!shouldResume) {
                    break;
                }
            }

            if (shouldResume) {
                try {
                    eventSet.resume();
                } catch (VMDisconnectedException disconnected) {
                    emitDone(exitCode(), lastState);
                    connected = false;
                }
            }
        }
    }

    private void configureReferenceType(ReferenceType type) {
        if (!isTargetType(type)) {
            return;
        }

        installUserBreakpoints(type);

        if (type.name().equals(mainClassName)) {
            installMainBreakpoint(type);
        }
    }

    private void installMainBreakpoint(ReferenceType type) {
        for (Method method : type.methodsByName("main")) {
            if (!method.isPublic() || !method.isStatic()) {
                continue;
            }

            try {
                BreakpointRequest request = virtualMachine.eventRequestManager().createBreakpointRequest(method.location());
                request.putProperty(INTERNAL_MAIN_BREAKPOINT, Boolean.TRUE);
                request.enable();
                internalRequests.add(request);
                return;
            } catch (RuntimeException ignored) {
                return;
            }
        }
    }

    private void installUserBreakpoints(ReferenceType type) {
        for (Integer line : breakpointLines) {
            try {
                for (Location location : type.locationsOfLine(line)) {
                    String key = type.name() + ":" + line + ":" + location.codeIndex();
                    if (!installedBreakpoints.add(key)) {
                        continue;
                    }

                    BreakpointRequest request = virtualMachine.eventRequestManager().createBreakpointRequest(location);
                    request.enable();
                }
            } catch (AbsentInformationException ignored) {
                // Source line information is unavailable without debug symbols.
            }
        }
    }

    private boolean handleBreakpoint(BreakpointEvent event) throws Exception {
        EventRequest request = event.request();
        if (Boolean.TRUE.equals(request.getProperty(INTERNAL_MAIN_BREAKPOINT))) {
            request.disable();
            internalRequests.remove(request);
            virtualMachine.eventRequestManager().deleteEventRequest(request);
        }

        return pause(event.thread(), event.location());
    }

    private boolean handleStep(StepEvent event) throws Exception {
        virtualMachine.eventRequestManager().deleteEventRequest(event.request());

        if (isTargetLocation(event.location())) {
            return pause(event.thread(), event.location());
        }

        scheduleStep(event.thread());
        return true;
    }

    private boolean pause(ThreadReference thread, Location location) throws Exception {
        lastState = collectState(thread, location);
        emit(mapOf(
            "type", "paused",
            "line", lineNumber(location),
            "state", lastState
        ));

        String command = readCommand();

        if ("stop".equals(command) || "quit".equals(command)) {
            emitDone(0, lastState);
            try {
                virtualMachine.exit(0);
            } catch (VMDisconnectedException ignored) {
                // The VM can disconnect while being stopped.
            }
            return false;
        }

        if ("continue".equals(command)) {
            return true;
        }

        scheduleStep(thread);
        return true;
    }

    private void scheduleStep(ThreadReference thread) {
        EventRequestManager manager = virtualMachine.eventRequestManager();
        List<StepRequest> existingRequests = new ArrayList<>(manager.stepRequests());
        for (StepRequest request : existingRequests) {
            if (request.thread().equals(thread)) {
                manager.deleteEventRequest(request);
            }
        }

        StepRequest request = manager.createStepRequest(thread, StepRequest.STEP_LINE, StepRequest.STEP_INTO);
        request.addCountFilter(1);
        request.addClassExclusionFilter("java.*");
        request.addClassExclusionFilter("javax.*");
        request.addClassExclusionFilter("jdk.*");
        request.addClassExclusionFilter("sun.*");
        request.addClassExclusionFilter("com.sun.*");
        request.enable();
    }

    private Map<String, Object> collectState(ThreadReference thread, Location location) {
        heapObjects.clear();
        references.clear();
        visitingObjects.clear();

        List<Map<String, Object>> stackFrames = collectStackFrames(thread);
        Map<String, Object> variables = collectVisibleVariables(stackFrames);
        List<Map<String, Object>> heapObjectList = new ArrayList<>(heapObjects.values());

        Map<String, Object> state = new LinkedHashMap<>();
        state.put("currentLine", lineNumber(location));
        state.put("variables", variables);
        state.put("callStack", stackFrames);
        state.put("heap", heapObjectList);
        state.put("stackFrames", stackFrames);
        state.put("heapObjects", heapObjectList);
        state.put("references", new ArrayList<>(references));
        return state;
    }

    private List<Map<String, Object>> collectStackFrames(ThreadReference thread) {
        List<Map<String, Object>> frames = new ArrayList<>();

        try {
            List<StackFrame> rawFrames = thread.frames();
            for (int index = rawFrames.size() - 1; index >= 0; index -= 1) {
                StackFrame frame = rawFrames.get(index);
                if (!isTargetLocation(frame.location())) {
                    continue;
                }

                Method method = frame.location().method();
                String frameId = "frame-" + index + "-" + method.declaringType().name() + "-" + method.name();
                Map<String, Object> variables = collectVariables(frame);
                List<Object> parameters = collectParameters(method, variables);
                Map<String, Object> frameState = new LinkedHashMap<>();
                frameState.put("id", frameId);
                frameState.put("name", method.isConstructor() ? simpleTypeName(method.declaringType().name()) : method.name());
                frameState.put("line", lineNumber(frame.location()));
                frameState.put("parameters", parameters);
                frameState.put("variables", variables);
                frames.add(frameState);

                for (Object variable : variables.values()) {
                    addVariableReference(frameId, String.valueOf(frameState.get("name")), castMap(variable));
                }
            }
        } catch (IncompatibleThreadStateException | RuntimeException ignored) {
            // A disappearing frame should not break the visualizer.
        }

        return frames;
    }

    private Map<String, Object> collectVisibleVariables(List<Map<String, Object>> stackFrames) {
        Map<String, Object> variables = new LinkedHashMap<>();

        for (Map<String, Object> frame : stackFrames) {
            Map<String, Object> frameVariables = castMap(frame.get("variables"));
            for (Map.Entry<String, Object> entry : frameVariables.entrySet()) {
                variables.put(entry.getKey(), entry.getValue());
            }
        }

        return variables;
    }

    private Map<String, Object> collectVariables(StackFrame frame) {
        Map<String, Object> variables = new LinkedHashMap<>();

        try {
            ObjectReference thisObject = frame.thisObject();
            if (thisObject != null) {
                Map<String, Object> thisValue = describeValue(thisObject, 0);
                thisValue.put("name", "this");
                thisValue.put("scope", "local");
                variables.put("this", thisValue);
            }

            List<com.sun.jdi.LocalVariable> visibleVariables = frame.visibleVariables();
            Map<com.sun.jdi.LocalVariable, Value> values = frame.getValues(visibleVariables);
            for (com.sun.jdi.LocalVariable variable : visibleVariables) {
                Map<String, Object> value = describeValue(values.get(variable), 0);
                value.put("name", variable.name());
                value.put("scope", "local");
                value.put("declaredType", variable.typeName());
                variables.put(variable.name(), value);
            }
        } catch (AbsentInformationException | RuntimeException ignored) {
            // Locals require debug symbols; the target is compiled with -g when possible.
        }

        return variables;
    }

    private List<Object> collectParameters(Method method, Map<String, Object> variables) {
        List<Object> parameters = new ArrayList<>();

        try {
            for (com.sun.jdi.LocalVariable argument : method.arguments()) {
                Object value = variables.get(argument.name());
                if (value != null) {
                    parameters.add(value);
                }
            }
        } catch (AbsentInformationException ignored) {
            // Parameter names are optional debug metadata.
        }

        return parameters;
    }

    private Map<String, Object> describeValue(Value value, int depth) {
        if (value == null) {
            return valueMap("null", "primitive", null, null, "null");
        }

        if (value instanceof PrimitiveValue) {
            return valueMap(value.type().name(), "primitive", value.toString(), null, value.toString());
        }

        if (value instanceof StringReference) {
            String stringValue = ((StringReference) value).value();
            return valueMap("String", "primitive", stringValue, null, quoteString(stringValue));
        }

        if (value instanceof ObjectReference) {
            ObjectReference object = (ObjectReference) value;
            String target = collectHeapObject(object, depth);
            return valueMap(simpleTypeName(object.referenceType().name()), "reference", null, target, simpleTypeName(object.referenceType().name()) + " " + target);
        }

        return valueMap(value.type().name(), "primitive", value.toString(), null, value.toString());
    }

    private Map<String, Object> valueMap(String type, String kind, Object value, String target, String repr) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("type", type);
        result.put("kind", kind);
        result.put("value", value);
        result.put("target", target);
        result.put("repr", trim(repr));
        return result;
    }

    private String collectHeapObject(ObjectReference object, int depth) {
        String objectId = heapId(object);

        if (visitingObjects.contains(object.uniqueID())) {
            return objectId;
        }

        Map<String, Object> heapObject = heapObjects.computeIfAbsent(objectId, ignored -> new LinkedHashMap<>());
        heapObject.put("id", objectId);
        heapObject.put("type", simpleTypeName(object.referenceType().name()));
        heapObject.put("repr", simpleTypeName(object.referenceType().name()) + " " + objectId);
        heapObject.put("address", "jdi:" + object.uniqueID());
        heapObject.put("fields", new ArrayList<>());
        heapObject.put("items", new ArrayList<>());

        if (depth >= MAX_OBJECT_DEPTH) {
            return objectId;
        }

        visitingObjects.add(object.uniqueID());

        if (object instanceof ArrayReference) {
            describeArrayItems(heapObject, (ArrayReference) object, depth);
        } else {
            describeObjectFields(heapObject, object, depth);
        }

        visitingObjects.remove(object.uniqueID());
        return objectId;
    }

    private void describeArrayItems(Map<String, Object> heapObject, ArrayReference array, int depth) {
        List<Object> items = castList(heapObject.get("items"));
        int count = Math.min(array.length(), MAX_ARRAY_ITEMS);
        List<Value> values = array.getValues(0, count);

        for (int index = 0; index < values.size(); index += 1) {
            Map<String, Object> value = describeValue(values.get(index), depth + 1);
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("name", String.valueOf(index));
            item.put("index", index);
            item.put("value", value);
            items.add(item);
            addHeapReference(String.valueOf(heapObject.get("id")), "[" + index + "]", value);
        }
    }

    private void describeObjectFields(Map<String, Object> heapObject, ObjectReference object, int depth) {
        List<Object> fields = castList(heapObject.get("fields"));
        List<Field> candidateFields = new ArrayList<>();

        for (Field field : object.referenceType().allFields()) {
            if (!field.isStatic() && !field.isSynthetic()) {
                candidateFields.add(field);
            }
        }

        Map<Field, Value> values = object.getValues(candidateFields);
        for (Field field : candidateFields) {
            Map<String, Object> value = describeValue(values.get(field), depth + 1);
            Map<String, Object> fieldState = new LinkedHashMap<>();
            fieldState.put("name", field.name());
            fieldState.put("value", value);
            fields.add(fieldState);
            addHeapReference(String.valueOf(heapObject.get("id")), "." + field.name(), value);
        }
    }

    private void addVariableReference(String frameId, String frameName, Map<String, Object> variable) {
        if (!"reference".equals(variable.get("kind")) || variable.get("target") == null) {
            return;
        }

        Map<String, Object> reference = new LinkedHashMap<>();
        reference.put("kind", "variable");
        reference.put("source", variable.get("name"));
        reference.put("sourceLabel", frameName + "." + variable.get("name"));
        reference.put("frameId", frameId);
        reference.put("target", variable.get("target"));
        references.add(reference);
    }

    private void addHeapReference(String ownerId, String memberName, Map<String, Object> value) {
        if (!"reference".equals(value.get("kind")) || value.get("target") == null) {
            return;
        }

        Map<String, Object> reference = new LinkedHashMap<>();
        reference.put("kind", "heap");
        reference.put("source", ownerId + memberName);
        reference.put("sourceLabel", ownerId + memberName);
        reference.put("target", value.get("target"));
        references.add(reference);
    }

    private String heapId(ObjectReference object) {
        return objectIds.computeIfAbsent(object.uniqueID(), ignored -> "object-" + (objectIds.size() + 1));
    }

    private boolean isTargetType(ReferenceType type) {
        try {
            return sourceFileName.equals(type.sourceName());
        } catch (AbsentInformationException ignored) {
            return type.name().equals(mainClassName) || type.name().startsWith(mainClassName + "$");
        }
    }

    private boolean isTargetLocation(Location location) {
        try {
            return sourceFileName.equals(location.sourceName());
        } catch (AbsentInformationException ignored) {
            return false;
        }
    }

    private int lineNumber(Location location) {
        int lineNumber = location.lineNumber();
        return Math.max(lineNumber, 0);
    }

    private String readCommand() throws IOException {
        String line = input.readLine();
        if (line == null) {
            return "stop";
        }

        if (line.contains("continue")) {
            return "continue";
        }

        if (line.contains("stop") || line.contains("quit")) {
            return "stop";
        }

        return "step";
    }

    private static List<Integer> parseBreakpoints(String[] args) {
        List<Integer> breakpoints = new ArrayList<>();

        for (String arg : args) {
            if (!arg.startsWith("--breakpoints=")) {
                continue;
            }

            String value = arg.substring("--breakpoints=".length());
            if (value.isBlank()) {
                continue;
            }

            for (String part : value.split(",")) {
                try {
                    breakpoints.add(Integer.parseInt(part.trim()));
                } catch (NumberFormatException ignored) {
                    // Ignore malformed breakpoint entries.
                }
            }
        }

        return breakpoints;
    }

    private void pumpTargetOutput(InputStream stream, String streamName) {
        Thread thread = new Thread(() -> {
            byte[] buffer = new byte[2048];
            try {
                int count;
                while ((count = stream.read(buffer)) != -1) {
                    if (count > 0) {
                        emit(mapOf(
                            "type", "output",
                            "stream", streamName,
                            "text", new String(buffer, 0, count, StandardCharsets.UTF_8)
                        ));
                    }
                }
            } catch (IOException ignored) {
                // The stream is closed when the debuggee exits.
            }
        });
        thread.setDaemon(true);
        thread.start();
    }

    private int exitCode() {
        if (virtualMachine == null) {
            return 0;
        }

        try {
            return virtualMachine.process().waitFor();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return 1;
        } catch (RuntimeException ignored) {
            return 0;
        }
    }

    private void emitDone(int exitCode, Map<String, Object> state) {
        if (doneEmitted) {
            return;
        }

        doneEmitted = true;
        emit(mapOf(
            "type", "done",
            "exitCode", exitCode,
            "state", state
        ));
    }

    private static String simpleTypeName(String typeName) {
        int packageSeparator = typeName.lastIndexOf('.');
        String simple = packageSeparator >= 0 ? typeName.substring(packageSeparator + 1) : typeName;
        return simple.replace('$', '.');
    }

    private static String trim(String text) {
        if (text == null) {
            return "null";
        }

        if (text.length() > MAX_REPR_LENGTH) {
            return text.substring(0, MAX_REPR_LENGTH - 3) + "...";
        }

        return text;
    }

    private static String quoteString(String value) {
        return "\"" + value + "\"";
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Object value) {
        return (Map<String, Object>) value;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> castList(Object value) {
        return (List<Object>) value;
    }

    private static synchronized void emit(Map<String, Object> payload) {
        System.out.println(toJson(payload));
        System.out.flush();
    }

    private static Map<String, Object> mapOf(Object... entries) {
        Map<String, Object> map = new LinkedHashMap<>();

        for (int index = 0; index < entries.length; index += 2) {
            map.put(String.valueOf(entries[index]), entries[index + 1]);
        }

        return map;
    }

    private static String stackTrace(Throwable error) {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try {
            output.write(error.toString().getBytes(StandardCharsets.UTF_8));
            output.write('\n');
            for (StackTraceElement element : error.getStackTrace()) {
                output.write(("    at " + element + "\n").getBytes(StandardCharsets.UTF_8));
            }
        } catch (IOException ignored) {
            return error.toString();
        }

        return output.toString(StandardCharsets.UTF_8);
    }

    private static String toJson(Object value) {
        if (value == null) {
            return "null";
        }

        if (value instanceof String) {
            return quoteJson((String) value);
        }

        if (value instanceof Number || value instanceof Boolean) {
            return String.valueOf(value);
        }

        if (value instanceof Map<?, ?>) {
            StringBuilder builder = new StringBuilder();
            builder.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
                if (!first) {
                    builder.append(',');
                }
                first = false;
                builder.append(quoteJson(String.valueOf(entry.getKey())));
                builder.append(':');
                builder.append(toJson(entry.getValue()));
            }
            builder.append('}');
            return builder.toString();
        }

        if (value instanceof Iterable<?>) {
            StringBuilder builder = new StringBuilder();
            builder.append('[');
            boolean first = true;
            for (Object item : (Iterable<?>) value) {
                if (!first) {
                    builder.append(',');
                }
                first = false;
                builder.append(toJson(item));
            }
            builder.append(']');
            return builder.toString();
        }

        return quoteJson(String.valueOf(value));
    }

    private static String quoteJson(String text) {
        StringBuilder builder = new StringBuilder();
        builder.append('"');
        for (int index = 0; index < text.length(); index += 1) {
            char character = text.charAt(index);
            switch (character) {
                case '"':
                    builder.append("\\\"");
                    break;
                case '\\':
                    builder.append("\\\\");
                    break;
                case '\b':
                    builder.append("\\b");
                    break;
                case '\f':
                    builder.append("\\f");
                    break;
                case '\n':
                    builder.append("\\n");
                    break;
                case '\r':
                    builder.append("\\r");
                    break;
                case '\t':
                    builder.append("\\t");
                    break;
                default:
                    if (character < 0x20) {
                        builder.append(String.format("\\u%04x", (int) character));
                    } else {
                        builder.append(character);
                    }
                    break;
            }
        }
        builder.append('"');
        return builder.toString();
    }
}