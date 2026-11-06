# TuckBox

Private file sharing on Cloudflare Workers, D1, Backblaze B2, and Cloudflare R2.

## Architecture

- A Cloudflare Worker authorizes uploads, downloads, previews, file management, and access-code-protected shares.
- Backblaze B2 and Cloudflare R2 store private file objects under the `files/` prefix.
- D1 stores file metadata, the explicit object storage backend for each file and upload session, and encrypted application settings.
- The Worker calculates SHA-256 as upload streams pass through it.
- Expiring share links are independent of file retention. File expiration triggers object deletion.

Both storage providers use their S3-compatible APIs. Credentials are never exposed to the browser.

## Runtime secrets

Set three Worker Secrets:

| Secret | Purpose |
| --- | --- |
| `ADMIN_PATH` | Private administrator URL segment (letters, numbers, underscores, or hyphens) |
| `ADMIN_PASSWORD` | Administrator password (at least 6 characters) |
| `APP_MASTER_KEY` | Random 32-byte base64 value used to encrypt D1 settings and derive session/share-code keys |

Generate the master key locally:

```sh
openssl rand -base64 32
```

Keep these secrets out of source control. The master key protects encrypted D1 settings with AES-256-GCM and derives purpose-specific keys via HKDF-SHA256. Rotating the master key without re-encrypting existing settings and protected share codes makes them unreadable. Changing the administrator password invalidates existing admin sessions after deployment.

No B2/R2 credentials, regions, account IDs, or bucket names are required as Worker Secrets or Variables.

## Build/deploy environment

Supply the following build-time values:

| Variable | Purpose |
| --- | --- |
| `D1_DATABASE_NAME` | Name of a newly created D1 database |
| `D1_DATABASE_ID` | UUID of that D1 database |

`scripts/configure-d1.mjs` generates the gitignored `wrangler.generated.jsonc`, including the native `DB` binding.

### Start with a fresh D1 database

The sole SQL migration, **`migrations/0001_initial.sql`**, creates only:

- `files`, with indexes for creation and expiration.
- `upload_sessions`, with a required `backend` value of `b2` or `r2`.
- `app_settings`, containing encrypted B2, R2 and optional VirusTotal configuration.

There is no storage-reset table, import bookkeeping table, historical data migration, automatic bucket clearing, or compatibility mode. File records must contain an explicit `backend`. Absent or invalid backend values are rejected rather than silently mapped to B2.

**Use a new D1 database for this fresh-start schema.** Changing the contents of `0001_initial.sql` does not replay a migration already marked as applied by Wrangler on an older database. Pointing this release at a database created with previous schemas will not automatically upgrade that schema. This repository deliberately does not ship destructive resets or historical compatibility scripts. Do not reuse an old D1 database without a separately planned, explicit migration.

## Deploy

Create a new D1 database through Cloudflare, set the D1 build variables and the three Worker Secrets, then run:

```sh
bun install
bun run deploy
```

The deploy script applies the initial D1 migration, builds, and publishes the Worker. To deploy via a Cloudflare Git-connected build:

```text
Build command:  bun run build
Deploy command: bun run deploy:publish
```

## Configure storage in the admin dashboard

1. Navigate to `https://your-domain/<ADMIN_PATH>` and sign in using `ADMIN_PASSWORD`.
2. Open **Object storage settings**.
3. Configure one or both providers:
   - **Backblaze B2:** Private bucket name, region (for example `us-west-004`), application key ID, and application key.
   - **Cloudflare R2:** Cloudflare account ID, private R2 bucket name, and R2 S3 API access key ID/secret. The S3 endpoint is `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` with the `auto` signing region.
4. Save. The Worker verifies the bucket can be listed before storing credentials encrypted in D1.
5. Optionally enter a VirusTotal API key in the same settings page.

On each upload, select **Object storage backend**. Only configured providers appear. The selected provider is stored in the upload session and completed file record. Downloads, previews, deletes, and expiration cleanup always use that recorded provider; changing the upload selection does not migrate existing files.

B2 and R2 must use bucket-scoped read/list/write/delete credentials. You can configure either backend independently. Keep its credentials valid as long as files stored there still exist.

## Local development

Copy `.dev.vars.example` to `.dev.vars`, set the three Worker Secrets, and supply `D1_DATABASE_NAME` and `D1_DATABASE_ID` to the development shell.

```sh
bun install
bun run dev
```

Local development applies `0001_initial.sql` to the local D1 database. Configure the private object storage providers in the local administrator dashboard.

## Cleanup and safety

Only one scheduled cleanup runs: **every six hours**, expired files are deleted from the specific backend recorded on each file, and abandoned uploads are cleaned from the backend recorded on their upload sessions. There is no first-run wipe or periodic whole-bucket reset. Objects outside the app's tracked files are never scanned and bulk-deleted as part of setup.

Keep B2 and R2 buckets private. Downloads go through the authenticated Worker, and session/download cookies are Secure, HttpOnly and SameSite=Strict. The admin file list currently returns up to 500 records, and HTTP Range downloads are not implemented.
