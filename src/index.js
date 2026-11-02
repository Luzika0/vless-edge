import { connect } from "cloudflare:sockets";
import { parseVlessRequest, uuidToBytes } from "./vless.js";
import { encodeUdpRelayHandshake, MAX_UDP_DATAGRAM_SIZE, StreamBufferReader } from "./udp-relay.js";

const MAX_PENDING_HEADER_BYTES = 8 * 1024;
const MAX_UDP_BUFFER_BYTES = 256 * 1024;

function json(message, status = 400) {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});
}

function concatenate(a, b) {
	const result = new Uint8Array(a.byteLength + b.byteLength);
	result.set(a);
	result.set(b, a.byteLength);
	return result;
}

async function asBytes(data) {
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
	throw new TypeError("Only binary WebSocket frames are supported");
}

function isValidPath(path) {
	return typeof path === "string" && path.startsWith("/") && path.length > 1 &&
		path.length <= 256 && !/[?#\\\\\s]/.test(path);
}

function takeUdpFrames(buffer) {
	const frames = [];
	let offset = 0;
	while (buffer.byteLength - offset >= 2) {
		const length = (buffer[offset] << 8) | buffer[offset + 1];
		if (length > MAX_UDP_DATAGRAM_SIZE) throw new Error("UDP datagram exceeds maximum size");
		if (buffer.byteLength - offset < length + 2) break;
		frames.push(buffer.slice(offset, offset + length + 2));
		offset += length + 2;
	}
	return { frames, remaining: buffer.slice(offset) };
}

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/") {
			return new Response("VLESS Edge is running", {
				headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
			});
		}
		if (request.method !== "GET") return json("Method not allowed", 405);
		if (!env.VLESS_UUID || !env.WS_PATH) {
			console.error("Missing VLESS_UUID or WS_PATH Worker secret");
			return json("Worker is not configured", 503);
		}
		if (!uuidToBytes(env.VLESS_UUID)) return json("VLESS_UUID is not a valid UUID", 503);
		if (!isValidPath(env.WS_PATH)) return json("WS_PATH must be a valid absolute path", 503);
		if (url.pathname !== env.WS_PATH) return json("Not found", 404);
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
		let udpBuffer = new Uint8Array(0);

		const closeBoth = async (code = 1000, reason = "Connection closed") => {
			if (closed) return;
			closed = true;
			try { if (tcpReader) await tcpReader.cancel(); } catch {}
			try { if (tcpWriter) await tcpWriter.abort(); } catch {}
			try { if (tcpSocket) await tcpSocket.close(); } catch {}
			try {
				if (server.readyState === WebSocket.OPEN || server.readyState === WebSocket.CLOSING) {
					server.close(code, reason.slice(0, 120));
				}
			} catch {}
		};

		const sendUdpFrames = async (bytes) => {
			udpBuffer = concatenate(udpBuffer, bytes);
			if (udpBuffer.byteLength > MAX_UDP_BUFFER_BYTES) throw new Error("UDP input buffer limit exceeded");
			const parsedFrames = takeUdpFrames(udpBuffer);
			udpBuffer = parsedFrames.remaining;
			for (const frame of parsedFrames.frames) {
				if (closed) return;
				await tcpWriter.write(frame);
			}
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
				let parsed;
				try { parsed = parseVlessRequest(pendingHeader, env.VLESS_UUID); }
				catch { parsed = null; }
				if (parsed?.incomplete) return;
				if (!parsed) {
					await closeBoth(1008, "Invalid or unsupported VLESS request");
					return;
				}
				initialized = true;
				try {
					if (parsed.command === 0x01) {
						tcpSocket = connect({ hostname: parsed.host, port: parsed.port }, { allowHalfOpen: true });
						await tcpSocket.opened;
						tcpWriter = tcpSocket.writable.getWriter();
						tcpReader = tcpSocket.readable.getReader();
						server.send(new Uint8Array([parsed.version, 0]));
						if (parsed.payload.byteLength) await tcpWriter.write(parsed.payload);
						ctx.waitUntil(pipeTcpToWebSocket(tcpReader, server, closeBoth));
						ctx.waitUntil(watchTcpClose(tcpSocket, closeBoth));
					} else if (parsed.command === 0x02) {
						if (!env.UDP_RELAY_HOST || !env.UDP_RELAY_PORT || !env.UDP_RELAY_SECRET) {
							throw new Error("UDP relay is not configured");
						}
						const relayPort = Number(env.UDP_RELAY_PORT);
						if (!Number.isInteger(relayPort) || relayPort < 1 || relayPort > 65535) {
							throw new Error("UDP_RELAY_PORT is invalid");
						}
						if (env.UDP_RELAY_SECRET.length < 32) throw new Error("UDP_RELAY_SECRET must be at least 32 characters");
						tcpSocket = connect(
							{ hostname: env.UDP_RELAY_HOST, port: relayPort },
							{ secureTransport: "on", allowHalfOpen: true },
						);
						await tcpSocket.opened;
						tcpWriter = tcpSocket.writable.getWriter();
						tcpReader = tcpSocket.readable.getReader();
						await tcpWriter.write(encodeUdpRelayHandshake(parsed, env.UDP_RELAY_SECRET));
						server.send(new Uint8Array([parsed.version, 0]));
						if (parsed.payload.byteLength) await sendUdpFrames(parsed.payload);
						ctx.waitUntil(pipeUdpRelayToWebSocket(tcpReader, server, closeBoth));
					}
					pendingHeader = new Uint8Array(0);
				} catch (error) {
					console.error("VLESS upstream connection failed", error?.message || error);
					await closeBoth(1011, "Unable to connect to upstream");
				}
				return;
			}

			if (bytes.byteLength === 0) return;
			if (pendingHeader.byteLength === 0 && tcpSocket && !udpBuffer.length && !env.__unused) {
				// TCP and UDP both use the same WebSocket stream after initialization.
			}
			tcpWriteChain = tcpWriteChain.then(async () => {
				if (closed || !tcpWriter) return;
				// TCP mode writes raw stream bytes. UDP mode writes complete length-prefixed datagrams.
				if (udpMode) await sendUdpFrames(bytes);
				else await tcpWriter.write(bytes);
			});
			try { await tcpWriteChain; }
			catch (error) {
				console.error("Upstream write failed", error?.message || error);
				await closeBoth(1011, "Upstream write failed");
			}
		};

		let udpMode = false;
		server.addEventListener("message", (event) => {
			messageChain = messageChain.then(async () => {
				if (!initialized && pendingHeader.byteLength === 0) {
					// The mode is selected from the parsed VLESS command during initialization.
				}
				await handleMessage(event);
			}).catch(async (error) => {
				console.error("WebSocket message failed", error?.message || error);
				await closeBoth(1011, "Tunnel error");
			});
		});
		server.addEventListener("close", () => { void closeBoth(); });
		server.addEventListener("error", () => { void closeBoth(1011, "WebSocket error"); });

		return new Response(null, { status: 101, webSocket: client });
	},
};

async function pipeTcpToWebSocket(reader, websocket, closeBoth) {
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done || websocket.readyState !== WebSocket.OPEN) break;
			if (value?.byteLength) websocket.send(value);
		}
	} catch (error) {
		console.error("TCP read failed", error?.message || error);
	} finally {
		try { reader.releaseLock(); } catch {}
		await closeBoth();
	}
}

async function pipeUdpRelayToWebSocket(reader, websocket, closeBoth) {
	const buffered = new StreamBufferReader(reader);
	try {
		while (websocket.readyState === WebSocket.OPEN) {
			const prefix = await buffered.readExactly(2);
			const length = (prefix[0] << 8) | prefix[1];
			if (length > MAX_UDP_DATAGRAM_SIZE) throw new Error("Relay returned oversized UDP datagram");
			const payload = await buffered.readExactly(length);
			const frame = new Uint8Array(length + 2);
			frame.set(prefix);
			frame.set(payload, 2);
			websocket.send(frame);
		}
	} catch (error) {
		if (websocket.readyState === WebSocket.OPEN) console.error("UDP relay stream ended", error?.message || error);
	} finally {
		try { reader.releaseLock(); } catch {}
		await closeBoth();
	}
}

async function watchTcpClose(socket, closeBoth) {
	try { await socket.closed; }
	catch (error) {
		console.error("TCP socket closed with error", error?.message || error);
		await closeBoth(1011, "Destination connection closed");
	}
}
