const path = require("path");
const vscode = require("vscode");

class MemoryVisualizerPanel {
  static currentPanel = undefined;

  static createOrShow(extensionUri) {
    const column = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Beside
      : vscode.ViewColumn.One;

    if (MemoryVisualizerPanel.currentPanel) {
      MemoryVisualizerPanel.currentPanel.panel.reveal(column);
      return MemoryVisualizerPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      "codeMemoryVisualizer",
      "Code Memory",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    MemoryVisualizerPanel.currentPanel = new MemoryVisualizerPanel(panel, extensionUri);
    return MemoryVisualizerPanel.currentPanel;
  }

  static disposeCurrent() {
    if (MemoryVisualizerPanel.currentPanel) {
      MemoryVisualizerPanel.currentPanel.dispose();
      MemoryVisualizerPanel.currentPanel = undefined;
    }
  }

  constructor(panel, extensionUri) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.document = undefined;
    this.adapter = undefined;
    this.session = undefined;
    this.sessionId = 0;
    this.disposables = [];

    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message) => this.handleMessage(message),
      null,
      this.disposables
    );
  }

  loadDocument(document, adapter) {
    this.stopSession();
    this.document = document;
    this.adapter = adapter;
    this.panel.title = `Code Memory: ${path.basename(document.uri.fsPath)}`;
    this.post({
      type: "source",
      fileName: document.uri.fsPath,
      languageId: document.languageId || "python",
      code: document.getText()
    });
    this.post({
      type: "status",
      state: "ready",
      message: "Ready"
    });
  }

  handleMessage(message) {
    switch (message.command) {
      case "run":
        this.startExecution();
        break;
      case "step":
        this.stepExecution();
        break;
      case "restart":
        this.restartExecution();
        break;
      default:
        break;
    }
  }

  startExecution() {
    if (!this.document || !this.adapter) {
      this.post({
        type: "status",
        state: "idle",
        message: "Open a Python file"
      });
      return;
    }

    if (this.session && !this.session.isDone()) {
      this.post({
        type: "status",
        state: this.session.isPaused() ? "paused" : "running",
        message: this.session.isPaused()
          ? "Paused. Use Next step or Restart."
          : "Running..."
      });
      return;
    }

    this.post({ type: "resetExecution" });
    this.session = this.createSession();
    this.session.start();
  }

  stepExecution() {
    if (!this.session || this.session.isDone()) {
      this.post({
        type: "status",
        state: "ready",
        message: "Start the execution first"
      });
      return;
    }

    this.session.step();
  }

  restartExecution() {
    if (!this.document || !this.adapter) {
      return;
    }

    this.stopSession();
    this.post({ type: "resetExecution" });
    this.session = this.createSession();
    this.session.start();
  }

  createSession() {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(this.document.uri);
    const sessionId = this.nextSessionId();

    return this.adapter.createSession({
      filePath: this.document.uri.fsPath,
      cwd: workspaceFolder ? workspaceFolder.uri.fsPath : path.dirname(this.document.uri.fsPath),
      callbacks: {
        onPause: (line) => {
          if (!this.isActiveSession(sessionId)) {
            return;
          }

          this.post({
            type: "pause",
            line
          });
          this.post({
            type: "status",
            state: "paused",
            message: `Paused at line ${line}`
          });
        },
        onOutput: (stream, text) => {
          if (!this.isActiveSession(sessionId)) {
            return;
          }

          this.post({
            type: "output",
            stream,
            text
          });
        },
        onDone: ({ exitCode, signal }) => {
          if (!this.isActiveSession(sessionId)) {
            return;
          }

          const detail = signal ? `signal ${signal}` : `exit code ${exitCode}`;
          this.post({
            type: "done",
            message: `Finished with ${detail}`
          });
          this.post({
            type: "status",
            state: "done",
            message: `Finished with ${detail}`
          });
        },
        onError: (message) => {
          if (!this.isActiveSession(sessionId)) {
            return;
          }

          this.post({
            type: "output",
            stream: "stderr",
            text: `${message}\n`
          });
          this.post({
            type: "status",
            state: "error",
            message: "Execution error"
          });
        },
        onStatus: (state, message) => {
          if (!this.isActiveSession(sessionId)) {
            return;
          }

          this.post({
            type: "status",
            state,
            message
          });
        }
      }
    });
  }

  stopSession() {
    if (this.session && !this.session.isDone()) {
      this.session.stop();
    }

    this.session = undefined;
    this.nextSessionId();
  }

  nextSessionId() {
    this.sessionId += 1;
    return this.sessionId;
  }

  isActiveSession(sessionId) {
    return this.sessionId === sessionId;
  }

  post(message) {
    this.panel.webview.postMessage(message);
  }

  dispose() {
    this.stopSession();
    MemoryVisualizerPanel.currentPanel = undefined;

    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  getHtml(webview) {
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Code Memory</title>
  <style>
    :root {
      --line-height: 22px;
      --accent: var(--vscode-focusBorder);
      --panel-border: var(--vscode-panel-border);
      --muted: var(--vscode-descriptionForeground);
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }

    .shell {
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto auto 1fr;
    }

    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--panel-border);
      background: var(--vscode-sideBar-background);
    }

    .title {
      min-width: 0;
      display: grid;
      gap: 2px;
    }

    .title strong,
    .title span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .title span {
      color: var(--muted);
      font-size: 12px;
    }

    .status {
      min-width: 120px;
      text-align: right;
      color: var(--muted);
      font-size: 12px;
    }

    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 16px;
      border-bottom: 1px solid var(--panel-border);
      background: var(--vscode-editorWidget-background);
    }

    button {
      min-height: 30px;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 4px;
      padding: 4px 10px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      font: inherit;
      line-height: 1.2;
      cursor: pointer;
    }

    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }

    button:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground);
    }

    button.secondary:hover:not(:disabled) {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    button:disabled {
      cursor: default;
      opacity: 0.55;
    }

    .content {
      min-height: 0;
      display: grid;
      grid-template-columns: minmax(280px, 1fr) minmax(220px, 34%);
    }

    .code-area,
    .output-area {
      min-width: 0;
      min-height: 0;
      overflow: auto;
    }

    .output-area {
      border-left: 1px solid var(--panel-border);
      background: var(--vscode-terminal-background, var(--vscode-editor-background));
    }

    .section-title {
      position: sticky;
      top: 0;
      z-index: 1;
      height: 32px;
      display: flex;
      align-items: center;
      padding: 0 12px;
      border-bottom: 1px solid var(--panel-border);
      color: var(--muted);
      background: var(--vscode-editor-background);
      font-size: 12px;
      text-transform: uppercase;
    }

    .code {
      margin: 0;
      padding: 8px 0 16px;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      line-height: var(--line-height);
      tab-size: 4;
    }

    .line {
      min-height: var(--line-height);
      display: grid;
      grid-template-columns: 56px minmax(0, 1fr);
      border-left: 3px solid transparent;
    }

    .line.current {
      border-left-color: var(--accent);
      background: var(--vscode-editor-lineHighlightBackground);
      outline: 1px solid var(--vscode-editor-lineHighlightBorder, transparent);
      outline-offset: -1px;
    }

    .line-number {
      padding: 0 10px;
      color: var(--vscode-editorLineNumber-foreground);
      text-align: right;
      user-select: none;
    }

    .line-code {
      min-width: 0;
      padding-right: 16px;
      white-space: pre;
    }

    .line-code:empty::after {
      content: " ";
    }

    .output {
      margin: 0;
      padding: 10px 12px 18px;
      white-space: pre-wrap;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      line-height: var(--line-height);
    }

    .stderr {
      color: var(--vscode-errorForeground);
    }

    @media (max-width: 760px) {
      .topbar {
        align-items: flex-start;
        flex-direction: column;
      }

      .status {
        text-align: left;
      }

      .toolbar {
        flex-wrap: wrap;
      }

      .content {
        grid-template-columns: 1fr;
        grid-template-rows: minmax(260px, 1fr) 220px;
      }

      .output-area {
        border-left: 0;
        border-top: 1px solid var(--panel-border);
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div class="title">
        <strong>Code Memory</strong>
        <span id="fileName">No file</span>
      </div>
      <div id="status" class="status">Ready</div>
    </header>

    <nav class="toolbar" aria-label="Execution controls">
      <button id="run" title="Executar"><span aria-hidden="true">&#9654;</span><span>Executar</span></button>
      <button id="step" class="secondary" title="Proxima etapa"><span aria-hidden="true">&#9193;</span><span>Proxima etapa</span></button>
      <button id="restart" class="secondary" title="Reiniciar"><span aria-hidden="true">&#8635;</span><span>Reiniciar</span></button>
    </nav>

    <section class="content">
      <div class="code-area">
        <div class="section-title">Codigo</div>
        <div id="code" class="code"></div>
      </div>
      <div class="output-area">
        <div class="section-title">Saida</div>
        <pre id="output" class="output"></pre>
      </div>
    </section>
  </main>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const fileName = document.getElementById("fileName");
    const status = document.getElementById("status");
    const code = document.getElementById("code");
    const output = document.getElementById("output");
    const run = document.getElementById("run");
    const step = document.getElementById("step");
    const restart = document.getElementById("restart");

    const state = {
      lines: [],
      currentLine: undefined,
      sourceLoaded: false,
      status: "ready"
    };

    run.addEventListener("click", () => vscode.postMessage({ command: "run" }));
    step.addEventListener("click", () => vscode.postMessage({ command: "step" }));
    restart.addEventListener("click", () => vscode.postMessage({ command: "restart" }));

    window.addEventListener("message", (event) => {
      const message = event.data;

      switch (message.type) {
        case "source":
          state.lines = message.code.split(/\\r?\\n/);
          state.currentLine = undefined;
          state.sourceLoaded = true;
          fileName.textContent = message.fileName;
          output.textContent = "";
          renderCode();
          updateButtons();
          break;
        case "resetExecution":
          state.currentLine = undefined;
          state.status = "running";
          output.textContent = "";
          renderCode();
          updateButtons();
          break;
        case "pause":
          state.currentLine = message.line;
          state.status = "paused";
          renderCode();
          updateButtons();
          break;
        case "output":
          appendOutput(message.stream, message.text);
          break;
        case "done":
          state.currentLine = undefined;
          state.status = "done";
          renderCode();
          updateButtons();
          break;
        case "status":
          state.status = message.state;
          status.textContent = message.message;
          updateButtons();
          break;
        default:
          break;
      }
    });

    function renderCode() {
      code.textContent = "";
      const fragment = document.createDocumentFragment();

      state.lines.forEach((line, index) => {
        const lineNumber = index + 1;
        const row = document.createElement("div");
        row.className = lineNumber === state.currentLine ? "line current" : "line";

        const gutter = document.createElement("span");
        gutter.className = "line-number";
        gutter.textContent = String(lineNumber);

        const content = document.createElement("span");
        content.className = "line-code";
        content.textContent = line;

        row.append(gutter, content);
        fragment.append(row);
      });

      code.append(fragment);

      const current = code.querySelector(".line.current");
      if (current) {
        current.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }

    function appendOutput(stream, text) {
      const span = document.createElement("span");
      span.className = stream === "stderr" ? "stderr" : "stdout";
      span.textContent = text;
      output.append(span);
      output.scrollTop = output.scrollHeight;
    }

    function updateButtons() {
      const hasSource = state.sourceLoaded;
      const isRunning = state.status === "running";
      const isPaused = state.status === "paused";

      run.disabled = !hasSource || isRunning || isPaused;
      step.disabled = !hasSource || !isPaused;
      restart.disabled = !hasSource || isRunning;
    }

    updateButtons();
  </script>
</body>
</html>`;
  }
}

function getNonce() {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";

  for (let index = 0; index < 32; index += 1) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }

  return text;
}

module.exports = {
  MemoryVisualizerPanel
};
