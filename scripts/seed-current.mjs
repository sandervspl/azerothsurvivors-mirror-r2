// One-time metadata migration for the archive already present at its original R2 key.
// This only prepares files; inspect the bucket before using cf to create the manifests.
import { createReadStream } from 'node:fs';
import { stat, mkdir, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const path = process.argv[2];
if (!path) throw new Error('Usage: node scripts/seed-current.mjs <existing-archive-path>');
const sha256 = createHash('sha256'), md5 = createHash('md5');
for await (const bytes of createReadStream(path)) { sha256.update(bytes); md5.update(bytes); }
const id = `${Date.now()}-${randomUUID()}`;
const release = { id, key: basename(path), filename: basename(path), bytes: (await stat(path)).size, sha256: sha256.digest('hex'), md5: md5.digest('hex'), version: 'Initial mirror upload', published: new Date().toISOString() };
await mkdir(new URL('../.local/', import.meta.url), { recursive: true });
await writeFile(new URL('../.local/seed-manifest.json', import.meta.url), JSON.stringify(release, null, 2) + '\n');
await writeFile(new URL('../.local/seed-current.json', import.meta.url), JSON.stringify({ ...release, revision: randomUUID() }, null, 2) + '\n');
const historyKey = `history/${String(9999999999999 - Number(id.slice(0, 13))).padStart(13, '0')}-${id}.json`;
console.log(JSON.stringify({ id, manifestKey: `manifests/${id}.json`, historyKey, currentKey: 'release.json', ...release }, null, 2));
