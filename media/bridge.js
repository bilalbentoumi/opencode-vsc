// Injected into the OpenCode page by the extension's proxy. VS Code grants
// clipboard permissions only to vscode-webview:// origins, so navigator.clipboard
// is routed through the webview to the extension host, and the context menu and
// the shortcuts VS Code swallows (select all, undo, redo) are recreated here.
(function () {
	"use strict";

	if (window.__opencodeVscBridge || window.parent === window) {
		return;
	}
	window.__opencodeVscBridge = true;

	const REQUEST_TIMEOUT = 5000;

	let parentOrigin = null;
	let outbox = [];
	const pending = new Map();
	let nextId = 0;

	function post(message) {
		if (parentOrigin === null) {
			outbox.push(message);
			return;
		}
		window.parent.postMessage(message, parentOrigin);
	}

	function request(kind, payload) {
		return new Promise((resolve, reject) => {
			const id = ++nextId;
			pending.set(id, { resolve, reject });
			post({ __opencodeVsc: "request", id, kind, payload });
			setTimeout(() => {
				if (pending.delete(id)) {
					reject(new Error("OpenCode clipboard bridge timed out"));
				}
			}, REQUEST_TIMEOUT);
		});
	}

	window.addEventListener("message", (event) => {
		if (event.source !== window.parent) {
			return;
		}
		const data = event.data;
		if (!data || typeof data !== "object") {
			return;
		}

		// The webview greets us first because only it knows both origins.
		if (data.__opencodeVsc === "hello") {
			parentOrigin = event.origin;
			const queued = outbox;
			outbox = [];
			for (const message of queued) {
				window.parent.postMessage(message, parentOrigin);
			}
			return;
		}

		if (event.origin !== parentOrigin) {
			return;
		}
		if (data.__opencodeVsc === "response") {
			const entry = pending.get(data.id);
			if (!entry) {
				return;
			}
			pending.delete(data.id);
			if (data.error) {
				entry.reject(new Error(data.error));
			} else {
				entry.resolve(data.result);
			}
		} else if (data.__opencodeVsc === "command") {
			runCommand(data.command);
		}
	});

	// --- clipboard -----------------------------------------------------------

	const clipboard = {
		writeText: (text) => request("clipboard.write", { text: String(text) }),
		readText: () => request("clipboard.read").then((text) => text ?? ""),
		write: (items) =>
			Promise.all(
				Array.from(items ?? []).map((item) => {
					if (!item || typeof item.getType !== "function") {
						return "";
					}
					if (!Array.from(item.types ?? []).includes("text/plain")) {
						return "";
					}
					return item.getType("text/plain").then((blob) => blob.text());
				}),
			).then((texts) => clipboard.writeText(texts.filter(Boolean).join("\n"))),
		read: () =>
			clipboard.readText().then((text) => {
				if (typeof ClipboardItem === "undefined") {
					return [];
				}
				return [
					new ClipboardItem({
						"text/plain": new Blob([text], { type: "text/plain" }),
					}),
				];
			}),
		addEventListener: () => {},
		removeEventListener: () => {},
		dispatchEvent: () => false,
	};

	try {
		Object.defineProperty(navigator, "clipboard", {
			value: clipboard,
			configurable: true,
		});
	} catch {
		// Leave the (non-functional) native clipboard in place.
	}

	// --- editing helpers -----------------------------------------------------

	function isTextInput(element) {
		if (!element) {
			return false;
		}
		if (element.tagName === "TEXTAREA") {
			return true;
		}
		return (
			element.tagName === "INPUT" &&
			/^(text|search|url|tel|password|email|number)$/i.test(
				element.type || "text",
			)
		);
	}

	function closestEditable(node) {
		let element = node instanceof Element ? node : node?.parentElement;
		while (element) {
			if (isTextInput(element) || element.isContentEditable) {
				return element;
			}
			element = element.parentElement;
		}
		return null;
	}

	function focusEditable(editable) {
		if (editable && document.activeElement !== editable) {
			editable.focus({ preventScroll: true });
		}
	}

	function selectionText(editable) {
		if (isTextInput(editable)) {
			const start = editable.selectionStart ?? 0;
			const end = editable.selectionEnd ?? 0;
			return start === end ? "" : editable.value.slice(start, end);
		}
		const selection = window.getSelection();
		return selection ? selection.toString() : "";
	}

	function setNativeValue(element, value) {
		const prototype =
			element instanceof HTMLTextAreaElement
				? HTMLTextAreaElement.prototype
				: HTMLInputElement.prototype;
		const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
		if (setter) {
			setter.call(element, value);
		} else {
			element.value = value;
		}
		element.dispatchEvent(new Event("input", { bubbles: true }));
	}

	function insertText(editable, text) {
		focusEditable(editable);
		// execCommand fires the input events frameworks listen for.
		if (document.execCommand("insertText", false, text)) {
			return;
		}
		if (!isTextInput(editable)) {
			return;
		}
		const start = editable.selectionStart ?? editable.value.length;
		const end = editable.selectionEnd ?? start;
		setNativeValue(
			editable,
			editable.value.slice(0, start) + text + editable.value.slice(end),
		);
		const caret = start + text.length;
		editable.setSelectionRange(caret, caret);
	}

	function deleteSelection(editable) {
		focusEditable(editable);
		if (document.execCommand("delete")) {
			return;
		}
		if (!isTextInput(editable)) {
			return;
		}
		const start = editable.selectionStart ?? 0;
		const end = editable.selectionEnd ?? start;
		if (start === end) {
			return;
		}
		setNativeValue(
			editable,
			editable.value.slice(0, start) + editable.value.slice(end),
		);
		editable.setSelectionRange(start, start);
	}

	function selectAll(editable) {
		if (isTextInput(editable)) {
			focusEditable(editable);
			editable.setSelectionRange(0, editable.value.length);
			return;
		}
		focusEditable(editable);
		document.execCommand("selectAll");
	}

	function copy(editable, text) {
		return text ? clipboard.writeText(text) : Promise.resolve();
	}

	function cut(editable, text) {
		if (!text) {
			return Promise.resolve();
		}
		return clipboard.writeText(text).then(() => deleteSelection(editable));
	}

	function paste(editable) {
		focusEditable(editable);
		return clipboard.readText().then((text) => {
			if (text) {
				insertText(editable, text);
			}
		});
	}

	function runCommand(command) {
		const editable = closestEditable(document.activeElement);
		switch (command) {
			case "selectAll":
				selectAll(editable);
				break;
			case "copy":
				void copy(editable, selectionText(editable));
				break;
			case "cut":
				void cut(editable, selectionText(editable));
				break;
			case "paste":
				void paste(editable);
				break;
			case "undo":
				focusEditable(editable);
				document.execCommand("undo");
				break;
			case "redo":
				focusEditable(editable);
				document.execCommand("redo");
				break;
		}
	}

	// --- keyboard ------------------------------------------------------------

	// Set when the browser handled a shortcut itself, which it still does on
	// Windows and Linux. macOS routes cmd+c/x/v through its Edit menu and never
	// delivers the key here, so only ctrl+* arrives and nothing acts on it.
	let handledNatively = false;
	for (const type of ["copy", "cut", "paste"]) {
		document.addEventListener(
			type,
			() => {
				handledNatively = true;
			},
			true,
		);
	}

	// Never calls preventDefault: the fallback runs a tick later, and only if
	// the browser's own handling produced nothing.
	function onKeydown(event) {
		if (event.defaultPrevented || event.altKey || event.shiftKey) {
			return;
		}
		if (!event.ctrlKey && !event.metaKey) {
			return;
		}

		const key = event.key.toLowerCase();
		if (!["c", "x", "v", "a"].includes(key)) {
			return;
		}

		const editable = closestEditable(document.activeElement);
		const selected = selectionText(editable);
		handledNatively = false;

		setTimeout(() => {
			// Select all is idempotent, so it needs no such guard.
			if (handledNatively && key !== "a") {
				return;
			}
			switch (key) {
				case "c":
					void copy(editable, selected);
					break;
				case "x":
					if (editable) {
						void cut(editable, selected);
					}
					break;
				case "v":
					if (editable) {
						void paste(editable);
					}
					break;
				case "a":
					selectAll(editable);
					break;
			}
		}, 0);
	}

	// Registered after load so OpenCode's own window-level handlers, which are
	// bound while the bundle runs, still get first refusal.
	function listenForKeys() {
		window.addEventListener("keydown", onKeydown);
	}
	if (document.readyState === "complete") {
		listenForKeys();
	} else {
		window.addEventListener("load", listenForKeys, { once: true });
	}

	// --- context menu --------------------------------------------------------

	// Built as OpenCode's own menu-v2 component, so the app's stylesheet supplies
	// the chrome: [data-component="menu-v2-content"] for the surface and
	// [data-component="menu-v2-item"] with the item-content / item-shortcut slots
	// for the rows, including the data-highlighted and data-disabled states.
	const MENU_ATTR = "data-opencode-vsc-menu";
	const SEPARATOR_ATTR = "data-opencode-vsc-menu-separator";
	const IS_MAC = /mac|iphone|ipad/i.test(
		navigator.userAgentData?.platform || navigator.platform || navigator.userAgent,
	);
	// Escaped so the glyph survives however the file is served or decoded.
	const MOD = IS_MAC ? "\u2318" : "Ctrl+";

	let closeMenu = () => {};

	function installMenuStyles() {
		if (document.getElementById(`${MENU_ATTR}-styles`)) {
			return;
		}
		const style = document.createElement("style");
		style.id = `${MENU_ATTR}-styles`;
		// The first block is what the component cannot know: where the menu sits.
		// It matches the component's own specificity and is appended later, so it
		// wins. The :where() block has zero specificity and only takes effect if
		// the app's menu-v2 styles are ever absent.
		style.textContent = `
[${MENU_ATTR}] {
	position: fixed;
	z-index: 2147483000;
	max-height: calc(100vh - 16px);
	overflow-y: auto;
	overflow-x: hidden;
}

[${SEPARATOR_ATTR}] {
	flex: none;
	height: 1px;
	margin: 3px -2px;
	background: var(--v2-border-border-muted, light-dark(#00000014, #ffffff1f));
}

:where([${MENU_ATTR}]) {
	box-sizing: border-box;
	display: flex;
	flex-direction: column;
	align-items: stretch;
	min-width: 160px;
	padding: 2px;
	border-radius: 6px;
	background: var(--v2-background-bg-layer-01, light-dark(#ffffff, #1b1b1b));
	box-shadow: var(--v2-elevation-floating, 0 8px 16px #0000001f, 0 4px 8px #00000014);
	color: var(--v2-text-text-base, light-dark(#1a1a1a, #ededed));
	outline: none;
	animation: ${MENU_ATTR}-in 0.12s ease-out;
}

:where([${MENU_ATTR}] [data-component="menu-v2-item"]) {
	box-sizing: border-box;
	display: flex;
	align-items: center;
	gap: 8px;
	height: 28px;
	padding: 0 12px;
	border-radius: 4px;
	cursor: default;
	user-select: none;
}

:where([${MENU_ATTR}] [data-slot="menu-v2-item-content"]) {
	display: flex;
	flex: 1 1 auto;
	align-items: center;
	min-width: 0;
	font-size: 13px;
}

:where([${MENU_ATTR}] [data-slot="menu-v2-item-shortcut"]) {
	flex: none;
	font-size: 11px;
	color: var(--v2-text-text-faint, light-dark(#9b9b9b, #6b6b6b));
}

:where([${MENU_ATTR}] [data-component="menu-v2-item"][data-highlighted]) {
	background: var(--v2-overlay-simple-overlay-hover, light-dark(#0000000f, #ffffff17));
}

:where([${MENU_ATTR}] [data-component="menu-v2-item"][data-disabled]) {
	pointer-events: none;
	opacity: 0.5;
}

[${MENU_ATTR}] [${MENU_ATTR}-label] {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	line-height: 1.25rem;
}

@keyframes ${MENU_ATTR}-in {
	from { opacity: 0; transform: scale(0.96); }
	to { opacity: 1; transform: scale(1); }
}

@media (prefers-reduced-motion: reduce) {
	[${MENU_ATTR}] { animation: none; }
}
`;
		document.head.appendChild(style);
	}

	window.addEventListener("contextmenu", (event) => {
		// Let the app keep any context menu of its own.
		if (event.defaultPrevented) {
			return;
		}
		event.preventDefault();
		const target = event.composedPath?.()[0] ?? event.target;
		if (target instanceof Element && target.closest(`[${MENU_ATTR}]`)) {
			return;
		}
		openMenu(event, target);
	});

	function openMenu(event, target) {
		closeMenu();

		const editable = closestEditable(target);
		const selected = selectionText(editable);
		const link = target instanceof Element ? target.closest("a[href]") : null;

		const edits = [];
		if (editable) {
			edits.push({
				label: "Cut",
				shortcut: `${MOD}X`,
				enabled: Boolean(selected),
				run: () => cut(editable, selected),
			});
		}
		edits.push({
			label: "Copy",
			shortcut: `${MOD}C`,
			enabled: Boolean(selected),
			run: () => copy(editable, selected),
		});
		if (editable) {
			edits.push({
				label: "Paste",
				shortcut: `${MOD}V`,
				enabled: true,
				run: () => paste(editable),
			});
		}

		const groups = [edits];
		if (link) {
			groups.push([
				{
					label: "Copy Link",
					enabled: true,
					run: () => clipboard.writeText(link.href),
				},
			]);
		}
		groups.push([
			{
				label: "Select All",
				shortcut: `${MOD}A`,
				enabled: true,
				run: () => selectAll(editable),
			},
		]);

		renderMenu(groups, event.clientX, event.clientY);
	}

	function buildItem(item) {
		const row = document.createElement("div");
		row.dataset.component = "menu-v2-item";
		row.setAttribute("role", "menuitem");
		row.tabIndex = -1;

		const content = document.createElement("span");
		content.setAttribute("data-slot", "menu-v2-item-content");

		const label = document.createElement("span");
		label.setAttribute(`${MENU_ATTR}-label`, "");
		label.textContent = item.label;
		content.appendChild(label);
		row.appendChild(content);

		if (item.shortcut) {
			const shortcut = document.createElement("span");
			shortcut.setAttribute("data-slot", "menu-v2-item-shortcut");
			shortcut.textContent = item.shortcut;
			row.appendChild(shortcut);
		}

		if (!item.enabled) {
			row.setAttribute("data-disabled", "");
			row.setAttribute("aria-disabled", "true");
		}
		return row;
	}

	function renderMenu(groups, x, y) {
		installMenuStyles();

		const restoreFocusTo = document.activeElement;
		const menu = document.createElement("div");
		menu.dataset.component = "menu-v2-content";
		menu.setAttribute(MENU_ATTR, "");
		menu.setAttribute("role", "menu");
		menu.tabIndex = -1;
		menu.style.left = `${x}px`;
		menu.style.top = `${y}px`;

		// Keeps the click from collapsing the selection being acted on.
		menu.addEventListener("mousedown", (event) => event.preventDefault());

		const rows = [];
		let active = -1;

		const setActive = (next) => {
			if (active === next) {
				return;
			}
			if (rows[active]) {
				delete rows[active].row.dataset.highlighted;
			}
			active = next;
			if (rows[active]) {
				rows[active].row.dataset.highlighted = "";
				rows[active].row.scrollIntoView({ block: "nearest" });
			}
		};

		const activate = (index) => {
			const entry = rows[index];
			if (!entry) {
				return;
			}
			closeMenu();
			void entry.item.run();
		};

		groups.forEach((group, groupIndex) => {
			if (groupIndex > 0) {
				const separator = document.createElement("div");
				separator.setAttribute(SEPARATOR_ATTR, "");
				separator.setAttribute("role", "separator");
				menu.appendChild(separator);
			}
			for (const item of group) {
				const row = buildItem(item);
				if (item.enabled) {
					const index = rows.length;
					rows.push({ row, item });
					row.addEventListener("mousemove", () => setActive(index));
					row.addEventListener("click", () => activate(index));
				}
				menu.appendChild(row);
			}
		});

		document.body.appendChild(menu);
		menu.focus({ preventScroll: true });

		// Flip rather than clamp, so the cursor never lands on top of the menu.
		const margin = 8;
		const rect = menu.getBoundingClientRect();
		const flipLeft = x + rect.width > window.innerWidth - margin;
		const flipUp = y + rect.height > window.innerHeight - margin;
		menu.style.left = `${Math.max(margin, flipLeft ? x - rect.width : x)}px`;
		menu.style.top = `${Math.max(margin, flipUp ? y - rect.height : y)}px`;
		// The component animates from this origin.
		menu.style.setProperty(
			"--kb-menu-content-transform-origin",
			`${flipUp ? "bottom" : "top"} ${flipLeft ? "right" : "left"}`,
		);

		const dismiss = (event) => {
			if (event?.type === "mousedown" && menu.contains(event.target)) {
				return;
			}
			closeMenu();
		};

		const onMenuKeydown = (event) => {
			const step =
				event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
			if (step !== 0) {
				if (rows.length) {
					const from = active === -1 ? (step > 0 ? -1 : 0) : active;
					setActive((from + step + rows.length) % rows.length);
				}
			} else if (event.key === "Home") {
				setActive(0);
			} else if (event.key === "End") {
				setActive(rows.length - 1);
			} else if (event.key === "Enter" || event.key === " ") {
				activate(active);
			} else if (event.key === "Escape" || event.key === "Tab") {
				closeMenu();
			} else {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
		};

		document.addEventListener("mousedown", dismiss, true);
		document.addEventListener("scroll", dismiss, true);
		window.addEventListener("blur", dismiss);
		window.addEventListener("resize", dismiss);
		menu.addEventListener("keydown", onMenuKeydown);

		closeMenu = () => {
			closeMenu = () => {};
			menu.remove();
			document.removeEventListener("mousedown", dismiss, true);
			document.removeEventListener("scroll", dismiss, true);
			window.removeEventListener("blur", dismiss);
			window.removeEventListener("resize", dismiss);
			if (restoreFocusTo?.isConnected && restoreFocusTo.focus) {
				restoreFocusTo.focus({ preventScroll: true });
			}
		};
	}
})();
