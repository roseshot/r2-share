# TuckBox

Private, self-hosted file sharing built on **Cloudflare Workers**, **D1**, **Backblaze B2**, and **Cloudflare R2**. Store each file once, then issue multiple independent sharing links.

## Features

- Upload multiple files, drag in folders as ZIP archives, or paste images, files, and plain text (**90 MiB per upload**).
- Choose a named storage ID at upload time; configure up to **32** B2 or R2 storage instances.
- Create multiple links for one file, each with its own admin-only name, public/protected access, optional access code, and expiration.
- Revoke or update one link without affecting other links or duplicating the stored object.
- Keep file retention separate from link expiration; manage file deletion independently.
- Download any supported file or preview images, PDFs, text, audio, and video in the browser. Archive files (ZIP, TAR, TGZ, etc.) are download-only; their contents are not parsed or previewed.
- Verify uploaded content with Worker-computed **SHA-256**; optionally look up the hash on VirusTotal.
- Apply database changes through versioned SQL migrations.

The Worker handles authorization and streams files from private S3-compatible buckets. Storage credentials remain server-side.

## How it works

```text
Browser ── HTTPS ──► Cloudflare Worker
                      ├── D1: files, shares, upload sessions, encrypted settings
                      └── Private object storage
                          ├── Backblaze B2 (one or more storage IDs)
                          └── Cloudflare R2 (one or more storage IDs)
```

A **file** owns its metadata, storage ID, object, and retention deadline. A **share link** points to a file and has its own ID, access policy, access code, and expiration. Share permissions are checked for every public metadata, preview, and download request.

## Requirements

- A Cloudflare account with **Workers** and **D1** enabled.
- A private Backblaze B2 or Cloudflare R2 bucket and its S3 API credentials.
- [Bun](https://bun.sh/) for development, tests, and builds.
- Wrangler access to the Cloudflare account for local/CLI deployment.
- A custom domain or route for the Worker: `workers_dev` and preview URLs are disabled by default.

Keep the object bucket private; do not use a public bucket URL as a substitute for Worker authorization.

## Quick start

### 1. Create a D1 database

Create a D1 database in the Cloudflare dashboard or with Wrangler. Record its **name** and **database UUID**.

Export both values in the terminal that will run Bun or Wrangler:

```sh
export D1_DATABASE_NAME="your-d1-database"
export D1_DATABASE_ID="00000000-0000-4000-8000-000000000000"
```

Replace the example UUID with your real database ID. Both variables are required by `scripts/configure-d1.mjs`, which generates the gitignored `wrangler.generated.jsonc` containing the `DB` binding. Do not commit live database IDs or secrets.

### 2. Configure Worker secrets

Create these **Worker Secrets** in Cloudflare's dashboard under **Workers & Pages → your Worker → Settings → Variables and Secrets**:

| Secret | Purpose |
| --- | --- |
| `ADMIN_PATH` | Private administrator URL segment, containing only letters, numbers, `_`, or `-`. |
| `ADMIN_PASSWORD` | Administrator password; at least 6 characters are required, but use a long, unique password. |
| `APP_MASTER_KEY` | Base64-encoded, randomly generated 32-byte key protecting app settings and access-code encryption keys. |

Generate the master key **locally**:

```sh
openssl rand -base64 32
```

The application derives its internal session and code-encryption keys from `APP_MASTER_KEY`. **Back up this key securely.** Replacing or losing it without a coordinated re-encryption process makes encrypted storage configuration and existing protected-link codes unreadable. Do not put any of these values in Git.

Object storage credentials and the optional VirusTotal API key are configured later in the admin dashboard, not as Worker Secrets.

### 3. Install and publish

```sh
bun install
bun run deploy
```

The `deploy` command directly runs **remote D1 migrations → Vite build → Wrangler deploy**. Each step must succeed before the next begins. For database migrations only, use `bun run db:migrate`.

Because `workers_dev` is disabled, configure a **custom domain or Worker route** in Cloudflare before opening the app.

### 4. Add storage and upload

1. Visit `https://your-domain/<ADMIN_PATH>` and sign in.
2. Open **Object storage settings → Add storage**.
3. Give the storage an immutable ID, for example `b2-primary`, `b2-backup`, or `r2-media`.
4. Choose **B2** or **R2**, provide the private bucket name and provider-specific credentials, and save.
5. Select the **storage ID**, not merely the provider, when uploading a file.

Each storage ID has separate credentials and a bucket. IDs must start with a lowercase letter and be 2–32 characters long, using lowercase letters, digits, `_`, or `-`. The app checks bucket listing access before saving a configuration.

| Provider | Required settings |
| --- | --- |
| Backblaze B2 | Bucket, region (for example `us-west-004`), application key ID, application key |
| Cloudflare R2 | Bucket, 32-character account ID, R2 S3 access key ID, secret access key |

R2 uses `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` and the signing region `auto`. Storage settings are encrypted in D1 with a key derived from `APP_MASTER_KEY`.

Storage IDs and provider types cannot be renamed. Deleting a storage configuration or changing its bucket/account/region is blocked while files or upload sessions reference it; credential rotation is supported. **Removing a storage configuration never deletes an entire bucket.**

The upload dashboard supports **Choose files** (multiple selection), **Choose folder**
(recursive selection), and dragging files or folders into the upload area. Each folder
becomes a **single ZIP archive** before uploading; nested file paths are retained
inside the ZIP, and separate folder roots produce separate ZIPs. Loose files remain
individual uploads. ZIP creation happens in the browser, not the Worker, and does
not modify the original local files. Browser support for folder selection and
folder drag-and-drop varies. Empty folders contain no uploadable files.

Press **Ctrl+V** (or the platform's Paste shortcut) on the admin page to enqueue
clipboard **files and images**, or **plain text** saved as a timestamped `.txt`
file. Pasting into inputs or other editable fields retains normal editing behavior.
Clipboard permission and available formats vary by browser.

Each queued item (loose file, generated ZIP, or pasted text/image) is uploaded
**individually** to the selected Storage ID, sequentially. The limit is **90 MiB per
upload**, including ZIP files; folder ZIP creation rejects folders with more than
90 MiB of input, and verifies the final ZIP size. A folder has a limit of 500
contained files; the upload queue holds at most 500 entries. Display filenames
must be at most **240 characters**.

All files in a batch use the selected share expiration and access policy, but
**each file receives its own share link** (and its own generated access code,
when that option is enabled). The dashboard shows overall and per-file progress,
then retains a separate share URL, copy/open actions, access code, and expiration
for every successful file. Failed files remain queued for retry; successful files
are not uploaded again. If storage has not been configured, **Configure storage**
jumps to the setup form.

## Managing files and share links

After upload, a file receives one initial share link. Its link ID matches the file ID; further links get independent random 16-character IDs.

In **File management**, click the **file name** to rename it, or click **File deletion**
to set a specific local date and time (or **Never**). Changes take effect only after
clicking **Save**; Cancel leaves the record unchanged. Renaming changes D1 display
metadata and the download filename, not the object storage key or existing share URLs.
The file deletion date applies to the file and its links, but editing it does
**not change any individual Share Link expiration**.

In **File management**, use:

- **Share links** to create, copy, edit, or revoke links individually.
- **File settings** to change the file's retention deadline independently.
- **Download** to retrieve the original file as an administrator.
- **Delete file** to remove the stored object and all of its share links.

A link can be **Public** (anyone with the URL) or **Access code protected**. Access codes may be supplied by the administrator or generated automatically. Protected access is remembered in a Secure, HttpOnly, SameSite=Strict cookie for up to **24 hours**; changing a link's settings invalidates that link's existing authorization. Authorization is not shared between links.

Supported expiration choices are **Never**, **1 hour**, **24 hours**, **3 days**, and **7 days**. A share's expiration immediately blocks access through that link but does **not** delete the file or affect sibling links. File expiration blocks all links and the scheduled cleanup later deletes the file object. New uploads have no file expiration unless an administrator changes it.

VirusTotal integration is optional. The lookup sends the file's **SHA-256 hash**, not its contents; it is a reputation check, **not an antivirus scan or guarantee of safety**.

## Notifications and confirmations

The admin dashboard uses **Sonner toasts** for successful uploads, saves, copies, and link changes. Newly generated access codes are available from the share-link controls and shown in a longer-lived toast with a **Copy code** action. Errors that require correcting a form stay visible inline; authentication and share access-code failures are also shown next to their forms. File uploads retain a real-time progress indicator.

Deleting a file, revoking an individual share link, or removing a storage configuration requires an accessible **Base UI Alert Dialog** confirmation. Canceling does not send a delete request. An operation failure remains visible in the dialog, and the dialog stays open for retry.

The file management screen provides server-side filename search, storage filtering, creation-time sorting, and 25-file pagination. Share links can be given optional admin-only names to distinguish their intended recipients.

## Database and migrations

D1 holds four tables:

| Table | Role |
| --- | --- |
| `files` | Object metadata, storage ID, creation time, and file expiration |
| `shares` | Multiple independent links per file, including admin-only names, encrypted access codes and share expiration |
| `upload_sessions` | In-progress upload reservations associated with a storage ID |
| `app_settings` | Encrypted storage configurations and optional VirusTotal key |

Versioned migrations:

| File | Effect |
| --- | --- |
| `migrations/0001_initial.sql` | Initial `files`, `upload_sessions`, and `app_settings` schema |
| `migrations/0002_file_shares.sql` | Adds `shares` and migrates existing single-link settings into the first share |
| `migrations/0003_share_labels.sql` | Adds optional admin-only names without changing share URLs or access settings |

The `0002` migration preserves existing links' **IDs/URLs, access codes, and expiry**. File metadata retains compatibility fields from the initial schema; the `shares` table is authoritative for link access.

**For a new installation:** use a new D1 database; `bun run deploy` applies both migrations.

**For an existing installation using this repository's `0001` schema:** back up the D1 database, review pending SQL, then apply `0002` through the normal deploy workflow. Do not wipe the database or edit an already-applied migration.

**For a database created with a different, older schema:** this repository does not provide an automatic legacy-schema conversion. Plan and test a separate migration before pointing the Worker at that database.

Useful commands:

```sh
# Apply only pending SQL migrations to remote D1 (no Worker deployment).
bun run db:migrate

# Deploy, including remote migration and build.
bun run deploy
```

Cloudflare D1 tracks applied migrations. Applying a migration does not re-run previously recorded migration files. Keep database backups before schema changes; production data is not recreated by the build.

## Development and CI

For local development, copy the example Worker secrets file and edit only your local copy:

```sh
cp .dev.vars.example .dev.vars
# Set D1_DATABASE_NAME and D1_DATABASE_ID in your shell.
bun install
bun run dev
```

`bun run dev` applies migrations to **local** D1 and starts Vite. Local database contents are separate from the remote production D1 database. Configure local storage instances in the local dashboard.

Run validation before pushing:

```sh
bun run typecheck
bun test
bun run build
```

The build requires `D1_DATABASE_NAME` and `D1_DATABASE_ID` in the environment. GitHub's **CI** runs typechecking, tests, and a Worker/assets build, but it does **not** publish to Cloudflare or migrate a production database.

**Reproducible builds:** the repository currently has **no committed Bun lockfile**, so `bun install` may resolve newer package versions allowed by `package.json`. For strictly reproducible CI and releases, commit a generated `bun.lock` and then switch CI to frozen-lockfile installation.

## Cloudflare Git-connected deployment

For **Workers Builds** connected to this GitHub repository, provide `D1_DATABASE_NAME` and `D1_DATABASE_ID` as **build environment variables**, and configure the same runtime Worker Secrets listed above.

Use these commands to avoid building twice:

```text
Build command:  bun run build
Deploy command: bun run db:migrate && wrangler deploy
```

The build generates the Worker bundle and deployment configuration through the Cloudflare Vite plugin; Wrangler locates the generated deployment configuration afterward. The deploy command applies pending **remote** migrations before publishing the built Worker.

If you instead use `bun run deploy` as the Cloudflare **deploy command**, that is valid but runs another build after the platform has already executed the build command. Choose **one deployment pipeline** for production, and verify deployments in the Cloudflare dashboard; a green GitHub CI job alone is not proof of a production release.

## Dependency updates

`.github/dependabot.yml` schedules npm and GitHub Actions checks every **Thursday at 01:00 UTC**. The `CI` workflow validates PRs.

After successful pull-request CI, `.github/workflows/dependabot-auto-merge.yml` evaluates Dependabot metadata before merging. The policy:

- Squash-merges eligible stable **patch/minor** updates after successful CI.
- Leaves **major** and **prerelease** (including dev/beta/RC) updates for manual review.
- Rejects failed CI, mismatched or changed commits, non-Dependabot PRs, and stale base commits.

This is a post-CI merge action, not GitHub's per-PR `auto_merge` toggle. Protect `main` with a required **`validate`** CI status check in repository settings so that other merge paths are also gated; repository administration permissions are needed to configure branch protection.

## Download and preview experience

Downloads and media previews support single HTTP byte ranges, forwarded through the
authorized Worker to the configured B2/R2 bucket. The Worker rejects invalid
ranges with HTTP 416 and does not provide multipart byte-range responses.

The share page checks download availability with an authorized HEAD request
before navigating to the download endpoint, so missing files and expired
access codes can be explained inline. Preview errors provide a fallback
download link. Download authorization, access codes, and file expiration still
apply to HEAD and partial requests.

## Operations and security

- **Private buckets and least-privilege credentials:** grant only required bucket/object operations; do not expose B2/R2 credentials to the browser.
- **Access scope:** public links are bearer URLs; anyone with a valid public URL can access its file. Share links are not user accounts, and an access code is not end-to-end encryption.
- **Expiration cleanup:** the Worker runs a cron every **6 hours** (`0 */6 * * *`). Each run removes at most **10 expired files** and **10 abandoned upload sessions**; large backlogs require subsequent runs.
- **Data deletion:** file deletion targets the specific recorded storage ID and the `files/<file-id>` object. It does not enumerate or purge unrelated bucket objects.
- **Monitoring:** check Cloudflare deployment logs, Worker errors, D1 migrations, and scheduled cleanup. Treat GitHub CI and Cloudflare deployment as separate status checks.
- **Resource limits:** maximum upload size is **90 MiB**; the administrator file list returns at most **500 files**. single HTTP byte ranges are supported with **206 Partial Content** (multipart ranges return **416**).
- **Credentials and recovery:** keep a secure backup of `APP_MASTER_KEY`, use long unique administrator credentials, and test D1 backups and object storage recovery before production changes.
- **Network exposure:** `workers_dev` and preview URLs are off; configure your own Worker route/domain.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `D1_DATABASE_NAME is required` or `D1_DATABASE_ID is required` | Export both build-time values before running Bun/Wrangler. |
| Missing `shares` table | Check whether `0002_file_shares.sql` was applied to the correct D1 database; run `bun run db:migrate`. |
| Storage cannot be added | Verify the private bucket, provider credentials, and bucket-list permission. |
| Storage cannot be removed or relocated | Delete or move all files and finish/clean upload sessions referencing that storage ID. |
| Share link returns 404 | The link may be expired/revoked or the file expired/deleted; an admin can inspect remaining links. |
| Worker deployed but no public URL | Configure a custom domain or route; `workers_dev` is disabled. |
| GitHub checks pass but the app is unchanged | Check the separate Cloudflare deployment run and its environment variables. |

## References

- [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare Vite plugin / Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Cloudflare Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)
- [GitHub Dependabot configuration](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference/)
