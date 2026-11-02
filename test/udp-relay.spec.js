import { describe, expect, it } from "vitest";
import { encodeLengthPrefixed, encodeUdpRelayHandshake, StreamBufferReader } from "../src/udp-relay.js";

describe("UDP relay framing", () => {
	it("encodes a length-prefixed UDP datagram", () => {
		expect(encodeLengthPrefixed(new Uint8Array([1, 2, 3]))).toEqual(new Uint8Array([0, 3, 1, 2, 3]));
	});

	it("rejects an undersized shared secret", () => {
		expect(() => encodeUdpRelayHandshake({ addressType: 2, addressBytes: new TextEncoder().encode("example.com"), port: 53 }, "short")).toThrow(/32 to 255/);
	});

	it("encodes an authenticated domain destination handshake", () => {
		const host = new TextEncoder().encode("example.com");
		const secret = "0123456789abcdef0123456789abcdef";
		const frame = encodeUdpRelayHandshake({ addressType: 2, addressBytes: host, port: 53 }, secret);
		expect(new TextDecoder().decode(frame.slice(0, 4))).toBe("VUD1");
		expect(frame[4]).toBe(secret.length);
		expect(new TextDecoder().decode(frame.slice(5, 5 + secret.length))).toBe(secret);
		expect(frame[5 + secret.length]).toBe(2);
	});

	it("reads exact byte counts across fragmented stream chunks", async () => {
		const chunks = [new Uint8Array([1]), new Uint8Array([2, 3]), new Uint8Array([4])];
		const reader = { async read() { return chunks.length ? { value: chunks.shift(), done: false } : { done: true }; } };
		const buffered = new StreamBufferReader(reader);
		expect(await buffered.readExactly(3)).toEqual(new Uint8Array([1, 2, 3]));
		expect(await buffered.readExactly(1)).toEqual(new Uint8Array([4]));
	});
});
