# Deployment guide

[← README](../README.md) · [Operations & security](operations.md) · [Development](development.md)

This guide covers **new deployments** of TuckBox to Cloudflare Workers. It uses a Cloudflare D1 database and private S3-compatible storage; the Go download service is optional.

## Prerequisites

- Cloudflare account with permission to create Workers, D1 databases, secrets, routes, and scheduled triggers.
- Private Backblaze B2, Cloudflare R2, or AWS S3 bucket and appropriately scoped API credentials.
- [Bun](https://bun.sh/docs/installation), Wrangler (installed through the package), and Cloudflare login for CLI deployment.
- Custom domain or Worker route. The project's `wrangler.jsonc` explicitly disables `workers_dev` and preview URLs.

The Worker service is named **`tuckbox`**. A differently named service is not automatically renamed or removed. Configure the new Worker's routes, secrets and bindings before switching production traffic.

## 1. Prepare the source

~~~sh
git clone https://github.com/roseshot/tuckbox.git
cd tuckbox
bun install
bunx wrangler login
~~~

`package.json` defines these tasks:

| Command | Effect |
| --- | --- |
| `bun run dev` | Apply the baseline to **local** D1, then start Vite |
| `bun run build` | Generate D1 binding config, then build Worker + assets |
| `bun run db:migrate` | Apply pending SQL to **remote** D1 |
| `bun run deploy` | Remote migration → build → deploy |

**Never run a production migration against a database you have not reviewed or backed up.** Unlike `bun run dev`, `bun run db:migrate` acts on the remote database specified by your environment.

## 2. Create a fresh D1 database

Create a D1 database from the Cloudflare dashboard or Wrangler. For example:

~~~sh
bunx wrangler d1 create tuckbox-db
~~~

Record the resulting **database name and UUID**, then supply both in the build/deploy environment:

~~~sh
export D1_DATABASE_NAME="tuckbox-db"
export D1_DATABASE_ID="<actual-database-UUID>"
~~~

Both values are mandatory for the build and migration scripts. `scripts/configure-d1.mjs` writes the gitignored `wrangler.generated.jsonc` with binding `DB`; it does not modify the tracked `wrangler.jsonc`. You do not need to store the database UUID in Git.

The only SQL file is `migrations/0001_initial.sql`, a baseline creating eight tables:

| Table | Purpose |
| --- | --- |
| `files` | File metadata and retention |
| `shares` | Independent per-file access links and access codes |
| `upload_sessions` | Upload reservations and quota tracking |
| `app_settings` | Encrypted storage and service settings |
| `storage_usage` | Scheduled per-storage usage snapshots |
| `public_upload_pages` | Guest upload link limits |
| `virustotal_queue` | Pending hash lookups and optional sample submission authorization |
| `virustotal_reports` | Cached reputation results |

**Older or partially upgraded schema layouts are not supported.** There are no historical data conversions, backfills, or compatibility migrations. This repository does **not** automatically delete an existing D1 database. For an existing installation, verify its schema and take a backup before pointing this version at it; the baseline file is not a repair tool.

Cloudflare tracks which migration filenames have been applied. Deploying does not reset existing data.

## 3. Set runtime secrets

Configure the following Worker secrets for `tuckbox` using the Cloudflare dashboard's **Variables and Secrets** section (or Wrangler's `secret put` command if appropriate to the current service state):

| Secret | Constraints |
| --- | --- |
| `APP_MASTER_KEY` | Random **32-byte** value encoded in Base64 |
| `ADMIN_PATH` | Secret path segment of letters, digits, `_`, `-` |
| `ADMIN_PASSWORD` | At least six characters; prefer a long unique password |

Generate the master key locally:

~~~sh
openssl rand -base64 32
~~~

**Keep a secure independent backup of `APP_MASTER_KEY`.** The Worker derives session and access-code encryption keys from it; a lost or changed master key cannot decrypt existing settings and protected-share codes.

These are **runtime secrets**, distinct from build-time `D1_DATABASE_NAME` and `D1_DATABASE_ID`. The tracked configuration declares the required secret names but not their values. Do not commit `.dev.vars`, private keys, cloud credentials, or the generated D1 config.

Store provider credentials and the optional VirusTotal API key in **Admin → Object storage settings / Settings**, after deploying. They are stored encrypted in D1 instead of as separate Wrangler variables.

## 4. Deploy

~~~sh
bun run deploy
~~~

This executes:

1. `bun run db:migrate` to apply the baseline to remote D1 if pending.
2. `bun run build` to build the React assets and Worker with Cloudflare's Vite plugin.
3. `wrangler deploy` to publish the application.

Set a **custom domain or Worker route** for the `tuckbox` Worker in Cloudflare; it cannot be opened through an implicit `workers.dev` URL.

Browse to:

~~~text
https://your-domain/<ADMIN_PATH>
~~~

Log in with the configured password. If no storage has been configured, the dashboard prompts you to add one.

## 5. Add an object-storage destination

In **Object storage settings → Add storage**, choose a unique **Storage ID** and provider, then configure:

| Provider | Required settings |
| --- | --- |
| Backblaze B2 | Bucket, region (for example `us-west-004`), application key ID, application key |
| Cloudflare R2 | Bucket, 32-character account ID, S3 access key ID, secret access key |
| AWS S3 | Private bucket, AWS region, access key ID, secret access key |

Storage IDs must match `^[a-z][a-z0-9_-]{1,31}$`: 2–32 characters, beginning with a lowercase letter. Storage provider, bucket, and endpoint settings cannot be reassigned while files or upload sessions use that ID; rotating credentials is supported.

- Keep buckets **private** and grant the least privilege necessary. The application verifies bucket listing access when adding a storage.
- For AWS S3, grant `s3:ListBucket` at the bucket scope and `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` for `tuckbox/*`. Other providers need equivalent private object/bucket permissions.
- R2 uses the S3 endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` and signing region `auto`.
- AWS S3 uses `https://s3.<region>.amazonaws.com/<bucket>` (path-style). China-region endpoints are not supported.
- Keep credentials solely in encrypted Worker-side settings. Browsers and download nodes do not receive them.
- Removing a storage configuration **does not** delete the bucket. In-use destinations cannot be removed until all references are cleared.

Choose the **Storage ID** when uploading; selecting a provider name alone is insufficient.

## Cloudflare Git-connected builds

You can connect this repository through Cloudflare **Workers Builds**. In the Cloudflare build environment, configure:

- `D1_DATABASE_NAME` and `D1_DATABASE_ID` as **build-time variables**.
- `APP_MASTER_KEY`, `ADMIN_PATH`, and `ADMIN_PASSWORD` as **Worker runtime secrets**.
- The custom route/domain and all other Worker-side settings for the correct service.

Suggested commands when separate build and deploy steps are supported:

~~~text
Build command:   bun run build
Deploy command:  bun run db:migrate && wrangler deploy
~~~

This avoids building twice. Using `bun run deploy` as the deploy command also works, but will rebuild after the platform's build step. Use **one production deployment pipeline**, and confirm the resulting Worker version and routes in Cloudflare. A green GitHub CI run does **not** mean production has deployed.

The repository's CI uses a placeholder D1 name/ID for compilation and does not apply migrations to production.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `D1_DATABASE_NAME is required` / `D1_DATABASE_ID is required` | Export both build/deploy variables in the executing environment. |
| Missing `shares` or another table | Confirm that the **current baseline schema** was initialized in the target D1 database; use `bun run db:migrate` for a **fresh** database. Do not expect removed SQL files to repair older databases. |
| Secrets missing on deploy | Set the three required runtime secrets on `tuckbox` and rerun deployment. |
| Worker deployed, but no public URL | Configure its custom domain or route; `workers_dev` is disabled. |
| Cannot add a storage | Check bucket name, provider endpoint/account, key scope, and listing permission. |
| Cannot remove or relocate storage | Clear all files and upload sessions referencing its immutable Storage ID. |
| Public link unavailable | Check link revocation/expiry and the underlying file's retention state. |
| GitHub CI succeeded, but app is unchanged | Inspect Cloudflare Workers Builds/deployment status and environment selection. |

For expired-file cleanup, backup strategy, credential rotation, rate limiting, and operational caveats see [Operations & security](operations.md).

## Official references

- [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare Workers Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/)
- [Cloudflare Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)
