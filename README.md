# VLESS Edge — Cloudflare Workers

A minimal VLESS-over-WebSocket-to-outbound-TCP bridge running on Cloudflare Workers. It does not require a VPS, Docker, or a custom domain.

## Important scope and limitations

This project is **not Xray-core** and does not implement the full V2Ray/Xray feature set.

- Supports VLESS TCP over WebSocket (WSS via the Worker's HTTPS endpoint).
- Does not support VLESS UDP, DNS-over-UDP, QUIC, XTLS/REALITY, MUX, or Xray routing features.
- Uses Cloudflare's outbound TCP Sockets API. Some destination IP ranges and connections are restricted by Cloudflare; a successful Worker deployment does not guarantee every destination or port is reachable.
- Cloudflare documents that outbound TCP connections to Cloudflare IP ranges, localhost, and private IP ranges are blocked. Port 25 is prohibited. For HTTP requests to destinations on ports 80/443, Cloudflare recommends `fetch()`; `fetch()` is not a transparent replacement for a raw TCP tunnel.
- Workers do not accept arbitrary inbound raw TCP from the public Internet. This project receives WebSocket connections over HTTPS and creates outbound TCP sockets.
- WebSocket connections can be interrupted during runtime updates or failures; clients should reconnect.
- Review current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [TCP Sockets documentation](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) before production use.

Do not use this project as an unrestricted/open public proxy. Keep the UUID and WebSocket path private, rotate them if exposed, and monitor usage in Cloudflare.

## Requirements

- Node.js LTS and npm
- A Cloudflare account with Workers access
- Wrangler CLI (installed through the project's dev dependencies)

## Install

```bash
npm install
npx wrangler login
```

## Configure secrets

Generate a UUID and a random WebSocket path locally. In PowerShell:

```powershell
$uuid = [guid]::NewGuid().ToString()
$path = "/" + [guid]::NewGuid().ToString("N")
Write-Host "UUID: $uuid"
Write-Host "WS path: $path"
```

Keep these values private. Do not commit them to Git, put them in `wrangler.jsonc`, or paste them into issue reports.

Add them as encrypted Worker secrets:

```powershell
npx wrangler secret put VLESS_UUID
# Paste the UUID when prompted

npx wrangler secret put WS_PATH
# Paste the path (including the leading /) when prompted
```

The UUID must be a standard UUID. The path must begin with `/`, contain at least one character after it, and must not contain spaces, backslashes, `?`, or `#`.

For local development, create a `.dev.vars` file (already ignored by Git):

```dotenv
VLESS_UUID="replace-with-a-private-uuid"
WS_PATH="/replace-with-a-private-random-path"
```

Never use production credentials in a shared or untrusted development environment.

## Local development

```bash
npm run dev
```

Open `http://localhost:8787/`. The health endpoint should return:

```text
VLESS Edge is running
```

The tunnel endpoint is the exact value configured in `WS_PATH`.

## Tests

```bash
npm test
```

## Deploy to workers.dev

The project enables `workers_dev` in `wrangler.jsonc`.

```bash
npm run deploy
```

Wrangler prints the deployed URL, normally:

```text
https://vless-edge.<your-account-subdomain>.workers.dev
```

The hostname is assigned by Cloudflare. Do not guess your account subdomain.

## V2Box / Shadowrocket profile

Create a VLESS profile with:

| Setting | Value |
|---|---|
| Protocol | VLESS |
| Address | The exact `workers.dev` hostname from deployment |
| Port | `443` |
| UUID | The value stored in `VLESS_UUID` |
| Encryption | `none` |
| Transport | WebSocket |
| WebSocket path | The exact `WS_PATH` secret |
| WebSocket Host | The same `workers.dev` hostname |
| TLS | Enabled |
| SNI | The same `workers.dev` hostname |
| Allow insecure | Disabled |
| Flow | None |

Use the hostname only, without `https://` or a trailing slash, in Address, Host, and SNI. The WebSocket path must include its leading slash.

## Health check

```bash
curl -i https://<your-worker-hostname>/
```

A health check confirms that the Worker is deployed; it does not verify that outbound TCP destinations are reachable.

## Live logs

```bash
npx wrangler tail
```

Check the Worker logs while attempting a client connection. Never share logs containing credentials or full connection URLs.

## Rotate credentials

If either secret is exposed, generate a new UUID/path and run `wrangler secret put` again for the corresponding secret, then restart/reconnect clients using the new values.

## Source layout

- `src/index.js` — Worker HTTP/WebSocket entry point and TCP bridge.
- `src/vless.js` — VLESS request parser and destination validation.
- `test/vless.spec.js` — protocol parser and HTTP endpoint tests.
- `wrangler.jsonc` — Wrangler deployment configuration.
