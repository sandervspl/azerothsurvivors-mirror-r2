import page from "./page.html?raw";
import adminPage from "./admin.html?raw";
import adminScript from "virtual:admin-client";
import { adminApi } from "./admin-api";
import { authenticated, authRoute } from "./auth";
import { contentType, disposition, escapeHtml, HttpError, json, response, validId, type Env } from "./core";
import { current, getRelease, publicRelease } from "./releases";

function byteRange(value: string, size: number): { offset: number; length: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const offset = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || offset >= size || offset > end) return null;
  return { offset, length: end - offset + 1 };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const head = request.method === "HEAD";
    try {
      if (path.startsWith("/api/admin/")) {
        const auth = await authRoute(request, env, path);
        return auth || await adminApi(request, env, path);
      }
      if (request.method !== "GET" && !head) return response("Method not allowed", 405, { Allow: "GET, HEAD", "Cache-Control": "no-store" });
      if (path === "/admin/app.js") return response(head ? null : adminScript, 200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" });
      if (path === "/admin" || path === "/admin/" || path === "/admin/setup") {
        const mode = await authenticated(request, env) ? "dashboard" : path === "/admin/setup" ? "setup" : "login";
        return response(head ? null : adminPage.replace("__MODE__", mode), 200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" });
      }
      if (path === "/" || path === "/api/release" || path === "/download" || path === "/checksums.txt") {
        const pinned = url.searchParams.get("release");
        if (pinned && !validId(pinned)) throw new HttpError(404, "Release not found.");
        const release = pinned && path === "/checksums.txt" ? await getRelease(env, pinned) : (await current(env))?.release;
        if (!release) throw new HttpError(503, "No release is available yet.");
        const data = publicRelease(release);
        if (path === "/api/release") return json(head ? null : data);
        if (path === "/download") return response(null, 302, { Location: data.downloadUrl, "Cache-Control": "no-store" });
        if (path === "/checksums.txt") return response(head ? null : `${release.sha256}  ${release.filename}\n`, 200, { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": 'attachment; filename="checksums.txt"', "Cache-Control": "no-store" });
        const values: Record<string, string> = {
          FILENAME: release.filename, SIZE: `${(release.bytes / 1024 / 1024).toLocaleString("en-US", { maximumFractionDigits: 1 })} MiB`,
          FORMAT: release.filename.split(".").pop()!.toUpperCase(), SHA256: release.sha256, MD5: release.md5, DOWNLOAD_URL: data.downloadUrl,
        };
        const html = page.replace(/__([A-Z0-9_]+)__/g, (_, key: string) => escapeHtml(values[key] || ""));
        return response(head ? null : html, 200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      }
      const publicManifest = /^\/api\/releases\/([^/]+)$/.exec(path);
      if (publicManifest && validId(publicManifest[1])) return json(head ? null : publicRelease(await getRelease(env, publicManifest[1])));
      const download = /^\/downloads\/([^/]+)\/([^/]+)$/.exec(path);
      if (!download || !validId(download[1])) throw new HttpError(404, "Page not found.");
      const release = await getRelease(env, download[1]);
      let name;
      try { name = decodeURIComponent(download[2]); } catch { throw new HttpError(404, "File not found."); }
      if (name !== release.filename) throw new HttpError(404, "File not found.");
      const metadata = await env.DOWNLOADS.head(release.key);
      if (!metadata || metadata.size !== release.bytes) throw new HttpError(503, "The download is temporarily unavailable. Please try again shortly.");
      const headers = new Headers({
        "Content-Type": contentType(release.filename), "Content-Disposition": disposition(release.filename),
        "Content-Length": String(metadata.size), "Accept-Ranges": "bytes", ETag: metadata.httpEtag,
        "Last-Modified": metadata.uploaded.toUTCString(), "Cache-Control": "public, max-age=31536000, immutable, no-transform",
      });
      const noneMatch = request.headers.get("If-None-Match");
      if (noneMatch && (noneMatch === "*" || noneMatch.split(",").some(tag => tag.trim().replace(/^W\//, "") === metadata.httpEtag))) {
        headers.delete("Content-Length");
        return response(null, 304, headers);
      }
      const modified = request.headers.get("If-Modified-Since");
      if (!noneMatch && modified && Math.floor(metadata.uploaded.getTime() / 1000) <= Date.parse(modified) / 1000) {
        headers.delete("Content-Length");
        return response(null, 304, headers);
      }
      const rangeHeader = head ? null : request.headers.get("Range");
      const ifRange = request.headers.get("If-Range");
      const rangeMatches = !ifRange || ifRange === metadata.httpEtag || (!ifRange.startsWith('"') && !ifRange.startsWith("W/") && Math.floor(metadata.uploaded.getTime() / 1000) <= Date.parse(ifRange) / 1000);
      const range = rangeHeader && rangeMatches ? byteRange(rangeHeader, metadata.size) : undefined;
      if (range === null) return response(null, 416, { "Content-Range": `bytes */${metadata.size}`, "Accept-Ranges": "bytes", "Cache-Control": "no-store" });
      const status = range ? 206 : 200;
      if (range) {
        headers.set("Content-Length", String(range.length));
        headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${metadata.size}`);
      }
      if (head) return response(null, status, headers);
      const object = await env.DOWNLOADS.get(release.key, { onlyIf: { etagMatches: metadata.etag }, ...(range ? { range } : {}) });
      if (!object || !("body" in object)) throw new HttpError(503, "The file changed unexpectedly. Please retry.");
      return response(object.body, status, headers);
    } catch (error) {
      if (error instanceof HttpError) {
        if (path.startsWith("/api/")) return json({ error: error.message }, error.status, error.status === 503 ? { "Retry-After": "60" } : {});
        return response(head ? null : error.message, error.status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...(error.status === 503 ? { "Retry-After": "60" } : {}) });
      }
      console.error("Request failed", error instanceof Error ? error.message : "Unknown error");
      return json({ error: "The request could not be completed. Please retry." }, 503, { "Retry-After": "5" });
    }
  },
} satisfies ExportedHandler<Env>;
