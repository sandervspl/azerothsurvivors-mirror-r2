import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { apiClient, ApiError } from './api-client.mjs';
import { publishArchive } from './upload.mjs';

const base = 'https://azerothsurvivors-release-staging.sandervispoel.workers.dev';
const checks = [];
const report = { base, startedAt: new Date().toISOString(), passed: false, checks, requests: [] };
const root = new URL('../', import.meta.url);
const client = apiClient(base);
const run = Date.now();
let browser;
async function check(name, action) { await action(); checks.push({ name, passed: true }); console.log(`PASS ${name}`); }
async function eventually(action, timeout = 240000) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    try { return await action(); } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 5000));
  } while (Date.now() < deadline);
  throw last;
}
async function request(path, status, options = {}) {
  const response = await fetch(new URL(path, base), { redirect: 'manual', ...options });
  report.requests.push({ path, method: options.method || 'GET', range: options.headers?.Range, status: response.status });
  assert.equal(response.status, status);
  return response;
}
try {
  await mkdir(new URL('.local/', root), { recursive: true });
  let password;
  try { password = JSON.parse(await readFile(new URL('.local/analytics-staging-credential.json', root))).password; }
  catch { password = randomBytes(24).toString('hex'); await writeFile(new URL('.local/analytics-staging-credential.json', root), JSON.stringify({ password }), { mode: 0o600 }); }
  if (!(await client.request('/api/admin/session')).configured) {
    const setup = new URL((await readFile(new URL('.local/analytics-staging-setup-url.txt', root), 'utf8')).trim());
    await client.request('/api/admin/setup', { method: 'POST', json: { token: new URLSearchParams(setup.hash.slice(1)).get('token'), password } });
  }
  await client.login(password);
  await check('Stats require authentication and reject unsupported periods', async () => {
    await request('/api/admin/stats', 401);
    await assert.rejects(client.request('/api/admin/stats?days=1%20OR%201=1'), error => error instanceof ApiError && error.status === 400);
  });
  const before = await eventually(() => client.request('/api/admin/stats?days=30'));
  report.before = before;
  await check('Empty or existing statistics have UTC day buckets and no private fields', async () => {
    assert.equal(before.daily.length, 30); assert.equal(before.timezone, 'UTC');
    assert.equal(before.daily.reduce((sum, row) => sum + row.downloads, 0), before.totals.selected);
    assert.ok(!JSON.stringify(before).includes('signingKey'));
  });
  const releases = [];
  for (let index = 0; index < 2; index++) {
    const bytes = Buffer.alloc(128 * 1024 + index * 113, index + 37);
    const filename = `analytics-${run}-${index}.zip`;
    const path = new URL(`.local/${filename}`, root); await writeFile(path, bytes);
    const version = index ? `0.116.0 · long version ${'é新'.repeat(24)}` : `0.115.0 analytics ${run}`;
    const release = await publishArchive({ base, path, version, password, resumePath: new URL(`.local/analytics-resume-${index}.json`, root), progress: () => {} });
    releases.push({ ...release, fixtureBytes: bytes });
  }
  const [a, b] = releases;
  await check('Older and current versions return independently verified bytes', async () => {
    for (const release of releases) {
      const response = await request(release.downloadUrl, 200);
      const bytes = Buffer.from(await response.arrayBuffer()); assert.deepEqual(bytes, release.fixtureBytes);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), release.sha256);
    }
    const response = await request(a.downloadUrl, 206, { headers: { Range: 'bytes=0-127' } });
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), a.fixtureBytes.subarray(0, 128));
  });
  await check('HEAD, resumed/suffix ranges, 304, invalid ranges, aliases, and pages do not add starts', async () => {
    const head = await request(a.downloadUrl, 200, { method: 'HEAD' });
    for (const Range of ['bytes=128-255', 'bytes=-999999999', 'bytes=-128']) {
      const range = await request(a.downloadUrl, 206, { headers: { Range } }); await range.arrayBuffer();
    }
    await request(a.downloadUrl, 304, { headers: { 'If-None-Match': head.headers.get('etag') } });
    await request(a.downloadUrl, 416, { headers: { Range: 'bytes=999999999-' } });
    await request(a.downloadUrl + '-wrong', 404);
    await request('/download', 302); await request('/download', 302, { method: 'HEAD' });
    await request('/', 200); await request('/api/release', 200);
  });
  const expected = new Map([[a.id, 2], [b.id, 1]]);
  const stats = await eventually(async () => {
    const result = await client.request('/api/admin/stats?days=30');
    for (const [id, count] of expected) assert.equal(result.versions.find(row => row.id === id)?.downloads, count);
    assert.equal(result.totals.today - before.totals.today, 3);
    assert.equal(result.totals.selected - before.totals.selected, 3);
    return result;
  });
  await check('Actual Analytics Engine events match admin totals and immutable release versions', async () => {
    const query = `SELECT index1 AS releaseId, blob2 AS version, SUM(_sample_interval) AS downloads FROM azerothsurvivors_downloads_staging WHERE blob1 = 'download_start' AND timestamp > NOW() - INTERVAL '1' HOUR GROUP BY releaseId, version FORMAT JSON`;
    const queryPath = new URL('.local/analytics-query.sql', root); await writeFile(queryPath, query);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('node_modules/cf/bin/cf', root)), 'analytics_engine', 'sql', 'query', '--file', fileURLToPath(queryPath)], { cwd: fileURLToPath(root), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const raw = JSON.parse(result.stdout); report.engine = raw;
    const rows = raw.data || raw;
    for (const [id, count] of expected) {
      const row = rows.find(value => value.releaseId === id); assert.equal(Number(row.downloads), count);
      assert.equal(stats.versions.find(value => value.id === id).version, row.version);
    }
    report.stats = stats;
    report.releases = releases.map(({ fixtureBytes, ...release }) => ({ ...release, verifiedBytes: fixtureBytes.length }));
  });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
  let statsRequests = 0;
  const pageErrors = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/admin/stats') statsRequests++; });
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(base + '/admin/stats');
  assert.equal(statsRequests, 0);
  await page.locator('#login-password').fill(password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('#stats-content')).toBeVisible();
  await expect(page).toHaveURL(base + '/admin/stats');
  await check('Direct stats login preserves the page; navigation separates releases and stats without extra analytics queries', async () => {
    await expect(page.getByRole('heading', { name: 'Download statistics.', exact: true })).toBeVisible();
    await expect(page.locator('#upload-form')).toHaveCount(0);
    await expect(page.getByRole('navigation').getByRole('link', { name: 'Statistics' })).toHaveAttribute('aria-current', 'page');
    const queries = statsRequests;
    await page.getByRole('navigation').getByRole('link', { name: 'Releases', exact: true }).click();
    await expect(page).toHaveURL(base + '/admin');
    await expect(page.locator('#upload-button')).toBeEnabled();
    await expect(page.locator('.release').filter({ hasText: b.version })).toBeVisible();
    await expect(page.locator('#stats-content')).toHaveCount(0);
    assert.equal(statsRequests, queries);
    await expect(page.getByRole('navigation').getByRole('link', { name: 'Releases' })).toHaveAttribute('aria-current', 'page');
    await page.screenshot({ path: fileURLToPath(new URL('artifacts/releases-desktop.png', root)), fullPage: true });
    await page.getByRole('navigation').getByRole('link', { name: 'Statistics', exact: true }).click();
    await expect(page.locator('#stats-content')).toBeVisible();
  });
  await check('Admin charts, period selection, daily table, and version counts work in browser', async () => {
    await expect(page.locator('#stats-today')).toHaveText(String(stats.totals.today));
    await expect(page.locator('.stats-version').filter({ hasText: b.id })).toContainText(b.version);
    await page.locator('#stats-days').selectOption('7');
    await expect(page.locator('#stats-daily-rows tr')).toHaveCount(7);
    await page.locator('#stats-days').selectOption('90');
    await expect(page.locator('#stats-daily-rows tr')).toHaveCount(90);
    await page.locator('#stats-days').selectOption('30');
    await expect(page.locator('#stats-daily-rows tr')).toHaveCount(30);
    await page.locator('.stats-daily summary').click();
    await expect(page.locator('#stats-daily-rows')).toBeVisible();
    await page.locator('.stats-daily summary').click();
    await mkdir(new URL('artifacts/', root), { recursive: true });
    await page.screenshot({ path: fileURLToPath(new URL('artifacts/analytics-desktop.png', root)), fullPage: true });
    await page.setViewportSize({ width: 320, height: 760 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: fileURLToPath(new URL('artifacts/analytics-mobile.png', root)), fullPage: true });
  });
  await check('Query errors and empty states render honestly without blocking release management', async () => {
    await page.route('**/api/admin/stats?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Download statistics are temporarily unavailable.' }) }));
    await page.getByRole('button', { name: 'Refresh stats' }).click();
    await expect(page.locator('#stats-message')).toContainText('temporarily unavailable');
    await expect(page.locator('#stats-content')).toBeHidden();
    await page.getByRole('navigation').getByRole('link', { name: 'Releases', exact: true }).click();
    await expect(page.locator('#upload-button')).toBeEnabled(); await expect(page.locator('.release').filter({ hasText: b.version })).toBeVisible();
    await expect(page.locator('#stats-content')).toHaveCount(0);
    await page.getByRole('navigation').getByRole('link', { name: 'Statistics', exact: true }).click();
    await expect(page.locator('#stats-message')).toContainText('temporarily unavailable');
    await page.unroute('**/api/admin/stats?*');
    await page.route('**/api/admin/stats?*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...stats, totals: { today: 0, last7Days: 0, last30Days: 0, selected: 0 }, versions: [], daily: stats.daily.map(day => ({ ...day, downloads: 0 })) }) }));
    await page.getByRole('button', { name: 'Refresh stats' }).click();
    await expect(page.locator('#stats-empty')).toBeVisible(); await expect(page.locator('#stats-today')).toHaveText('0');
    await page.unroute('**/api/admin/stats?*');
    await page.getByRole('button', { name: 'Refresh stats' }).click();
    await expect(page.locator('#stats-today')).toHaveText(String(stats.totals.today));
  });
  await check('Sign-out revokes access to the stats API', async () => {
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.locator('#login-view')).toBeVisible();
    await expect(page).toHaveURL(base + '/admin/stats');
    assert.equal((await context.request.get(base + '/api/admin/stats')).status(), 401);
    assert.deepEqual(pageErrors, []);
  });
  report.passed = true;
} catch (error) { report.error = error.stack; process.exitCode = 1; console.error(error); }
finally {
  if (browser) await browser.close();
  report.finishedAt = new Date().toISOString();
  await mkdir(new URL('artifacts/', root), { recursive: true });
  await writeFile(new URL('artifacts/analytics-e2e.json', root), JSON.stringify(report, null, 2) + '\n');
  console.log('Evidence saved to artifacts/analytics-e2e.json');
}
