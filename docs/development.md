# Development guide

[← README](../README.md) · [Deployment](deployment.md) · [User guide](usage.md)

This repository contains a Cloudflare Worker API, a React application, and an optional standalone Go download node. All source code, comments, UI text and documentation are written in **English**.

## Requirements

- [Bun](https://bun.sh/docs/installation), with Vite, Wrangler and TypeScript dependencies installed from `package.json`.
- Cloudflare credentials for live deployments; local development uses a local D1 database.
- Go **1.27.3+** for the separate `services/download-node/` service, when changing or running it.

## Start the application locally

~~~sh
git clone https://github.com/roseshot/tuckbox.git
cd tuckbox
bun install
cp .dev.vars.example .dev.vars
~~~

Replace example values in the **gitignored** `.dev.vars`. For instance, generate a fresh local `APP_MASTER_KEY` with `openssl rand -base64 32`; set a nontrivial `ADMIN_PATH` and `ADMIN_PASSWORD`. Do not copy production secrets into test environments.

Set the required D1 build parameters in your shell:

~~~sh
export D1_DATABASE_NAME="tuckbox-local"
export D1_DATABASE_ID="<D1-database-UUID>"
bun run dev
~~~

The `dev` task generates `wrangler.generated.jsonc`, applies `database/migrations/0001_initial.sql` to **local D1** and starts Vite with the Cloudflare Workers plugin. Local data is independent of the remote production D1 database. Configure local object-storage destinations through the running administrator dashboard.

`D1_DATABASE_NAME` and `D1_DATABASE_ID` are required even for compilation because the build generates the `DB` binding. The generated config is excluded from Git.

## Validation

~~~sh
bun run typecheck
bun test
bun run build
~~~

The build uses the D1 variables set above. To exercise a remote migration without deploying, use **`bun run db:migrate`** only when you intend to change the specified remote database; it is not a test command.

For the Go node:

~~~sh
cd services/download-node
go test -race -count=1 ./...
go vet ./...
go build .
docker build --file Dockerfile --tag tuckbox-download-node:local .
~~~

See [Go download node](../services/download-node/README.md) for TLS, environment variables and Docker runtime configuration.

## Fonts

JetBrains Mono is bundled locally through `@fontsource-variable/jetbrains-mono` and Vite. The application imports the normal-style variable font in `src/main.tsx`; its WOFF2 files are built into same-origin `/assets/` files and served with Cloudflare Workers static assets. Body text uses the system sans-serif stack. Do not add runtime Google Fonts or third-party font CDN requests. JetBrains Mono is licensed under SIL Open Font License 1.1; its package retains the license notice.

## Repository layout

~~~text
src/
  main.tsx                Vite / React application entry
  pages/                  Route-level UI (admin, home, sharing, guest upload)
  components/             Reusable UI primitives, dialogs and theme
  features/
    admin/                Administrator settings and share controls
    files/                Previews, checksums and file metadata
    uploads/              Upload queue, clipboard and folder ZIP logic
  lib/                    Shared frontend API types and route utilities
worker/                   Hono Worker entry and server-side integrations
database/migrations/      D1 schema baseline
services/download-node/   Independent Go HTTPS download service + Dockerfile
tests/                    Bun integration and regression tests
docs/                     Deployment, usage, operations and development guides
scripts/                  D1 binding generation and maintenance scripts
.github/                  CI workflows and Dependabot configuration
wrangler.jsonc            Worker deployment configuration
vite.config.ts            Vite + Cloudflare Worker plugin
~~~

### Database conventions

- D1 baseline: `database/migrations/0001_initial.sql` only, for fresh installations.
- File UUIDs and object paths: `tuckbox/<file-uuid>`; share IDs are independent short strings.
- Older schema conversions, `files/<legacy-id>` paths, and 16-character old file IDs are not supported.
- The test helper in `tests/d1-helper.ts` initializes the current schema directly.

## CI

The [CI workflow](../.github/workflows/ci.yml) runs on pushes to `main` and pull requests.

| Job | Checks |
| --- | --- |
| `validate` | Install Bun and dependencies, TypeScript typecheck, Bun tests, Worker/assets build |
| `Go download node` | Go race tests, `go vet`, binary build, Docker build |

CI uses a synthetic D1 UUID and **does not** migrate or publish a production Worker. Cloudflare production deployments are a separate process; see [Deployment](deployment.md).

**Reproducible installs:** The repository commits the Bun text lockfile (`bun.lock`). CI installs Bun 1.4.4 and runs `bun install --frozen-lockfile`; CI fails if `package.json` and the lockfile disagree. For local development, use `bun install --frozen-lockfile` to reproduce the pinned dependencies. When updating packages, run `bun install` with the supported Bun version and commit the updated `bun.lock` alongside `package.json`.

## Dependabot and automatic merging

[Dependabot configuration](../.github/dependabot.yml) checks **npm, Go modules, Docker images, and GitHub Actions** weekly (Thursday, 01:00 UTC). It has **no version ignore rules**.

The [auto-merge workflow](../.github/workflows/dependabot-auto-merge.yml) evaluates successful PR CI after completion, using trusted `main` code. It:

- Can squash-merge **patch, minor, major, and prerelease** versions.
- Checks Dependabot identity/metadata, source commit signatures and successful PR CI.
- Rejects mismatched/stale head or base SHAs and other invalid merge contexts.

This is a **post-CI custom merge workflow**, not GitHub's native per-PR Auto-merge switch. For defense in depth, configure branch protection on `main` to require successful CI, when your repository's rules permit it.

**Risk:** Major and prerelease dependency upgrades are intentionally eligible for merging. Tests and deployment monitoring remain necessary, especially after breaking upstream releases.

## Contributing

Before filing a report, search [Issues](https://github.com/roseshot/tuckbox/issues) for an existing discussion. Include reproducible steps, expected vs. actual results, affected browser/runtime versions, and relevant logs **with all tokens, codes and storage credentials removed**.

For source changes, add focused regression tests and run the checks above. Keep commits concise and use [Conventional Commits](https://www.conventionalcommits.org/). Avoid modifying production D1 data or deploying from CI test jobs.

## Helpful references

- [GitHub repository README guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes)
- [Cloudflare Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/)
- [Cloudflare D1 local development](https://developers.cloudflare.com/d1/best-practices/local-development/)
- [Bun package management](https://bun.sh/docs/pm/cli/install)
