import { open, readFile, mkdir, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

const secretPath = new URL('../.local/upload-secret.json', import.meta.url);
if (process.argv[2] === 'init') {
  await mkdir(new URL('../.local/', import.meta.url), { recursive: true });
  await writeFile(secretPath, JSON.stringify({ UPLOAD_TOKEN: randomBytes(32).toString('hex') }), { flag: 'wx' });
  console.log('Created local upload credential. Deploy tools/upload with --secrets-file pointing to .local/upload-secret.json.');
  process.exit(0);
}
const [base, filePath] = process.argv.slice(2);
if (!base || !filePath) throw new Error('Usage: node scripts/upload.mjs <temporary-worker-url> <archive-path>');
const expectedHash = '971db7968dc37ec50b18d64a1de7f693e137f6793a7368e4d5c27bd9522eccd8';
const hash = createHash('sha256');
for await (const chunk of createReadStream(filePath)) hash.update(chunk);
if (hash.digest('hex') !== expectedHash) throw new Error('Archive differs from the documented release. Update release metadata before uploading.');
const { UPLOAD_TOKEN } = JSON.parse(await readFile(secretPath, 'utf8'));
const file = await open(resolve(filePath));
const size = (await file.stat()).size;
async function call(path, method, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await fetch(new URL(path, base), {
        method, headers: { Authorization: `Bearer ${UPLOAD_TOKEN}` }, body,
        signal: AbortSignal.timeout(180000),
      });
      if (!result.ok) throw new Error(`Upload ${path.split('?')[0]} returned ${result.status}: ${await result.text()}`);
      return result.status === 204 ? null : await result.json();
    } catch (error) { if (attempt === 2) throw error; console.log(`Retrying ${path.split('?')[0]}...`); }
  }
}
const { uploadId } = await call('/start', 'POST');
const query = `uploadId=${encodeURIComponent(uploadId)}`;
try {
  const parts = [];
  const chunkSize = 32 * 1024 * 1024;
  for (let position = 0, number = 1; position < size; position += chunkSize, number++) {
    const length = Math.min(chunkSize, size - position);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await file.read(buffer, read, length - read, position + read);
      if (!bytesRead) throw new Error('Unexpected end of archive');
      read += bytesRead;
    }
    parts.push(await call(`/part?${query}&number=${number}`, 'PUT', buffer));
    console.log(`Uploaded part ${number}/${Math.ceil(size / chunkSize)} (${Math.round((position + length) / size * 100)}%)`);
  }
  const result = await call(`/complete?${query}`, 'POST', JSON.stringify(parts));
  if (result.size !== size) throw new Error('Uploaded size mismatch');
  await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
  await writeFile(new URL('../artifacts/upload.json', import.meta.url), JSON.stringify({ ...result, sha256: expectedHash, verifiedAt: new Date().toISOString() }, null, 2) + '\n');
  console.log(`Completed: ${result.size} bytes uploaded to R2.`);
} catch (error) {
  await call(`/abort?${query}`, 'POST').catch(() => {});
  throw error;
} finally { await file.close(); }
