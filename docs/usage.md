# User guide

[← README](../README.md) · [Deployment](deployment.md) · [Operations & security](operations.md)

TuckBox stores each file in one private bucket object and lets you issue multiple independent access links for that file. Administrators control storage destinations, file retention, and share-link permissions.

## Upload files and folders

In the admin upload dashboard, select a configured **Storage ID**, choose an access policy and link expiration, then:

- **Choose files** for multiple individual files.
- **Choose folder** or drag a directory to create a ZIP in the browser. Nested paths are preserved and each root folder becomes one archive.
- **Drag and drop** individual files or folders onto the uploader.
- **Paste** clipboard files or images. Plain text becomes a timestamped `.txt` file. Pasting into a text input continues to edit that input normally.

Limits and behavior:

| Item | Limit / behavior |
| --- | --- |
| Single upload, including generated ZIP | **90 MiB**, nonempty |
| Files within a folder | Up to **500** |
| Pending upload queue | Up to **500** entries |
| Filename | Up to **240** characters |
| Upload order | Sequential, one queued item at a time |
| Failures | Failed items remain available for retry; completed items are not uploaded again |

Folder ZIP creation is local to the browser, does not change the original files, and validates both input size and archive size. Browser support for folder selection, drag/drop, and clipboard formats varies. Empty folders have no uploadable files.

Every uploaded item gets a distinct **UUID v4 File ID** and an independent short **Share ID**, plus a generated access code when applicable. Each receives its own URL even when uploaded in one batch. The Worker computes the SHA-256 digest from the uploaded bytes rather than trusting a client-provided checksum.

### Import a URL (administrator only)

**Import from URL** streams a public HTTP/HTTPS resource directly through the Worker to a selected bucket. Choose a storage destination, link expiration, access mode, and optional code.

- Maximum **90 MiB**; multipart upload is used when appropriate.
- The remote source must expose a usable content length through GET or a fallback HEAD request. Unknown-length chunked-only responses are unsupported.
- Up to five redirects are followed; the filename is taken from the final URL unless explicitly specified.
- Only public HTTP/HTTPS destinations are accepted. IP literals, private/reserved hostnames, embedded credentials, and nonstandard ports are rejected on each redirect.
- The Worker does not import URL content on behalf of guest upload pages.

Public hostname validation reduces SSRF risk but cannot fully prevent DNS rebinding; **do not import from untrusted domains**. Failed imports release upload reservations and clean up partial bucket objects.

## Guest upload pages

Administrators can create a link under **Public upload pages** for contributors who do not have administrator accounts.

1. Specify a title and destination **Storage ID**.
2. Set **at least one** restriction: a time limit or successful-upload quota.
3. Share `https://your-domain/u/<page-id>` with intended contributors.

| Option | Choices |
| --- | --- |
| Time limit | Never, 1 hour, 24 hours, 3 days, or 7 days |
| Completed uploads | Optional cap of **1–1000** successful files |
| Upload methods | Files, folder ZIPs, drag/drop, paste |
| Upload size | **90 MiB** per file |

A page may be time-limited without a count limit, or count-limited without an expiration. Each completed file or ZIP consumes one slot. D1 reservations prevent concurrent visitors from exceeding the quota; failed transfers release their slots. A visitor sees one **Upload successful** confirmation when the entire batch completes, or actionable errors with retry options for partial failures.

Guest uploads are stored privately and become visible to administrators in the file list. Each guest-uploaded file receives a **protected** initial share with a random access code; the guest is **not** shown that code or a download link. Admins may later retrieve and share them.

Expired, exhausted, or revoked upload pages stop accepting new files but do not delete files uploaded earlier. Treat the guest upload URL as sensitive: possession of an active URL permits uploads, subject to its limits and rate limiting.

## File management and independent share links

### Files vs. links

| File | Share link |
| --- | --- |
| Owns the bucket object, name, storage ID, checksum and deletion deadline | Points to a file with its own short ID, label, access policy and expiration |
| File expiration blocks **every** linked URL; daily cleanup later deletes its object | Link expiration stops only that link; the file and sibling links remain |
| Renaming changes metadata and download filename, not bucket key | Links can be created, copied, edited and revoked independently |
| Deleting the file deletes the stored object and all its links | Revoking a link never deletes the underlying file |

File retention and link expiration support **Never**, **1 hour**, **24 hours**, **3 days**, or **7 days**. New files have no deletion deadline unless the administrator assigns one.

Use **File management → File deletion** to select the retention duration. Saving the selection starts the countdown from **that moment**, not upload time. Opening the selector without choosing a new duration does not change the deadline.

Click a file name to rename it using **Save** or **Cancel**. Renaming does not change its UUID object key, link URLs, or individual share expirations.

### Link access

Links are either **Public** (anyone possessing the URL) or **Access code protected**. Administrators may choose codes or allow TuckBox to generate them. Protected authorization is stored in a Secure, HttpOnly, SameSite=Strict cookie for up to **24 hours**.

- Authorization applies only to the unlocked link, not sibling links.
- Changing that link's protected access settings invalidates its prior authorization.
- A protected link is not end-to-end encryption; the Worker decrypts its stored access-code data and enforces access controls.
- Public file information, preview and download requests each enforce the relevant authorization and expiration checks.

In the file list, **Share links** manages multiple recipient-specific links; optional labels are visible only to administrators. **Delete file**, **revoke link**, and **remove storage** actions require explicit confirmation. Cancel does not issue a deletion request; a failed operation remains visible for retry.

The file list includes server-side filename search, storage filtering, creation-time sorting and pages of **25** files. API listing is capped to **500** files where applicable.

### IDs and object layout

| Identifier | Format |
| --- | --- |
| File ID | UUID v4, 36 characters |
| Share ID | Random Base64URL, 8, 9, or 10 characters |
| Guest upload page ID | Random Base64URL, 16 characters |
| Bucket object key | `tuckbox/<file-uuid>` |

Only UUID-backed bucket keys are accepted. Old file IDs and `files/<id>` object layouts are **not supported**.

### Unavailable links and decoy metadata

Unknown, expired or malformed single-segment share URLs show the regular share page. For plausible missing IDs (8–12 characters), the public metadata API returns a normal-looking deterministic placeholder instead of exposing whether a file exists.

Placeholder responses are stable for a secret-keyed, ID-specific lease of roughly **1 hour to 7 days**; regeneration requires no D1 write. They are not real uploads: preview and download endpoints never serve placeholder bytes, and unlock attempts cannot grant access. No VirusTotal report is exposed for placeholder IDs.

A private administrator path is identified by authenticated session probing, not by guessing from the share URL.

## Download and preview

The public share page checks authorized **HEAD** availability before navigating to downloads. Files and supported media previews allow single byte ranges (HTTP 206); invalid or multipart range requests return HTTP 416. Supported inline previews include images, PDF, text, audio, and video. Archives such as ZIP, TAR and TGZ are **download only** and are not parsed for previews.

When a preview cannot load, the page offers a download fallback. Protected access and expiration apply equally to normal GET, HEAD and range requests.

By default, the Worker streams bytes from the selected private B2, R2 or S3 object. An administrator can optionally configure **independent Go HTTPS download nodes**: authorized GETs then receive a short-lived signed 307 redirect, while HEAD checks, previews, uploads and admin requests remain on the Worker. See [Go download node](../services/download-node/README.md).

## VirusTotal reputation and consent

VirusTotal integration is **optional**. When configured, the Worker queues each successfully uploaded file's verified **SHA-256**. The daily scheduled task processes up to **four** distinct hashes and sends **only the digest** to the VirusTotal reputation API by default.

- A cached successful report is reused for identical file content.
- Missing reports, rate limits and temporary errors are retried on a later scheduled run.
- Opening a share or its admin controls **never** triggers a live VirusTotal request.
- Per-share **Show VirusTotal on share page** is **off by default**. When enabled, a stored result and external report link may appear after any access-code check. SHA-256 verification is separate from this display toggle.
- The administrator's report control reads saved D1 data only.

### Explicit sample submission

An administrator may select **Submit to VirusTotal** for a specific file and confirm the warning that VirusTotal may share the uploaded sample. This records **file-specific consent** in D1 and hides the action once that hash is authorized, submitted, or already has a cached report; identical hashes share one queue entry.

At the next daily run the Worker first checks whether a report already exists. Only if necessary and authorized does it send the selected file's **actual bytes**. Up to 32 MiB uses VirusTotal's direct upload endpoint; larger files use its designated upload-URL flow. Removing the authorized file revokes consent, even if another file has the same hash. A normal hash lookup alone **never** submits bytes.

When the final copy of a file hash is deleted, the corresponding unreferenced queue entry and cached report are removed. A later upload of the same bytes starts a fresh lookup.

**VirusTotal is a reputation service, not an antivirus or a guarantee of safety.** A zero-detection or missing report does not prove content is harmless.

## Interface and usage snapshots

- Upload, rename, link, and copy operations provide status notifications; generated access codes have a **Copy code** action.
- Errors needing input corrections stay visible inline; delete/revoke confirmations use an accessible dialog.
- **Storage used** shows a separate D1-calculated snapshot for each configured Storage ID (bytes, file count, calculation timestamp).
- The snapshot refreshes after scheduled cleanup, not on every upload. Prior to the first run it shows **Awaiting first cleanup**. It is **not** a live bucket inventory; unmanaged objects are excluded.

See [Operations & security](operations.md) for daily cleanup limits and operational expectations.
