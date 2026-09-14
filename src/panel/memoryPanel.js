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
      case "continue":
        this.continueExecution();
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
        message: "Abra um arquivo Python ou Java"
      });
      return;
    }

    if (this.session && !this.session.isDone()) {
      this.post({
        type: "status",
        state: this.session.isPaused() ? "paused" : "running",
        message: this.session.isPaused()
          ? "Pausado. Use Proxima etapa, Continuar ate o proximo breakpoint, ou Reiniciar."
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
      --current-arrow: var(--vscode-charts-red, #f14c4c);
      --flow-arrow: var(--vscode-charts-green, #73c991);
      --created: var(--vscode-charts-green, #4caf50);
      --changed: var(--vscode-charts-yellow, #f5c542);
      --reference: var(--vscode-charts-blue, #4da3ff);
      --surface: var(--vscode-editorWidget-background);
      --surface-strong: var(--vscode-sideBar-background);
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
      background: var(--surface-strong);
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
      background: var(--surface);
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
      grid-template-columns: minmax(280px, 1fr) minmax(320px, 42%);
    }

    .code-area,
    .state-area {
      min-width: 0;
      min-height: 0;
      overflow: auto;
    }

    .state-area {
      border-left: 1px solid var(--panel-border);
      background: var(--vscode-terminal-background, var(--vscode-editor-background));
    }

    .section-title {
      position: sticky;
      top: 0;
      z-index: 1;
      min-height: 32px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 0 12px;
      border-bottom: 1px solid var(--panel-border);
      color: var(--muted);
      background: var(--vscode-editor-background);
      font-size: 12px;
      text-transform: uppercase;
    }

    .section-count {
      color: var(--vscode-foreground);
      font-variant-numeric: tabular-nums;
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
      grid-template-columns: 26px 48px minmax(0, 1fr);
      border-left: 3px solid transparent;
    }

    .line.current {
      border-left-color: var(--accent);
      background: var(--vscode-editor-lineHighlightBackground);
      outline: 1px solid var(--vscode-editor-lineHighlightBorder, transparent);
      outline-offset: -1px;
    }

    .execution-pointer {
      min-width: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .execution-pointer::before {
      content: "";
      width: 0;
      height: 0;
      border-top: 6px solid transparent;
      border-bottom: 6px solid transparent;
      border-left: 10px solid transparent;
      transform: translateX(2px);
    }

    .line.current .execution-pointer::before {
      border-left-color: var(--current-arrow);
    }

    .line-number {
      padding: 0 8px 0 0;
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

    .state-section {
      border-bottom: 1px solid var(--panel-border);
    }

    .summary,
    .stack,
    .heap,
    .references,
    .variables {
      min-width: 0;
      display: grid;
      align-content: start;
      gap: 8px;
      padding: 10px 12px;
    }

    .summary-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }

    .metric {
      min-width: 0;
      display: grid;
      gap: 2px;
      padding: 7px 8px;
      border: 1px solid var(--panel-border);
      border-radius: 6px;
      background: var(--surface);
    }

    .metric span {
      color: var(--muted);
      font-size: 11px;
    }

    .metric strong {
      overflow: hidden;
      color: var(--vscode-foreground);
      font-weight: 600;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .stack-frame,
    .heap-object,
    .reference-row,
    .variable-row,
    .member-row {
      transition: background-color 160ms ease, border-color 160ms ease;
    }

    .stack-frame,
    .heap-object {
      min-width: 0;
      position: relative;
      display: grid;
      gap: 8px;
      padding: 9px 9px 9px 20px;
      border: 1px solid var(--panel-border);
      border-left: 3px solid var(--reference);
      border-radius: 6px;
      background: var(--surface);
    }

    .stack-frame.created,
    .heap-object.created,
    .variable-row.created,
    .member-row.created,
    .reference-row.created {
      border-left-color: var(--created);
      animation: pulseChange 520ms ease-out;
    }

    .stack-frame.changed,
    .heap-object.changed,
    .variable-row.changed,
    .reference-row.changed,
    .member-row.changed {
      border-left-color: var(--changed);
      animation: pulseChange 520ms ease-out;
    }

    .card-header {
      min-width: 0;
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
    }

    .card-title,
    .object-id,
    .reference-source,
    .reference-target,
    .variable-name,
    .variable-value,
    .member-name,
    .member-value {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .card-title,
    .variable-name,
    .member-name,
    .reference-source,
    .reference-target {
      font-weight: 600;
    }

    .object-id,
    .card-meta,
    .variable-meta,
    .empty-state,
    .reference-kind,
    .member-meta {
      color: var(--muted);
      font-size: 11px;
    }

    .parameter-list,
    .member-list,
    .frame-variable-list {
      display: grid;
      gap: 5px;
    }

    .parameter-list {
      grid-template-columns: repeat(auto-fit, minmax(92px, 1fr));
    }

    .parameter-chip {
      min-width: 0;
      overflow: hidden;
      padding: 4px 6px;
      border: 1px solid var(--panel-border);
      border-radius: 999px;
      color: var(--vscode-foreground);
      background: var(--vscode-input-background);
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 11px;
    }

    .variable-row,
    .member-row,
    .reference-row {
      min-width: 0;
      position: relative;
      display: grid;
      gap: 4px;
      padding: 6px 7px 6px 18px;
      border-left: 3px solid transparent;
      background: var(--surface);
    }

    .variable-main,
    .member-main,
    .reference-main {
      min-width: 0;
      display: grid;
      grid-template-columns: minmax(68px, 0.42fr) 20px minmax(96px, 1fr);
      gap: 6px;
      align-items: baseline;
    }

    .variable-arrow,
    .member-arrow,
    .reference-arrow {
      color: var(--reference);
      font-weight: 700;
      text-align: center;
    }

    .stack-frame::before,
    .heap-object::before,
    .variable-row::before,
    .member-row::before,
    .reference-row::before {
      content: "";
      position: absolute;
      top: 12px;
      left: 6px;
      width: 0;
      height: 0;
      border-top: 5px solid transparent;
      border-bottom: 5px solid transparent;
      border-left: 8px solid transparent;
      opacity: 0;
    }

    .stack-frame.created::before,
    .heap-object.created::before,
    .variable-row.created::before,
    .member-row.created::before,
    .reference-row.created::before {
      border-left-color: var(--flow-arrow);
      opacity: 1;
    }

    .stack-frame.changed::before,
    .heap-object.changed::before,
    .variable-row.changed::before,
    .member-row.changed::before,
    .reference-row.changed::before {
      border-left-color: var(--changed);
      opacity: 1;
    }

    .variable-row.created .variable-arrow,
    .member-row.created .member-arrow,
    .reference-row.created .reference-arrow {
      color: var(--flow-arrow);
    }

    .variable-row.changed .variable-arrow,
    .member-row.changed .member-arrow,
    .reference-row.changed .reference-arrow {
      color: var(--changed);
    }

    .variable-value,
    .member-value,
    .output {
      font-family: var(--vscode-editor-font-family);
    }

    .reference-row:not(.created):not(.changed) {
      border-left-color: var(--reference);
    }

    .output {
      margin: 0;
      min-height: 110px;
      padding: 10px 12px 18px;
      overflow: auto;
      white-space: pre-wrap;
      font-size: var(--vscode-editor-font-size);
      line-height: var(--line-height);
    }

    .stderr {
      color: var(--vscode-errorForeground);
    }

    @keyframes pulseChange {
      0% {
        background: color-mix(in srgb, var(--changed) 20%, var(--surface));
      }
      100% {
        background: var(--surface);
      }
    }

    @media (max-width: 860px) {
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
        grid-template-rows: minmax(260px, 1fr) minmax(360px, 1fr);
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
      <button id="continue" class="secondary" title="Continuar ate o proximo breakpoint ou fim"><span aria-hidden="true">&#9658;</span><span>Continuar</span></button>
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
        <section class="state-section">
          <div class="section-title">Estado</div>
          <div id="summary" class="summary"></div>
        </section>
        <section class="state-section">
          <div class="section-title"><span>Stack</span><span id="stackCount" class="section-count">0</span></div>
          <div id="stack" class="stack"></div>
        </section>
        <section class="state-section">
          <div class="section-title"><span>Heap</span><span id="heapCount" class="section-count">0</span></div>
          <div id="heap" class="heap"></div>
        </section>
        <section class="state-section">
          <div class="section-title"><span>Referencias</span><span id="referenceCount" class="section-count">0</span></div>
          <div id="references" class="references"></div>
        </section>
        <section class="state-section">
          <div class="section-title"><span>Variaveis</span><span id="variableCount" class="section-count">0</span></div>
          <div id="variables" class="variables"></div>
        </section>
        <section class="state-section">
          <div class="section-title">Saida</div>
          <pre id="output" class="output"></pre>
        </section>
      </div>
    </section>
  </main>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const fileName = document.getElementById("fileName");
    const status = document.getElementById("status");
    const code = document.getElementById("code");
    const summary = document.getElementById("summary");
    const stack = document.getElementById("stack");
    const heap = document.getElementById("heap");
    const references = document.getElementById("references");
    const variables = document.getElementById("variables");
    const stackCount = document.getElementById("stackCount");
    const heapCount = document.getElementById("heapCount");
    const referenceCount = document.getElementById("referenceCount");
    const variableCount = document.getElementById("variableCount");
    const output = document.getElementById("output");
    const run = document.getElementById("run");
    const continueButton = document.getElementById("continue");
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
    continueButton.addEventListener("click", () => vscode.postMessage({ command: "continue" }));
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
      const stackFrames = Array.isArray(snapshot.stackFrames)
        ? snapshot.stackFrames
        : Array.isArray(snapshot.callStack)
          ? snapshot.callStack
          : [];
      const heapObjects = Array.isArray(snapshot.heapObjects)
        ? snapshot.heapObjects
        : Array.isArray(snapshot.heap)
          ? snapshot.heap
          : [];

      return {
        currentLine,
        variables: snapshot.variables || {},
        callStack: Array.isArray(snapshot.callStack) ? snapshot.callStack : stackFrames,
        heap: heapObjects,
        stackFrames,
        heapObjects,
        references: Array.isArray(snapshot.references) ? snapshot.references : []
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
      clear(summary, stack, heap, references, variables);

      const snapshot = state.currentExecutionState;

      if (!snapshot) {
        stackCount.textContent = "0";
        heapCount.textContent = "0";
        referenceCount.textContent = "0";
        variableCount.textContent = "0";
        appendEmpty(summary, "Nenhuma execucao ainda.");
        appendEmpty(stack, "Stack vazio.");
        appendEmpty(heap, "Heap vazio.");
        appendEmpty(references, "Sem referencias.");
        appendEmpty(variables, "Sem variaveis.");
        return;
      }

      const stackFrames = snapshot.stackFrames || [];
      const heapObjects = snapshot.heapObjects || [];
      const referenceList = snapshot.references || [];
      const variableList = sortedVariables(snapshot.variables || {});

      stackCount.textContent = String(stackFrames.length);
      heapCount.textContent = String(heapObjects.length);
      referenceCount.textContent = String(referenceList.length);
      variableCount.textContent = String(variableList.length);

      renderSummary(snapshot, stackFrames, heapObjects, referenceList, variableList);
      renderStack(snapshot, stackFrames);
      renderHeap(snapshot, heapObjects);
      renderReferences(snapshot, referenceList);
      renderVariables(snapshot, variableList);
    }

    function renderSummary(snapshot, stackFrames, heapObjects, referenceList, variableList) {
      const grid = document.createElement("div");
      grid.className = "summary-grid";
      grid.append(
        createMetric("Etapa", String(state.historyIndex + 1) + "/" + String(state.history.length)),
        createMetric("Linha", snapshot.currentLine ? String(snapshot.currentLine) : "final"),
        createMetric("Frames", String(stackFrames.length)),
        createMetric("Objetos", String(heapObjects.length)),
        createMetric("Referencias", String(referenceList.length)),
        createMetric("Variaveis", String(variableList.length))
      );
      summary.append(grid);
    }

    function renderStack(snapshot, stackFrames) {
      if (stackFrames.length === 0) {
        appendEmpty(stack, "Stack vazio.");
        return;
      }

      const previousFrames = getPreviousStackFrames();

      stackFrames.forEach((frame) => {
        const previous = previousFrames.get(frame.id || frame.name);
        const frameElement = document.createElement("article");
        frameElement.className = "stack-frame" + changeClass(previous, frameSignature(frame));

        const header = document.createElement("div");
        header.className = "card-header";
        header.append(createText("strong", "card-title", frame.name + "()"));
        header.append(createText("span", "card-meta", "linha " + frame.line));
        frameElement.append(header);

        const parameters = Array.isArray(frame.parameters) ? frame.parameters : [];
        if (parameters.length > 0) {
          const parameterList = document.createElement("div");
          parameterList.className = "parameter-list";
          parameters.forEach((parameter) => {
            parameterList.append(createText("span", "parameter-chip", parameter.name + " = " + formatValue(parameter, snapshot)));
          });
          frameElement.append(parameterList);
        }

        const frameVariables = sortedVariables(frame.variables || {});
        const variableList = document.createElement("div");
        variableList.className = "frame-variable-list";
        if (frameVariables.length === 0) {
          appendEmpty(variableList, "Sem variaveis locais.");
        } else {
          frameVariables.forEach((variable) => {
            variableList.append(createVariableRow(variable, snapshot, previous ? previous.variables : undefined));
          });
        }
        frameElement.append(variableList);
        stack.append(frameElement);
      });
    }

    function renderHeap(snapshot, heapObjects) {
      if (heapObjects.length === 0) {
        appendEmpty(heap, "Heap vazio.");
        return;
      }

      const previousObjects = getPreviousHeapObjects();

      heapObjects.forEach((object) => {
        const previous = previousObjects.get(object.id);
        const objectElement = document.createElement("article");
        objectElement.className = "heap-object" + changeClass(previous, heapSignature(object));

        const header = document.createElement("div");
        header.className = "card-header";
        header.append(createText("strong", "card-title", object.type));
        header.append(createText("span", "object-id", object.id));
        objectElement.append(header);
        objectElement.append(createText("div", "card-meta", object.address || object.repr || ""));

        const members = document.createElement("div");
        members.className = "member-list";
        const fields = Array.isArray(object.fields) ? object.fields : [];
        const items = Array.isArray(object.items) ? object.items : [];

        if (fields.length === 0 && items.length === 0) {
          appendEmpty(members, object.repr || "Sem campos.");
        } else {
          fields.forEach((field) => {
            members.append(createMemberRow(field.name, field.value, snapshot, previous));
          });
          items.forEach((item) => {
            const label = item.key ? "[" + formatValue(item.key, snapshot) + "]" : "[" + item.name + "]";
            members.append(createMemberRow(label, item.value, snapshot, previous));
          });
        }

        objectElement.append(members);
        heap.append(objectElement);
      });
    }

    function renderReferences(snapshot, referenceList) {
      if (referenceList.length === 0) {
        appendEmpty(references, "Sem referencias.");
        return;
      }

      const previousReferences = getPreviousReferenceSignatures();

      referenceList.forEach((reference) => {
        const signature = referenceSignature(reference);
        const row = document.createElement("div");
        row.className = "reference-row" + (previousReferences.has(signature) ? "" : " created");

        const main = document.createElement("div");
        main.className = "reference-main";
        main.append(createText("span", "reference-source", reference.sourceLabel || reference.source));
        main.append(createText("span", "reference-arrow", "->"));
        main.append(createText("span", "reference-target", heapLabel(reference.target, snapshot)));
        row.append(main);
        row.append(createText("div", "reference-kind", reference.kind === "heap" ? "campo de objeto" : "variavel"));
        references.append(row);
      });
    }

    function renderVariables(snapshot, variableList) {
      if (variableList.length === 0) {
        appendEmpty(variables, "Sem variaveis.");
        return;
      }

      const previousSnapshot = state.history[state.historyIndex - 1];
      const previousVariables = previousSnapshot ? previousSnapshot.variables || {} : {};

      variableList.forEach((variable) => {
        variables.append(createVariableRow(variable, snapshot, previousVariables));
      });
    }

    function createVariableRow(variable, snapshot, previousVariables) {
      const previous = previousVariables ? previousVariables[variable.name] : undefined;
      const row = document.createElement("div");
      row.className = "variable-row" + changeClass(previous, valueSignature(variable));

      const main = document.createElement("div");
      main.className = "variable-main";
      main.append(createText("span", "variable-name", variable.name));
      main.append(createText("span", "variable-arrow", variable.kind === "reference" ? "->" : "="));
      main.append(createText("span", "variable-value", formatValue(variable, snapshot)));
      row.append(main);
      row.append(createText("div", "variable-meta", variable.scope + " | " + variable.type + changeLabel(previous, valueSignature(variable))));
      return row;
    }

    function createMemberRow(name, value, snapshot, previousObject) {
      const row = document.createElement("div");
      const previousMembers = previousObject ? memberSignatureMap(previousObject) : new Map();
      const previous = previousMembers.get(name);
      row.className = "member-row" + changeClass(previous, valueSignature(value));

      const main = document.createElement("div");
      main.className = "member-main";
      main.append(createText("span", "member-name", name));
      main.append(createText("span", "member-arrow", value.kind === "reference" ? "->" : "="));
      main.append(createText("span", "member-value", formatValue(value, snapshot)));
      row.append(main);
      row.append(createText("div", "member-meta", value.type || "valor"));
      return row;
    }

    function formatValue(value, snapshot) {
      if (!value) {
        return "undefined";
      }

      if (value.kind === "reference" && value.target) {
        return heapLabel(value.target, snapshot);
      }

      return value.repr === undefined ? String(value.value) : value.repr;
    }

    function heapLabel(targetId, snapshot) {
      const object = findHeapObject(snapshot, targetId);
      if (!object) {
        return targetId || "objeto";
      }

      return object.type + " " + object.id;
    }

    function findHeapObject(snapshot, targetId) {
      return (snapshot.heapObjects || []).find((object) => object.id === targetId);
    }

    function getPreviousStackFrames() {
      const previousSnapshot = state.history[state.historyIndex - 1];
      const map = new Map();
      if (!previousSnapshot) {
        return map;
      }

      (previousSnapshot.stackFrames || []).forEach((frame) => {
        map.set(frame.id || frame.name, {
          signature: frameSignature(frame),
          variables: frame.variables || {}
        });
      });
      return map;
    }

    function getPreviousHeapObjects() {
      const previousSnapshot = state.history[state.historyIndex - 1];
      const map = new Map();
      if (!previousSnapshot) {
        return map;
      }

      (previousSnapshot.heapObjects || []).forEach((object) => {
        map.set(object.id, heapSignature(object));
      });
      return map;
    }

    function getPreviousReferenceSignatures() {
      const previousSnapshot = state.history[state.historyIndex - 1];
      const set = new Set();
      if (!previousSnapshot) {
        return set;
      }

      (previousSnapshot.references || []).forEach((reference) => {
        set.add(referenceSignature(reference));
      });
      return set;
    }

    function sortedVariables(variableMap) {
      return Object.values(variableMap || {})
        .sort((left, right) => left.name.localeCompare(right.name));
    }

    function memberSignatureMap(object) {
      const map = new Map();
      (object.fields || []).forEach((field) => map.set(field.name, valueSignature(field.value)));
      (object.items || []).forEach((item) => map.set(item.key ? "[" + formatRawValue(item.key) + "]" : "[" + item.name + "]", valueSignature(item.value)));
      return map;
    }

    function valueSignature(value) {
      if (!value) {
        return "";
      }

      return [value.kind, value.type, value.target || "", value.repr || String(value.value)].join("|");
    }

    function frameSignature(frame) {
      return JSON.stringify({ line: frame.line, variables: frame.variables || {} });
    }

    function heapSignature(object) {
      return JSON.stringify({ repr: object.repr, fields: object.fields || [], items: object.items || [] });
    }

    function referenceSignature(reference) {
      return [reference.kind, reference.sourceLabel || reference.source, reference.target].join("|");
    }

    function formatRawValue(value) {
      if (!value) {
        return "undefined";
      }

      return value.repr === undefined ? String(value.value) : value.repr;
    }

    function changeClass(previous, currentSignature) {
      if (!previous) {
        return " created";
      }

      const previousSignature = typeof previous === "string" ? previous : previous.signature;
      return previousSignature !== currentSignature ? " changed" : "";
    }

    function changeLabel(previous, currentSignature) {
      if (!previous) {
        return " | criada";
      }

      const previousSignature = typeof previous === "string" ? previous : valueSignature(previous);
      return previousSignature !== currentSignature ? " | alterada" : "";
    }

    function createMetric(label, value) {
      const metric = document.createElement("div");
      metric.className = "metric";
      metric.append(createText("span", "", label));
      metric.append(createText("strong", "", value));
      return metric;
    }

    function createText(tagName, className, text) {
      const element = document.createElement(tagName);
      if (className) {
        element.className = className;
      }
      element.textContent = text || "";
      element.title = text || "";
      return element;
    }

    function appendEmpty(parent, text) {
      parent.append(createText("div", "empty-state", text));
    }

    function clear() {
      Array.from(arguments).forEach((element) => {
        element.textContent = "";
      });
    }

    function renderCode() {
      code.textContent = "";
      const fragment = document.createDocumentFragment();

      state.lines.forEach((line, index) => {
        const lineNumber = index + 1;
        const row = document.createElement("div");
        row.className = lineNumber === state.currentLine ? "line current" : "line";

        const pointer = document.createElement("span");
        pointer.className = "execution-pointer";
        pointer.title = lineNumber === state.currentLine ? "Linha atual" : "";

        const gutter = document.createElement("span");
        gutter.className = "line-number";
        gutter.textContent = String(lineNumber);

        const content = document.createElement("span");
        content.className = "line-code";
        content.textContent = line;

        row.append(pointer, gutter, content);
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
      continueButton.disabled = !hasSource || isRunning || !canStepLive;
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