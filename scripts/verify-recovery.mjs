// Live storage-failure recovery scenario, restricted to the disposable staging bucket.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { apiClient } from './api-client.mjs';

const base = 'https://azerothsurvivors-release-staging.sandervispoel.workers.dev';
const { password } = JSON.parse(await readFile(new URL('../.local/staging-credential.json', import.meta.url)));
const client = apiClient(base); await client.login(password);
const release = await fetch(base + '/api/release').then(response => response.json());
const indexKey = `history/${String(9999999999999 - Number(release.id.slice(0, 13))).padStart(13, '0')}-${release.id}.json`;
const cf = fileURLToPath(new URL('../node_modules/cf/bin/cf', import.meta.url));
const deletion = spawnSync(process.execPath, [cf, 'r2', 'objects', 'bulk-delete', '--bucket-name', 'azerothsurvivors-release-staging', '--body', JSON.stringify([indexKey]), '--force'], { encoding: 'utf8' });
if (deletion.status !== 0) throw new Error('Could not simulate a missing staging history index: ' + deletion.stderr);
assert.ok(!(await client.request('/api/admin/releases')).releases.some(item => item.id === release.id));
const retried = await client.request(`/api/admin/uploads/${release.id}/complete`, { method: 'POST', json: { sha256: release.sha256, md5: release.md5 } });
assert.equal(retried.release.id, release.id);
assert.ok((await client.request('/api/admin/releases')).releases.some(item => item.id === release.id));
assert.equal((await fetch(base + '/api/release').then(response => response.json())).id, release.id);
await writeFile(new URL('../artifacts/recovery-e2e.json', import.meta.url), JSON.stringify({ verifiedAt: new Date().toISOString(), base, releaseId: release.id, missingHistoryIndexRestored: true, currentReleaseUnchanged: true, passed: true }, null, 2) + '\n');
console.log('PASS retried completion restores a missing history index without changing the current release.');
