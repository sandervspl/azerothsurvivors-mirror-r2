import { HttpError, type Env } from "./core";

export interface Release {
  id: string;
  key: string;
  filename: string;
  bytes: number;
  sha256: string;
  md5: string;
  version: string;
  published: string;
}
export interface Current { release: Release; etag: string }
export const CURRENT_KEY = "release.json";
export const manifestKey = (id: string) => `manifests/${id}.json`;
export const historyKey = (release: Release) => `history/${String(9999999999999 - Number(release.id.slice(0, 13))).padStart(13, "0")}-${release.id}.json`;

export async function current(env: Env): Promise<Current | null> {
  const object = await env.DOWNLOADS.get(CURRENT_KEY);
  return object ? { release: await object.json<Release>(), etag: object.etag } : null;
}
export async function getRelease(env: Env, id: string) {
  const object = await env.DOWNLOADS.get(manifestKey(id));
  if (!object) throw new HttpError(404, "Release not found.");
  return object.json<Release>();
}
export function publicRelease(release: Release) {
  const { id, filename, bytes, sha256, md5, version, published } = release;
  return { id, filename, bytes, sha256, md5, version, published, downloadUrl: `/downloads/${id}/${encodeURIComponent(filename)}` };
}
export async function archiveRelease(env: Env, release: Release) {
  const created = await env.DOWNLOADS.put(manifestKey(release.id), JSON.stringify(release), {
    onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: "application/json" },
  });
  if (!created) {
    const saved = await getRelease(env, release.id);
    if (saved.sha256 !== release.sha256 || saved.md5 !== release.md5 || saved.bytes !== release.bytes || saved.filename !== release.filename || saved.key !== release.key) throw new HttpError(409, "This release was already completed with different metadata.");
    release = saved;
  }
  await env.DOWNLOADS.put(historyKey(release), JSON.stringify(release), {
    onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: "application/json" },
  });
  return release;
}
export async function setCurrent(env: Env, release: Release, expectedEtag: string | null) {
  const result = await env.DOWNLOADS.put(CURRENT_KEY, JSON.stringify({ ...release, revision: crypto.randomUUID() }), {
    onlyIf: expectedEtag ? { etagMatches: expectedEtag } : { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
  });
  return !!result;
}
