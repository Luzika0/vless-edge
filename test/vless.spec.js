import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { isBlockedHost, isValidPort, parseVlessRequest, uuidToBytes } from "../src/vless.js";

const UUID = "123e4567-e89b-12d3-a456-426614174000";

function makeRequest({ uuid = UUID, host = "example.com", port = 443, command = 1 } = {}) {
	const uuidBytes = uuidToBytes(uuid);
	const hostBytes = new TextEncoder().encode(host);
	const bytes = new Uint8Array(1 + 16 + 1 + 1 + 2 + 1 + 1 + hostBytes.length);
	let offset = 0;
	bytes[offset++] = 0;
	bytes.set(uuidBytes, offset);
	offset += 16;
	bytes[offset++] = 0; // addons length
	bytes[offset++] = command;
	bytes[offset++] = (port >> 8) & 255;
	bytes[offset++] = port & 255;
	bytes[offset++] = 2; // domain address type
	bytes[offset++] = hostBytes.length;
	bytes.set(hostBytes, offset);
	return bytes;
}

describe("VLESS protocol parser", () => {
	it("parses a valid TCP domain request", () => {
		const parsed = parseVlessRequest(makeRequest(), UUID);
		expect(parsed).toMatchObject({ version: 0, host: "example.com", port: 443 });
		expect(parsed.payload).toEqual(new Uint8Array());
	});

	it("preserves application bytes following the VLESS header", () => {
		const request = makeRequest();
		const combined = new Uint8Array(request.length + 3);
		combined.set(request);
		combined.set([1, 2, 3], request.length);
		expect(parseVlessRequest(combined, UUID).payload).toEqual(new Uint8Array([1, 2, 3]));
	});

	it("accepts UUIDs with or without hyphens", () => {
		expect(uuidToBytes(UUID)).toHaveLength(16);
		expect(uuidToBytes(UUID.replaceAll("-", ""))).toHaveLength(16);
	});

	it("rejects an invalid UUID", () => {
		expect(parseVlessRequest(makeRequest(), "not-a-uuid")).toBeNull();
	});

	it("rejects a mismatched UUID", () => {
		expect(parseVlessRequest(makeRequest(), "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toBeNull();
	});

	it("parses a valid UDP domain request", () => {
		const parsed = parseVlessRequest(makeRequest({ command: 2, port: 53 }), UUID);
		expect(parsed).toMatchObject({ command: 2, host: "example.com", port: 53, addressType: 2 });
		expect(parsed.addressBytes).toEqual(new TextEncoder().encode("example.com"));
	});

	it("waits for fragmented headers", () => {
		const request = makeRequest();
		expect(parseVlessRequest(request.slice(0, 12), UUID)).toEqual({ incomplete: true });
		expect(parseVlessRequest(request.slice(0, 24), UUID)).toEqual({ incomplete: true });
		expect(parseVlessRequest(request, UUID).host).toBe("example.com");
	});

	it("rejects blocked private destinations", () => {
		for (const host of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.0.1", "localhost", "service.local"]) {
			expect(isBlockedHost(host), host).toBe(true);
			expect(parseVlessRequest(makeRequest({ host }), UUID), host).toBeNull();
		}
	});

	it("rejects invalid ports and SMTP port 25", () => {
		expect(isValidPort(443)).toBe(true);
		expect(isValidPort(25)).toBe(false);
		expect(isValidPort(0)).toBe(false);
		expect(isValidPort(65536)).toBe(false);
		expect(parseVlessRequest(makeRequest({ port: 25 }), UUID)).toBeNull();
	});

	it("rejects malformed hostnames", () => {
		expect(parseVlessRequest(makeRequest({ host: "bad host" }), UUID)).toBeNull();
	});
});

describe("Worker HTTP endpoints", () => {
	it("returns a health response", async () => {
		const response = await worker.fetch(new Request("https://worker.example/"), {}, { waitUntil() {} });
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("VLESS Edge is running");
	});

	it("requires the Worker secrets before accepting connections", async () => {
		const response = await worker.fetch(new Request("https://worker.example/ws"), {}, { waitUntil() {} });
		expect(response.status).toBe(503);
	});

	it("rejects an unknown path", async () => {
		const response = await worker.fetch(
			new Request("https://worker.example/not-the-path"),
			{ VLESS_UUID: UUID, WS_PATH: "/secret-ws" },
			{ waitUntil() {} },
		);
		expect(response.status).toBe(404);
	});

	it("requires a WebSocket upgrade on the configured path", async () => {
		const response = await worker.fetch(
			new Request("https://worker.example/secret-ws"),
			{ VLESS_UUID: UUID, WS_PATH: "/secret-ws" },
			{ waitUntil() {} },
		);
		expect(response.status).toBe(426);
	});
});
