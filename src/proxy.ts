import * as fs from "fs";
import * as http from "http";
import type { Duplex } from "stream";
import type { Socket } from "net";

/**
 * The OpenCode UI runs in an iframe whose origin (http://127.0.0.1:PORT) is not
 * the webview origin (vscode-webview://...). VS Code denies every permission to
 * such origins, so `navigator.clipboard` throws, and neither VS Code nor the
 * page can see the other's keyboard/context-menu events. Nothing can be
 * injected into a cross-origin document from the outside, so we proxy the
 * OpenCode server and add a bridge script to the HTML it serves.
 */
export const BRIDGE_PATH = "/__opencode-vsc/bridge.js";

const SCRIPT_TAG = `<script src="${BRIDGE_PATH}"></script>`;

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

interface Upstream {
  host: string;
  port: number;
}

export interface InjectingProxy {
  readonly origin: string;
  dispose(): void;
}

export function startInjectingProxy(
  targetUrl: string,
  bridgeScriptPath: string,
): Promise<InjectingProxy> {
  const target = new URL(targetUrl);
  const upstream: Upstream = {
    host: target.hostname,
    port: Number(target.port) || 80,
  };
  const sockets = new Set<Duplex>();

  const server = http.createServer((req, res) => {
    if ((req.url ?? "").split("?")[0] === BRIDGE_PATH) {
      serveBridge(bridgeScriptPath, res);
    } else {
      forward(req, res, upstream);
    }
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (req, socket, head) =>
    forwardUpgrade(req, socket, head, upstream),
  );
  server.on("clientError", (_err, socket) => socket.destroy());

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      server.on("error", () => {
        /* keep a late socket error from taking down the extension host */
      });
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        dispose: () => {
          server.close();
          // Event-stream requests stay open forever; close() alone would hang.
          for (const socket of sockets) {
            socket.destroy();
          }
          sockets.clear();
        },
      });
    });
  });
}

function forward(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  upstream: Upstream,
): void {
  const headers: http.OutgoingHttpHeaders = { ...req.headers };
  // Identity encoding keeps HTML injectable; everything here is loopback.
  headers["accept-encoding"] = "identity";
  headers.host = `${upstream.host}:${upstream.port}`;

  const proxied = http.request(
    {
      host: upstream.host,
      port: upstream.port,
      path: req.url,
      method: req.method,
      headers,
    },
    (upstreamRes) => {
      const status = upstreamRes.statusCode ?? 502;
      const encoding = String(upstreamRes.headers["content-encoding"] ?? "");
      const isHtml = String(upstreamRes.headers["content-type"] ?? "").includes(
        "text/html",
      );
      // Anything else (HEAD, 304, compressed) has no body to inject into.
      const injectable =
        isHtml &&
        status === 200 &&
        req.method === "GET" &&
        (!encoding || encoding === "identity");

      if (!injectable) {
        res.writeHead(status, forwardableHeaders(upstreamRes.headers));
        res.flushHeaders();
        res.socket?.setNoDelay(true);
        upstreamRes.pipe(res);
        return;
      }

      const chunks: Buffer[] = [];
      upstreamRes.on("data", (chunk: Buffer) => chunks.push(chunk));
      upstreamRes.on("end", () => {
        const body = injectBridge(Buffer.concat(chunks).toString("utf8"));
        const outgoing = forwardableHeaders(upstreamRes.headers);
        delete outgoing["content-length"];
        res.writeHead(status, {
          ...outgoing,
          "content-length": Buffer.byteLength(body),
        });
        res.end(body);
      });
      upstreamRes.on("error", () => res.destroy());
    },
  );

  proxied.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain" });
    }
    res.end("OpenCode proxy: upstream request failed.");
  });
  res.on("close", () => proxied.destroy());
  req.pipe(proxied);
}

function forwardUpgrade(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  upstream: Upstream,
): void {
  const headers: http.OutgoingHttpHeaders = { ...req.headers };
  headers.host = `${upstream.host}:${upstream.port}`;

  const proxied = http.request({
    host: upstream.host,
    port: upstream.port,
    path: req.url,
    method: req.method,
    headers,
  });

  proxied.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
    const statusLine = `HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}`;
    const rawHeaders = Object.entries(upstreamRes.headers).flatMap(
      ([key, value]) =>
        Array.isArray(value)
          ? value.map((entry) => `${key}: ${entry}`)
          : [`${key}: ${String(value)}`],
    );
    socket.write(`${statusLine}\r\n${rawHeaders.join("\r\n")}\r\n\r\n`);
    if (upstreamHead?.length) {
      socket.write(upstreamHead);
    }
    if (head?.length) {
      upstreamSocket.write(head);
    }
    (socket as Socket).setNoDelay?.(true);
    upstreamSocket.setNoDelay(true);
    upstreamSocket.on("error", () => socket.destroy());
    socket.on("error", () => upstreamSocket.destroy());
    upstreamSocket.pipe(socket).pipe(upstreamSocket);
  });
  proxied.on("error", () => socket.destroy());
  proxied.end();
}

function forwardableHeaders(
  headers: http.IncomingHttpHeaders,
): http.OutgoingHttpHeaders {
  const result: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(key.toLowerCase())) {
      result[key] = value;
    }
  }
  return result;
}

function injectBridge(html: string): string {
  if (html.includes(SCRIPT_TAG)) {
    return html;
  }
  // The page's CSP allows script-src 'self', and the bridge is served from this
  // same origin, so no CSP rewriting is needed.
  const head = html.search(/<head[^>]*>/i);
  if (head !== -1) {
    const insertAt = html.indexOf(">", head) + 1;
    return html.slice(0, insertAt) + SCRIPT_TAG + html.slice(insertAt);
  }
  return SCRIPT_TAG + html;
}

function serveBridge(
  bridgeScriptPath: string,
  res: http.ServerResponse,
): void {
  fs.readFile(bridgeScriptPath, (err, contents) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("OpenCode proxy: bridge script not found.");
      return;
    }
    res.writeHead(200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(contents);
  });
}
