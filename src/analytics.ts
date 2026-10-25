import { HttpError, type Env } from "./core";
import type { Release } from "./releases";

let initialized = false;
function write(env: Env, event: string, id: string, version = "") {
  try {
    env.DOWNLOAD_ANALYTICS.writeDataPoint({ indexes: [id], blobs: [event, version], doubles: [1] });
    return true;
  } catch {
    // Analytics must never prevent file delivery. Do not log request/user data.
    console.warn("Download analytics write unavailable");
    return false;
  }
}
export function initializeAnalytics(env: Env) {
  // Creates the dataset before the first download; excluded from every stats query.
  if (!initialized) initialized = write(env, "tracking_enabled", "_system");
}
export function recordDownload(env: Env, release: Release) {
  write(env, "download_start", release.id, release.version);
}

const DAY = 86400000;
interface Row { day: string; releaseId: string; version: string; downloads: number | string }
export async function downloadStats(env: Env, window: string) {
  if (!["7", "30", "90"].includes(window)) throw new HttpError(400, "Choose a 7, 30, or 90 day window.");
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(env.ANALYTICS_DATASET)) throw new HttpError(503, "Download statistics are not configured.");
  const days = Number(window);
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const day = (time: number) => new Date(time).toISOString().slice(0, 10);
  let rows: Row[];
  try {
    const result = await env.ANALYTICS_SQL.query({
      query: `SELECT toDate(timestamp) AS day, index1 AS releaseId, blob2 AS version, COUNT(*) AS downloads
        FROM events.analyticsEngine.${env.ANALYTICS_DATASET}
        WHERE timestamp >= $start AND timestamp <= $end AND blob1 = 'download_start'
        GROUP BY day, releaseId, version ORDER BY day ASC LIMIT 10001`,
      params: { start: new Date(today - 89 * DAY).toISOString(), end: now.toISOString() },
    });
    // Analytics SQL automatically weights COUNT for sampled event datasets.
    rows = result.data as unknown as Row[];
    if (!Array.isArray(rows) || rows.length > 10000) throw new Error("Unexpected analytics result");
  } catch {
    throw new HttpError(503, "Download statistics are temporarily unavailable. New datasets can take a few minutes to appear. Try refreshing shortly.");
  }
  const first = day(today - (days - 1) * DAY);
  const seven = day(today - 6 * DAY);
  const thirty = day(today - 29 * DAY);
  const daily = Array.from({ length: days }, (_, index) => ({ date: day(today - (days - index - 1) * DAY), downloads: 0 }));
  const buckets = new Map(daily.map(value => [value.date, value]));
  const versions = new Map<string, { id: string; version: string; downloads: number }>();
  const totals = { today: 0, last7Days: 0, last30Days: 0, selected: 0 };
  for (const row of rows) {
    const count = Number(row.downloads);
    const date = String(row.day).slice(0, 10);
    if (!Number.isFinite(count) || count < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(503, "Download statistics returned an invalid result. Try refreshing shortly.");
    if (date === day(today)) totals.today += count;
    if (date >= seven) totals.last7Days += count;
    if (date >= thirty) totals.last30Days += count;
    if (date < first) continue;
    totals.selected += count;
    const bucket = buckets.get(date);
    if (bucket) bucket.downloads += count;
    const release = versions.get(row.releaseId) || { id: row.releaseId, version: row.version, downloads: 0 };
    release.downloads += count;
    versions.set(row.releaseId, release);
  }
  return { days, timezone: "UTC", generatedAt: now.toISOString(), totals, daily, versions: [...versions.values()].sort((a, b) => b.downloads - a.downloads) };
}
