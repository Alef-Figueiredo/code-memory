const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const vscode = require("vscode");
const { LanguageAdapter } = require("./languageAdapter");
const { parseCommandLine } = require("../utils/commandLine");

class JavaAdapter extends LanguageAdapter {
  constructor(extensionUri, outputChannel) {
    super();
    this.extensionUri = extensionUri;
    this.outputChannel = outputChannel;
  }

  canHandle(document) {
    const fileName = document.uri.fsPath.toLowerCase();
    return document.languageId === "java" || fileName.endsWith(".java");
  }

  createSession(options) {
    const configuration = vscode.workspace.getConfiguration("codeMemory");
    const javaPath = configuration.get("javaPath", "java");
    const javacPath = configuration.get("javacPath", "javac");

    return new JavaExecutionSession({
      ...options,
      javaPath,
      javacPath,
      breakpoints: collectBreakpoints(options.filePath),
      runnerPath: path.join(this.extensionUri.fsPath, "src", "java", "JavaTraceRunner.java"),
      outputChannel: this.outputChannel
    });
  }
}

class JavaExecutionSession {
  constructor(options) {
    this.filePath = options.filePath;
    this.cwd = options.cwd;
    this.callbacks = options.callbacks;
    this.javaPath = options.javaPath;
    this.javacPath = options.javacPath;
    this.breakpoints = options.breakpoints || [];
    this.runnerPath = options.runnerPath;
    this.outputChannel = options.outputChannel;
    this.child = undefined;
    this.compileProcess = undefined;
    this.stdoutBuffer = "";
    this.done = false;
    this.stopped = false;
    this.paused = false;
    this.tempDir = undefined;
  }

  start() {
    if (this.child || this.compileProcess) {
      return;
    }

    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "code-memory-java-"));
    const runnerOutputDir = path.join(this.tempDir, "runner");
    fs.mkdirSync(runnerOutputDir, { recursive: true });

    const commandParts = parseCommandLine(this.javacPath, "javac");
    const command = commandParts[0];
    const args = [
      ...commandParts.slice(1),
      "--add-modules",
      "jdk.jdi",
      "-d",
      runnerOutputDir,
      this.runnerPath
    ];

    this.callbacks.onStatus("running", "Compilando suporte Java...");
    this.outputChannel.appendLine(`[javac] ${command} ${args.join(" ")}`);

    this.compileProcess = spawn(command, args, {
      cwd: this.cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let compileOutput = "";
    this.compileProcess.stdout.on("data", (chunk) => {
      compileOutput += chunk.toString("utf8");
    });
    this.compileProcess.stderr.on("data", (chunk) => {
      compileOutput += chunk.toString("utf8");
    });
    this.compileProcess.on("error", (error) => {
      this.compileProcess = undefined;
      this.done = true;
      this.callbacks.onError(`Nao foi possivel iniciar javac com "${this.javacPath}". ${error.message}`);
      this.cleanup();
    });
    this.compileProcess.on("exit", (code) => {
      this.compileProcess = undefined;

      if (this.stopped) {
        this.cleanup();
        return;
      }

      if (code !== 0) {
        this.done = true;
        this.callbacks.onError(`Falha ao compilar o runner Java.\n${compileOutput}`);
        this.cleanup();
        return;
      }

      this.launchRunner(runnerOutputDir);
    });
  }

  launchRunner(runnerOutputDir) {
    const commandParts = parseCommandLine(this.javaPath, "java");
    const command = commandParts[0];
    const args = [
      ...commandParts.slice(1),
      "--add-modules",
      "jdk.jdi",
      "-cp",
      runnerOutputDir,
      "JavaTraceRunner",
      this.filePath,
      this.cwd,
      `--breakpoints=${this.breakpoints.join(",")}`
    ];

    this.callbacks.onStatus("running", "Iniciando depuracao Java...");
    this.outputChannel.appendLine(`[java] ${command} ${args.join(" ")}`);

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
      this.callbacks.onError(`Nao foi possivel iniciar java com "${this.javaPath}". ${error.message}`);
      this.cleanup();
    });
    this.child.on("exit", (code, signal) => {
      if (!this.done && !this.stopped) {
        this.done = true;
        this.callbacks.onDone({ exitCode: code, signal });
      }
      this.cleanup();
    });
  }

  step() {
    this.sendCommand("step");
  }

  continue() {
    this.sendCommand("continue");
  }

  sendCommand(command) {
    if (!this.child || this.done || !this.child.stdin.writable) {
      return;
    }

    this.paused = false;
    this.callbacks.onStatus("running", command === "continue" ? "Continuando..." : "Executando...");
    this.child.stdin.write(JSON.stringify({ command }) + "\n");
  }

  stop() {
    this.stopped = true;

    if (this.compileProcess && !this.compileProcess.killed) {
      this.compileProcess.kill();
    }

    if (!this.child || this.done) {
      this.cleanup();
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
        this.callbacks.onPause(event.state || createEmptyState(event.line));
        break;
      case "output":
        this.callbacks.onOutput(event.stream, event.text);
        break;
      case "error":
        this.done = true;
        this.callbacks.onError(event.message);
        this.cleanup();
        break;
      case "done":
        this.done = true;
        this.callbacks.onDone({
          exitCode: event.exitCode,
          signal: undefined,
          state: event.state
        });
        this.cleanup();
        break;
      default:
        this.callbacks.onOutput("stdout", line + "\n");
        break;
    }
  }

  cleanup() {
    if (!this.tempDir) {
      return;
    }

    fs.rm(this.tempDir, { recursive: true, force: true }, () => {});
    this.tempDir = undefined;
  }
}

function collectBreakpoints(filePath) {
  const normalizedPath = path.normalize(filePath).toLowerCase();

  return vscode.debug.breakpoints
    .filter((breakpoint) => breakpoint instanceof vscode.SourceBreakpoint)
    .filter((breakpoint) => path.normalize(breakpoint.location.uri.fsPath).toLowerCase() === normalizedPath)
    .map((breakpoint) => breakpoint.location.range.start.line + 1)
    .filter((line, index, lines) => lines.indexOf(line) === index)
    .sort((left, right) => left - right);
}

function createEmptyState(line) {
  return {
    currentLine: line,
    variables: {},
    callStack: [],
    heap: [],
    stackFrames: [],
    heapObjects: [],
    references: []
  };
}

module.exports = {
  JavaAdapter,
  JavaExecutionSession,
  collectBreakpoints
};