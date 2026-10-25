export interface Env {
  DOWNLOADS: R2Bucket;
  DOWNLOAD_ANALYTICS: AnalyticsEngineDataset;
  ANALYTICS_SQL: AnalyticsSQLBinding;
  ANALYTICS_DATASET: string;
  ADMIN_SETUP_HASH: string;
  LOGIN_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function response(body: BodyInit | null, status = 200, extra: HeadersInit = {}) {
  const headers = new Headers({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  });
  new Headers(extra).forEach((value, key) => headers.set(key, value));
  return new Response(body, { status, headers });
}

export function json(value: unknown, status = 200, extra: HeadersInit = {}) {
  return response(JSON.stringify(value), status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...Object.fromEntries(new Headers(extra)) });
}

export async function body<T>(request: Request): Promise<T> {
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) throw new HttpError(415, "Expected JSON.");
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) { await reader.cancel(); throw new HttpError(413, "Request is too large."); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as T;
  } catch { throw new HttpError(400, "Invalid JSON."); }
}

export function assertOrigin(request: Request) {
  if (request.headers.get("Origin") !== new URL(request.url).origin) throw new HttpError(403, "Request origin is not allowed.");
}

export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
export const hex = (bytes: ArrayBuffer | Uint8Array) => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
export const randomHex = () => hex(crypto.getRandomValues(new Uint8Array(32)));
export const digest = async (value: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
export const validId = (id: string) => /^\d{13}-[0-9a-f-]{36}$/.test(id);
export const newId = () => `${Date.now()}-${crypto.randomUUID()}`;
export const PART_SIZE = 32 * 1024 * 1024;
export const MAX_SIZE = 10 * 1024 * 1024 * 1024;

export function filename(value: unknown): string {
  if (typeof value !== "string" || value.length > 160 || !/^[^\x00-\x1f\x7f/\\"<>:|?*]+\.(rar|zip|7z)$/i.test(value) || value.trim() !== value) throw new HttpError(400, "Choose a .rar, .zip, or .7z archive with a valid filename (up to 160 characters).");
  return value;
}

export function disposition(name: string) {
  return `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16)}`)}`;
}

export function contentType(name: string) {
  return /\.zip$/i.test(name) ? "application/zip" : /\.7z$/i.test(name) ? "application/x-7z-compressed" : "application/vnd.rar";
}
