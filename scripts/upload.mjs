import { open, readFile, mkdir, writeFile, unlink } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { apiClient, ApiError } from './api-client.mjs';

export async function publishArchive({ base, path, version = '', password, token, resumePath, progress = console.log }) {
  const client = apiClient(base, { token });
  if (!token) await client.login(password);
  const actualPath = path instanceof URL ? fileURLToPath(path) : resolve(path);
  const file = await open(actualPath);
  const size = (await file.stat()).size;
  const name = basename(actualPath);
  let upload;
  try {
    if (resumePath) {
      try { upload = JSON.parse(await readFile(resumePath, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (upload && (upload.filename !== name || upload.bytes !== size || upload.base !== new URL(base).origin)) throw new Error('Saved upload belongs to another archive or host. Use a different resume file.');
    if (!upload) {
      const history = await client.request('/api/admin/releases');
      const started = await client.request('/api/admin/uploads', { method: 'POST', json: { filename: name, bytes: size, version, expectedCurrentId: history.current } });
      upload = { id: started.id, filename: name, bytes: size, base: new URL(base).origin };
      if (resumePath) await writeFile(resumePath, JSON.stringify(upload), { mode: 0o600 });
    }
    const state = await client.request('/api/admin/uploads/' + upload.id);
    const known = new Map(state.parts.map(part => [part.partNumber, part.etag]));
    const sha256 = createHash('sha256'), md5 = createHash('md5');
    for (let offset = 0, number = 1; offset < size; offset += state.partSize, number++) {
      const length = Math.min(state.partSize, size - offset);
      const bytes = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const { bytesRead } = await file.read(bytes, read, length - read, offset + read);
        if (!bytesRead) throw new Error('Unexpected end of file');
        read += bytesRead;
      }
      sha256.update(bytes); md5.update(bytes);
      const partMd5 = createHash('md5').update(bytes).digest('hex');
      if (known.has(number)) {
        if (known.get(number) !== partMd5) throw new Error('The selected file differs from the saved upload. Start a new upload.');
      } else {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const part = await client.request('/api/admin/uploads/' + upload.id + '/parts/' + number, { method: 'PUT', bytes, md5: partMd5 });
            if (part.etag !== partMd5) throw new Error('R2 part verification failed');
            break;
          } catch (error) { if (attempt === 2 || error instanceof ApiError && error.status < 500 && error.status !== 422) throw error; }
        }
      }
      progress('Verified part ' + number + '/' + Math.ceil(size / state.partSize) + ' (' + Math.round((offset + length) / size * 100) + '%)');
    }
    const result = await client.request('/api/admin/uploads/' + upload.id + '/complete', { method: 'POST', json: { sha256: sha256.digest('hex'), md5: md5.digest('hex') } });
    if (resumePath) await unlink(resumePath).catch(() => {});
    return result.release;
  } finally { await file.close(); }
}

async function hiddenPassword() {
  if (process.env.MIRROR_ADMIN_PASSWORD) return process.env.MIRROR_ADMIN_PASSWORD;
  if (!process.stdin.isTTY) throw new Error('Run in an interactive terminal, or supply MIRROR_ADMIN_PASSWORD through your secret manager.');
  process.stdout.write('Admin password: ');
  process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
  return new Promise((resolvePassword, reject) => {
    let value = '';
    const finish = () => { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onData); process.stdout.write('\n'); };
    const onData = text => {
      for (const char of text) {
        if (char === '\u0003') { finish(); reject(new Error('Cancelled')); return; }
        if (char === '\r' || char === '\n') { finish(); resolvePassword(value); return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ' && value.length < 256) value += char;
      }
    };
    process.stdin.on('data', onData);
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [path, version = '', base = 'https://azerothsurvivors-mirror.sandervspl.dev'] = process.argv.slice(2);
    if (!path) throw new Error('Usage: npm run upload -- <archive-path> [version-label] [mirror-url]');
    await mkdir(new URL('../.local/', import.meta.url), { recursive: true });
    const resumePath = process.env.MIRROR_UPLOAD_STATE ? resolve(process.env.MIRROR_UPLOAD_STATE) : new URL('../.local/cli-upload.json', import.meta.url);
    const token = process.env.MIRROR_API_TOKEN;
    const release = await publishArchive({ base, path, version, ...(token ? { token } : { password: await hiddenPassword() }), resumePath });
    await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
    await writeFile(new URL('../artifacts/upload.json', import.meta.url), JSON.stringify({ ...release, verifiedAt: new Date().toISOString() }, null, 2) + '\n');
    console.log('Published ' + release.filename + '\nSHA-256: ' + release.sha256 + '\nMD5: ' + release.md5 + '\n' + new URL(release.downloadUrl, base));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
