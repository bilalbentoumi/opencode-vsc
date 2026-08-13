(function () {
	const vscode = acquireVsCodeApi();

	const frame = document.getElementById("frame");
	const status = document.getElementById("status");

	function setStatus(text) {
		status.textContent = text;
		status.style.display = text ? "flex" : "none";
	}

	window.addEventListener("message", (event) => {
		const message = event.data;
		switch (message.type) {
			case "url":
				frame.src = message.url;
				setStatus("");
				break;
			case "status":
				setStatus(message.message ?? "");
				break;
			case "error":
				setStatus(message.message ?? "Unknown error");
				break;
		}
	});

	vscode.postMessage({ type: "load" });
})();
