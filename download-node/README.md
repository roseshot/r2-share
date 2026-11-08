# TuckBox Go download offload node

Standalone Go 1.23+ service to **stream** authorized TuckBox downloads directly
from a private Backblaze B2, Cloudflare R2, or AWS S3 bucket. No D1 or TuckBox
admin password is needed on this service, and no third-party Go dependencies
are required. The main Cloudflare Worker remains the authorization authority.

## Request flow

```text
Browser -- GET /api/files/<Share ID>/download --> Cloudflare Worker
                        |
                Validate share existence / expiration / access code
                        |
                Issue 90-second signed download grant
                        |
                   HTTP 307 redirect
                        |
                  Go download node
                  (verify HMAC, host and expiry)
                        |
                Private S3-compatible GET
                        |
          Stream bytes straight to browser
```

Only **GET downloads** are offloaded. Share metadata, access-code unlocks,
**HEAD preflight**, public or admin uploads, file previews, and administrative
actions remain on the Worker. If `DOWNLOAD_NODES` is omitted, the current Worker
download path is unchanged.

## Quick start

1. Deploy the binary or Docker image to a VPS/server. Put it behind an **HTTPS
   reverse proxy** that preserves the original HTTP `Host` header. Its own
   listener is plain HTTP on port 8080 by default.
2. On the Go server, set:
   - `DOWNLOAD_NODE_SECRET`: **the same random secret** used by the Worker,
     at least 32 characters (`openssl rand -hex 32`).
   - `STORAGES_JSON`: a JSON array of your private B2/R2/S3 storage
     definitions. **IDs must exactly match TuckBox Admin's Storage IDs**.
     Use **read-only GetObject permissions** where your provider allows it.
   - `LISTEN_ADDR`: defaults to `:8080`.
   - `CORS_ORIGIN`: optional, a single HTTPS origin for explicit cross-origin
     clients. Normal browser downloads do not require this.
3. On the Cloudflare Worker, configure **optional secrets**:
   `DOWNLOAD_NODE_SECRET` and `DOWNLOAD_NODES`. Example:

   ```sh
   # Enter the SAME value as on the Go server when prompted:
   bunx wrangler secret put DOWNLOAD_NODE_SECRET
   # Enter: https://dl1.example.com,https://dl2.example.com
   bunx wrangler secret put DOWNLOAD_NODES
   bun run deploy
   ```

   Configure secrets for the deployed Worker used by the project; if your
   setup uses a different Wrangler config, specify the corresponding config.
   All nodes should have matching storage configuration and the same secret.

Build and test locally:

```sh
cd download-node
go test ./...
go vet ./...
go build -o tuckbox-download-node .
# Set environment variables from your secret manager, then:
./tuckbox-download-node
```

Docker build and run:

```sh
docker build -t tuckbox-download-node ./download-node
docker run --rm -p 127.0.0.1:8080:8080 --env-file ./download-node/.env tuckbox-download-node
```

Copy `.env.example` to `.env` on the server, replace placeholders, protect
file permissions, and **never commit `.env`**. Check `GET /healthz` on the
Go server from your reverse proxy/monitor.

### Storage configuration examples

Supply the corresponding JSON entry in `STORAGES_JSON`:

```json
[
  {"id":"b2-primary","backend":"b2","bucket":"my-bucket","region":"us-west-004",
   "keyId":"B2_KEY_ID","applicationKey":"B2_APPLICATION_KEY"},
  {"id":"r2-media","backend":"r2","bucket":"media","accountId":"0123456789abcdef0123456789abcdef",
   "accessKeyId":"R2_ACCESS_KEY_ID","secretAccessKey":"R2_SECRET_ACCESS_KEY"},
  {"id":"aws-backup","backend":"s3","bucket":"archive","region":"us-east-1",
   "accessKeyId":"AWS_ACCESS_KEY_ID","secretAccessKey":"AWS_SECRET_ACCESS_KEY"}
]
```

The node generates private, SigV4-authenticated S3 **GET/HEAD** requests
against the same path-style endpoints as TuckBox. No bucket URLs or credentials
are sent to the browser. It streams full downloads and single byte ranges
(HTTP 206); invalid/multipart ranges return 416. Upstream HTTP status,
byte count, and `Content-Range` are verified before responding.

### Multiple nodes / traffic steering

`DOWNLOAD_NODES` is a comma-separated set of **HTTPS origins** (maximum 16,
no paths, query strings or embedded credentials). The Worker selects a node
using a stable hash of the **File ID**, keeping new range/resume requests for
the same file on the same node. This is **distribution**, not active health
balancing; a down node will make downloads assigned to it fail until the
configuration is changed. Do not use Cloudflare-proxied/orange-cloud node
hostnames if your goal is to move download egress off Cloudflare; instead use
DNS-only hostnames pointed at the Go servers and terminate TLS there.

### Security and operational notes

- The Worker first validates each share/access code (or admin session).
  Grants are HMAC-SHA256 signed, scoped to an exact storage ID/object key,
  bound to the selected node's hostname and expire after **at most 90 seconds**.
  The Go node never receives the user's access code or admin session cookie.
- Like any short-lived signed URL, a grant **can be reused** until it expires,
  even if the share is revoked during that time. Restrict who can read HTTP
  access logs containing query strings. Never log download tokens.
- The node validates only known `tuckbox/<UUID v4>` or legacy
  `files/<16-character ID>` object keys. It never accepts arbitrary upstream
  URLs, and the bucket stays private.
- Node `Host` must match the host in the signed grant; preserve it through
  your TLS reverse proxy. Keep clocks synchronized using NTP.
- Keep the Go node credentials read-only and the shared secret outside Git.
  Rotate the same secret on all nodes and the Worker together.
- There is no automatic failover, rate limiting, or bandwidth accounting.
  Monitor node health, outbound bandwidth, response latency and S3 costs.
  Private bucket `GetObject` charges and node egress fees may apply.
