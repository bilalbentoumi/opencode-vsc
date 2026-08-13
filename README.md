<div align="center">

# OpenCode Extension for VS Code

<img alt="OpenCode Terminal logo" src="media/icon.png" width="80" height="80">

AI coding agent for VS Code, powered by OpenCode.

[github.com/bilalbentoumi/opencode-vsc](https://github.com/bilalbentoumi/opencode-vsc)

<p align="center">
<a href="https://github.com/bilalbentoumi/opencode-vsc/releases">
<img src="https://img.shields.io/github/release-date/bilalbentoumi/opencode-vsc?label=Release%20Date&display_date=published_at">
</a>
<a href="https://github.com/bilalbentoumi/opencode-vsc/issues">
<img src="https://img.shields.io/github/issues/bilalbentoumi/opencode-vsc?color=orange" />
</a>
<a href="https://github.com/bilalbentoumi/opencode-vsc/pulls">
<img src="https://img.shields.io/github/issues-pr/bilalbentoumi/opencode-vsc?color=8B5CF6" />
</a>
<a href="https://marketplace.visualstudio.com/items?itemName=bilalbentoumi.opencode-vsc">
<img src="https://img.shields.io/badge/VS%20Code-Marketplace-0078D4?logo=visualstudiocode">
</a>
<a href="https://open-vsx.org/extension/bilalbentoumi/opencode-vsc">
<img src="https://img.shields.io/badge/Open%20VSX-Registry-C8962E?logo=openvsx">
</a>
</p>

</div>

## Overview

OpenCode Terminal embeds **OpenCode's web UI** in a VS Code side panel. It spawns an external `opencode serve` process and loads the official UI at `http://127.0.0.1:<port>/app` in a webview iframe — sharing the exact same binary, config, auth, providers, MCP servers, agents, and rules as the terminal TUI.

No custom terminal emulator, no xterm.js, no node-pty — just OpenCode's own UI.

The `opencode` binary is not bundled: install and authenticate it once, and the extension drives it from inside the editor.

For more information, visit the repository.

<div align="center">
<img alt="OpenCode Terminal screenshot" src="media/screenshot.png" width="100%">
</div>

## Requirements

- [OpenCode CLI](https://opencode.ai) (`opencode` on PATH, or set `opencodeTerminal.command` to a full path).
- VS Code 1.90+.

## Features

- OpenCode in the Activity Bar side panel via a webview iframe.
- Shares the exact same config as the terminal TUI (MCP servers, agents, rules, auth, providers) because it runs the same binary against the same config files.
- Auto-manages the server process: starts it when the panel opens, stops it when the panel closes or the extension deactivates.
- Robust PATH resolution: checks `PATH`, common install locations (`~/.opencode/bin`, Homebrew, `/usr/local`), then falls back to your login shell (`zsh`/`bash`) — works even when VS Code is launched from Finder.
- Busy-port handling: if the configured port is taken, retries on a free port.
- `Restart` button in the panel title bar.

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `opencodeTerminal.command` | `opencode` | Command (or full path) used to launch the OpenCode server. |
| `opencodeTerminal.port` | `0` | Port for the server (`0` = OpenCode's default). If busy, a free port is used. |

## Commands

- `OpenCode Terminal: Focus Side Panel` — open/focus the side panel.
- `OpenCode Terminal: Restart Session` — restart the server and reload the UI (also available as a panel title-bar button).

## Issues

Found a bug or have a feature request? Please open an issue on GitHub.

## License

OpenCode Terminal is released under the MIT License. It embeds the MIT-licensed OpenCode web UI through its documented `serve` interface.
