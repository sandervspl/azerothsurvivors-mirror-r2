import page from "./page.html?raw";
import { release } from "./release";

interface Env { DOWNLOADS: R2Bucket }

const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
};

function response(body: BodyInit | null, status = 200, extra: HeadersInit = {}) {
  const headers = new Headers(securityHeaders);
  new Headers(extra).forEach((value, key) => headers.set(key, value));
  return new Response(body, { status, headers });
}

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
    const path = new URL(request.url).pathname;
    if (request.method !== "GET" && request.method !== "HEAD") {
      return response("Method not allowed", 405, { Allow: "GET, HEAD" });
    }
    const head = request.method === "HEAD";
    if (path === "/") return response(head ? null : page, 200, {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300",
    });
    if (path === "/api/release") return response(head ? null : JSON.stringify(release), 200, {
      "Content-Type": "application/json", "Cache-Control": "public, max-age=300",
    });
    if (path === "/checksums.txt") return response(head ? null : `${release.sha256}  ${release.filename}\n`, 200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": 'attachment; filename="checksums.txt"',
    });
    if (path !== "/download" && path !== `/downloads/${release.filename}`) {
      return response(head ? null : "Page not found", 404);
    }

    try {
      const metadata = await env.DOWNLOADS.head(release.filename);
      if (!metadata) return response(head ? null : "The download is temporarily unavailable. Please try again shortly.", 503, { "Retry-After": "60", "Cache-Control": "no-store" });
      const headers = new Headers({
        "Content-Type": "application/vnd.rar",
        "Content-Disposition": `attachment; filename="${release.filename}"`,
        "Content-Length": String(metadata.size),
        "Accept-Ranges": "bytes",
        ETag: metadata.httpEtag,
        "Last-Modified": metadata.uploaded.toUTCString(),
        "Cache-Control": "public, max-age=3600, no-transform",
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
      // Range applies only to GET. A stale If-Range requests the full current file.
      const rangeHeader = head ? null : request.headers.get("Range");
      const ifRange = request.headers.get("If-Range");
      const rangeMatches = !ifRange || ifRange === metadata.httpEtag || (!ifRange.startsWith('"') && !ifRange.startsWith("W/") && Math.floor(metadata.uploaded.getTime() / 1000) <= Date.parse(ifRange) / 1000);
      const range = rangeHeader && rangeMatches ? byteRange(rangeHeader, metadata.size) : undefined;
      if (range === null) return response(null, 416, {
        "Content-Range": `bytes */${metadata.size}`, "Accept-Ranges": "bytes", "Cache-Control": "no-store",
      });
      const status = range ? 206 : 200;
      if (range) {
        headers.set("Content-Length", String(range.length));
        headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${metadata.size}`);
      }
      if (head) return response(null, status, headers);
      // Pin the GET to the metadata ETag so a release replacement cannot mix versions.
      const object = await env.DOWNLOADS.get(release.filename, {
        onlyIf: { etagMatches: metadata.etag },
        ...(range ? { range } : {}),
      });
      if (!object || !("body" in object)) return response("The release changed. Please retry the download.", 503, { "Retry-After": "1", "Cache-Control": "no-store" });
      return response(object.body, status, headers);
    } catch (error) {
      console.error("R2 download failed", error);
      return response(head ? null : "The download is temporarily unavailable. Please try again shortly.", 503, { "Retry-After": "60", "Cache-Control": "no-store" });
    }
  },
} satisfies ExportedHandler<Env>;
