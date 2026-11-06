# TuckBox

Private file sharing on Cloudflare Workers, D1, Backblaze B2, and Cloudflare R2.

## Architecture

- A Cloudflare Worker authorizes uploads, downloads, previews, file management, and access-code-protected shares.
- Backblaze B2 and Cloudflare R2 store private file objects under the `files/` prefix.
- D1 stores file metadata, a required storage ID for each file and upload session, and encrypted per-ID storage configurations.
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
- `upload_sessions`, with a required `storage_id` referencing a configured storage ID.
- `app_settings`, containing encrypted B2, R2 and optional VirusTotal configuration.

There is no storage-reset table, import bookkeeping table, historical data migration, automatic bucket clearing, or compatibility mode. File records must contain an explicit `storageId`. A missing or unknown storage ID is rejected; a provider name such as `b2` or `r2` is not a substitute for an ID.

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

## Configure multiple storage IDs in the admin dashboard

1. Navigate to `https://your-domain/<ADMIN_PATH>` and sign in using `ADMIN_PASSWORD`.
2. Open **Object storage settings** and select **Add storage**.
3. Assign a unique, permanent identifier such as `b2-primary`, `b2-backup`, `r2-photos`, or `r2-archive`. IDs must begin with a lowercase letter, contain 2–32 lowercase alphanumeric/underscore/hyphen characters, and are unique across all providers.
4. Select the provider for this ID and enter its credentials:
   - **Backblaze B2:** Private bucket name, region (for example `us-west-004`), application key ID, and application key.
   - **Cloudflare R2:** Cloudflare account ID, private bucket name, and R2 S3 API access key ID/secret. The S3 endpoint is `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` with signing region `auto`.
5. Save. The Worker verifies bucket listing access before encrypting the config in D1. Repeat to add as many as 32 independent storage IDs of either provider.

**When uploading, choose the storage ID, not the provider.** Only configured IDs appear. The selected ID is persisted in the upload session (`storage_id`) and the completed file's JSON record (`storageId`). Downloads, previews, deletions and expiration cleanup always use that exact ID, not a global B2/R2 preference.

Storage IDs and their provider types cannot be changed after creation. Bucket/account/region changes and deleting a storage ID are blocked while any file or upload session references that ID. Credentials may be rotated without changing the storage location. Keep credentials available while files exist. Removing a configuration does not delete an entire bucket.

Configure the optional VirusTotal API key separately in Object storage settings. All storage credentials are encrypted in D1 using `APP_MASTER_KEY`; no additional Worker Secrets, Variables, or R2 bindings are required.

## Local development

Copy `.dev.vars.example` to `.dev.vars`, set the three Worker Secrets, and supply `D1_DATABASE_NAME` and `D1_DATABASE_ID` to the development shell.

```sh
bun install
bun run dev
```

Local development applies `0001_initial.sql` to the local D1 database. Configure the private object storage providers in the local administrator dashboard.

## Cleanup and safety

Only one scheduled cleanup runs: **every six hours**, expired files are deleted from the specific backend recorded on each file, and abandoned uploads are cleaned from the storage ID recorded on their upload sessions. There is no first-run wipe or periodic whole-bucket reset. Objects outside the app's tracked files are never scanned and bulk-deleted as part of setup.

Keep B2 and R2 buckets private. Downloads go through the authenticated Worker, and session/download cookies are Secure, HttpOnly and SameSite=Strict. The admin file list currently returns up to 500 records, and HTTP Range downloads are not implemented.
