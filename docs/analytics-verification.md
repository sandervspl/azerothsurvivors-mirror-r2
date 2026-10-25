# Download analytics verification

Behavior and failure cases recorded before implementation. Use a dedicated staging Worker, bucket, and Analytics Engine dataset; never seed production statistics.

- A successful full GET and an explicit byte-zero range each record one start against the immutable release ID and version. Nonzero and suffix ranges, HEAD, 304, 404, 416, aliases, page views, and metadata requests must not add starts.
- A failed analytics write must not interrupt an otherwise valid download. Counts describe starts, not completed transfers, unique people, or bot-filtered downloads. Restarting from byte zero may add another start.
- Publish two distinct releases, download both after switching the current version, and verify their downloaded bytes and the per-version statistics independently.
- The stats API requires the existing admin session, accepts only fixed time windows, and never exposes storage keys, account credentials, or arbitrary SQL access. Unauthenticated and signed-out callers are rejected.
- Query the actual Analytics Engine dataset after ingestion and compare its events with admin totals, daily buckets, and version breakdowns. Poll with a bounded deadline because ingestion is asynchronous.
- Empty data must show zeros and an explanatory state. Query failures must show an error with retry rather than fabricated zero counts; uploads/history must remain usable.
- Query results use UTC day boundaries, zero-fill missing days, include archived versions, and account for the SQL API's automatic sampling weights. UI labels explain retention, sampling, and delayed updates.
- Exercise desktop and narrow mobile layouts, window switching, stats refresh, sign-out, and long version labels. Save browser screenshots and a JSON report with requests, release IDs, timestamps, independent hashes, and comparison results. Do not save passwords or session tokens.
- Page separation: `/admin` serves only uploads/history and makes no stats queries. `/admin/stats` serves only analytics, keeps its destination through sign-in/sign-out, and provides working navigation back to releases. Direct and trailing-slash stats routes remain uncached and require the existing session before loading data. Verify navigation still works when stats queries fail.
