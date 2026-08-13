# OpenCode Terminal (VS Code extension)

Embeds **OpenCode's web UI** in a VS Code **side panel**. The extension spawns `opencode serve` (same binary, same `opencode.json` / global config, same auth, providers, MCP servers, agents, and rules as the TUI) and loads the official UI at `http://127.0.0.1:<port>/app` in a webview iframe.

No custom terminal emulator, no xterm.js, no node-pty — just OpenCode's own UI.

## Features

- OpenCode in the Activity Bar side panel via a webview iframe.
- Shares the exact same config as the terminal TUI (MCP servers, agents, rules, auth, providers) because it runs the same binary against the same config files.
- Auto-manages the server process: starts it when the panel opens, stops it when the panel closes or the extension deactivates.
- Robust PATH resolution: checks `PATH`, common install locations (`~/.opencode/bin`, Homebrew, `/usr/local`), then falls back to your login shell (`zsh`/`bash`) — works even when VS Code is launched from Finder.
- Busy-port handling: if the configured port is taken, retries on a free port.
- `Restart` button in the panel title bar.

## Requirements

- [OpenCode CLI](https://opencode.ai) (`opencode` on PATH, or set `opencodeTerminal.command` to a full path).
- VS Code 1.90+.

## Getting started

```bash
npm install
npm run build
```

Then press `F5` in VS Code to launch the Extension Development Host. Click the **OpenCode** icon in the Activity Bar.

To rebuild on save during development:

```bash
npm run watch
```

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `opencodeTerminal.command` | `opencode` | Command (or full path) used to launch the OpenCode server. |
| `opencodeTerminal.port` | `0` | Port for the server (`0` = OpenCode's default). If busy, a free port is used. |

## Commands

- `OpenCode Terminal: Focus Side Panel` — open/focus the side panel.
- `OpenCode Terminal: Restart Session` — restart the server and reload the UI (also available as a panel title-bar button).

## How it works

```
┌─────────────────────────────────────────────────────────┐
│ Extension Host            Webview (side panel)          │
│  spawn("opencode serve") ──stdout──► parse "listening"  │
│  ──── "http://127.0.0.1:PORT" ──postMessage──► iframe  │
│                        └──► https://…/app  (web UI)     │
└─────────────────────────────────────────────────────────┘
```

- `src/extension.ts` — activation, commands.
- `src/OpenCodeViewProvider.ts` — spawns/stops the server, parses the listening URL, falls back to a free port on collision, resolves the binary via login shell if needed.
- `media/main.js` — tiny webview script that sets the iframe `src` from the URL message.

Build output is `out/extension.js` (bundled with esbuild).

## Notes

- The server listens on `127.0.0.1` only and is unsecured (no `OPENCODE_SERVER_PASSWORD`), same as a locally-run `opencode web`. Set `OPENCODE_SERVER_PASSWORD` in your environment if you want a password.
- If the server fails to launch, check the status bar in the panel and set `opencodeTerminal.command` to the full path of the `opencode` binary.
- To package a `.vsix`: `npx @vscode/vsce package`.
