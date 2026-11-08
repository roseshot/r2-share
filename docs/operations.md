# Operations and security

[← README](../README.md) · [Deployment](deployment.md) · [User guide](usage.md) · [Go download node](../services/download-node/README.md)

TuckBox is a self-hosted file-sharing service, not a managed security product. Operators are responsible for bucket isolation, credentials, abuse prevention, uptime, backups, and local regulatory requirements.

## Security model

| Component | Trust boundary |
| --- | --- |
| Browser / visitor | Receives only authorized metadata and content; never bucket access credentials |
| Cloudflare Worker | Validates admin sessions, share permissions, codes and expiration; holds storage credentials |
| D1 | Stores file metadata, independent shares, upload reservations and encrypted application settings |
| Private B2 / R2 / S3 | Stores objects at `tuckbox/<UUID-v4>`; must not expose public object URLs |
| Optional Go node | Verifies signed, short-lived download grants and streams presigned content; no bucket credentials |

### Secrets and encryption

- Set required `APP_MASTER_KEY`, `ADMIN_PATH`, and `ADMIN_PASSWORD` as **Worker secrets**.
- `APP_MASTER_KEY` is a 32-byte Base64 master key. The Worker uses HKDF to derive keys for session signatures, access-code encryption and encrypted D1 settings. Store an offline backup securely.
- Object-storage API keys, the optional VirusTotal key, and download-node configuration are entered through the administrator interface and stored encrypted in D1.
- Never commit credentials, `.dev.vars`, TLS private keys, `wrangler.generated.jsonc` with production IDs, or local Go-node `.env` files.
- Cloudflare Worker `secrets.required` validates that named secrets exist at deployment, but **does not provide or rotate their values**.
- Do not rotate `APP_MASTER_KEY` without first planning how encrypted settings and existing protected access codes will be recovered or replaced. Changing it without re-encryption makes those records unreadable.

### Permissions and public exposure

- Buckets must be private; grant only required list/get/put/delete capabilities on designated bucket paths.
- A **public share URL is a bearer token**: anyone with it can download that file until it expires or is revoked. Access codes add a gate but do not provide end-to-end encryption.
- Guest-upload pages are also bearer URLs: protect their distribution and configure quota and/or expiration.
- Admin entry path obscurity is **not** a substitute for a strong password, HTTPS, and edge-level abuse controls.
- The Worker has login and access-code rate-limit bindings; add suitable Cloudflare WAF / edge policies where needed. Short share IDs can be enumerated.
- Expiration checks happen at request time, but already downloaded data cannot be revoked.
- Optional Go nodes must be exposed publicly over HTTPS, either with native TLS or behind a trusted HTTPS reverse proxy forwarding to the node's private HTTP listener. Do not expose plain HTTP to the internet. Keep DNS-only hostnames if the goal is to avoid routing download egress through Cloudflare.

### VirusTotal privacy

Normal reputation lookups send **SHA-256 only**, not the file bytes or share link. File-content submission occurs only after an administrator explicitly authorizes the specific file. VirusTotal may retain or share submitted samples; do not submit confidential content without authorization and review. Missing/clean reputation results are not proof of safety.

## Scheduled maintenance

`wrangler.jsonc` runs the Worker cron at **00:01 UTC daily** (`1 0 * * *`).

| Task | Per-run limit / behavior |
| --- | --- |
| Expired stored files | Deletes at most **10** per run, including object and associated D1 shares |
| Abandoned upload reservations | Cleans up to **10** per run |
| VirusTotal reputation queue | Processes up to **4** distinct pending hashes |
| Per-storage usage | Recalculates snapshot from D1 managed-file records after cleanup |

Deletion backlogs require additional scheduled runs; reaching a retention deadline blocks access **before** background object deletion happens. Monitor the backlog for growing storage bills.

When a file is deleted, TuckBox deletes its object under `tuckbox/<file-uuid>` from the recorded storage destination and removes its associated share rows and other relevant metadata. It does **not** enumerate or purge unrelated bucket content.

### Usage reporting

The dashboard's **Storage used** data is the *last cleanup snapshot*, not a real-time inventory.

- Counts TuckBox-managed file records per configured storage ID.
- Includes expired file records that are still awaiting deletion.
- Excludes objects uploaded outside the app and abandoned object data not represented as file records.
- Shows **Awaiting first cleanup** before the first successful maintenance run.
- A storage with no file records shows zero after the first snapshot is calculated.

## Backups and recovery

**Recommended operator checklist:**

1. Keep an offline copy of `APP_MASTER_KEY` and secure storage credentials under an appropriate secret-management policy.
2. Back up D1 before schema changes, application upgrades, or destructive maintenance. Verify restoration using a nonproduction D1 database.
3. Enable suitable bucket backups/versioning or recovery controls if required by your retention policy.
4. Test that a recovered database's Storage IDs still point to the intended buckets and that protected shares decrypt correctly.
5. Monitor the scheduled cron and storage availability after every deployment.

The repository provides **one current D1 baseline** (`database/migrations/0001_initial.sql`) for new installations, not historical schema conversion. Older/partially upgraded databases are unsupported; a new code checkout cannot reconstruct missing metadata or deleted objects.

### Credential rotation

Rotate B2/R2/S3 credentials in **Object storage settings** without changing the associated storage ID, bucket or provider. In-use storage destinations cannot be moved or removed. Update the Go-node shared secret consistently across all configured nodes; changing only one side interrupts offloaded downloads.

## Optional Go download nodes

[See the dedicated Go node guide](../services/download-node/README.md) for installation, certificates, Docker, and environment variables.

Important operational distinctions:

- Nodes require `NODE_DOMAIN` and `DOWNLOAD_NODE_SECRET`. Set both `TLS_CERT_FILE` and `TLS_KEY_FILE` for native HTTPS; omit both to serve HTTP behind a TLS-terminating reverse proxy. Setting only one fails startup. A reverse proxy must preserve the public `Host` header.
- The Worker sends a short-lived **HMAC-signed**, AES-256-GCM-encrypted grant, valid at most **90 seconds**, containing presigned S3 GET/HEAD URLs. Nodes decrypt the presigned object URLs in the grant, but never receive long-lived bucket credentials.
- Only authorized **GET downloads** are redirected. HEAD availability checks, previews, metadata, uploads and admin actions continue through the Worker.
- A valid grant can still be reused until expiry, including briefly after a link is revoked. Never log grant-bearing query strings.
- Selection across up to **16** nodes is based on a stable file-ID hash, not health. **There is no automatic failover**; monitor each hostname, certificates, resource limits, bandwidth, and upstream errors.
- Public node origins should be **DNS-only (unproxied)** if the objective is to offload Cloudflare download traffic. Cloudflare-proxied nodes still carry traffic through Cloudflare.
- Keep the shared download secret and any TLS private key out of Git; synchronize clocks and renew certificates wherever TLS terminates.

## Known limits and considerations

| Concern | Behavior |
| --- | --- |
| File size | Up to **90 MiB** per browser upload/import |
| Share IDs | Random 8–10 Base64URL characters; deploy additional edge abuse protection |
| Download range requests | One byte range; multipart range requests rejected |
| Node streaming | Direct server egress can incur bucket request and bandwidth fees |
| Metadata retention | File deletion also revokes shares; independent link expiry alone does not delete bytes |
| Worker URL exposure | `workers_dev` and preview URLs are disabled; configure a route or domain |
| Browser preview | Archives are download-only; previewing content is not malware scanning |
| Dependency updates | All Dependabot update types, including major and prerelease, may be auto-merged after CI |

**Major and prerelease dependency auto-merge is intentionally enabled** in this repository. CI passing does not guarantee application-level compatibility or production safety; review deployment signals and keep backups.

## Monitoring and troubleshooting

Check Cloudflare Worker logs, D1 errors, scheduled trigger results, Cloudflare deployment history, private bucket access errors, and Go-node health checks. The GitHub CI workflow validates source but **does not deploy** the Worker to production.

| Symptom | Initial check |
| --- | --- |
| Repeated 401/403 | Administrator/session login, share code, expired links, rate limiter |
| 404 on share/download | Revoked/expired link, missing file, expired object |
| Unexpected storage use | Last cron run and snapshot timestamp; compare with bucket inventory |
| Downloads fail only with node offloading | Node TLS, `NODE_DOMAIN`, secret consistency, network health |
| No public URL | Custom Worker route/domain; `workers_dev` is off |
| VirusTotal reporting delays | API key, pending hashes, provider rate limits and daily schedule |
| Deployment fails for secrets | Required runtime secret values on the target Worker |
| Missing D1 table | Validate that the current baseline schema exists; see [Deployment](deployment.md) |

## Further reading

- [Cloudflare Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
