import * as vscode from "vscode";
import { OpenCodeViewProvider } from "./OpenCodeViewProvider";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new OpenCodeViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      OpenCodeViewProvider.viewType,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
      },
    ),
    vscode.commands.registerCommand("opencode-vsc.focus", () => {
      void vscode.commands.executeCommand(
        `${OpenCodeViewProvider.viewType}.focus`,
      );
    }),
    vscode.commands.registerCommand("opencode-vsc.restart", () =>
      provider.restart(),
    ),
    // VS Code's Edit menu swallows these shortcuts and applies them to the
    // webview document instead of the OpenCode page, so route them ourselves.
    ...["selectAll", "undo", "redo"].map((command) =>
      vscode.commands.registerCommand(`opencode-vsc.${command}`, () =>
        provider.runBridgeCommand(command),
      ),
    ),
    provider,
  );
}

export function deactivate(): void {}
