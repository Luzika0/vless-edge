import { connect } from "cloudflare:sockets";
import { parseVlessRequest, uuidToBytes } from "./vless.js";

const MAX_PENDING_HEADER_BYTES = 8 * 1024;

function json(message, status = 400) {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

function concatenate(a, b) {
	const result = new Uint8Array(a.byteLength + b.byteLength);
	result.set(a, 0);
	result.set(b, a.byteLength);
	return result;
}

async function asBytes(data) {
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) {
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	}
	if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
	throw new TypeError("Only binary WebSocket frames are supported");
}

function isValidPath(path) {
	return typeof path === "string" &&
		path.startsWith("/") &&
		path.length > 1 &&
		path.length <= 256 &&
		!/[?#\\\\\s]/.test(path);
}

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);

		if (request.method === "GET" && url.pathname === "/") {
			return new Response("VLESS Edge is running", {
				headers: {
					"content-type": "text/plain; charset=utf-8",
					"cache-control": "no-store",
				},
			});
		}

		if (request.method !== "GET") {
			return json("Method not allowed", 405);
		}

		if (!env.VLESS_UUID || !env.WS_PATH) {
			console.error("Missing VLESS_UUID or WS_PATH Worker secret");
			return json("Worker is not configured", 503);
		}
		if (!uuidToBytes(env.VLESS_UUID)) {
			console.error("VLESS_UUID is not a valid UUID");
			return json("Worker configuration is invalid", 503);
		}

		if (!isValidPath(env.WS_PATH)) {
			console.error("WS_PATH must be a valid absolute path");
			return json("Worker configuration is invalid", 503);
		}

		if (url.pathname !== env.WS_PATH) {
			return json("Not found", 404);
		}

		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return json("WebSocket upgrade required", 426);
		}

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		server.accept({ allowHalfOpen: true });
		server.binaryType = "arraybuffer";

		let closed = false;
		let initialized = false;
		let pendingHeader = new Uint8Array(0);
		let tcpSocket;
		let tcpWriter;
		let tcpReader;
		let messageChain = Promise.resolve();
		let tcpWriteChain = Promise.resolve();

		const closeBoth = async (code = 1000, reason = "Connection closed") => {
			if (closed) return;
			closed = true;

			try {
				if (tcpReader) await tcpReader.cancel();
			} catch {}
			try {
				if (tcpWriter) await tcpWriter.abort();
			} catch {}
			try {
				if (tcpSocket) await tcpSocket.close();
			} catch {}
			try {
				if (server.readyState === WebSocket.OPEN || server.readyState === WebSocket.CLOSING) {
					server.close(code, reason.slice(0, 120));
				}
			} catch {}
		};

		const handleMessage = async (event) => {
			if (closed) return;
			if (typeof event.data === "string") {
				await closeBoth(1003, "Binary VLESS frames required");
				return;
			}

			const bytes = await asBytes(event.data);

			if (!initialized) {
				pendingHeader = concatenate(pendingHeader, bytes);
				if (pendingHeader.byteLength > MAX_PENDING_HEADER_BYTES) {
					await closeBoth(1009, "VLESS header too large");
					return;
				}

				const parsed = parseVlessRequest(pendingHeader, env.VLESS_UUID);
				if (parsed?.incomplete) return;
				if (!parsed) {
					await closeBoth(1008, "Invalid or unsupported VLESS request");
					return;
				}

				initialized = true;

				try {
					// Cloudflare's TCP Sockets API supports outbound TCP, not inbound public TCP.
					// The client must connect to this Worker over WebSocket.
					tcpSocket = connect(
						{ hostname: parsed.host, port: parsed.port },
						{ allowHalfOpen: true },
					);
					await tcpSocket.opened;
					tcpWriter = tcpSocket.writable.getWriter();
					tcpReader = tcpSocket.readable.getReader();

					// VLESS response: request version followed by zero-length addons.
					server.send(new Uint8Array([parsed.version, 0]));

					if (parsed.payload.byteLength > 0) {
						await tcpWriter.write(parsed.payload);
					}

					ctx.waitUntil(pipeTcpToWebSocket(tcpReader, server, closeBoth));
					ctx.waitUntil(watchTcpClose(tcpSocket, closeBoth));
					pendingHeader = new Uint8Array(0);
				} catch (error) {
					console.error("TCP connection failed", error?.message || error);
					await closeBoth(1011, "Unable to connect to destination");
				}
				return;
			}

			if (bytes.byteLength === 0) return;
			tcpWriteChain = tcpWriteChain.then(async () => {
				if (!closed && tcpWriter) await tcpWriter.write(bytes);
			});
			try {
				await tcpWriteChain;
			} catch (error) {
				console.error("TCP write failed", error?.message || error);
				await closeBoth(1011, "TCP write failed");
			}
		};

		server.addEventListener("message", (event) => {
			messageChain = messageChain.then(() => handleMessage(event)).catch(async (error) => {
				console.error("WebSocket message failed", error?.message || error);
				await closeBoth(1011, "Tunnel error");
			});
		});

		server.addEventListener("close", () => {
			void closeBoth();
		});

		server.addEventListener("error", () => {
			void closeBoth(1011, "WebSocket error");
		});

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	},
};

async function pipeTcpToWebSocket(reader, websocket, closeBoth) {
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			if (websocket.readyState !== WebSocket.OPEN) break;
			if (value?.byteLength) websocket.send(value);
		}
	} catch (error) {
		console.error("TCP read failed", error?.message || error);
	} finally {
		try {
			reader.releaseLock();
		} catch {}
		await closeBoth();
	}
}

async function watchTcpClose(socket, closeBoth) {
	try {
		await socket.closed;
	} catch (error) {
		console.error("TCP socket closed with error", error?.message || error);
		await closeBoth(1011, "Destination connection closed");
	}
}
