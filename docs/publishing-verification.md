# Publishing behavior and failure scenarios

Written before implementing the publishing flow. Verify against an isolated deployed Worker and R2 bucket; never replace the public mirror with test data.

- No password configured: upload APIs stay locked. Only a correct, high-entropy, one-time setup token can establish the password. A second setup attempt cannot replace it.
- Wrong password, missing/forged/expired session, cross-origin requests, and excessive login attempts cannot upload, publish, activate, or abort releases.
- Passwords and session tokens never appear in page source, logs, public manifests, or Git. Cookies are Secure, HttpOnly, SameSite=Strict. The private bucket stores a salted password verifier, never the password.
- Reject unsafe filenames, unsupported formats, invalid sizes, invalid IDs, invalid part numbers/lengths, and invalid hash values.
- Upload a deterministic archive larger than one multipart part with a long filename. Interrupt after the first part, resume with a new client, and verify both hashes against independently computed local values.
- Reject a part whose supplied MD5 differs from the R2-confirmed part ETag. Incomplete completion cannot change the live release. A pending upload leaves the previous public file and checksums unchanged.
- Publish the same filename with different bytes as a second release. The current page, API, checksums, and download must agree; the first immutable download URL must still serve the original bytes.
- Two uploads started against the same current release cannot silently supersede each other. The losing publication remains a complete archived release and requires explicit activation against the latest current ID.
- Completion retries are idempotent. Aborting a pending upload never removes the current file; aborting a completed release is rejected.
- Roll back to the first release and verify its full bytes and both hashes. A stale rollback request fails with a conflict instead of overwriting a newer selection.
- Verify pinned byte ranges, suffix ranges, ETag revalidation, unavailable/missing routes, and that private storage paths are not public endpoints.
- Check the actual upload/login/setup pages at narrow and desktop widths. Exercise file selection, upload progress, completion, and release activation in browser automation when available.
- Save a repeatable end-to-end command and a JSON evidence report with release IDs, independent hashes, checked behaviors, and timestamps. Keep credentials out of the report.
