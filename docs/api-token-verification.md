# API token behavior and failure cases

Recorded before implementation. Verify with the dedicated staging Worker/bucket and browser E2E workflow; do not create test tokens or upload fixtures in production.

- Token creation, listing, and revocation require the password-authenticated session. Mutations require same-origin requests. Bearer credentials alone cannot manage tokens, access statistics, or activate existing releases.
- Generate a high-entropy token on the server, reveal it only in its creation response, and store only its SHA-256 digest. List responses, HTML, logs, local upload state, screenshots, and evidence must not include the secret or its digest.
- Malformed, forged, unknown, expired, revoked, or query-string credentials cannot upload. A bad Authorization header cannot fall back to an otherwise valid session cookie. Requests carrying a foreign Origin are rejected; scripts with a valid Bearer header and no Origin are accepted.
- Tokens can read release history and create/publish/resume/discard only their own upload jobs. A different token cannot modify another token's job or a browser-created upload. The password session can still manage all jobs.
- Keep the existing multipart length/MD5 verification, incomplete-publish protection, immutable release URLs, and concurrency controls. Verify a file over one chunk, resume it with a new token client, independently hash and compare the complete download, and upload through the actual CLI environment-token entry point without a password.
- Expiry and revocation take effect on subsequent requests, including an interrupted upload. An admin authentication reset invalidates tokens from the previous signing-key generation. Re-authenticating with the original password remains possible after the staging key-rotation simulation.
- Concurrent token creation/revocation must use conditional registry writes so tokens are not lost or resurrected. Bound active tokens and validate names and expiry selections.
- The tokens page must be reachable by admin navigation and direct login, show secrets once, clear them on dismissal/reload, list names and expiry, and revoke without exposing credentials. Other admin pages must not load token data. Check mobile overflow and browser errors.
- Save repeatable E2E evidence with token IDs, checked statuses, independently verified archive hashes, and screenshots taken after clearing the secret. Never print token values, password/session cookies, or credential-bearing request traces.
