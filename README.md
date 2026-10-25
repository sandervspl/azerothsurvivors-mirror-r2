# Azeroth Survivors download mirror

Public website: https://azerothsurvivors.sandervispoel.workers.dev

A small Cloudflare Worker serves the download page and streams the Windows archive from the private `azerothsurvivors-downloads` R2 bucket. The site is public and requires no login. It does not depend on the old file server. The archive stays outside Git.

## Develop and deploy

Requires Node.js 22+ and the Cloudflare `cf` CLI, authenticated to the account containing the bucket.

```powershell
npm ci
npm run dev
npm run typecheck
npm run deploy
```

Configuration lives in `cloudflare.config.ts`. No custom domain is configured; the original domain and server are unchanged.

## Release

- Object key / download name: `AzerothSurvivorsWindowsNew.rar`
- Size: 760,497,456 bytes (725.3 MiB)
- SHA-256: `971db7968dc37ec50b18d64a1de7f693e137f6793a7368e4d5c27bd9522eccd8`
- MD5 (legacy): `7748bfdffaccd2f46d868cf69ad3e72c`
- Contents: `AzerothSurvivors.exe` and the accompanying `Data` directory.

Routes:

| Route | Purpose |
| --- | --- |
| `/` | Responsive download page and installation instructions |
| `/download` | R2 archive download |
| `/downloads/AzerothSurvivorsWindowsNew.rar` | Named download alias |
| `/checksums.txt` | Downloadable SHA-256 checksum |
| `/api/release` | Release metadata |

Downloads support HEAD, byte ranges, suffix ranges, ETags, conditional requests, and If-Range so download managers can resume. R2 bodies stream directly to the response without loading the archive into Worker memory. The object ETag is checked between the metadata lookup and stream retrieval. Unavailable objects return an uncached 503 with a retry interval.

## Repeatable live verification

```powershell
npm run verify
# Or target another deployment:
npm run verify -- https://your-worker.workers.dev
```

The HTTP E2E scenario downloads all 760 MB across 23 independent byte-range requests, validates the complete SHA-256, and checks suffix/open-ended ranges, invalid requests, caching, stale resume validators, file headers, and route errors. It writes `artifacts/e2e.json`, including the deployment URL, timestamps, checked behavior, total bytes, and computed hash. It keeps no downloaded copy of the archive.

Responsive visual verification uses the actual page HTML at desktop and phone widths, including expanded checksum instructions and clipboard-denied fallback. See `artifacts/visual-qa.json` for recorded checks. The HTML is self-contained and makes no external asset requests.

## Upload the archive

`cf r2 objects put` supports up to 300 MB, below this archive's size. The optional temporary Worker in `tools/upload` uses the [R2 multipart API](https://developers.cloudflare.com/r2/api/workers/multipart-usage/) with 32 MiB parts. It accepts only the documented archive key and requires a random bearer credential generated locally. No upload route exists on the public website.

```powershell
node scripts/upload.mjs init
Push-Location tools/upload
cf deploy --secrets-file ../../.local/upload-secret.json
Pop-Location
node scripts/upload.mjs https://azerothsurvivors-upload.sandervispoel.workers.dev 'C:\path\to\AzerothSurvivorsWindowsNew.rar'
cf workers delete azerothsurvivors-upload --force
npm run verify
```

The upload script validates the local archive hash before sending it, retries individual parts, aborts failed multipart transfers, and writes a size/hash receipt to `artifacts/upload.json`. On an ambiguous network failure during completion, check the R2 object and run live verification before retrying. After a successful upload, delete the temporary Worker as shown, then remove `.local/upload-secret.json`. Initialization deliberately refuses to overwrite an existing credential.

When changing the release, update `src/release.ts`, the visible metadata in `src/page.html`, the uploader metadata/hash guard, and the E2E release expectation together. Upload first, deploy the corresponding metadata, and rerun verification. The existing scripts intentionally reject unreviewed archive changes.
