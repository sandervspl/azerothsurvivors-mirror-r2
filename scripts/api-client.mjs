export class ApiError extends Error {
  constructor(status, data) { super(data.error || `Request failed (${status})`); this.status = status; this.data = data; }
}
export function apiClient(base, { token } = {}) {
  if (token !== undefined && (typeof token !== 'string' || !/^as_mirror_[0-9a-f]{32}_[0-9a-f]{64}$/.test(token))) throw new Error('Invalid API token format.');
  const origin = new URL(base).origin;
  if (!origin.startsWith('https://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin)) throw new Error('Use HTTPS for admin requests.');
  let cookie = '';
  async function request(path, { method = 'GET', json, bytes, md5, headers = {} } = {}) {
    const url = new URL(path, origin);
    if (url.origin !== origin) throw new Error('API requests must stay on the configured mirror origin.');
    const result = await fetch(url, {
      method, redirect: 'error', headers: { ...(token ? { Authorization: `Bearer ${token}` } : { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) }), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(bytes ? { 'Content-Type': 'application/octet-stream', 'X-Part-MD5': md5 } : {}), ...headers },
      body: bytes || (json === undefined ? undefined : JSON.stringify(json)), signal: AbortSignal.timeout(180000),
    });
    const setCookie = result.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const data = await result.json();
    if (!result.ok) throw new ApiError(result.status, data);
    return data;
  }
  return { request, login: password => request('/api/admin/login', { method: 'POST', json: { password } }) };
}
