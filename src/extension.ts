import * as vscode from "vscode";
import { OpenCodeViewProvider } from "./OpenCodeViewProvider";

export function activate(context: vscode.ExtensionContext): void {
	const provider = new OpenCodeViewProvider(context.extensionUri);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(OpenCodeViewProvider.viewType, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
		vscode.commands.registerCommand("opencode-terminal.focus", () => {
			void vscode.commands.executeCommand(`${OpenCodeViewProvider.viewType}.focus`);
		}),
		vscode.commands.registerCommand("opencode-terminal.restart", () => provider.restart()),
		provider,
	);
}

export function deactivate(): void {}
