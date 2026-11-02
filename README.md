# VLESS Edge — Cloudflare Workers

A VLESS-over-WebSocket-to-outbound-TCP bridge running on Cloudflare Workers. It can use the default `workers.dev` hostname or a custom hostname in a Cloudflare zone.

## Supported features

- VLESS TCP over WebSocket (WSS).
- Cloudflare Workers custom domains.
- UUID authentication and a private WebSocket path.
- IPv4, IPv6, and domain-name destinations.
- TCP connection lifecycle and binary frame handling.

## Not supported

This project is **not Xray-core** and does not implement the full V2Ray/Xray feature set.

- VLESS UDP command (`0x02)), UDP forwarding, DNS-over-UDP, and QUIC are not supported.
- XTLS/REALITY, MUX, and Xray routing features are not implemented.
- Cloudflare's documented Workers TCP Sockets API exposes outbound TCP sockets via `connect()`; it is not an outbound UDP datagram API. A Worker receiving a WebSocket connection cannot turn that into arbitrary UDP forwarding merely by changing the VLESS parser.
- Workers do not accept arbitrary inbound raw TCP/UDP from the public Internet. This Worker receives HTTPS/WebSocket requests.
- Cloudflare restricts certain outbound TCP destinations and ports. A successful deployment does not guarantee every target can be reached.
- WebSocket sessions may be interrupted during runtime updates or failures; clients should reconnect.

If full VLESS UDP is a requirement, use a UDP-capable proxy backend (for example, Xray on a VPS) and treat the Worker as a WebSocket/TCP front end only where appropriate. Do not advertise this Worker as UDP-capable.

Review the current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [TCP Sockets documentation](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/), and [Custom Domains documentation](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

Do not use this project as an unrestricted/open public proxy. Keep the UUID and WebSocket path private, rotate them if exposed, and monitor usage.

## Requirements

- Node.js LTS and npm
- A Cloudflare account with Workers access
- A Cloudflare zone active on the same account if using a custom domain
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
Write-Host "Path: $path"
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

## Deploy using workers.dev

The project enables `workers_dev` in `wrangler.jsonc`.

```bash
npm run deploy
```

Wrangler prints the deployed URL, normally:

```text
https://vless-edge.<your-account-subdomain>.workers.dev
```

## Use a custom domain

Custom Domains are supported by Workers. Your domain must be an active Cloudflare zone in the same account, and the Worker must already exist. Cloudflare creates the DNS record and provisions the certificate. A hostname with an existing CNAME record cannot be used as a Custom Domain until that conflict is resolved. Custom Domains match the exact hostname; they do not automatically cover sibling subdomains or wildcard hosts.

Recommended example: use a dedicated hostname such as `vless.example.com`, replacing `example.com` with a domain you control in Cloudflare. Do not reuse a hostname currently serving another app or Fly deployment.

**Dashboard setup (recommended):**

1. Deploy the Worker to `workers.dev` first.
2. Open Cloudflare Dashboard → Workers & Pages → `vless-edge`.
3. Open Settings → Domains & Routes → Add → Custom Domain.
4. Enter your dedicated hostname, for example `vless.example.com`.
5. Confirm Add Custom Domain and wait for Cloudflare to provision DNS and TLS.
6. Test `https://vless.example.com/`; it should return `VLESS Edge is running`.
7. Configure the VLESS client to use this hostname, port `443`, TLS enabled, and the same secret WebSocket path.

**Wrangler configuration alternative:**

After deciding on the real hostname and confirming it belongs to your Cloudflare zone, add this to the top-level configuration in `wrangler.jsonc`:

```jsonc
"routes": [
  {
    "pattern": "vless.example.com",
    "custom_domain": true
  }
],
```

Replace `vless.example.com` with your actual hostname. Do not leave the example hostname in place. Then run:

```bash
npx wrangler deploy
```

Do not configure both a conflicting DNS CNAME and a Custom Domain for the same hostname. Custom Domain creation manages the hostname's DNS record and certificate.

## V2Box / Shadowrocket profile

Create a VLESS profile with:

| Setting | Value |
|---|---|
| Protocol | VLESS |
| Address | The deployed `workers.dev` or custom hostname |
| Port | `443` |
| UUID | The value stored in `VLESS_UUID` |
| Encryption | `none` |
| Transport | WebSocket |
| WebSocket path | The exact `WS_PATH` secret |
| WebSocket Host | The same hostname |
| TLS | Enabled |
| SNI | The same hostname |
| Allow insecure | Disabled |
| Flow | None |

This Worker supports TCP only. Select TCP for network traffic. UDP-dependent apps, DNS-over-UDP, QUIC, and UDP-based games will not work through this implementation.

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

If either secret is exposed, generate a new UUID/path and run `wrangler secret put` again for the corresponding secret, then reconnect clients using the new values.

## Source layout

- `src/index.js` — Worker HTTP/WebSocket entry point and TCP bridge.
- `src/vless.js` — VLESS request parser and destination validation.
- `test/vless.spec.js` — protocol parser and HTTP endpoint tests.
- `wrangler.jsonc` — Wrangler deployment configuration.
