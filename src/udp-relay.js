export const MAX_UDP_DATAGRAM_SIZE = 65507;
const RELAY_MAGIC = new Uint8Array([0x56, 0x55, 0x44, 0x31]); // "VUD1"

export function encodeUdpRelayHandshake(parsed, secret) {
	const secretBytes = new TextEncoder().encode(secret);
	if (secretBytes.byteLength < 32 || secretBytes.byteLength > 255) {
		throw new Error("UDP relay secret must be 32 to 255 UTF-8 bytes");
	}
	if (![0x01, 0x02, 0x03].includes(parsed.addressType)) {
		throw new Error("Unsupported UDP destination address type");
	}
	const address = parsed.addressBytes;
	const domainLength = parsed.addressType === 0x02 ? 1 : 0;
	const output = new Uint8Array(4 + 1 + secretBytes.length + 1 + 2 + domainLength + address.length);
	let offset = 0;
	output.set(RELAY_MAGIC, offset); offset += 4;
	output[offset++] = secretBytes.length;
	output.set(secretBytes, offset); offset += secretBytes.length;
	output[offset++] = parsed.addressType;
	output[offset++] = (parsed.port >> 8) & 255;
	output[offset++] = parsed.port & 255;
	if (domainLength) output[offset++] = address.length;
	output.set(address, offset);
	return output;
}

export function encodeLengthPrefixed(payload) {
	if (!(payload instanceof Uint8Array) || payload.byteLength > MAX_UDP_DATAGRAM_SIZE) {
		throw new Error("Invalid UDP datagram size");
	}
	const frame = new Uint8Array(payload.byteLength + 2);
	frame[0] = (payload.byteLength >> 8) & 255;
	frame[1] = payload.byteLength & 255;
	frame.set(payload, 2);
	return frame;
}

export class StreamBufferReader {
	constructor(reader) {
		this.reader = reader;
		this.buffer = new Uint8Array(0);
		this.done = false;
	}

	async readExactly(length) {
		while (this.buffer.byteLength < length) {
			if (this.done) throw new Error("Relay stream ended unexpectedly");
			const { value, done } = await this.reader.read();
			if (done) {
				this.done = true;
				throw new Error("Relay stream ended unexpectedly");
			}
			if (value?.byteLength) {
				const next = new Uint8Array(this.buffer.byteLength + value.byteLength);
				next.set(this.buffer);
				next.set(value, this.buffer.byteLength);
				this.buffer = next;
			}
		}
		const result = this.buffer.slice(0, length);
		this.buffer = this.buffer.slice(length);
		return result;
	}
}
