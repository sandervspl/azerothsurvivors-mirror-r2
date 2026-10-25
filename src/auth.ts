import { assertOrigin, body, digest, hex, HttpError, json, randomHex, type Env } from "./core";

interface AuthRecord { salt: string; verifier: string; signingKey: string }
const AUTH_KEY = "admin/auth.json";
const COOKIE = "__Host-mirror_session";
const SESSION_SECONDS = 12 * 60 * 60;
export const equal = (a: string, b: string) => {
  let difference = a.length ^ b.length;
  for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ (b.charCodeAt(index) || 0);
  return difference === 0;
};
async function passwordHash(password: string, salt: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", salt: new TextEncoder().encode(salt), iterations: 100000, hash: "SHA-256" }, key, 256));
}
async function authRecord(env: Env) {
  const object = await env.DOWNLOADS.get(AUTH_KEY);
  return object?.json<AuthRecord>();
}
export async function authGeneration(env: Env) {
  const record = await authRecord(env);
  return record ? digest(record.signingKey) : null;
}
async function signingKey(record: AuthRecord) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(record.signingKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function sessionCookie(record: AuthRecord, origin: string) {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS, origin, nonce: randomHex() }));
  const signature = hex(await crypto.subtle.sign("HMAC", await signingKey(record), new TextEncoder().encode(payload)));
  return `${COOKIE}=${payload}.${signature}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`;
}
export async function authenticated(request: Request, env: Env) {
  const token = request.headers.get("Cookie")?.split(";").map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!token || token.length > 1024) return false;
  const record = await authRecord(env);
  if (!record) return false;
  try {
    const [payload, signature, extra] = token.split(".");
    if (extra || !/^[0-9a-f]{64}$/.test(signature)) return false;
    const bytes = Uint8Array.from(signature.match(/../g)!, byte => parseInt(byte, 16));
    if (!await crypto.subtle.verify("HMAC", await signingKey(record), bytes, new TextEncoder().encode(payload))) return false;
    const session = JSON.parse(atob(payload));
    return session.exp > Date.now() / 1000 && session.origin === new URL(request.url).origin;
  } catch { return false; }
}
export async function requireAdmin(request: Request, env: Env) {
  if (!await authenticated(request, env)) throw new HttpError(401, "Sign in to manage releases.");
}
export async function authRoute(request: Request, env: Env, path: string): Promise<Response | null> {
  if (path === "/api/admin/session" && request.method === "GET") return json({ authenticated: await authenticated(request, env), configured: !!await authRecord(env) });
  if (!["/api/admin/setup", "/api/admin/login", "/api/admin/logout"].includes(path)) return null;
  if (request.method !== "POST") throw new HttpError(405, "Use POST.");
  assertOrigin(request);
  if (path === "/api/admin/logout") return json({ ok: true }, 200, { "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
  const limited = await env.LOGIN_LIMITER.limit({ key: request.headers.get("CF-Connecting-IP") || "unknown" });
  if (!limited.success) return json({ error: "Too many attempts. Try again in a minute." }, 429, { "Retry-After": "60" });
  const data = await body<{ password: string; token?: string }>(request);
  if (typeof data.password !== "string" || data.password.length > 256) throw new HttpError(400, "Enter a password of up to 256 characters.");
  const record = await authRecord(env);
  if (path === "/api/admin/setup") {
    if (record) throw new HttpError(409, "The admin password has already been set. Sign in instead.");
    if (!env.ADMIN_SETUP_HASH || typeof data.token !== "string" || data.token.length > 128 || !equal(await digest(data.token), env.ADMIN_SETUP_HASH)) throw new HttpError(403, "This setup link is invalid.");
    if (data.password.length < 12) throw new HttpError(400, "Use at least 12 characters for the password.");
    const salt = randomHex();
    const created: AuthRecord = { salt, verifier: await passwordHash(data.password, salt), signingKey: randomHex() };
    const result = await env.DOWNLOADS.put(AUTH_KEY, JSON.stringify(created), { onlyIf: { etagDoesNotMatch: "*" } });
    if (!result) throw new HttpError(409, "The admin password has already been set.");
    return json({ ok: true }, 200, { "Set-Cookie": await sessionCookie(created, new URL(request.url).origin) });
  }
  if (!record) throw new HttpError(503, "Admin setup has not been completed.");
  if (!equal(await passwordHash(data.password, record.salt), record.verifier)) throw new HttpError(401, "Incorrect password.");
  return json({ ok: true }, 200, { "Set-Cookie": await sessionCookie(record, new URL(request.url).origin) });
}
