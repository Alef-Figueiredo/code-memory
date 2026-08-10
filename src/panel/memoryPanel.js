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
      message: "Pronto"
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
        message: "Abra um arquivo Python"
      });
      return;
    }

    if (this.session && !this.session.isDone()) {
      this.post({
        type: "status",
        state: this.session.isPaused() ? "paused" : "running",
        message: this.session.isPaused()
          ? "Pausado. Use Proxima etapa ou Reiniciar."
          : "Executando..."
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
        message: "Inicie a execucao primeiro"
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
        onPause: (executionState) => {
          if (!this.isActiveSession(sessionId)) {
            return;
          }

          this.post({
            type: "pause",
            line: executionState.currentLine,
            state: executionState
          });
          this.post({
            type: "status",
            state: "paused",
            message: `Pausado na linha ${executionState.currentLine}`
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
        onDone: ({ exitCode, signal, state }) => {
          if (!this.isActiveSession(sessionId)) {
            return;
          }

          const detail = signal ? `sinal ${signal}` : `codigo de saida ${exitCode}`;
          this.post({
            type: "done",
            message: `Finalizado com ${detail}`,
            state
          });
          this.post({
            type: "status",
            state: "done",
            message: `Finalizado com ${detail}`
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
            message: "Erro de execucao"
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
      --created: var(--vscode-charts-green, #4caf50);
      --changed: var(--vscode-charts-yellow, #f5c542);
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
    .state-area {
      min-width: 0;
      min-height: 0;
    }

    .code-area {
      overflow: auto;
    }

    .state-area {
      display: grid;
      grid-template-rows: auto auto auto minmax(170px, 1fr) auto minmax(120px, 1fr);
      overflow: hidden;
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
      overflow: auto;
      white-space: pre-wrap;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      line-height: var(--line-height);
    }

    .stderr {
      color: var(--vscode-errorForeground);
    }

    .execution-state,
    .variables {
      min-height: 0;
      overflow: auto;
      padding: 10px 12px;
    }

    .execution-state {
      display: grid;
      gap: 8px;
      border-bottom: 1px solid var(--panel-border);
      color: var(--muted);
      font-size: 12px;
    }

    .state-metrics {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }

    .metric {
      min-width: 0;
      display: grid;
      gap: 2px;
    }

    .metric strong {
      color: var(--vscode-foreground);
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .stack-list {
      display: grid;
      gap: 3px;
      margin-top: 2px;
    }

    .stack-frame {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .variables {
      display: grid;
      align-content: start;
      gap: 6px;
      border-bottom: 1px solid var(--panel-border);
    }

    .variable-row {
      min-width: 0;
      display: grid;
      grid-template-columns: minmax(52px, 0.42fr) 18px minmax(90px, 1fr);
      gap: 6px;
      align-items: baseline;
      padding: 5px 7px;
      border-left: 3px solid transparent;
      background: var(--vscode-editorWidget-background);
    }

    .variable-row.created {
      border-left-color: var(--created);
    }

    .variable-row.changed {
      border-left-color: var(--changed);
    }

    .variable-name,
    .variable-value,
    .variable-scope {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .variable-name {
      color: var(--vscode-symbolIcon-variableForeground, var(--vscode-foreground));
      font-weight: 600;
    }

    .variable-arrow,
    .variable-scope,
    .empty-state {
      color: var(--muted);
    }

    .variable-value {
      font-family: var(--vscode-editor-font-family);
    }

    .variable-scope {
      grid-column: 3;
      font-size: 11px;
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

      .state-area {
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
      <div id="status" class="status">Pronto</div>
    </header>

    <nav class="toolbar" aria-label="Execution controls">
      <button id="run" title="Executar"><span aria-hidden="true">&#9654;</span><span>Executar</span></button>
      <button id="back" class="secondary" title="Voltar etapa"><span aria-hidden="true">&#8592;</span><span>Voltar etapa</span></button>
      <button id="step" class="secondary" title="Proxima etapa"><span aria-hidden="true">&#9193;</span><span>Proxima etapa</span></button>
      <button id="restart" class="secondary" title="Reiniciar"><span aria-hidden="true">&#8635;</span><span>Reiniciar</span></button>
    </nav>

    <section class="content">
      <div class="code-area">
        <div class="section-title">Codigo</div>
        <div id="code" class="code"></div>
      </div>
      <div class="state-area">
        <div class="section-title">Estado</div>
        <div id="executionState" class="execution-state"></div>
        <div class="section-title">Variaveis</div>
        <div id="variables" class="variables"></div>
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
    const executionState = document.getElementById("executionState");
    const variables = document.getElementById("variables");
    const output = document.getElementById("output");
    const run = document.getElementById("run");
    const back = document.getElementById("back");
    const step = document.getElementById("step");
    const restart = document.getElementById("restart");

    const state = {
      lines: [],
      currentLine: undefined,
      currentExecutionState: undefined,
      history: [],
      historyIndex: -1,
      sourceLoaded: false,
      status: "ready",
      statusMessage: "Pronto"
    };

    run.addEventListener("click", () => vscode.postMessage({ command: "run" }));
    back.addEventListener("click", () => showHistoryState(state.historyIndex - 1));
    step.addEventListener("click", () => {
      if (state.historyIndex < state.history.length - 1) {
        showHistoryState(state.historyIndex + 1);
        return;
      }

      vscode.postMessage({ command: "step" });
    });
    restart.addEventListener("click", () => vscode.postMessage({ command: "restart" }));

    window.addEventListener("message", (event) => {
      const message = event.data;

      switch (message.type) {
        case "source":
          state.lines = message.code.split(/\\r?\\n/);
          state.currentLine = undefined;
          state.currentExecutionState = undefined;
          state.history = [];
          state.historyIndex = -1;
          state.sourceLoaded = true;
          fileName.textContent = message.fileName;
          output.textContent = "";
          renderCode();
          renderExecutionState();
          updateButtons();
          break;
        case "resetExecution":
          state.currentLine = undefined;
          state.currentExecutionState = undefined;
          state.history = [];
          state.historyIndex = -1;
          state.status = "running";
          output.textContent = "";
          renderCode();
          renderExecutionState();
          updateButtons();
          break;
        case "pause":
          state.status = "paused";
          appendExecutionState(normalizeExecutionState(message.state, message.line));
          break;
        case "output":
          appendOutput(message.stream, message.text);
          break;
        case "done":
          state.status = "done";
          if (message.state) {
            appendExecutionState(normalizeExecutionState(message.state, undefined));
          } else {
            state.currentLine = undefined;
            renderCode();
            renderExecutionState();
          }
          updateButtons();
          break;
        case "status":
          state.status = message.state;
          state.statusMessage = message.message;
          status.textContent = message.message;
          updateButtons();
          break;
        default:
          break;
      }
    });

    function normalizeExecutionState(rawState, fallbackLine) {
      const snapshot = rawState || {};
      const currentLine = snapshot.currentLine === null || snapshot.currentLine === undefined
        ? fallbackLine
        : snapshot.currentLine;

      return {
        currentLine,
        variables: snapshot.variables || {},
        callStack: Array.isArray(snapshot.callStack) ? snapshot.callStack : [],
        heap: Array.isArray(snapshot.heap) ? snapshot.heap : []
      };
    }

    function appendExecutionState(snapshot) {
      if (state.historyIndex < state.history.length - 1) {
        state.history = state.history.slice(0, state.historyIndex + 1);
      }

      state.history.push(snapshot);
      showHistoryState(state.history.length - 1);
    }

    function showHistoryState(index) {
      if (index < 0 || index >= state.history.length) {
        return;
      }

      state.historyIndex = index;
      state.currentExecutionState = state.history[index];
      state.currentLine = state.currentExecutionState.currentLine;

      renderCode();
      renderExecutionState();
      updateButtons();

      if (state.historyIndex < state.history.length - 1) {
        status.textContent = "Visualizando etapa " + (state.historyIndex + 1) + " de " + state.history.length;
      } else {
        status.textContent = state.statusMessage;
      }
    }

    function renderExecutionState() {
      executionState.textContent = "";
      variables.textContent = "";

      const snapshot = state.currentExecutionState;

      if (!snapshot) {
        appendEmpty(executionState, "Nenhuma execucao ainda.");
        appendEmpty(variables, "Sem variaveis.");
        return;
      }

      const metrics = document.createElement("div");
      metrics.className = "state-metrics";
      metrics.append(
        createMetric("Etapa", String(state.historyIndex + 1) + "/" + String(state.history.length)),
        createMetric("Linha", snapshot.currentLine ? String(snapshot.currentLine) : "final"),
        createMetric("Frames", String(snapshot.callStack.length)),
        createMetric("Heap", String(snapshot.heap.length))
      );
      executionState.append(metrics);

      const stackList = document.createElement("div");
      stackList.className = "stack-list";

      if (snapshot.callStack.length === 0) {
        appendEmpty(stackList, "Call stack vazio.");
      } else {
        snapshot.callStack.forEach((frame) => {
          const frameRow = document.createElement("div");
          frameRow.className = "stack-frame";
          frameRow.textContent = frame.name + "() - linha " + frame.line;
          stackList.append(frameRow);
        });
      }

      executionState.append(stackList);
      renderVariables(snapshot);
    }

    function renderVariables(snapshot) {
      const currentVariables = Object.values(snapshot.variables || {})
        .sort((left, right) => left.name.localeCompare(right.name));
      const previousSnapshot = state.history[state.historyIndex - 1];
      const previousVariables = previousSnapshot ? previousSnapshot.variables || {} : {};

      if (currentVariables.length === 0) {
        appendEmpty(variables, "Sem variaveis.");
        return;
      }

      currentVariables.forEach((variable) => {
        const previous = previousVariables[variable.name];
        const row = document.createElement("div");
        const changed = previous && previous.repr !== variable.repr;
        const created = !previous;
        row.className = "variable-row" + (created ? " created" : changed ? " changed" : "");

        const name = document.createElement("span");
        name.className = "variable-name";
        name.textContent = variable.name;

        const arrow = document.createElement("span");
        arrow.className = "variable-arrow";
        arrow.textContent = "->";

        const value = document.createElement("span");
        value.className = "variable-value";
        value.title = variable.repr;
        value.textContent = variable.repr;

        const scope = document.createElement("span");
        scope.className = "variable-scope";
        scope.textContent = variable.scope + " | " + variable.type + variableChangeLabel(created, changed);

        row.append(name, arrow, value, scope);
        variables.append(row);
      });
    }

    function variableChangeLabel(created, changed) {
      if (created) {
        return " | criada";
      }

      if (changed) {
        return " | alterada";
      }

      return "";
    }

    function createMetric(label, value) {
      const metric = document.createElement("div");
      metric.className = "metric";

      const labelElement = document.createElement("span");
      labelElement.textContent = label;

      const valueElement = document.createElement("strong");
      valueElement.textContent = value;

      metric.append(labelElement, valueElement);
      return metric;
    }

    function appendEmpty(parent, text) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = text;
      parent.append(empty);
    }

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
      const hasPreviousState = state.historyIndex > 0;
      const hasNextHistoryState = state.historyIndex >= 0 && state.historyIndex < state.history.length - 1;
      const canStepLive = isPaused && state.historyIndex === state.history.length - 1;

      run.disabled = !hasSource || isRunning || isPaused;
      back.disabled = !hasSource || isRunning || !hasPreviousState;
      step.disabled = !hasSource || isRunning || (!canStepLive && !hasNextHistoryState);
      restart.disabled = !hasSource || isRunning;
    }

    renderExecutionState();
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
