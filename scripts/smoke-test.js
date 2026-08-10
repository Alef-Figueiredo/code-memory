const assert = require("assert");
const { spawn, spawnSync } = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "..");
const runnerPath = path.join(root, "src", "python", "traceRunner.py");
const samplePath = path.join(root, "examples", "sample.py");

const candidates = process.platform === "win32"
  ? [
      process.env.CODE_MEMORY_PYTHON
        ? { command: process.env.CODE_MEMORY_PYTHON, args: [] }
        : undefined,
      { command: "py", args: ["-3"] },
      { command: "python", args: [] },
      { command: "python3", args: [] }
    ].filter(Boolean)
  : [
      process.env.CODE_MEMORY_PYTHON
        ? { command: process.env.CODE_MEMORY_PYTHON, args: [] }
        : undefined,
      { command: "python3", args: [] },
      { command: "python", args: [] }
    ].filter(Boolean);

function findPython() {
  for (const candidate of candidates) {
    const result = spawnSync(candidate.command, [...candidate.args, "--version"], {
      encoding: "utf8"
    });

    if (result.status === 0) {
      return candidate;
    }
  }

  throw new Error("Python was not found. Install Python or configure the PATH.");
}

async function runSmokeTest() {
  const python = findPython();
  const events = [];

  await new Promise((resolve, reject) => {
    const child = spawn(python.command, [...python.args, runnerPath, samplePath], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        const event = JSON.parse(line);
        events.push(event);

        if (event.type === "paused") {
          child.stdin.write(JSON.stringify({ command: "step" }) + "\n");
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderrBuffer += chunk.toString("utf8");
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Runner exited with code ${code}: ${stderrBuffer}`));
        return;
      }

      resolve();
    });
  });

  const pausedEvents = events.filter((event) => event.type === "paused");
  const doneEvent = events.find((event) => event.type === "done");
  const stateEvents = pausedEvents.filter((event) => event.state);
  const outputText = events
    .filter((event) => event.type === "output")
    .map((event) => event.text)
    .join("");

  assert(pausedEvents.length >= 5, "expected at least five paused events");
  assert(stateEvents.length > 0, "expected paused events to include execution state");
  assert(doneEvent, "expected a done event");
  assert.strictEqual(doneEvent.exitCode, 0, "expected a successful exit code");
  assert(doneEvent.state, "expected done event to include final execution state");
  assert(doneEvent.state.variables.total, "expected final state to include total");
  assert.strictEqual(doneEvent.state.variables.total.repr, "3", "expected final total to be 3");
  assert(outputText.includes("Code Memory 0"), "expected program output");

  console.log("Smoke test passed.");
}

runSmokeTest().catch((error) => {
  console.error(error);
  process.exit(1);
});
