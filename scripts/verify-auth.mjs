import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const base = 'https://azerothsurvivors-release-staging.sandervispoel.workers.dev';
assert.equal((await fetch(base + '/api/admin/session').then(r => r.json())).configured, true);
const statuses = [];
for (let attempt = 0; attempt < 20; attempt++) {
  const result = await fetch(base + '/api/admin/login', {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'intentionally-incorrect-test-password' }),
  });
  statuses.push(result.status); await result.body?.cancel();
  if (result.status === 429) break;
  assert.equal(result.status, 401);
}
assert.ok(statuses.includes(429), 'Repeated incorrect passwords must trigger throttling.');
await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
await writeFile(new URL('../artifacts/auth-rate-limit.json', import.meta.url), JSON.stringify({ verifiedAt: new Date().toISOString(), base, passed: true, statuses }, null, 2) + '\n');
console.log('PASS staging sign-in attempts are rate limited; evidence written to artifacts/auth-rate-limit.json');
