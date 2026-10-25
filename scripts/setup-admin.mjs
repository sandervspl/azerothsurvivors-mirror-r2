import { randomBytes, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

const [base = 'https://azerothsurvivors-mirror.sandervspl.dev', label = 'admin'] = process.argv.slice(2);
if (!/^[a-z-]+$/.test(label) || new URL(base).protocol !== 'https:') throw new Error('Use an HTTPS URL and a simple local label.');
const token = randomBytes(32).toString('hex');
const root = new URL('../.local/', import.meta.url);
await mkdir(root, { recursive: true });
await writeFile(new URL(`${label}-secrets.json`, root), JSON.stringify({ ADMIN_SETUP_HASH: createHash('sha256').update(token).digest('hex') }), { flag: 'wx', mode: 0o600 });
await writeFile(new URL(`${label}-setup-url.txt`, root), `${base.replace(/\/$/, '')}/admin/setup#token=${token}\n`, { flag: 'wx', mode: 0o600 });
console.log(`Setup hash saved to .local/${label}-secrets.json; private setup link saved to .local/${label}-setup-url.txt. No password has been generated or stored.`);
