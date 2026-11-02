import tls from "node:tls";
import dgram from "node:dgram";
import dns from "node:dns/promises";
import net from "node:net";
import fs from "node:fs";
import { timingSafeEqual } from "node:crypto";

const PORT = Number(process.env.UDP_RELAY_LISTEN_PORT || 8443);
const SECRET = process.env.UDP_RELAY_SECRET || "";
const CERT = process.env.UDP_RELAY_TLS_CERT || "/etc/letsencrypt/live/relay.example.com/fullchain.pem";
const KEY = process.env.UDP_RELAY_TLS_KEY || "/etc/letsencrypt/live/relay.example.com/privkey.pem";
const MAX_DATAGRAM = 65507;
const MAX_BUFFER = 256 * 1024;
const IDLE_TIMEOUT_MS = 120_000;
const MAX_SESSION_BYTES_PER_SECOND = 8 * 1024 * 1024;

const blocked = new net.BlockList();
for (const [subnet, prefix] of [
	["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
	["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
	["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
	["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
]) blocked.addSubnet(subnet, prefix, "ipv4");
for (const [subnet, prefix] of [
	["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10],
	["ff00::", 8], ["2001:db8::", 32],
]) blocked.addSubnet(subnet, prefix, "ipv6");

function isPublicIp(address) {
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
	if (mapped) return isPublicIp(mapped[1]);
	const family = net.isIP(address);
	return family !== 0 && !blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

class Reader {
	constructor(socket) {
		this.iterator = socket[Symbol.asyncIterator]();
		this.buffer = Buffer.alloc(0);
	}
	async exact(length) {
		while (this.buffer.length < length) {
			const next = await this.iterator.next();
			if (next.done) throw new Error("Client closed relay stream");
			this.buffer = Buffer.concat([this.buffer, next.value]);
			if (this.buffer.length > MAX_BUFFER + 1024) throw new Error("Relay input buffer exceeded");
		}
		const value = this.buffer.subarray(0, length);
		this.buffer = this.buffer.subarray(length);
		return value;
	}
}

function parseDestination(type, addressBytes) {
	if (type === 1 && addressBytes.length === 4) return [...addressBytes].join(".");
	if (type === 2) {
		const host = new TextDecoder("utf-8", { fatal: true }).decode(addressBytes);
		if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i.test(host)) {
			throw new Error("Invalid destination hostname");
		}
		return host.toLowerCase();
	}
	if (type === 3 && addressBytes.length === 16) {
		const groups = [];
		for (let i = 0; i < 16; i += 2) groups.push(addressBytes.readUInt16BE(i).toString(16));
		return groups.join(":");
	}
	throw new Error("Invalid destination address");
}

async function resolvePublic(host) {
	if (net.isIP(host)) {
		if (!isPublicIp(host)) throw new Error("Private or reserved destination is blocked");
		return host;
	}
	const records = await dns.lookup(host, { all: true, verbatim: true });
	if (!records.length || records.some((record) => !isPublicIp(record.address))) {
		throw new Error("Destination resolves to a private or reserved address");
	}
	return records[0].address;
}

function safeEqual(a, b) {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

async function handleClient(socket) {
	let udp;
	let idleTimer;
	let closed = false;
	let byteWindowStart = Date.now();
	let bytesThisWindow = 0;
	let backpressured = false;
	const close = () => {
		if (closed) return;
		closed = true;
		clearTimeout(idleTimer);
		try { udp?.close(); } catch {}
		socket.destroy();
	};
	socket.setTimeout(10_000, close);
	const touch = () => {
		clearTimeout(idleTimer);
		idleTimer = setTimeout(close, IDLE_TIMEOUT_MS);
		idleTimer.unref?.();
	};
	socket.on("drain", () => { backpressured = false; });
	socket.on("error", () => close());
	socket.on("close", () => close());
	try {
		if (SECRET.length < 32) throw new Error("UDP_RELAY_SECRET must contain at least 32 characters");
		const reader = new Reader(socket);
		const magic = await reader.exact(4);
		if (!magic.equals(Buffer.from("VUD1"))) throw new Error("Invalid relay protocol");
		const secretLength = (await reader.exact(1))[0];
		if (secretLength < 32) throw new Error("Invalid relay secret length");
		const suppliedSecret = await reader.exact(secretLength);
		if (!safeEqual(suppliedSecret, Buffer.from(SECRET, "utf8"))) throw new Error("Authentication failed");

		socket.setTimeout(0);
		const type = (await reader.exact(1))[0];
		const portBytes = await reader.exact(2);
		const port = portBytes.readUInt16BE(0);
		if (!port || port === 25) throw new Error("Invalid destination port");
		const addressLength = type === 1 ? 4 : type === 3 ? 16 : type === 2 ? (await reader.exact(1))[0] : 0;
		if (!addressLength || addressLength > 253) throw new Error("Invalid destination address length");
		const host = parseDestination(type, await reader.exact(addressLength));
		const destinationIp = await resolvePublic(host);
		const family = net.isIP(destinationIp);
		udp = dgram.createSocket(family === 6 ? "udp6" : "udp4");

		udp.on("message", (message) => {
			if (closed || !socket.writable || backpressured) return;
			const now = Date.now();
			if (now - byteWindowStart >= 1000) {
				byteWindowStart = now;
				bytesThisWindow = 0;
			}
			bytesThisWindow += message.length;
			if (bytesThisWindow > MAX_SESSION_BYTES_PER_SECOND) {
				close();
				return;
			}
			const frame = Buffer.allocUnsafe(message.length + 2);
			frame.writeUInt16BE(message.length, 0);
			message.copy(frame, 2);
			backpressured = !socket.write(frame);
			touch();
		});
		udp.on("error", (error) => {
			console.error("UDP socket error:", error.message);
			close();
		});
		udp.connect(port, destinationIp);
		touch();

		while (!closed) {
			const prefix = await reader.exact(2);
			const length = prefix.readUInt16BE(0);
			if (length > MAX_DATAGRAM) throw new Error("Oversized UDP datagram");
			const payload = await reader.exact(length);
			const now = Date.now();
			if (now - byteWindowStart >= 1000) {
				byteWindowStart = now;
				bytesThisWindow = 0;
			}
			bytesThisWindow += length;
			if (bytesThisWindow > MAX_SESSION_BYTES_PER_SECOND) throw new Error("UDP session rate limit exceeded");
			udp.send(payload);
			touch();
		}
	} catch (error) {
		if (!closed) console.warn("UDP relay session closed:", error.message);
		close();
	}
}

if (SECRET.length < 32) {
	console.error("Set UDP_RELAY_SECRET to a random value of at least 32 characters.");
	process.exit(1);
}
if (!fs.existsSync(CERT) || !fs.existsSync(KEY)) {
	console.error("TLS certificate or key not found. Set UDP_RELAY_TLS_CERT and UDP_RELAY_TLS_KEY.");
	process.exit(1);
}

const server = tls.createServer({
	cert: fs.readFileSync(CERT),
	key: fs.readFileSync(KEY),
	minVersion: "TLSv1.2",
}, (socket) => {
	socket.setNoDelay(true);
	handleClient(socket);
});
server.on("error", (error) => console.error("UDP relay server error:", error.message));
server.listen(PORT, "0.0.0.0", () => console.log(`Authenticated UDP relay listening on TCP/TLS port ${PORT}`));
