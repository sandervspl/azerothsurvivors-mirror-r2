# Download mirror

Public mirror: https://azerothsurvivors-mirror.sandervspl.dev

Upload and release management: https://azerothsurvivors-mirror.sandervspl.dev/admin

## Upload a new version

Sign in at the admin page, choose a RAR, ZIP, or 7z archive (up to 10 GiB), optionally enter a version label, and click **Upload & publish**. SHA-256 and MD5 are calculated automatically while reading the file in 32 MiB chunks. Each chunk is checked against the MD5 ETag returned by R2 before publication.

The archive, hashes, filename, and size are stored together in a release manifest. The public page reads the current manifest, so uploading a new version requires no code changes or deployment.

If interrupted, reopen the page, select the same file, and resume. Uploaded chunks are checked and skipped. Pending uploads expire after 24 hours; discard expired uploads and start again. Discarding never removes a completed release.

Every upload gets a unique R2 key and permanent download URL, even with an identical filename. Publication succeeds only if the current release has not changed since the upload started. A conflicting upload is retained in history for explicit activation.

Use **Make current** in history to roll back or activate an archived version. Previous files and manifests remain intact; there is no automatic deletion of old versions.

## Download statistics

Sign in at `/admin` to see download starts today, over the last 7 and 30 UTC calendar days, a daily chart, daily numbers, and a breakdown by immutable release. Select a 7, 30, or 90 day chart window and use **Refresh stats** to query again. Statistics begin when tracking is deployed; previous downloads cannot be reconstructed.

The Worker records `download_start` only after R2 supplies a successful full GET or an explicit range beginning at byte zero. It excludes HEAD, revalidation, redirects, errors, nonzero ranges, and suffix ranges (including suffixes large enough to cover the entire file). Restarts from zero and automated requests can count again. These are starts observed by the Worker, not completed transfers or unique people; a file served entirely from a browser or upstream cache may not reach it.

Events contain only the release ID, version label, event type, and a count. No IP addresses, user agents, cookies, or other visitor identifiers are recorded by this feature. A `tracking_enabled` event creates the dataset on the first request of a Worker instance, even before anyone downloads; it is excluded from statistics. Analytics failures never block archive delivery.

The `DOWNLOAD_ANALYTICS` binding writes to `azerothsurvivors_downloads`. The `ANALYTICS_SQL` binding queries the account-scoped dataset without an API token. The protected `/api/admin/stats?days=30` endpoint accepts only 7, 30, or 90; it exposes aggregate results and never accepts SQL. The Analytics SQL API automatically applies sampling weights to `COUNT(*)`; do not manually multiply this API's counts by `_sample_interval`. The separate legacy Analytics Engine SQL API used for independent verification requires explicit sampling weights.

Cloudflare retains Analytics Engine data for three months, ingestion can take minutes, and counts may be sampled estimates. This feature does not maintain a lifetime total. Failed queries show an error and a refresh control instead of zero counts. The staging Worker writes to a separate dataset, `azerothsurvivors_downloads_staging`.

## First-time admin setup

The owner chooses the production password directly through a private one-time setup link. It is never sent to the agent or stored in Git.

The setup hash is a Cloudflare Worker secret. A salted PBKDF2-SHA-256 verifier and a random session signing key are stored in the private R2 bucket. Sessions expire after 12 hours and use Secure, HttpOnly, SameSite=Strict cookies. Mutations require the same Origin; setup and sign-in attempts are rate limited. The setup link stops working once a password is configured.

For a new environment:

~~~powershell
node scripts/setup-admin.mjs https://your-worker.workers.dev admin
cf deploy --secrets-file .local/admin-secrets.json
~~~

Open the private URL saved in **.local/admin-setup-url.txt** and set the password. The token is removed from the address bar immediately and submitted only to this site's setup API. Keep it out of public messages and Git. The entire .local directory is ignored.

Do not rerun setup for a configured admin. To reset a lost password, first generate and deploy a fresh setup hash using a new local label. Then use the authenticated Cloudflare CLI to delete **only admin/auth.json** from the private bucket, and immediately open the new setup link. This invalidates all sessions without affecting releases.

## Command-line publishing

~~~powershell
npm run upload -- 'C:\path\to\new-archive.rar' 'Version label'
~~~

The command asks for the password with hidden input, calculates both full-file hashes, uploads and verifies parts, then publishes. It saves only an unfinished upload ID and file information in **.local/cli-upload.json**, so rerunning the same command resumes it. Credentials are not saved. Automation can supply MIRROR_ADMIN_PASSWORD through a secret manager, never a command-line argument.

An optional third argument selects another mirror URL. A publication conflict means the archive is complete and available in history for activation. After discarding a CLI upload in the web UI, remove its obsolete local resume file before starting another upload.

## Develop and deploy

Requires Node.js 22+, the cf CLI, and access to the configured Cloudflare resources.

~~~powershell
npm ci
npm run dev
npm run typecheck
npm run deploy
~~~

Cloudflare configuration declares the Worker, custom domain, private R2 bucket, setup secret, rate limiter, Analytics Engine dataset, and Analytics SQL binding. Existing secrets are retained on ordinary deployments. The browser uploader is bundled locally by client-build.ts; no CDN scripts are used.

The original mirror archive was retained at its existing R2 key and given an initial manifest. Both hashes were independently calculated from the local archive. All new uploads use releases/{release-id}/{filename} keys.

## Storage and public routes

| R2 key | Purpose |
| --- | --- |
| release.json | Current release selected with conditional writes to prevent concurrent overwrite |
| manifests/{id}.json | Immutable release metadata |
| history/{reverse-time}-{id}.json | History ordered newest first |
| releases/{id}/{filename} | Immutable new archive objects |
| uploads/{id}/... | Upload state and verified part receipts |
| admin/auth.json | Private password verifier and session signing key |

| Route | Purpose |
| --- | --- |
| / | File information, download button, and hashes from the current manifest |
| /download | Uncached redirect to the current immutable download |
| /downloads/{id}/{filename} | Versioned file with HEAD, ranges, If-Range, and ETag support |
| /api/release | Current release metadata, without private storage keys |
| /api/releases/{id} | Archived release metadata |
| /checksums.txt?release={id} | SHA-256 checksum file for a pinned release |

Private R2 objects are not exposed by a generic object-serving route. Selection responses use no-store; immutable downloads can be cached without mixing versions. Full-file hashes are computed by the authenticated browser or CLI, with R2-confirmed part MD5 checks protecting transfer integrity. Live verification independently rehashes the entire downloaded file.

## Verification

~~~powershell
npm run verify
npm run verify -- https://azerothsurvivors-mirror.sandervspl.dev 'C:\path\to\archive.rar'
~~~

This pins the current version, downloads it across independent range requests, verifies SHA-256 and MD5, and checks caching, invalid ranges, aliases, and HTTP errors. The optional archive argument also validates against a local source file. Evidence is saved in artifacts/e2e.json.

Publishing tests use a separate staging Worker and bucket. Provision them before running the following; these fixtures never replace production:

~~~powershell
cf r2 buckets create --name azerothsurvivors-release-staging --location-hint weur
node scripts/setup-admin.mjs https://azerothsurvivors-release-staging.sandervispoel.workers.dev staging
Push-Location tools/staging
cf deploy --secrets-file ../../.local/staging-secrets.json
Pop-Location
npm run verify:publishing
npm run verify:recovery
npm run verify:browser
npm run verify:auth
~~~

The API scenario uploads a 33 MiB archive with a long Unicode filename, resumes in a different client, verifies both hashes and all downloaded bytes, tests same-name replacement, publication conflicts, incomplete uploads, rollback, authentication, and origin checks. The recovery scenario deliberately removes a staging history index and verifies that retrying completion restores it without changing the current release or archive.

The browser scenario forces a network failure after part one, reloads, resumes without resending that part, publishes, verifies every downloaded byte and both hashes, rolls back, and signs out. It uses an isolated headless Chrome instance; set CHROME_PATH if necessary.

Evidence includes publishing-e2e.json, browser-e2e.json, and desktop/mobile screenshots in artifacts. Test-only credentials stay in ignored local files. Failure scenarios are recorded in docs/publishing-verification.md.

For analytics verification, provision the dedicated staging bucket as above, generate setup files with label `analytics-staging`, deploy the staging Worker with `--secrets-file ../../.local/analytics-staging-secrets.json`, then run `npm run verify:analytics`. The scenario publishes two small archives, verifies their bytes, exercises excluded requests, waits up to four minutes for real Analytics Engine ingestion, compares the independent SQL API with the admin API, and exercises the charts, time windows, query error/empty states, mobile layout, and sign-out. Browser error/empty states use intercepted API responses; download counting and aggregate comparisons use the real deployed services. Evidence is saved to `artifacts/analytics-e2e.json`, `analytics-desktop.png`, and `analytics-mobile.png`. The test records its baseline and fresh release IDs so it can be repeated; run it without other staging download traffic. Failure cases are in `docs/analytics-verification.md`.

`npm run verify:analytics:production` performs read-only live checks of the production page, release, HEAD/nonzero range delivery, admin protection, deployed stats assets, and the production Analytics SQL dataset. It adds no synthetic download starts and saves `artifacts/analytics-production.json`. The authenticated admin flow is verified on staging, where test credentials and archives are isolated.

After testing, abort pending staging uploads, delete the staging Worker, empty **only** its dedicated test bucket, and delete that bucket. Historical evidence remains useful after this disposable environment is removed.
