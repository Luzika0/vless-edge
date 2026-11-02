# VLESS Edge — Cloudflare Workers

A VLESS-over-WebSocket-to-outbound-TCP bridge running on Cloudflare Workers. It can use the default `workers.dev` hostname or a custom hostname in a Cloudflare zone.

## Supported features

- VLESS TCP over WebSocket (WSS).
- VLESS UDP over WebSocket using an authenticated TLS/TCP relay on a VPS.
- Cloudflare Workers custom domains.
- UUID authentication and a private WebSocket path.
- IPv4, IPv6, and domain-name destinations.
- TCP connection lifecycle and binary frame handling.

## Not supported

This project is **not Xray-core** and does not implement the full V2Ray/Xray feature set.

- Native UDP sockets are not available in the Worker. UDP is encapsulated over a TLS-protected TCP connection to the VPS relay; this is not native UDP transport and can introduce head-of-line blocking and latency.
- XTLS/REALITY, MUX, and Xray routing features are not implemented.
- Cloudflare's documented Workers TCP Sockets API exposes outbound TCP sockets via `connect()`; it is not an outbound UDP datagram API. A Worker receiving a WebSocket connection cannot turn that into arbitrary UDP forwarding merely by changing the VLESS parser.
- Workers do not accept arbitrary inbound raw TCP/UDP from the public Internet. This Worker receives HTTPS/WebSocket requests.
- Cloudflare restricts certain outbound TCP destinations and ports. A successful deployment does not guarantee every target can be reached.
- WebSocket sessions may be interrupted during runtime updates or failures; clients should reconnect.

For UDP, deploy the included authenticated relay in `relay/` on a VPS. The Worker forwards VLESS UDP datagrams to that relay over TLS/TCP; the VPS sends and receives actual UDP datagrams. This preserves the existing WebSocket client endpoint but TCP encapsulation can reduce real-time performance under packet loss. It does not guarantee every voice/video app will work perfectly.

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

## Enable UDP through your VPS

The Worker itself does not open UDP sockets. The optional relay receives a TLS/TCP stream from the Worker and forwards framed datagrams using a real UDP socket on your VPS.

### 1. Prepare a DNS name and TLS certificate

Create a DNS-only A record such as `relay.example.com` pointing to your VPS public IPv4 address. Do not proxy this relay hostname through Cloudflare. Issue a TLS certificate for that hostname (for example, with Certbot). The certificate hostname must match `UDP_RELAY_HOST` configured in the Worker.

### 2. Deploy the relay on the VPS

Copy the `relay/` directory to your VPS. Create `relay/.env` with:

```dotenv
UDP_RELAY_LISTEN_PORT=8443
UDP_RELAY_SECRET=PASTE_THE_SAME_RANDOM_SECRET_USED_BY_THE_WORKER
UDP_RELAY_TLS_CERT=/etc/letsencrypt/live/relay.example.com/fullchain.pem
UDP_RELAY_TLS_KEY=/etc/letsencrypt/live/relay.example.com/privkey.pem
```

Generate a secret with `openssl rand -hex 32`. Keep it private and use the exact same value on the Worker.

Build and run with Docker:

```bash
docker build -t vless-udp-relay ./relay
docker run -d --name vless-udp-relay --restart unless-stopped --network host --env-file relay/.env -v /etc/letsencrypt:/etc/letsencrypt:ro vless-udp-relay
docker logs -f vless-udp-relay
```

Allow inbound **TCP 8443** in your VPS/cloud firewall. The relay uses outbound UDP to destinations, so allow outbound UDP and stateful return traffic. Do not expose an inbound UDP listener for this relay.

### 3. Configure Worker secrets

From the project directory, set the relay hostname, port, and shared secret as encrypted secrets:

```bash
npx wrangler secret put UDP_RELAY_HOST
npx wrangler secret put UDP_RELAY_PORT
npx wrangler secret put UDP_RELAY_SECRET
```

Use `relay.example.com`, `8443`, and the same random secret used in `relay/.env`. Keep `VLESS_UUID` and `WS_PATH` unchanged. Then deploy:

```bash
npm test
npm run deploy
```

### 4. Client settings and limitations

Keep the existing VLESS + WebSocket + TLS profile pointed at the Worker hostname and path. Enable UDP support in the client/profile if it has a UDP toggle; do not change the server address to the VPS. TCP requests continue to use the existing direct Worker TCP path.

The VPS relay rejects private/reserved destinations, limits datagram sizes and per-session throughput, and closes idle sessions. UDP is carried inside TCP between the Worker and VPS, so packet loss can delay later packets (head-of-line blocking). This is a compatibility bridge, not native end-to-end UDP; test voice/video calls on the actual mobile networks and apps before relying on it.

Never commit `.env`, certificates, UUIDs, WebSocket paths, or relay secrets to Git.