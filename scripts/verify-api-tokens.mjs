import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { apiClient, ApiError } from './api-client.mjs';

const base = 'https://azerothsurvivors-release-staging.sandervispoel.workers.dev';
const bucket = 'azerothsurvivors-release-staging';
const root = new URL('../', import.meta.url);
const local = name => new URL(`.local/${name}`, root);
const checks = [], secrets = [], fixtures = [];
const report = { base, startedAt: new Date().toISOString(), passed: false, checks, fixtures };
const admin = apiClient(base);
let browser;
const hash = bytes => ({ sha256: createHash('sha256').update(bytes).digest('hex'), md5: createHash('md5').update(bytes).digest('hex') });
const redact = value => secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), String(value));
async function check(name, action) { await action(); checks.push({ name, passed: true }); console.log(`PASS ${name}`); }
async function denied(status, action) { await assert.rejects(action, error => error instanceof ApiError && error.status === status); }
function cf(...args) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('node_modules/cf/bin/cf', root)), ...args], { encoding: 'utf8', cwd: fileURLToPath(root), timeout: 180000 });
  if (result.status !== 0) throw new Error(redact(result.stderr || 'Cloudflare staging operation failed.'));
  return result.stdout;
}
async function putStaging(key, value) {
  const path = local('token-e2e-storage.json'); await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  cf('r2', 'objects', 'put', key, '--bucket-name', bucket, '--file', fileURLToPath(path), '--content-type', 'application/json');
}
const getStaging = key => JSON.parse(cf('r2', 'objects', 'get', key, '--bucket-name', bucket, '--text'));
async function create(name) {
  const value = await admin.request('/api/admin/tokens', { method: 'POST', json: { name, expiresInDays: 90 } });
  secrets.push(value.token);
  return value;
}
async function currentId() { const value = await fetch(base + '/api/release'); return value.status === 503 ? null : (await value.json()).id; }
async function start(client, name, size) { return client.request('/api/admin/uploads', { method: 'POST', json: { filename: name, bytes: size, version: 'API token E2E', expectedCurrentId: await currentId() } }); }
async function runCli(path, version, token, resumePath) {
  const savedReport = await readFile(new URL('artifacts/upload.json', root)).catch(() => null);
  try {
    const env = { ...process.env, MIRROR_API_TOKEN: token, MIRROR_UPLOAD_STATE: fileURLToPath(resumePath) }; delete env.MIRROR_ADMIN_PASSWORD;
    const result = spawnSync(process.execPath, ['scripts/upload.mjs', fileURLToPath(path), version, base], { env, cwd: fileURLToPath(root), encoding: 'utf8', timeout: 240000 });
    if (result.status !== 0) throw new Error(redact(result.stderr || result.stdout || 'Token CLI upload failed.'));
    assert.ok(!result.stdout.includes('Admin password:'), 'Token CLI must not prompt for an admin password');
    return JSON.parse(await readFile(new URL('artifacts/upload.json', root)));
  } finally {
    if (savedReport) await writeFile(new URL('artifacts/upload.json', root), savedReport);
    else await unlink(new URL('artifacts/upload.json', root)).catch(() => {});
  }
}
try {
  await mkdir(local(''), { recursive: true });
  let password;
  try { password = JSON.parse(await readFile(local('token-staging-credential.json'))).password; }
  catch { password = randomBytes(24).toString('hex'); await writeFile(local('token-staging-credential.json'), JSON.stringify({ password }), { mode: 0o600 }); }
  secrets.push(password);
  if (!(await admin.request('/api/admin/session')).configured) {
    const setup = new URL((await readFile(local('token-staging-setup-url.txt'), 'utf8')).trim());
    const token = new URLSearchParams(setup.hash.slice(1)).get('token'); secrets.push(token);
    await admin.request('/api/admin/setup', { method: 'POST', json: { token, password } });
  }
  await admin.login(password);
  await check('Token management requires a password session, same origin, valid names and expiry', async () => {
    await denied(401, () => apiClient(base).request('/api/admin/tokens'));
    await denied(403, () => admin.request('/api/admin/tokens', { method: 'POST', json: { name: 'foreign' }, headers: { Origin: 'https://untrusted.example' } }));
    await denied(400, () => admin.request('/api/admin/tokens', { method: 'POST', json: { name: '' } }));
    await denied(400, () => admin.request('/api/admin/tokens', { method: 'POST', json: { name: 'invalid expiry', expiresInDays: 0 } }));
  });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
  const pageErrors = []; let tokenQueries = 0;
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/admin/tokens' && request.method() === 'GET') tokenQueries++; });
  await page.goto(base + '/admin/tokens'); assert.equal(tokenQueries, 0);
  await page.locator('#login-password').fill(password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(base + '/admin/tokens');
  await expect(page.getByRole('heading', { name: 'Create an upload token' })).toBeVisible();
  let a;
  await check('Browser creates a named token, reveals it once, and stores only its digest', async () => {
    await page.getByLabel('Token name', { exact: true }).fill('CI release é新 <b>pipeline</b>');
    await page.getByLabel('Expires after', { exact: true }).selectOption('30');
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/tokens' && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Create token', exact: true }).click();
    a = await (await response).json(); secrets.push(a.token);
    assert.ok(/^as_mirror_[0-9a-f]{32}_[0-9a-f]{64}$/.test(a.token), 'Server generates a properly formed high-entropy token');
    await expect(page.locator('#token-secret')).toBeVisible();
    assert.ok(await page.locator('#created-token').inputValue() === a.token, 'Creation response is displayed once');
    const stored = getStaging('admin/api-tokens.json');
    assert.ok(!JSON.stringify(stored).includes(a.token), 'Plaintext token must not be persisted');
    assert.ok(stored.tokens.find(item => item.id === a.id).hash === hash(a.token).sha256, 'Stored credential is its SHA-256 digest');
    const list = await admin.request('/api/admin/tokens');
    assert.ok(!JSON.stringify(list).includes(a.token) && !JSON.stringify(list).includes('hash'), 'Listing never reveals token values or hashes');
    await page.getByRole('button', { name: "I've saved it", exact: true }).click();
    assert.ok(await page.locator('#created-token').inputValue() === '', 'Dismissing clears the secret');
    await page.reload(); await expect(page.locator(`[data-token-id="${a.id}"]`)).toBeVisible();
    await expect(page.locator('#token-list b')).toHaveCount(0);
    await expect(page.locator('#token-secret')).toBeHidden();
  });
  const clientA = apiClient(base, { token: a.token });
  const [b, c] = await Promise.all([create('Concurrent integration B'), create('Concurrent integration C')]);
  const clientB = apiClient(base, { token: b.token });
  await check('Concurrent creation keeps both tokens and token credentials cannot access other admin capabilities', async () => {
    const listed = (await admin.request('/api/admin/tokens')).tokens;
    assert.ok(listed.some(item => item.id === b.id) && listed.some(item => item.id === c.id));
    await clientA.request('/api/admin/releases');
    for (const [path, method] of [['/api/admin/tokens', 'GET'], ['/api/admin/tokens', 'POST'], [`/api/admin/tokens/${b.id}`, 'DELETE'], ['/api/admin/stats', 'GET'], ['/api/admin/releases/blocked/activate', 'POST']]) await denied(403, () => clientA.request(path, { method, json: method === 'POST' ? {} : undefined }));
    await denied(403, () => clientA.request('/api/admin/releases', { headers: { Origin: 'https://untrusted.example' } }));
    await assert.rejects(clientA.request('https://untrusted.example/api/admin/uploads'), error => /configured mirror origin/.test(error.message));
    const cookie = (await context.cookies()).map(value => `${value.name}=${value.value}`).join('; '); secrets.push(cookie);
    const invalid = await fetch(base + '/api/admin/uploads', { method: 'POST', headers: { Authorization: 'Bearer invalid', Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(invalid.status, 401);
    const forged = `as_mirror_${a.id}_${'0'.repeat(64)}`;
    const unauthorized = await fetch(base + '/api/admin/releases', { headers: { Authorization: `Bearer ${forged}` } }); assert.equal(unauthorized.status, 401);
    assert.equal((await fetch(base + '/api/admin/releases?token=not-a-credential')).status, 401);
  });
  const bytes = Buffer.alloc(33 * 1024 * 1024 + 137);
  for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 17 + 91) & 255;
  const filename = `token-multipart-${Date.now()}.zip`;
  const path = local(filename); await writeFile(path, bytes); fixtures.push(filename);
  const before = await currentId();
  const job = await start(clientA, filename, bytes.length);
  await clientA.request(`/api/admin/uploads/${job.id}/parts/1`, { method: 'PUT', bytes: bytes.subarray(0, job.partSize), md5: hash(bytes.subarray(0, job.partSize)).md5 });
  await check('Tokens are restricted to their own jobs and incomplete/corrupt multipart uploads cannot publish', async () => {
    for (const action of ['', '/abort', '/complete']) await denied(403, () => clientB.request(`/api/admin/uploads/${job.id}${action}`, { method: action ? 'POST' : 'GET', json: action ? {} : undefined }));
    const sessionJob = await start(admin, 'session-only.zip', 10);
    await denied(403, () => clientA.request(`/api/admin/uploads/${sessionJob.id}/abort`, { method: 'POST' }));
    await admin.request(`/api/admin/uploads/${sessionJob.id}/abort`, { method: 'POST' });
    await denied(422, () => clientA.request(`/api/admin/uploads/${job.id}/parts/2`, { method: 'PUT', bytes: bytes.subarray(job.partSize), md5: '0'.repeat(32) }));
    await denied(409, () => clientA.request(`/api/admin/uploads/${job.id}/complete`, { method: 'POST', json: hash(bytes) }));
    assert.equal(await currentId(), before);
  });
  let release;
  await check('Actual upload CLI resumes multipart state with only MIRROR_API_TOKEN and publishes independently verified bytes', async () => {
    const resume = local('token-e2e-resume.json');
    await writeFile(resume, JSON.stringify({ id: job.id, filename, bytes: bytes.length, base }));
    release = await runCli(path, 'Token CLI resumed version', a.token, resume);
    assert.equal(release.id, job.id);
    const downloaded = Buffer.from(await fetch(base + release.downloadUrl).then(result => result.arrayBuffer()));
    assert.ok(downloaded.equals(bytes), 'Every downloaded byte matches the local archive');
    assert.deepEqual(hash(downloaded), hash(bytes));
    assert.deepEqual({ sha256: release.sha256, md5: release.md5 }, hash(bytes));
    report.release = { id: release.id, bytes: bytes.length, ...hash(bytes) };
  });
  const pending = await start(clientA, 'revoked-pending.zip', 10);
  await check('UI navigation stays separate, layouts fit mobile, and revocation immediately blocks further upload requests', async () => {
    await page.getByRole('button', { name: 'Refresh tokens' }).click();
    await expect(page.locator(`[data-token-id="${b.id}"]`)).toBeVisible();
    const queries = tokenQueries;
    await page.getByRole('navigation').getByRole('link', { name: 'Releases', exact: true }).click();
    await expect(page.locator('#upload-button')).toBeEnabled(); assert.equal(tokenQueries, queries);
    await expect(page.locator('#token-form')).toHaveCount(0);
    await page.getByRole('navigation').getByRole('link', { name: 'API tokens', exact: true }).click();
    await expect(page.locator(`[data-token-id="${a.id}"]`)).toBeVisible();
    await mkdir(new URL('artifacts/', root), { recursive: true });
    await page.screenshot({ path: fileURLToPath(new URL('artifacts/api-tokens-desktop.png', root)), fullPage: true });
    await page.setViewportSize({ width: 320, height: 760 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: fileURLToPath(new URL('artifacts/api-tokens-mobile.png', root)), fullPage: true });
    await page.locator(`[data-token-id="${a.id}"]`).getByRole('button', { name: 'Revoke' }).click();
    await expect(page.locator(`[data-token-id="${a.id}"]`)).toHaveCount(0);
    await denied(401, () => clientA.request(`/api/admin/uploads/${pending.id}`));
    await denied(401, () => clientA.request(`/api/admin/uploads/${pending.id}/complete`, { method: 'POST', json: hash(Buffer.alloc(10)) }));
    await admin.request(`/api/admin/uploads/${pending.id}/abort`, { method: 'POST' });
    assert.equal(await currentId(), release.id); await clientB.request('/api/admin/releases');
  });
  let d;
  await check('Concurrent revocation/creation preserves unrelated tokens; expired credentials are rejected', async () => {
    [, d] = await Promise.all([admin.request(`/api/admin/tokens/${c.id}`, { method: 'DELETE' }), create('Integration D after concurrent revoke')]);
    const listed = (await admin.request('/api/admin/tokens')).tokens;
    assert.ok(!listed.some(item => item.id === c.id) && listed.some(item => item.id === b.id) && listed.some(item => item.id === d.id));
    await denied(401, () => apiClient(base, { token: c.token }).request('/api/admin/releases'));
    const value = getStaging('admin/api-tokens.json'); value.tokens.find(item => item.id === b.id).expiresAt = new Date(Date.now() - 1000).toISOString();
    await putStaging('admin/api-tokens.json', value);
    await denied(401, () => clientB.request('/api/admin/releases'));
    await page.getByRole('button', { name: 'Refresh tokens' }).click(); await expect(page.locator(`[data-token-id="${b.id}"]`)).toContainText('Expired');
  });
  await check('Sign-out and admin-key reset invalidate credentials while a new generation works', async () => {
    await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await expect(page.locator('#login-view')).toBeVisible(); await expect(page).toHaveURL(base + '/admin/tokens');
    assert.equal((await context.request.get(base + '/api/admin/tokens')).status(), 401);
    const auth = getStaging('admin/auth.json'); auth.signingKey = randomBytes(32).toString('hex'); await putStaging('admin/auth.json', auth);
    await denied(401, () => apiClient(base, { token: d.token }).request('/api/admin/releases'));
    await admin.login(password);
    const fresh = await create('After key reset');
    await apiClient(base, { token: fresh.token }).request('/api/admin/releases');
    await admin.request(`/api/admin/tokens/${fresh.id}`, { method: 'DELETE' });
    assert.deepEqual(pageErrors, []);
  });
  report.tokenIds = [a.id, b.id, c.id, d.id]; report.passed = true;
} catch (error) { report.error = redact(error.stack); process.exitCode = 1; console.error(report.error); }
finally {
  if (browser) await browser.close();
  report.finishedAt = new Date().toISOString();
  await mkdir(new URL('artifacts/', root), { recursive: true });
  await writeFile(new URL('artifacts/api-tokens-e2e.json', root), redact(JSON.stringify(report, null, 2)) + '\n');
  console.log('Evidence saved to artifacts/api-tokens-e2e.json (no credential values).');
}
