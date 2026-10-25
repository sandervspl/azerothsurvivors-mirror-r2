import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { apiClient, ApiError } from './api-client.mjs';
import { publishArchive } from './upload.mjs';

const base = process.argv[2] || 'https://azerothsurvivors-release-staging.sandervispoel.workers.dev';
if (!new URL(base).hostname.startsWith('azerothsurvivors-release-staging.')) throw new Error('Publishing E2E runs only on the dedicated staging Worker.');
const checks = [];
const report = { base, startedAt: new Date().toISOString(), passed: false, checks, releases: [] };
const client = apiClient(base);
const hash = bytes => ({ sha256: createHash('sha256').update(bytes).digest('hex'), md5: createHash('md5').update(bytes).digest('hex') });
async function check(name, work) { await work(); checks.push({ name, passed: true }); console.log(`PASS ${name}`); }
async function rejects(status, work) { await assert.rejects(work, error => error instanceof ApiError && error.status === status); }
async function live() { const result = await fetch(base + '/api/release'); return result.status === 503 ? null : result.json(); }
async function start(filename, bytes, version) { return client.request('/api/admin/uploads', { method: 'POST', json: { filename, bytes, version, expectedCurrentId: (await live())?.id || null } }); }
async function part(id, number, bytes, md5 = hash(bytes).md5) { return client.request(`/api/admin/uploads/${id}/parts/${number}`, { method: 'PUT', bytes, md5 }); }
async function complete(id, bytes) { return client.request(`/api/admin/uploads/${id}/complete`, { method: 'POST', json: hash(bytes) }); }
async function verify(release, bytes) {
  assert.deepEqual({ sha256: release.sha256, md5: release.md5 }, hash(bytes));
  const response = await fetch(new URL(release.downloadUrl, base));
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  const page = await fetch(base + '/').then(r => r.text());
  const active = await live();
  assert.ok(page.includes(active.sha256)); assert.ok(page.includes(active.md5)); assert.ok(page.includes(active.downloadUrl.replace(/&/g, '&amp;')));
}
try {
  await mkdir(new URL('../.local/', import.meta.url), { recursive: true });
  let password;
  try { password = JSON.parse(await readFile(new URL('../.local/staging-credential.json', import.meta.url))).password; }
  catch { password = randomBytes(24).toString('hex'); await writeFile(new URL('../.local/staging-credential.json', import.meta.url), JSON.stringify({ password }), { mode: 0o600 }); }
  const setupUrl = new URL((await readFile(new URL('../.local/staging-setup-url.txt', import.meta.url), 'utf8')).trim());
  const token = new URLSearchParams(setupUrl.hash.slice(1)).get('token');
  await check('Upload APIs are locked without a valid session; setup token is required and single use', async () => {
    await rejects(401, () => client.request('/api/admin/uploads', { method: 'POST', json: {} }));
    const session = await client.request('/api/admin/session');
    if (!session.configured) {
      await rejects(403, () => client.request('/api/admin/setup', { method: 'POST', json: { token: 'incorrect', password } }));
      await client.request('/api/admin/setup', { method: 'POST', json: { token, password } });
    }
    await rejects(409, () => client.request('/api/admin/setup', { method: 'POST', json: { token, password } }));
    await rejects(401, () => apiClient(base).login('incorrect-password'));
    await client.login(password);
    const wrongCookie = await fetch(base + '/api/admin/releases', { headers: { Cookie: '__Host-mirror_session=forged' } });
    assert.equal(wrongCookie.status, 401);
  });
  await check('Cross-origin changes and unsafe upload metadata are rejected', async () => {
    await rejects(403, () => client.request('/api/admin/uploads', { method: 'POST', json: {}, headers: { Origin: 'https://untrusted.example' } }));
    for (const filename of ['../archive.rar', 'archive.html', 'bad"name.rar']) await rejects(400, () => start(filename, 100, 'invalid'));
    await rejects(400, () => start('archive.rar', 0, 'invalid'));
  });
  const name = 'Azeroth Survivors - Windows build & download mirror - long filename é新.rar';
  const bytesA = Buffer.alloc(33 * 1024 * 1024 + 137);
  for (let index = 0; index < bytesA.length; index++) bytesA[index] = (index * 31 + 7) & 255;
  Buffer.from('526172211a070100', 'hex').copy(bytesA);
  const fixture = new URL(`../.local/${name}`, import.meta.url);
  await writeFile(fixture, bytesA);
  const beforeA = await live();
  const a = await start(name, bytesA.length, 'E2E resumed release A');
  await check('Invalid parts and incomplete publication cannot change the current release', async () => {
    await rejects(400, () => part(a.id, 0, Buffer.from([1])));
    await rejects(400, () => part(a.id, 1, Buffer.from([1])));
    await rejects(422, () => part(a.id, 2, bytesA.subarray(a.partSize), '0'.repeat(32)));
    await rejects(409, () => complete(a.id, bytesA));
    assert.equal((await live())?.id || null, beforeA?.id || null);
  });
  await part(a.id, 1, bytesA.subarray(0, a.partSize));
  const resumePath = new URL('../.local/e2e-resume.json', import.meta.url);
  await writeFile(resumePath, JSON.stringify({ id: a.id, filename: name, bytes: bytesA.length, base }));
  let releaseA;
  await check('A new CLI client resumes a multipart upload and publishes independently verified hashes', async () => {
    releaseA = await publishArchive({ base, path: fixture, version: 'ignored on resume', password, resumePath, progress: console.log });
    await verify(releaseA, bytesA);
    const retried = await complete(a.id, bytesA);
    assert.equal(retried.release.id, releaseA.id);
    await rejects(409, () => client.request(`/api/admin/uploads/${a.id}/abort`, { method: 'POST' }));
    report.releases.push({ id: releaseA.id, bytes: bytesA.length, ...hash(bytesA), resumedParts: 1 });
  });
  const bytesB = Buffer.from(bytesA); bytesB[200] ^= 255;
  const b = await start(name, bytesB.length, 'E2E replacement B');
  const bytesC = Buffer.from('PK\x03\x04Concurrent upload C. This is an isolated E2E fixture.');
  const c = await start('concurrent-c.zip', bytesC.length, 'E2E concurrent C');
  await part(b.id, 1, bytesB.subarray(0, b.partSize));
  await check('Same-name uploads leave the previous version public until all parts are complete', async () => {
    assert.equal((await live()).id, releaseA.id);
    await rejects(409, () => complete(b.id, bytesB));
    await verify(releaseA, bytesA);
  });
  await part(b.id, 2, bytesB.subarray(b.partSize));
  const releaseB = (await complete(b.id, bytesB)).release;
  await check('Publication updates the mirror while old immutable downloads remain intact', async () => {
    await verify(releaseB, bytesB); await verify(releaseA, bytesA);
    assert.equal((await live()).id, releaseB.id);
    report.releases.push({ id: releaseB.id, bytes: bytesB.length, ...hash(bytesB) });
  });
  await part(c.id, 1, bytesC);
  await check('A concurrent publication is archived and returns a conflict instead of overwriting current', async () => {
    await rejects(409, () => complete(c.id, bytesC));
    assert.equal((await live()).id, releaseB.id);
    const archived = await fetch(`${base}/api/releases/${c.id}`).then(r => r.json());
    await verify(archived, bytesC);
  });
  await check('Rollback restores the old file and hashes; stale activation and aborts are safe', async () => {
    await client.request(`/api/admin/releases/${releaseA.id}/activate`, { method: 'POST', json: { expectedCurrentId: releaseB.id } });
    await verify(releaseA, bytesA);
    await rejects(409, () => client.request(`/api/admin/releases/${releaseB.id}/activate`, { method: 'POST', json: { expectedCurrentId: releaseB.id } }));
    const abandoned = await start('discard.zip', bytesC.length, 'Discard me');
    await client.request(`/api/admin/uploads/${abandoned.id}/abort`, { method: 'POST' });
    await rejects(409, () => part(abandoned.id, 1, bytesC));
    assert.equal((await live()).id, releaseA.id);
  });
  await check('Pinned ranges, cache revalidation, checksums, and private paths behave correctly', async () => {
    const response = await fetch(new URL(releaseA.downloadUrl, base), { headers: { Range: 'bytes=33554400-33554500' } });
    assert.equal(response.status, 206); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytesA.subarray(33554400, 33554501));
    assert.equal((await fetch(new URL(releaseA.downloadUrl, base), { headers: { 'If-None-Match': response.headers.get('etag') } })).status, 304);
    assert.equal(await fetch(`${base}/checksums.txt?release=${releaseA.id}`).then(r => r.text()), `${releaseA.sha256}  ${name}\n`);
    assert.equal((await fetch(base + '/admin/auth.json')).status, 404);
    assert.equal((await fetch(base + '/release.json')).status, 404);
    const session = await client.request('/api/admin/session'); assert.equal(session.authenticated, true);
    await client.request('/api/admin/logout', { method: 'POST' });
    await rejects(401, () => client.request('/api/admin/releases'));
  });
  report.passed = true;
} catch (error) { report.error = error.stack; process.exitCode = 1; console.error(error); }
finally {
  report.finishedAt = new Date().toISOString();
  await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
  await writeFile(new URL('../artifacts/publishing-e2e.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log('Evidence written to artifacts/publishing-e2e.json');
}
