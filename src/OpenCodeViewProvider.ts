import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "child_process";
import * as vscode from "vscode";
import { startInjectingProxy, type InjectingProxy } from "./proxy";

interface ViewMessage {
  type: string;
  [key: string]: unknown;
}

const MAX_RETRIES = 3;

export class OpenCodeViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "opencode-vsc-view";

  private view?: vscode.WebviewView;
  private server?: ChildProcessWithoutNullStreams;
  private serverUrl?: string;
  private proxy?: InjectingProxy;
  private appUrl?: string;
  private serverId = 0;
  private retryAttempts = 0;

  constructor(private readonly extensionUri: vscode.Uri) {}

  dispose(): void {
    this.stopServer();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message: ViewMessage) => {
      if (message.type === "load") {
        this.retryAttempts = 0;
        if (this.appUrl) {
          this.post({ type: "url", url: this.appUrl });
          return;
        }
        this.startServer();
      } else if (message.type === "bridge-request") {
        void this.handleBridgeRequest(message);
      }
    });

    webviewView.onDidDispose(() => this.stopServer());
  }

  restart(): void {
    if (!this.view) {
      void vscode.commands.executeCommand(
        `${OpenCodeViewProvider.viewType}.focus`,
      );
      return;
    }
    this.serverId++;
    this.stopServer();
    this.retryAttempts = 0;
    this.post({ type: "status", message: "Restarting opencode server…" });
    this.startServer();
  }

  private startServer(port?: number): void {
    if (this.server) {
      return;
    }
    const id = ++this.serverId;
    const command = resolveCommand(
      vscode.workspace
        .getConfiguration("opencode-vsc")
        .get<string>("command", "opencode"),
    );
    const requestedPort =
      port ??
      vscode.workspace.getConfiguration("opencode-vsc").get<number>("port", 0);
    const cwd =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, ["serve", "--port", String(requestedPort)], {
        cwd,
        env: { ...process.env },
      });
    } catch (err) {
      this.post({
        type: "error",
        message: `Failed to launch "${command}". Is the OpenCode CLI installed? Set "opencode-vsc.command" to the full path if needed. (${(err as Error).message})`,
      });
      return;
    }

    this.server = child;
    this.post({ type: "status", message: "Starting opencode server…" });

    let buffer = "";
    const onChunk = (chunk: Buffer | string): void => {
      buffer += chunk.toString();
      const match = buffer.match(/listening on (http:\/\/[\w.:[\]-]+)/);
      if (match && !this.serverUrl) {
        this.serverUrl = match[1];
        void this.publishAppUrl(id, match[1]);
      }
    };
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);

    child.on("exit", (code) => {
      if (this.server !== child) {
        return;
      }
      const hadUrl = Boolean(this.serverUrl);
      this.server = undefined;
      this.serverUrl = undefined;
      this.proxy?.dispose();
      this.proxy = undefined;
      this.appUrl = undefined;
      if (id !== this.serverId) {
        return;
      }
      if (!hadUrl && code !== 0 && this.retryAttempts < MAX_RETRIES) {
        this.retryAttempts++;
        this.post({
          type: "status",
          message: "Port busy — retrying on a free port…",
        });
        void findFreePort().then((freePort) => {
          if (id === this.serverId) {
            this.startServer(freePort);
          }
        });
      } else if (!hadUrl) {
        this.post({
          type: "error",
          message: `Failed to start the opencode server (exit code ${code ?? "unknown"}). Check the binary and that the port is free, then use the Restart button.`,
        });
      } else {
        this.post({
          type: "error",
          message: `OpenCode server stopped (exit code ${code ?? "unknown"}). Use the Restart button to relaunch.`,
        });
      }
    });
  }

  private stopServer(): void {
    this.proxy?.dispose();
    this.proxy = undefined;
    this.appUrl = undefined;
    if (this.server) {
      const child = this.server;
      this.server = undefined;
      this.serverUrl = undefined;
      child.kill();
    }
  }

  /**
   * The UI is served through a local proxy that injects media/bridge.js, which
   * restores the clipboard, the context menu and the shortcuts VS Code cannot
   * deliver to a cross-origin iframe.
   */
  private async publishAppUrl(id: number, serverUrl: string): Promise<void> {
    const bridgeScript = vscode.Uri.joinPath(
      this.extensionUri,
      "media",
      "bridge.js",
    ).fsPath;

    try {
      const proxy = await startInjectingProxy(serverUrl, bridgeScript);
      if (id !== this.serverId) {
        proxy.dispose();
        return;
      }
      this.proxy?.dispose();
      this.proxy = proxy;
      this.appUrl = `${proxy.origin}/app`;
    } catch {
      // Still usable without the proxy, minus clipboard and context menu.
      if (id !== this.serverId) {
        return;
      }
      this.appUrl = `${serverUrl}/app`;
    }
    this.post({ type: "url", url: this.appUrl });
  }

  /** Runs an editing command inside the OpenCode page via the bridge. */
  runBridgeCommand(command: string): void {
    this.post({ type: "bridge-command", command });
  }

  private async handleBridgeRequest(message: ViewMessage): Promise<void> {
    const id = message.id;
    try {
      let result: unknown;
      switch (message.kind) {
        case "clipboard.read":
          result = await vscode.env.clipboard.readText();
          break;
        case "clipboard.write": {
          const payload = message.payload as { text?: string } | undefined;
          await vscode.env.clipboard.writeText(payload?.text ?? "");
          result = true;
          break;
        }
        default:
          throw new Error(`Unknown bridge request "${String(message.kind)}"`);
      }
      this.post({ type: "bridge-response", id, result });
    } catch (err) {
      this.post({
        type: "bridge-response",
        id,
        error: (err as Error).message,
      });
    }
  }

  private post(message: ViewMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "main.js"),
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; frame-src http://127.0.0.1:* http://localhost:* http://[::1]:*;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; }
    body { position: relative; background: #1e1e1e; }
    #frame { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
    #status {
      position: absolute; inset: 0;
      display: flex; align-items: center; justify-content: center;
      color: #9d9d9d; font-family: Menlo, Monaco, monospace; font-size: 12px;
      text-align: center; padding: 16px; box-sizing: border-box;
      pointer-events: none; white-space: pre-wrap;
    }
  </style>
  <title>OpenCode</title>
</head>
<body>
  <iframe id="frame" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads" allow="clipboard-read; clipboard-write"></iframe>
  <div id="status"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on("error", () => resolve(0));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

let cachedBinary: string | undefined;

function resolveCommand(configured: string): string {
  if (cachedBinary) {
    return cachedBinary;
  }
  if (configured.includes("/")) {
    cachedBinary = configured;
    return configured;
  }
  const onPath = findOnPath(configured);
  if (onPath) {
    cachedBinary = onPath;
    return onPath;
  }
  const inCommonLocations = findInCommonLocations();
  if (inCommonLocations) {
    cachedBinary = inCommonLocations;
    return inCommonLocations;
  }
  const viaLoginShell = findViaLoginShell(configured);
  if (viaLoginShell) {
    cachedBinary = viaLoginShell;
    return viaLoginShell;
  }
  return configured;
}

function findOnPath(command: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, command);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function findInCommonLocations(): string | undefined {
  const candidates = [
    path.join(os.homedir(), ".opencode", "bin", "opencode"),
    "/opt/homebrew/bin/opencode",
    "/usr/local/bin/opencode",
    "/usr/bin/opencode",
  ];
  for (const candidate of candidates) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function findViaLoginShell(command: string): string | undefined {
  for (const shell of ["/bin/zsh", "/bin/bash"]) {
    try {
      const output = execFileSync(
        shell,
        ["-lic", `command -v ${command} 2>/dev/null`],
        {
          encoding: "utf8",
          timeout: 5000,
          windowsHide: true,
        },
      );
      for (const line of output.trim().split("\n")) {
        const candidate = line.trim();
        if (
          candidate &&
          path.isAbsolute(candidate) &&
          isExecutable(candidate)
        ) {
          return candidate;
        }
      }
    } catch {
      // Try the next shell.
    }
  }
  return undefined;
}

function isExecutable(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
