const path = require("path");
const vscode = require("vscode");
const { PythonAdapter } = require("./adapters/pythonAdapter");
const { MemoryVisualizerPanel } = require("./panel/memoryPanel");

function activate(context) {
  const outputChannel = vscode.window.createOutputChannel("Code Memory");
  const adapters = [
    new PythonAdapter(context.extensionUri, outputChannel)
  ];

  const startCommand = vscode.commands.registerCommand("codeMemory.start", async (uri) => {
    try {
      const document = await resolveDocument(uri, adapters);

      if (!document) {
        return;
      }

      const adapter = selectAdapter(adapters, document);

      if (!adapter) {
        vscode.window.showWarningMessage("Code Memory currently supports Python files only.");
        return;
      }

      await vscode.window.showTextDocument(document, {
        preview: false,
        viewColumn: vscode.ViewColumn.One
      });

      const panel = MemoryVisualizerPanel.createOrShow(context.extensionUri);
      panel.loadDocument(document, adapter);
    } catch (error) {
      vscode.window.showErrorMessage(`Code Memory could not start: ${error.message}`);
    }
  });

  context.subscriptions.push(startCommand, outputChannel);
}

function deactivate() {
  MemoryVisualizerPanel.disposeCurrent();
}

async function resolveDocument(uri, adapters) {
  if (uri && uri.scheme === "file") {
    return vscode.workspace.openTextDocument(uri);
  }

  const activeDocument = vscode.window.activeTextEditor?.document;

  if (activeDocument && activeDocument.uri.scheme === "file" && selectAdapter(adapters, activeDocument)) {
    return activeDocument;
  }

  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    openLabel: "Open Python file",
    filters: {
      Python: ["py"],
      "All files": ["*"]
    }
  });

  if (!selected || selected.length === 0) {
    return undefined;
  }

  return vscode.workspace.openTextDocument(selected[0]);
}

function selectAdapter(adapters, document) {
  return adapters.find((adapter) => adapter.canHandle(document));
}

module.exports = {
  activate,
  deactivate,
  selectAdapter,
  resolveDocument
};

