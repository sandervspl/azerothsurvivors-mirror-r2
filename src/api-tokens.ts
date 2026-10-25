import { authGeneration, equal, requireAdmin } from "./auth";
import { assertOrigin, body, digest, HttpError, json, randomHex, type Env } from "./core";

interface TokenRecord { id: string; name: string; hash: string; generation: string; createdAt: string; expiresAt: string }
interface Registry { tokens: TokenRecord[] }
const KEY = "admin/api-tokens.json";
const DAY = 86400000;
const publicToken = ({ id, name, createdAt, expiresAt }: TokenRecord) => ({ id, name, createdAt, expiresAt });
async function registry(env: Env) {
  const object = await env.DOWNLOADS.get(KEY);
  return { value: object ? await object.json<Registry>() : { tokens: [] }, etag: object?.etag };
}
async function changeRegistry(env: Env, update: (value: Registry) => Registry) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const before = await registry(env);
    const value = update(before.value);
    const saved = await env.DOWNLOADS.put(KEY, JSON.stringify(value), {
      onlyIf: before.etag ? { etagMatches: before.etag } : { etagDoesNotMatch: "*" },
    });
    if (saved) return;
  }
  throw new HttpError(409, "API tokens changed concurrently. Refresh and try again.");
}

export async function tokenPrincipal(request: Request, env: Env) {
  const match = /^Bearer (as_mirror_([0-9a-f]{32})_[0-9a-f]{64})$/i.exec(request.headers.get("Authorization") || "");
  if (!match) throw new HttpError(401, "Invalid or expired API token.");
  const { value } = await registry(env);
  const token = value.tokens.find(token => token.id === match[2]);
  if (!token || !Number.isFinite(Date.parse(token.expiresAt)) || Date.parse(token.expiresAt) <= Date.now() || !equal(token.hash, await digest(match[1]))) throw new HttpError(401, "Invalid or expired API token.");
  const generation = await authGeneration(env);
  if (!generation || !equal(token.generation, generation)) throw new HttpError(401, "Invalid or expired API token.");
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== new URL(request.url).origin) throw new HttpError(403, "Request origin is not allowed.");
  return { id: token.id };
}

export async function tokenApi(request: Request, env: Env, path: string) {
  if (request.headers.has("Authorization")) throw new HttpError(403, "Sign in with the admin password to manage API tokens.");
  await requireAdmin(request, env);
  if (request.method !== "GET") assertOrigin(request);
  const generation = await authGeneration(env);
  if (!generation) throw new HttpError(401, "Sign in to manage API tokens.");
  if (path === "/api/admin/tokens" && request.method === "GET") {
    const { value } = await registry(env);
    return json({ tokens: value.tokens.filter(token => equal(token.generation, generation)).map(publicToken) });
  }
  if (path === "/api/admin/tokens" && request.method === "POST") {
    const data = await body<{ name: string; expiresInDays?: number }>(request);
    if (typeof data.name !== "string" || !data.name.trim() || data.name.length > 60 || /[\x00-\x1f\x7f]/.test(data.name)) throw new HttpError(400, "Enter a token name of 1–60 characters.");
    const days = data.expiresInDays ?? 90;
    if (![30, 90, 365].includes(days)) throw new HttpError(400, "Choose an expiry of 30, 90, or 365 days.");
    const id = crypto.randomUUID().replace(/-/g, "");
    const secret = `as_mirror_${id}_${randomHex()}`;
    const now = Date.now();
    const token: TokenRecord = { id, name: data.name.trim(), hash: await digest(secret), generation, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + days * DAY).toISOString() };
    await changeRegistry(env, value => {
      const active = value.tokens.filter(item => equal(item.generation, generation) && Date.parse(item.expiresAt) > now);
      if (active.length >= 20) throw new HttpError(409, "You can have up to 20 active API tokens. Revoke an unused token first.");
      return { tokens: [...active, token] };
    });
    return json({ token: secret, ...publicToken(token) }, 201);
  }
  const revoke = /^\/api\/admin\/tokens\/([0-9a-f]{32})$/.exec(path);
  if (revoke && request.method === "DELETE") {
    await changeRegistry(env, value => ({ tokens: value.tokens.filter(token => token.id !== revoke[1]) }));
    return json({ ok: true });
  }
  throw new HttpError(405, "Method not allowed.");
}
