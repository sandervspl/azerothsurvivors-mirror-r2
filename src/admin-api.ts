import { assertOrigin, body, contentType, disposition, filename, HttpError, json, MAX_SIZE, newId, PART_SIZE, validId, type Env } from "./core";
import { requireAdmin } from "./auth";
import { archiveRelease, current, getRelease, manifestKey, publicRelease, setCurrent, type Release } from "./releases";

interface Upload {
  id: string;
  uploadId: string;
  key: string;
  filename: string;
  bytes: number;
  version: string;
  createdAt: number;
  expectedEtag: string | null;
  status: "pending" | "completing" | "completed" | "aborted";
}
const uploadKey = (id: string) => `uploads/${id}/state.json`;
const partPrefix = (id: string) => `uploads/${id}/parts/`;
const partKey = (id: string, part: number) => `${partPrefix(id)}${String(part).padStart(5, "0")}.json`;
async function readUpload(env: Env, id: string) {
  if (!validId(id)) throw new HttpError(404, "Upload not found.");
  const object = await env.DOWNLOADS.get(uploadKey(id));
  if (!object) throw new HttpError(404, "Upload not found.");
  return { upload: await object.json<Upload>(), etag: object.etag };
}
async function receipts(env: Env, id: string) {
  const objects = await env.DOWNLOADS.list({ prefix: partPrefix(id), limit: 1000, include: ["customMetadata"] });
  return objects.objects.map(object => ({ partNumber: Number(object.customMetadata?.partNumber), etag: object.customMetadata?.etag || "" })).sort((a, b) => a.partNumber - b.partNumber);
}
function pending(upload: Upload) {
  if (upload.status !== "pending") throw new HttpError(409, `This upload is ${upload.status}.`);
  if (Date.now() - upload.createdAt > 24 * 60 * 60 * 1000) throw new HttpError(410, "This upload expired. Start a new upload.");
}

export async function adminApi(request: Request, env: Env, path: string) {
  await requireAdmin(request, env);
  if (request.method !== "GET") assertOrigin(request);
  if (path === "/api/admin/releases" && request.method === "GET") {
    const cursor = new URL(request.url).searchParams.get("cursor") || undefined;
    if (cursor && cursor.length > 4096) throw new HttpError(400, "Invalid cursor.");
    const objects = await env.DOWNLOADS.list({ prefix: "history/", limit: 20, cursor });
    const releases = await Promise.all(objects.objects.map(async object => (await env.DOWNLOADS.get(object.key))?.json<Release>()));
    return json({ current: (await current(env))?.release.id || null, releases: releases.filter((release): release is Release => !!release).map(publicRelease), cursor: objects.truncated ? objects.cursor : null });
  }
  const activate = /^\/api\/admin\/releases\/([^/]+)\/activate$/.exec(path);
  if (activate && request.method === "POST") {
    if (!validId(activate[1])) throw new HttpError(404, "Release not found.");
    const data = await body<{ expectedCurrentId: string | null }>(request);
    const before = await current(env);
    if (data.expectedCurrentId !== (before?.release.id || null)) throw new HttpError(409, "The current release changed. Refresh the history and try again.");
    const release = await getRelease(env, activate[1]);
    const object = await env.DOWNLOADS.head(release.key);
    if (!object || object.size !== release.bytes) throw new HttpError(409, "The archived file is unavailable.");
    if (!await setCurrent(env, release, before?.etag || null)) throw new HttpError(409, "Another release was activated. Refresh and try again.");
    return json({ release: publicRelease(release) });
  }
  if (path === "/api/admin/uploads" && request.method === "POST") {
    const data = await body<{ filename: string; bytes: number; version?: string; expectedCurrentId: string | null }>(request);
    const name = filename(data.filename);
    if (!Number.isSafeInteger(data.bytes) || data.bytes <= 0 || data.bytes > MAX_SIZE) throw new HttpError(400, "Choose a non-empty archive up to 10 GiB.");
    if (data.version !== undefined && (typeof data.version !== "string" || data.version.length > 80 || /[\x00-\x1f]/.test(data.version))) throw new HttpError(400, "Version labels must be up to 80 characters.");
    const before = await current(env);
    if (data.expectedCurrentId !== (before?.release.id || null)) throw new HttpError(409, "The current release changed. Refresh and try again.");
    const id = newId();
    const key = `releases/${id}/${name}`;
    const multipart = await env.DOWNLOADS.createMultipartUpload(key, { httpMetadata: { contentType: contentType(name), contentDisposition: disposition(name) } });
    const upload: Upload = { id, uploadId: multipart.uploadId, key, filename: name, bytes: data.bytes, version: data.version?.trim() || new Date().toISOString(), createdAt: Date.now(), expectedEtag: before?.etag || null, status: "pending" };
    try { await env.DOWNLOADS.put(uploadKey(id), JSON.stringify(upload)); }
    catch (error) { await multipart.abort(); throw error; }
    return json({ id, partSize: PART_SIZE }, 201);
  }
  const match = /^\/api\/admin\/uploads\/([^/]+)(?:\/(parts\/\d+|complete|abort))?$/.exec(path);
  if (!match) throw new HttpError(404, "Endpoint not found.");
  const { upload, etag: stateEtag } = await readUpload(env, match[1]);
  const action = match[2];
  if (!action && request.method === "GET") {
    return json({ id: upload.id, filename: upload.filename, bytes: upload.bytes, status: upload.status, expired: upload.status === "pending" && Date.now() - upload.createdAt > 24 * 60 * 60 * 1000, version: upload.version, partSize: PART_SIZE, parts: await receipts(env, upload.id) });
  }
  if (action?.startsWith("parts/") && request.method === "PUT") {
    pending(upload);
    const number = Number(action.slice(6));
    const count = Math.ceil(upload.bytes / PART_SIZE);
    if (!Number.isInteger(number) || number < 1 || number > count) throw new HttpError(400, "Invalid part number.");
    const length = Math.min(PART_SIZE, upload.bytes - (number - 1) * PART_SIZE);
    if (request.headers.get("Content-Type") !== "application/octet-stream" || Number(request.headers.get("Content-Length")) !== length || !request.body) throw new HttpError(400, `Part ${number} must contain ${length} bytes.`);
    const md5 = request.headers.get("X-Part-MD5") || "";
    if (!/^[0-9a-f]{32}$/.test(md5)) throw new HttpError(400, "A valid part MD5 is required.");
    const existing = await env.DOWNLOADS.get(partKey(upload.id, number));
    if (existing) {
      const receipt = await existing.json<R2UploadedPart>();
      if (receipt.etag !== md5) throw new HttpError(409, "This part belongs to different file content. Start a new upload.");
      return json(receipt);
    }
    const part = await env.DOWNLOADS.resumeMultipartUpload(upload.key, upload.uploadId).uploadPart(number, request.body);
    part.etag = part.etag.replace(/^"|"$/g, "");
    if (part.etag !== md5) throw new HttpError(422, "The uploaded part checksum did not match. Retry this part.");
    await env.DOWNLOADS.put(partKey(upload.id, number), JSON.stringify(part), { customMetadata: { partNumber: String(number), etag: part.etag } });
    return json(part);
  }
  if (action === "abort" && request.method === "POST") {
    if (upload.status === "completed" || await env.DOWNLOADS.head(manifestKey(upload.id))) throw new HttpError(409, "Completed releases are preserved and cannot be aborted.");
    if (upload.status !== "aborted") {
      if (upload.status !== "pending") throw new HttpError(409, "This upload is being completed and cannot be aborted.");
      const claimed = await env.DOWNLOADS.put(uploadKey(upload.id), JSON.stringify({ ...upload, status: "aborted" }), { onlyIf: { etagMatches: stateEtag } });
      if (!claimed) throw new HttpError(409, "The upload changed. Refresh before aborting.");
      try { await env.DOWNLOADS.resumeMultipartUpload(upload.key, upload.uploadId).abort(); }
      catch { console.warn("Discarded upload may require multipart cleanup", upload.id); }
    }
    return json({ ok: true });
  }
  if (action === "complete" && request.method === "POST") {
    const hashes = await body<{ sha256: string; md5: string }>(request);
    if (!/^[0-9a-f]{64}$/.test(hashes.sha256 || "") || !/^[0-9a-f]{32}$/.test(hashes.md5 || "")) throw new HttpError(400, "Valid SHA-256 and MD5 checksums are required.");
    const saved = await env.DOWNLOADS.get(manifestKey(upload.id));
    let release: Release;
    if (saved) {
      release = await saved.json<Release>();
      if (release.sha256 !== hashes.sha256 || release.md5 !== hashes.md5) throw new HttpError(409, "This release was completed with different checksums.");
    } else {
      if (upload.status !== "completing") pending(upload);
      const parts = await receipts(env, upload.id);
      const count = Math.ceil(upload.bytes / PART_SIZE);
      if (parts.length !== count || parts.some((part, index) => part.partNumber !== index + 1 || !/^[0-9a-f]{32}$/.test(part.etag))) throw new HttpError(409, "Some upload parts are missing. Resume the upload before publishing.");
      if (upload.status === "pending") {
        const claimed = await env.DOWNLOADS.put(uploadKey(upload.id), JSON.stringify({ ...upload, status: "completing" }), { onlyIf: { etagMatches: stateEtag } });
        if (!claimed) throw new HttpError(409, "The upload changed. Retry completion after refreshing.");
      }
      const object = await env.DOWNLOADS.head(upload.key) || await env.DOWNLOADS.resumeMultipartUpload(upload.key, upload.uploadId).complete(parts);
      if (object.size !== upload.bytes) throw new HttpError(409, "The completed archive size does not match.");
      release = { id: upload.id, key: upload.key, filename: upload.filename, bytes: upload.bytes, version: upload.version, published: new Date().toISOString(), sha256: hashes.sha256, md5: hashes.md5 };
    }
    release = await archiveRelease(env, release);
    await env.DOWNLOADS.put(uploadKey(upload.id), JSON.stringify({ ...upload, status: "completed" }));
    const before = await current(env);
    if (before?.release.id === release.id) return json({ release: publicRelease(release), published: true });
    if (!await setCurrent(env, release, upload.expectedEtag)) return json({ error: "Another release became current during this upload. Your upload is saved in history; activate it there after reviewing the current release.", release: publicRelease(release), published: false }, 409);
    return json({ release: publicRelease(release), published: true });
  }
  throw new HttpError(405, "Method not allowed.");
}
