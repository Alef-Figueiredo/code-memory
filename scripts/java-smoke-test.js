const assert = require("assert");
const fs = require("fs");
const os = require("os");
const { spawn, spawnSync } = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "..");
const runnerPath = path.join(root, "src", "java", "JavaTraceRunner.java");
const samplePath = path.join(root, "examples", "Sample.java");
const sampleSource = fs.readFileSync(samplePath, "utf8");
const breakpoints = {
  peerAssignment: findLine(sampleSource, "box.peer = other;"),
  addBody: findLine(sampleSource, "value = value + amount;")
};

function findLine(source, snippet) {
  const lineIndex = source
    .split(/\r?\n/)
    .findIndex((line) => line.includes(snippet));

  if (lineIndex < 0) {
    throw new Error(`Could not find Java sample line containing: ${snippet}`);
  }

  return lineIndex + 1;
}

function commandCandidates(envName, fallback) {
  return [
    process.env[envName] ? { command: process.env[envName], args: [] } : undefined,
    { command: fallback, args: [] }
  ].filter(Boolean);
}

function findCommand(envName, fallback) {
  for (const candidate of commandCandidates(envName, fallback)) {
    const result = spawnSync(candidate.command, [...candidate.args, "-version"], {
      encoding: "utf8"
    });

    if (result.status === 0) {
      return candidate;
    }
  }

  throw new Error(`${fallback} was not found. Install a JDK or configure ${envName}.`);
}

function runProcess(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    ...options
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }

  return result;
}

async function runJavaSmokeTest() {
  const javac = findCommand("CODE_MEMORY_JAVAC", "javac");
  const java = findCommand("CODE_MEMORY_JAVA", "java");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "code-memory-java-smoke-"));
  const runnerOutputDir = path.join(tempDir, "runner");
  fs.mkdirSync(runnerOutputDir, { recursive: true });

  try {
    runProcess(javac.command, [
      ...javac.args,
      "--add-modules",
      "jdk.jdi",
      "-d",
      runnerOutputDir,
      runnerPath
    ]);

    const events = [];

    await new Promise((resolve, reject) => {
      const child = spawn(java.command, [
        ...java.args,
        "--add-modules",
        "jdk.jdi",
        "-cp",
        runnerOutputDir,
        "JavaTraceRunner",
        samplePath,
        root,
        `--breakpoints=${breakpoints.peerAssignment},${breakpoints.addBody}`
      ], {
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"]
      });

      let stdoutBuffer = "";
      let stderrBuffer = "";
      let steppedAfterAddBreakpoint = false;
      let settled = false;
      const timeout = setTimeout(() => {
        finish(new Error(`Java runner timed out. Captured events: ${events.map((event) => event.type).join(", ")}`));
      }, 20000);

      function finish(error) {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);

        if (error) {
          if (!child.killed) {
            child.kill();
          }
          reject(error);
          return;
        }

        resolve();
      }

      child.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk.toString("utf8");
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }

          let event;
          try {
            event = JSON.parse(line);
          } catch (error) {
            finish(new Error(`Java runner emitted non-JSON output: ${line}`));
            return;
          }

          events.push(event);

          if (event.type === "paused") {
            const shouldExerciseStep = event.line === breakpoints.addBody && !steppedAfterAddBreakpoint;
            const command = shouldExerciseStep ? "step" : "continue";
            steppedAfterAddBreakpoint = steppedAfterAddBreakpoint || shouldExerciseStep;

            if (child.stdin.writable) {
              child.stdin.write(JSON.stringify({ command }) + "\n");
            }
          }
        }
      });

      child.stderr.on("data", (chunk) => {
        stderrBuffer += chunk.toString("utf8");
      });

      child.on("error", finish);
      child.on("exit", (code) => {
        if (code !== 0) {
          finish(new Error(`Java runner exited with code ${code}: ${stderrBuffer}`));
          return;
        }

        finish();
      });
    });

    const pausedEvents = events.filter((event) => event.type === "paused");
    const doneEvent = events.find((event) => event.type === "done");
    const stateEvents = pausedEvents.filter((event) => event.state);
    const outputText = events
      .filter((event) => event.type === "output")
      .map((event) => event.text)
      .join("");
    const states = stateEvents.map((event) => event.state);
    const lastState = doneEvent && doneEvent.state ? doneEvent.state : states[states.length - 1];

    assert(pausedEvents.length >= 2, "expected at least two paused events");
    assert(
      pausedEvents.some((event) => event.line === breakpoints.peerAssignment),
      "expected Java runner to pause at the box.peer breakpoint"
    );
    assert(
      pausedEvents.some((event) => event.line === breakpoints.addBody),
      "expected Java runner to pause inside Box.add"
    );
    assert(doneEvent, "expected a done event");
    assert(lastState, "expected a captured Java execution state");
    assert(Array.isArray(lastState.stackFrames), "expected stackFrames in Java state");
    assert(Array.isArray(lastState.heapObjects), "expected heapObjects in Java state");
    assert(Array.isArray(lastState.references), "expected references in Java state");
    assert(
      states.some((state) => state.stackFrames.some((frame) => frame.name === "add")),
      "expected stack frame for Box.add"
    );

    const stateWithAlias = states.find((state) => state.variables.box?.target && state.variables.alias?.target);
    assert(stateWithAlias, "expected state with box and alias variables");
    assert.strictEqual(
      stateWithAlias.variables.box.target,
      stateWithAlias.variables.alias.target,
      "expected box and alias to reference the same heap object"
    );
    assert(
      states.some((state) => state.heapObjects.some((object) => String(object.type).includes("Box"))),
      "expected heap to include a Box object"
    );
    assert(
      states.some((state) => state.references.some((reference) => String(reference.sourceLabel).includes("peer"))),
      "expected a heap reference for box.peer"
    );
    assert(outputText.includes("Code Memory 3"), "expected Java program output");

    console.log("Java smoke test passed.");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

runJavaSmokeTest().catch((error) => {
  console.error(error);
  process.exit(1);
});