import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stateFilePath, prepareStateStorage } from './storage.js';
import { Store } from './state.js';
import { DonationLedger } from './donations.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bot-storage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const local = join(root, 'app', 'data'), volume = join(root, 'volume');
  mkdirSync(local, { recursive: true }); mkdirSync(volume);
  return { local, volume };
}
test('Railway refuses ephemeral state and uses its provided mount path', t => {
  const { local, volume } = fixture(t);
  assert.throws(() => stateFilePath({ RAILWAY_SERVICE_ID: 'service' }, local), /Attach a Volume/);
  assert.throws(() => stateFilePath({ RAILWAY_ENVIRONMENT_ID: 'environment' }, local), /Attach a Volume/);
  assert.equal(stateFilePath({ RAILWAY_SERVICE_ID: 'service', RAILWAY_VOLUME_MOUNT_PATH: volume }, local), join(volume, 'state.json'));
  assert.equal(stateFilePath({}, local), join(local, 'state.json'));
  assert.throws(() => prepareStateStorage({ RAILWAY_VOLUME_MOUNT_PATH: join(volume, 'missing') }, local), /mount directory is missing/);
});
test('available legacy state is copied to the volume without overwriting existing state', t => {
  const { local, volume } = fixture(t);
  writeFileSync(join(local, 'state.json'), 'legacy');
  const target = prepareStateStorage({ RAILWAY_VOLUME_MOUNT_PATH: volume }, local);
  assert.equal(readFileSync(target, 'utf8'), 'legacy');
  assert.equal(readFileSync(join(local, 'state.json'), 'utf8'), 'legacy');
  writeFileSync(target, 'existing volume data');
  prepareStateStorage({ RAILWAY_VOLUME_MOUNT_PATH: volume }, local);
  assert.equal(readFileSync(target, 'utf8'), 'existing volume data');
});
test('verified totals and name links survive deployment to another application directory', t => {
  const { local, volume } = fixture(t);
  const env = { RAILWAY_SERVICE_ID: 'service', RAILWAY_VOLUME_MOUNT_PATH: volume };
  const first = new Store(prepareStateStorage(env, local), '2026-11-02', 'guild', 'Europe/Paris');
  const ledger = new DonationLedger(first);
  ledger.link('member', 'Tomhawky');
  ledger.saveProof({ id: 'proof', status: 'pending', signature: 'image', hashes: ['hash'], rows: [{ name: 'Tomhawky', amount: 2000, time: '08:09' }] });
  ledger.approve('proof', { id: 'officer', user: { bot: false }, roles: { cache: new Map([['leader', {}]]) } }, { leaderRoleIds: ['leader'] }, 'image');
  const restored = new DonationLedger(new Store(prepareStateStorage(env, join(local, 'new-deployment')), '2026-11-03', 'guild', 'Europe/Paris'));
  assert.equal(restored.total('member'), 2000);
  assert.equal(restored.data.links.member, 'Tomhawky');
});
