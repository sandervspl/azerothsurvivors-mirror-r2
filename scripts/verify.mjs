// Live HTTP E2E: resume the entire release across independent range requests,
// verify its hash, and exercise actual Worker/R2 protocol behavior.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

const base = process.argv[2] || 'https://azerothsurvivors-mirror.sandervspl.dev';
const checks = [];
const report = { base, startedAt: new Date().toISOString(), checks, passed: false };
const expected = {
  filename: 'AzerothSurvivorsWindowsNew.rar',
  bytes: 760497456,
  sha256: '971db7968dc37ec50b18d64a1de7f693e137f6793a7368e4d5c27bd9522eccd8',
};
async function get(path, options = {}) {
  return fetch(new URL(path, base), { ...options, signal: AbortSignal.timeout(180000) });
}
async function check(name, run) {
  await run(); checks.push({ name, passed: true }); console.log(`PASS ${name}`);
}
try {
  await check('Public page, release metadata, checksum file, and download links agree', async () => {
    const page = await get('/');
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes('href="/download"'));
    assert.ok(html.includes(expected.sha256));
    const metadata = await get('/api/release').then(r => r.json());
    for (const [key, value] of Object.entries(expected)) assert.equal(metadata[key], value);
    const sums = await get('/checksums.txt');
    assert.equal(sums.status, 200);
    assert.equal(await sums.text(), `${expected.sha256}  ${expected.filename}\n`);
  });
  const head = await get('/download', { method: 'HEAD' });
  const etag = head.headers.get('etag');
  await check('Download headers support saving and resuming the exact archive', async () => {
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get('content-length')), expected.bytes);
    assert.equal(head.headers.get('accept-ranges'), 'bytes');
    assert.ok(head.headers.get('content-disposition').includes(expected.filename));
    assert.ok(etag);
    const rangedHead = await get('/download', { method: 'HEAD', headers: { Range: 'bytes=0-9' } });
    assert.equal(rangedHead.status, 200);
    assert.equal(Number(rangedHead.headers.get('content-length')), expected.bytes);
  });
  await check('A disconnected download resumes to the complete SHA-256 verified file', async () => {
    const hash = createHash('sha256');
    const chunk = 32 * 1024 * 1024;
    let total = 0;
    let tail;
    for (let start = 0; start < expected.bytes; start += chunk) {
      const end = Math.min(start + chunk, expected.bytes) - 1;
      const result = await get('/download', { headers: { Range: `bytes=${start}-${end}`, 'If-Range': etag } });
      assert.equal(result.status, 206);
      assert.equal(result.headers.get('content-range'), `bytes ${start}-${end}/${expected.bytes}`);
      assert.equal(result.headers.get('etag'), etag);
      const bytes = Buffer.from(await result.arrayBuffer());
      assert.equal(bytes.length, end - start + 1);
      if (start === 0) assert.equal(bytes.subarray(0, 8).toString('hex'), '526172211a070100');
      total += bytes.length;
      hash.update(bytes);
      tail = bytes.subarray(-128);
      console.log(`Verified ${total}/${expected.bytes} bytes`);
    }
    report.download = { bytes: total, sha256: hash.digest('hex'), rangeRequests: Math.ceil(expected.bytes / chunk) };
    assert.equal(report.download.sha256, expected.sha256);
    const suffix = await get('/download', { headers: { Range: 'bytes=-128' } });
    assert.equal(suffix.status, 206);
    assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), tail);
  });
  await check('Open-ended ranges and oversized range ends resolve to the file boundary', async () => {
    for (const range of [`bytes=${expected.bytes - 64}-`, `bytes=${expected.bytes - 64}-${expected.bytes + 1000}`]) {
      const result = await get('/download', { headers: { Range: range } });
      assert.equal(result.status, 206);
      assert.equal((await result.arrayBuffer()).byteLength, 64);
    }
  });
  await check('Invalid and unsatisfiable ranges return 416', async () => {
    for (const range of [`bytes=${expected.bytes}-`, 'bytes=20-10', 'bytes=-0', 'bytes=0-1,3-4', 'bytes=-', 'items=0-1']) {
      const result = await get('/download', { headers: { Range: range } });
      assert.equal(result.status, 416, range);
      assert.equal(result.headers.get('content-range'), `bytes */${expected.bytes}`);
      await result.body?.cancel();
    }
  });
  await check('Cache revalidation works and stale If-Range restarts the full download', async () => {
    for (const headers of [{ 'If-None-Match': etag }, { 'If-None-Match': `"other", W/${etag}` }, { 'If-Modified-Since': head.headers.get('last-modified') }]) {
      assert.equal((await get('/download', { headers })).status, 304);
    }
    const result = await get('/download', { headers: { Range: 'bytes=100-200', 'If-Range': '"stale-etag"' } });
    assert.equal(result.status, 200);
    assert.equal(Number(result.headers.get('content-length')), expected.bytes);
    await result.body.cancel();
    const alias = await get(`/downloads/${expected.filename}`, { headers: { Range: 'bytes=0-7' } });
    assert.equal(alias.status, 206);
    assert.equal((await alias.arrayBuffer()).byteLength, 8);
  });
  await check('Unknown paths and unsupported methods fail clearly', async () => {
    assert.equal((await get('/missing')).status, 404);
    const result = await get('/download', { method: 'POST' });
    assert.equal(result.status, 405);
    assert.equal(result.headers.get('allow'), 'GET, HEAD');
  });
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
  console.error(error);
} finally {
  report.finishedAt = new Date().toISOString();
  await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
  await writeFile(new URL('../artifacts/e2e.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log('Evidence written to artifacts/e2e.json');
}
