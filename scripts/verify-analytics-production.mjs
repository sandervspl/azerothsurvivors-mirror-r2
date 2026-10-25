import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const base = 'https://azerothsurvivors-mirror.sandervspl.dev';
const report = { base, checkedAt: new Date().toISOString(), passed: false, checks: [] };
const root = new URL('../', import.meta.url);
try {
  const page = await fetch(base + '/'); assert.equal(page.status, 200);
  const html = await page.text(); assert.ok(html.includes('Azeroth Survivors'));
  const release = await fetch(base + '/api/release').then(result => result.json());
  assert.ok(html.includes(release.version));
  const head = await fetch(base + release.downloadUrl, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(Number(head.headers.get('content-length')), release.bytes);
  const resume = await fetch(base + release.downloadUrl, { headers: { Range: 'bytes=1024-2047' } });
  assert.equal(resume.status, 206); assert.equal((await resume.arrayBuffer()).byteLength, 1024);
  report.release = release; report.checks.push('Public page, release metadata, archive HEAD and nonzero range remain available without recording a download start');
  const session = await fetch(base + '/api/admin/session').then(result => result.json()); assert.equal(session.configured, true); assert.equal(session.authenticated, false);
  assert.equal((await fetch(base + '/api/admin/stats')).status, 401);
  const admin = await fetch(base + '/admin').then(result => result.text()); assert.ok(admin.includes('id="upload-form"')); assert.ok(!admin.includes('id="stats-title"')); assert.ok(admin.includes('href="/admin/stats"'));
  for (const path of ['/admin/stats', '/admin/stats/']) {
    const response = await fetch(base + path); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const stats = await response.text(); assert.ok(stats.includes('id="stats-title"')); assert.ok(stats.includes('id="stats-days"')); assert.ok(!stats.includes('id="upload-form"')); assert.ok(stats.includes('data-mode="login"'));
  }
  const app = await fetch(base + '/admin/app.js'); assert.equal(app.status, 200); assert.ok((await app.text()).includes('/api/admin/stats'));
  report.checks.push('Stats API requires authentication, releases and stats use separate uncached pages, direct stats visits require login, and production assets contain the stats client');
  for (const path of ['/admin/tokens', '/admin/tokens/']) {
    const response = await fetch(base + path); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const html = await response.text(); assert.ok(html.includes('id="token-form"')); assert.ok(html.includes('data-mode="login"')); assert.ok(!html.includes('id="upload-form"')); assert.ok(!html.includes('id="stats-days"')); assert.ok(!html.includes('as_mirror_'));
  }
  assert.equal((await fetch(base + '/api/admin/tokens')).status, 401);
  assert.equal((await fetch(base + '/api/admin/tokens', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'unauthenticated smoke request' }) })).status, 401);
  assert.equal((await fetch(base + '/api/admin/uploads', { method: 'POST', headers: { Authorization: 'Bearer invalid', 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  report.checks.push('Dedicated token pages require login and contain no tokens; unauthenticated token creation and invalid bearer upload are denied without mutating production');
  const query = `SELECT blob1 AS event, COUNT(*) AS count FROM events.analyticsEngine.azerothsurvivors_downloads WHERE accountTag = 'ca0578fc475d4ccbf2e176a18e6674e5' AND timestamp >= NOW() - INTERVAL '1' DAY GROUP BY event`;
  const queryFile = new URL('.local/analytics-production-query.sql', root); await writeFile(queryFile, query);
  let engine;
  for (let attempt = 0; attempt < 24; attempt++) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('node_modules/cf/bin/cf', root)), 'analytics', 'sql', 'post', '--file', fileURLToPath(queryFile)], { encoding: 'utf8', cwd: fileURLToPath(root) });
    if (result.status === 0) { engine = JSON.parse(result.stdout); break; }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  assert.ok(engine, 'Production Analytics SQL dataset must be queryable within two minutes');
  report.analytics = engine; report.checks.push('Production Analytics SQL API can query the dedicated dataset; no synthetic download starts were generated');
  report.passed = true;
} catch (error) { report.error = error.stack; process.exitCode = 1; console.error(error); }
finally {
  await mkdir(new URL('artifacts/', root), { recursive: true });
  await writeFile(new URL('artifacts/analytics-production.json', root), JSON.stringify(report, null, 2) + '\n');
  console.log('Evidence saved to artifacts/analytics-production.json');
}
