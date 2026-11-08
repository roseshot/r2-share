# TuckBox

[![CI](https://github.com/roseshot/tuckbox/actions/workflows/ci.yml/badge.svg)](https://github.com/roseshot/tuckbox/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

**Self-hosted file sharing on Cloudflare Workers.** Keep files in your own private Backblaze B2, Cloudflare R2, or AWS S3 buckets; manage access through independent share links backed by Cloudflare D1.

TuckBox separates **file retention** from **share-link access**. One stored object can have multiple links, each with its own permissions and expiration, without duplicating file bytes.

## Highlights

- **Multi-provider storage:** configure up to 32 named B2, R2, and AWS S3 storage destinations.
- **Flexible uploads:** upload multiple files, paste images/text, zip folders in the browser, or import a public HTTP(S) URL (up to **90 MiB per file**).
- **Independent share links:** public or access-code-protected links, individual expiry, labels, and revocation.
- **Guest uploads:** issue time-limited or quota-limited public upload pages; no administrator login needed.
- **Integrity and reputation:** Worker-computed SHA-256; optional VirusTotal hash lookup, with file submission requiring separate administrator consent.
- **Streaming downloads:** previews and byte ranges through the Worker, or optional standalone Go HTTPS download nodes for GET offload.

**Security boundary:** Buckets remain private. The Worker authorizes file and share access and holds storage credentials; the browser and optional Go nodes never receive those credentials. Public share URLs are bearer links, **not** end-to-end encryption.

## Architecture

~~~text
Browser ── HTTPS ──► TuckBox Cloudflare Worker
                       ├── D1: files, shares, uploads, encrypted settings
                       ├── Private B2 / R2 / AWS S3 bucket(s)
                       └── Optional HTTPS Go download node(s)
                           (signed GET redirects; no storage credentials)
~~~

**Stack:** React, TypeScript, Vite, Hono, Cloudflare Workers + D1, Bun; optional Go 1.27.3 download node.

## Requirements

- A Cloudflare account with Workers and D1 access.
- A **private** B2, R2, or AWS S3 bucket and compatible API credentials.
- [Bun](https://bun.sh/docs/installation) and authenticated [Wrangler](https://developers.cloudflare.com/workers/wrangler/) for CLI deployment.
- A **custom domain or Worker route**: `workers_dev` and preview URLs are disabled in this repository.

## Quick start

### 1. Clone and install

~~~sh
git clone https://github.com/roseshot/tuckbox.git
cd tuckbox
bun install
bunx wrangler login
~~~

### 2. Create a D1 database

Create a new D1 database in the Cloudflare dashboard or with Wrangler. Then export the **actual** database name and UUID in the shell used for building/deploying:

~~~sh
export D1_DATABASE_NAME="tuckbox-db"
export D1_DATABASE_ID="<your-D1-database-UUID>"
~~~

These are **build/deploy environment variables**, not Worker runtime secrets. `scripts/configure-d1.mjs` generates the ignored `wrangler.generated.jsonc` with the D1 binding named `DB`. Never commit the generated file with a real database ID.

**New installations require a new D1 database.** The only SQL file, `migrations/0001_initial.sql`, creates the complete current schema; TuckBox does not include older-schema upgrade scripts.

### 3. Configure required Worker secrets

Configure these three **runtime secrets** for the `tuckbox` Worker in Cloudflare (or through Wrangler when the Worker exists):

| Secret | Purpose |
| --- | --- |
| `APP_MASTER_KEY` | Base64-encoded 32-byte master key for encrypted settings and derived keys. |
| `ADMIN_PATH` | Secret URL segment for the administrator dashboard (letters, digits, `_`, `-`). |
| `ADMIN_PASSWORD` | Administrator login password; 6-character minimum, but use a much stronger unique value. |

Generate a master key on a trusted local machine:

~~~sh
openssl rand -base64 32
~~~

Back up `APP_MASTER_KEY` outside Git; losing it makes encrypted settings and protected-share codes unreadable. Provider credentials and the optional VirusTotal API key are configured later through the administrator dashboard, **not** as Worker secrets.

### 4. Deploy and configure the domain

~~~sh
bun run deploy
~~~

The script runs **remote D1 schema initialization → Vite build → Wrangler deploy**. Configure the custom domain or route for `tuckbox` in Cloudflare; the default `workers.dev` URL is disabled.

Open `https://your-domain/<ADMIN_PATH>`, sign in, then:

1. In **Object storage settings**, add a storage ID and private bucket credentials.
2. Select that **Storage ID** on the upload screen.
3. Upload a file and copy its generated share link.

For Cloudflare Git-connected builds, production secrets, migration commands, and troubleshooting, see **[Deployment guide](docs/deployment.md)**.

## Everyday use

| Task | Where |
| --- | --- |
| Upload files/folders, paste content, or import a URL | Admin upload dashboard |
| Create, name, edit, or revoke a link | **File management → Share links** |
| Set when the stored file itself is deleted | **File management → File deletion** |
| Let guests upload without an account | **Public upload pages** |
| Configure providers and credentials | **Object storage settings** |
| View cached VirusTotal reports / explicitly approve sample submission | Admin file controls |
| Offload downloads to Go nodes | **Download nodes** |

Each link may be **Public** or **Access code protected**. Share expiration stops access through that link; file expiration affects *all* links and leads to scheduled object deletion. Public upload pages accept new files but do not reveal generated access codes or download URLs to uploaders.

Detailed limits, workflows, and privacy behavior are in **[User guide](docs/usage.md)**.

## Documentation

| Guide | Covers |
| --- | --- |
| [Deployment](docs/deployment.md) | First deployment, secrets, D1, bucket configuration, Cloudflare Builds, troubleshooting |
| [User guide](docs/usage.md) | Uploads, share links, public upload pages, VirusTotal, interface behavior |
| [Operations & security](docs/operations.md) | Access boundaries, cleanup, quotas, backups, monitoring, threat considerations |
| [Development](docs/development.md) | Local setup, commands, repository layout, CI and Dependabot |
| [Go download node](download-node/README.md) | Optional TLS download offload, Docker, configuration and security |

## Local development

~~~sh
cp .dev.vars.example .dev.vars
# Replace placeholders with local secrets; export D1_DATABASE_NAME and D1_DATABASE_ID.
bun run dev

# In another terminal, or before committing:
bun run typecheck
bun test
bun run build
~~~

The dev command initializes **local** D1. It does not migrate the remote database. `bun run build` requires the two D1 environment variables. See the [Development guide](docs/development.md) for details, including current lockfile limitations.

## Security notes

- **Keep buckets private** and grant the fewest required storage permissions; never expose access keys or secret values in source control.
- **Protect the administrator URL and password.** Rotate secrets deliberately; preserve a secure backup of `APP_MASTER_KEY`.
- **Use edge abuse protection** in addition to built-in rate limits. Short share IDs can be guessed; public uploads and share links are sensitive bearer URLs.
- **Review VirusTotal consent:** automatic checks send only SHA-256. Complete file bytes are submitted **only after explicit per-file administrator authorization**, and VirusTotal may share the sample.
- **Monitor cleanup and node health.** Expired files are removed in bounded daily batches, not instantaneously.

See [Operations & security](docs/operations.md) before exposing TuckBox to the internet.

## Contributing and support

Found a bug or have a feature request? [Open a GitHub issue](https://github.com/roseshot/tuckbox/issues). For code changes, run `bun run typecheck`, `bun test`, and `bun run build`; for Go changes run `go test -race ./...` and `go vet ./...` in `download-node/`. Source, comments, UI strings, and documentation are written in English.

## License

TuckBox is licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0). Review its network-service obligations before modifying or redistributing the application.
