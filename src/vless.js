const UUID_HEX_PATTERN = /^[0-9a-f]{32}$/i;
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i;

export function uuidToBytes(value) {
	if (typeof value !== "string") return null;
	const hex = value.replaceAll("-", "");
	if (!UUID_HEX_PATTERN.test(hex)) return null;

	const bytes = new Uint8Array(16);
	for (let i = 0; i < 16; i += 1) {
		bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

export function parseVlessRequest(input, expectedUuid) {
	const data = input instanceof Uint8Array ? input : new Uint8Array(input);
	const expected = uuidToBytes(expectedUuid);

	// version(1) + UUID(16) + addons length(1) + command(1) + port(2) + address type(1)
	if (!expected) return null;
	if (data.byteLength < 18) return { incomplete: true };
	if (data[0] !== 0) return null;

	let mismatch = 0;
	for (let i = 0; i < 16; i += 1) {
		mismatch |= data[i + 1] ^ expected[i];
	}
	if (mismatch !== 0) return null;

	const addonsLength = data[17];
	if (addonsLength > 64) return null;
	const commandIndex = 18 + addonsLength;
	if (commandIndex + 4 > data.byteLength) return { incomplete: true };

	// VLESS command 0x01 is TCP. UDP and MUX are deliberately not implemented.
	if (data[commandIndex] !== 0x01) return null;

	const port = (data[commandIndex + 1] << 8) | data[commandIndex + 2];
	const addressType = data[commandIndex + 3];
	let offset = commandIndex + 4;
	let host;

	if (addressType === 0x01) {
		if (offset + 4 > data.byteLength) return { incomplete: true };
		const octets = Array.from(data.subarray(offset, offset + 4));
		host = octets.join(".");
		offset += 4;
	} else if (addressType === 0x02) {
		if (offset >= data.byteLength) return { incomplete: true };
		const length = data[offset++];
		if (length < 1) return null;
		if (offset + length > data.byteLength) return { incomplete: true };
		host = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(offset, offset + length));
		offset += length;
		if (!DOMAIN_PATTERN.test(host)) return null;
		host = host.toLowerCase();
	} else if (addressType === 0x03) {
		if (offset + 16 > data.byteLength) return { incomplete: true };
		const words = [];
		for (let i = 0; i < 16; i += 2) {
			words.push(((data[offset + i] << 8) | data[offset + i + 1]).toString(16));
		}
		host = words.join(":");
		offset += 16;
	} else {
		return null;
	}

	if (!isValidPort(port) || isBlockedHost(host)) return null;

	return {
		version: data[0],
		host,
		port,
		payload: data.slice(offset),
	};
}

export function isValidPort(port) {
	return Number.isInteger(port) && port >= 1 && port <= 65535 && port !== 25;
}

export function isBlockedHost(host) {
	if (typeof host !== "string" || host.length === 0) return true;
	const value = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");

	if (
		value === "localhost" ||
		value.endsWith(".localhost") ||
		value.endsWith(".local") ||
		value.endsWith(".internal") ||
		value.endsWith(".home.arpa") ||
		value.endsWith(".test") ||
		value.endsWith(".invalid") ||
		value.endsWith(".example")
	) return true;

	const octets = parseIPv4(value);
	if (octets) {
		const [a, b, c] = octets;
		return (
			a === 0 || a === 10 || a === 127 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && (b === 168 || (b === 0 && c === 0) || (b === 0 && c === 2))) ||
			(a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) ||
			(a === 203 && b === 0 && c === 113) ||
			a >= 224
		);
	}

	if (value.includes(":")) {
		const words = parseIPv6(value);
		if (!words) return true;
		const allZero = words.every((word) => word === 0);
		const loopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
		const uniqueLocal = (words[0] & 0xfe00) === 0xfc00;
		const linkLocal = (words[0] & 0xffc0) === 0xfe80;
		const multicast = (words[0] & 0xff00) === 0xff00;
		const documentation = words[0] === 0x2001 && words[1] === 0x0db8;
		const ipv4Mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
		if (allZero || loopback || uniqueLocal || linkLocal || multicast || documentation) return true;
		if (ipv4Mapped) {
			const mapped = [words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255];
			return isBlockedHost(mapped.join("."));
		}
		return false;
	}

	// Only hostnames or literal IP addresses are accepted.
	return !DOMAIN_PATTERN.test(value);
}

function parseIPv4(value) {
	const parts = value.split(".");
	if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return null;
	const octets = parts.map(Number);
	return octets.every((part) => part >= 0 && part <= 255) ? octets : null;
}

function parseIPv6(value) {
	if (!/^[0-9a-f:]+$/i.test(value) || value.includes(":::")) return null;
	const halves = value.split("::");
	if (halves.length > 2) return null;
	const left = halves[0] ? halves[0].split(":") : [];
	const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const groups = [...left, ...right];
	if (groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null;

	if (halves.length === 1) {
		if (groups.length !== 8) return null;
		return groups.map((group) => Number.parseInt(group, 16));
	}

	const missing = 8 - groups.length;
	if (missing < 1) return null;
	return [
		...left.map((group) => Number.parseInt(group, 16)),
		...Array(missing).fill(0),
		...right.map((group) => Number.parseInt(group, 16)),
	];
}
