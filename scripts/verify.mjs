// Live HTTP E2E: resume the entire release across independent range requests,
// verify its hash, and exercise actual Worker/R2 protocol behavior.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';

const base = process.argv[2] || 'https://azerothsurvivors-mirror.sandervspl.dev';
const checks = [];
const report = { base, startedAt: new Date().toISOString(), checks, passed: false };
let expected;
let downloadUrl;
async function get(path, options = {}) {
  return fetch(new URL(path, base), { ...options, signal: AbortSignal.timeout(180000) });
}
async function check(name, run) {
  await run(); checks.push({ name, passed: true }); console.log(`PASS ${name}`);
}
try {
  await check('Public page, release metadata, checksum file, and versioned download links agree', async () => {
    expected = await get('/api/release').then(r => r.json());
    report.release = expected;
    assert.ok(expected.id && expected.filename && expected.bytes > 0);
    assert.match(expected.sha256, /^[0-9a-f]{64}$/);
    assert.match(expected.md5, /^[0-9a-f]{32}$/);
    downloadUrl = expected.downloadUrl;
    assert.equal(downloadUrl, `/downloads/${expected.id}/${encodeURIComponent(expected.filename)}`);
    if (process.argv[3]) {
      const sha256 = createHash('sha256'), md5 = createHash('md5');
      for await (const bytes of createReadStream(process.argv[3])) { sha256.update(bytes); md5.update(bytes); }
      assert.equal(expected.sha256, sha256.digest('hex')); assert.equal(expected.md5, md5.digest('hex'));
      assert.equal(expected.bytes, (await stat(process.argv[3])).size);
    }
    const page = await get('/');
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes(`href="${downloadUrl.replace(/&/g, '&amp;')}"`));
    assert.ok(html.includes(expected.sha256));
    assert.ok(html.includes(expected.md5));
    const metadata = await get('/api/release').then(r => r.json());
    for (const [key, value] of Object.entries(expected)) assert.equal(metadata[key], value);
    const sums = await get(`/checksums.txt?release=${expected.id}`);
    assert.equal(sums.status, 200);
    assert.equal(await sums.text(), `${expected.sha256}  ${expected.filename}\n`);
  });
  const head = await get(downloadUrl, { method: 'HEAD' });
  const etag = head.headers.get('etag');
  await check('Download headers support saving and resuming the exact archive', async () => {
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get('content-length')), expected.bytes);
    assert.equal(head.headers.get('accept-ranges'), 'bytes');
    assert.ok(head.headers.get('content-disposition').includes("filename*=UTF-8''"));
    assert.ok(etag);
    const rangedHead = await get(downloadUrl, { method: 'HEAD', headers: { Range: 'bytes=0-9' } });
    assert.equal(rangedHead.status, 200);
    assert.equal(Number(rangedHead.headers.get('content-length')), expected.bytes);
  });
  await check('A disconnected download resumes to the complete SHA-256 verified file', async () => {
    const hash = createHash('sha256');
    const md5 = createHash('md5');
    const chunk = 32 * 1024 * 1024;
    let total = 0;
    let tail;
    for (let start = 0; start < expected.bytes; start += chunk) {
      const end = Math.min(start + chunk, expected.bytes) - 1;
      const result = await get(downloadUrl, { headers: { Range: `bytes=${start}-${end}`, 'If-Range': etag } });
      assert.equal(result.status, 206);
      assert.equal(result.headers.get('content-range'), `bytes ${start}-${end}/${expected.bytes}`);
      assert.equal(result.headers.get('etag'), etag);
      const bytes = Buffer.from(await result.arrayBuffer());
      assert.equal(bytes.length, end - start + 1);
      total += bytes.length;
      hash.update(bytes); md5.update(bytes);
      tail = bytes.subarray(-128);
      console.log(`Verified ${total}/${expected.bytes} bytes`);
    }
    report.download = { bytes: total, sha256: hash.digest('hex'), md5: md5.digest('hex'), rangeRequests: Math.ceil(expected.bytes / chunk) };
    assert.equal(report.download.sha256, expected.sha256);
    assert.equal(report.download.md5, expected.md5);
    const suffix = await get(downloadUrl, { headers: { Range: 'bytes=-128' } });
    assert.equal(suffix.status, 206);
    assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), tail);
  });
  await check('Open-ended ranges and oversized range ends resolve to the file boundary', async () => {
    const length = Math.min(64, expected.bytes);
    for (const range of [`bytes=${expected.bytes - length}-`, `bytes=${expected.bytes - length}-${expected.bytes + 1000}`]) {
      const result = await get(downloadUrl, { headers: { Range: range } });
      assert.equal(result.status, 206);
      assert.equal((await result.arrayBuffer()).byteLength, length);
    }
  });
  await check('Invalid and unsatisfiable ranges return 416', async () => {
    for (const range of [`bytes=${expected.bytes}-`, 'bytes=20-10', 'bytes=-0', 'bytes=0-1,3-4', 'bytes=-', 'items=0-1']) {
      const result = await get(downloadUrl, { headers: { Range: range } });
      assert.equal(result.status, 416, range);
      assert.equal(result.headers.get('content-range'), `bytes */${expected.bytes}`);
      await result.body?.cancel();
    }
  });
  await check('Cache revalidation works and stale If-Range restarts the full download', async () => {
    for (const headers of [{ 'If-None-Match': etag }, { 'If-None-Match': `"other", W/${etag}` }, { 'If-Modified-Since': head.headers.get('last-modified') }]) {
      assert.equal((await get(downloadUrl, { headers })).status, 304);
    }
    const result = await get(downloadUrl, { headers: { Range: 'bytes=100-200', 'If-Range': '"stale-etag"' } });
    assert.equal(result.status, 200);
    assert.equal(Number(result.headers.get('content-length')), expected.bytes);
    await result.body.cancel();
    const alias = await get('/download', { headers: { Range: 'bytes=0-7' } });
    assert.equal(alias.status, 206);
    assert.equal((await alias.arrayBuffer()).byteLength, Math.min(8, expected.bytes));
  });
  await check('Unknown paths and unsupported methods fail clearly', async () => {
    assert.equal((await get('/missing')).status, 404);
    const result = await get(downloadUrl, { method: 'POST' });
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
