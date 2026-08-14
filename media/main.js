(function () {
	const vscode = acquireVsCodeApi();

	const frame = document.getElementById("frame");
	const status = document.getElementById("status");

	// Origin of the OpenCode page, so the bridge handshake is never sent to "*".
	let frameOrigin = null;

	function setStatus(text) {
		status.textContent = text;
		status.style.display = text ? "flex" : "none";
	}

	function postToFrame(message) {
		if (frameOrigin && frame.contentWindow) {
			frame.contentWindow.postMessage(message, frameOrigin);
		}
	}

	// The bridge cannot know this origin on its own, so we greet it first.
	frame.addEventListener("load", () => {
		postToFrame({ __opencodeVsc: "hello" });
	});

	window.addEventListener("message", (event) => {
		const message = event.data;
		if (!message || typeof message !== "object") {
			return;
		}

		if (frame.contentWindow && event.source === frame.contentWindow) {
			if (event.origin !== frameOrigin) {
				return;
			}
			if (message.__opencodeVsc === "request") {
				vscode.postMessage({
					type: "bridge-request",
					id: message.id,
					kind: message.kind,
					payload: message.payload,
				});
			}
			return;
		}

		switch (message.type) {
			case "url":
				frameOrigin = new URL(message.url).origin;
				frame.src = message.url;
				setStatus("");
				break;
			case "status":
				setStatus(message.message ?? "");
				break;
			case "error":
				setStatus(message.message ?? "Unknown error");
				break;
			case "bridge-response":
				postToFrame({
					__opencodeVsc: "response",
					id: message.id,
					result: message.result,
					error: message.error,
				});
				break;
			case "bridge-command":
				postToFrame({
					__opencodeVsc: "command",
					command: message.command,
				});
				break;
		}
	});

	vscode.postMessage({ type: "load" });
})();
