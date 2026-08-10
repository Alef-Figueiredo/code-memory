const { spawn } = require("child_process");
const path = require("path");
const vscode = require("vscode");
const { LanguageAdapter } = require("./languageAdapter");

class PythonAdapter extends LanguageAdapter {
  constructor(extensionUri, outputChannel) {
    super();
    this.extensionUri = extensionUri;
    this.outputChannel = outputChannel;
  }

  canHandle(document) {
    const fileName = document.uri.fsPath.toLowerCase();
    return document.languageId === "python" || fileName.endsWith(".py");
  }

  createSession(options) {
    const pythonPath = vscode.workspace
      .getConfiguration("codeMemory")
      .get("pythonPath", "python");

    return new PythonExecutionSession({
      ...options,
      pythonPath,
      runnerPath: path.join(this.extensionUri.fsPath, "src", "python", "traceRunner.py"),
      outputChannel: this.outputChannel
    });
  }
}

class PythonExecutionSession {
  constructor(options) {
    this.filePath = options.filePath;
    this.cwd = options.cwd;
    this.callbacks = options.callbacks;
    this.pythonPath = options.pythonPath;
    this.runnerPath = options.runnerPath;
    this.outputChannel = options.outputChannel;
    this.child = undefined;
    this.stdoutBuffer = "";
    this.done = false;
    this.stopped = false;
    this.paused = false;
  }

  start() {
    if (this.child) {
      return;
    }

    const commandParts = parseCommandLine(this.pythonPath);
    const command = commandParts[0] || "python";
    const args = [...commandParts.slice(1), this.runnerPath, this.filePath];

    this.callbacks.onStatus("running", "Iniciando Python...");
    this.outputChannel.appendLine(`[python] ${command} ${args.join(" ")}`);

    this.child = spawn(command, args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.callbacks.onOutput("stderr", chunk.toString("utf8"));
    });

    this.child.on("error", (error) => {
      this.done = true;
      this.callbacks.onError(
        `Could not start Python with "${this.pythonPath}". ${error.message}`
      );
    });

    this.child.on("exit", (code, signal) => {
      if (!this.done && !this.stopped) {
        this.done = true;
        this.callbacks.onDone({ exitCode: code, signal });
      }
    });
  }

  step() {
    if (!this.child || this.done || !this.child.stdin.writable) {
      return;
    }

    this.paused = false;
    this.callbacks.onStatus("running", "Executando...");
    this.child.stdin.write(JSON.stringify({ command: "step" }) + "\n");
  }

  stop() {
    this.stopped = true;

    if (!this.child || this.done) {
      return;
    }

    if (this.child.stdin.writable) {
      this.child.stdin.write(JSON.stringify({ command: "stop" }) + "\n");
      this.child.stdin.end();
    }

    setTimeout(() => {
      if (this.child && !this.child.killed && !this.done) {
        this.child.kill();
      }
    }, 1000);
  }

  isPaused() {
    return this.paused;
  }

  isDone() {
    return this.done;
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk.toString("utf8");
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      this.handleProtocolLine(line);
    }
  }

  handleProtocolLine(line) {
    let event;

    try {
      event = JSON.parse(line);
    } catch (error) {
      this.callbacks.onOutput("stdout", line + "\n");
      return;
    }

    switch (event.type) {
      case "paused":
        this.paused = true;
        this.callbacks.onPause(event.state || {
          currentLine: event.line,
          variables: {},
          callStack: [],
          heap: []
        });
        break;
      case "output":
        this.callbacks.onOutput(event.stream, event.text);
        break;
      case "error":
        this.done = true;
        this.callbacks.onError(event.message);
        break;
      case "done":
        this.done = true;
        this.callbacks.onDone({
          exitCode: event.exitCode,
          signal: undefined,
          state: event.state
        });
        break;
      default:
        this.callbacks.onOutput("stdout", line + "\n");
        break;
    }
  }
}

function parseCommandLine(commandLine) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|[^\s]+/g;
  let match = pattern.exec(commandLine || "");

  while (match) {
    tokens.push(match[1] || match[2] || match[0]);
    match = pattern.exec(commandLine || "");
  }

  return tokens.length > 0 ? tokens : ["python"];
}

module.exports = {
  PythonAdapter,
  parseCommandLine
};
