import test from 'node:test';
import assert from 'node:assert/strict';
import { DonationLedger } from './donations.js';
import { coverageOnDay, initializeCoverage } from './donation-coverage.js';
import { classify, PATIENT_ROLE_ID } from './state.js';
import { Automation } from './automation.js';

function fixture() {
  let now = Date.parse('2026-11-02T12:00:00Z');
  const store = { data: { timezone: 'Europe/Paris', grants: {}, requests: {}, nicknames: {}, jobs: {}, missingStreaks: {}, lastClosedDay: '2026-11-01' }, save() {} };
  initializeCoverage(store, now);
  const ledger = new DonationLedger(store, () => now);
  const settings = { dailyDonationGems: 1000, leaderRoleIds: ['leader'] };
  const officer = { id: 'officer', user: { bot: false }, roles: { cache: new Map([['leader', {}]]) } };
  const member = { id: 'member', user: { bot: false }, nickname: '[No Donation Proof]', displayName: 'member', manageable: true,
    roles: { cache: new Map([[PATIENT_ROLE_ID, {}]]) }, async setNickname(value) { this.nickname = value; } };
  ledger.link('member', 'Tomhawky');
  let count = 0;
  function approve(amount) {
    const id = `proof-${++count}`;
    ledger.saveProof({ id, status: 'pending', signature: id, hashes: [id], rows: [{ name: 'Tomhawky', amount, time: `12:${String(count).padStart(2, '0')}` }] });
    ledger.approve(id, officer, settings, id);
    return id;
  }
  return { store, ledger, settings, officer, member, approve, setNow(value) { now = Date.parse(value); },
    coverage(day) { return coverageOnDay(store.data, day).get('member'); } };
}
test('10000 Gems at 1000/day covers today plus nine days, expires and survives a reload', () => {
  const f = fixture(); const id = f.approve(10000);
  assert.deepEqual(f.coverage('2026-11-02'), { covered: true, remainingDays: 9, remainderGems: 0 });
  assert.equal(f.coverage('2026-11-11').covered, true);
  assert.equal(f.coverage('2026-11-12').covered, false);
  f.ledger.approve(id, f.officer, f.settings, id);
  assert.equal(f.coverage('2026-11-12').covered, false);
  const data = JSON.parse(JSON.stringify(f.store.data));
  assert.equal(coverageOnDay(data, '2026-11-11').get('member').covered, true);
  assert.equal(coverageOnDay(data, '2026-11-01').size, 0);
});
test('leftover Gems carry forward, several approvals never consume today twice and later payments do not cover missed days', () => {
  const f = fixture(); f.approve(2500);
  assert.deepEqual(f.coverage('2026-11-02'), { covered: true, remainingDays: 1, remainderGems: 500 });
  f.approve(500);
  assert.deepEqual(f.coverage('2026-11-02'), { covered: true, remainingDays: 2, remainderGems: 0 });
  assert.equal(f.coverage('2026-11-04').covered, true);
  assert.equal(f.coverage('2026-11-05').covered, false);
  f.setNow('2026-11-06T12:00:00Z'); f.approve(1000);
  assert.equal(f.coverage('2026-11-05').covered, false);
  assert.equal(f.coverage('2026-11-06').covered, true);
});
test('approved vacations and clan breaks preserve prepaid days without using Vacation labels for paid days', () => {
  const f = fixture(); f.approve(2000);
  f.store.data.grants.v = { userId: 'member', start: '2026-11-03', end: '2026-11-04' };
  f.store.data.donationBreaks = { b: { start: '2026-11-05', end: '2026-11-06' } };
  assert.equal(f.coverage('2026-11-04').remainingDays, 1);
  assert.equal(f.coverage('2026-11-06').remainingDays, 1);
  assert.equal(f.coverage('2026-11-07').covered, true);
  assert.equal(f.coverage('2026-11-08').covered, false);
  const report = classify(new Map([['member', f.member]]), new Map(), f.store.data, '2026-11-02');
  assert.equal(report.excused.length, 0); assert.equal(report.submitted.length, 1);
});
test('new rate applies to new approvals and preserves prepaid days; void recomputes days and leftovers', () => {
  const f = fixture(); const first = f.approve(2500);
  f.settings.dailyDonationGems = 2000; f.approve(1500);
  assert.deepEqual(f.coverage('2026-11-02'), { covered: true, remainingDays: 2, remainderGems: 0 });
  assert.equal(f.ledger.total('member'), 4000);
  f.ledger.void(first, f.officer, f.settings);
  assert.deepEqual(f.coverage('2026-11-02'), { covered: false, remainingDays: 0, remainderGems: 1500 });
  assert.equal(f.ledger.total('member'), 1500);
});

test('unverification removes prepaid days and leftovers; reapproval earns coverage only from its new approval date', () => {
  const f = fixture(); const id = f.approve(2500);
  f.ledger.unverify(id, f.officer, f.settings);
  assert.equal(f.coverage('2026-11-02'), undefined);
  assert.equal(f.ledger.total('member'), 0);
  f.setNow('2026-11-04T12:00:00Z');
  f.ledger.approve(id, f.officer, f.settings, id);
  assert.equal(f.coverage('2026-11-02'), undefined);
  assert.deepEqual(f.coverage('2026-11-04'), { covered: true, remainingDays: 1, remainderGems: 500 });
});
test('approval day uses timezone; legacy approvals and raw uploads do not produce new prepaid credit', () => {
  const f = fixture(); f.setNow('2026-11-02T23:30:00Z'); f.approve(1000);
  assert.equal(f.coverage('2026-11-02'), undefined);
  assert.equal(f.coverage('2026-11-03').covered, true);
  const legacy = structuredClone(f.ledger.data.proofs['proof-1']);
  delete legacy.coverage; legacy.id = 'legacy'; f.ledger.data.proofs = { legacy };
  const members = new Map([['member', f.member]]), submissions = new Map([['member', 'screenshot']]);
  assert.equal(classify(members, submissions, f.store.data, '2026-11-03').missing.length, 1);
  assert.equal(classify(members, submissions, f.store.data, '2026-11-01').submitted.length, 1);
});
test('real automation suppresses reminders and clears nicknames during coverage, then resumes after expiry', async () => {
  const f = fixture(); f.approve(2000);
  const sent = [];
  const members = new Map([['member', f.member]]);
  const automation = new Automation({ guild: { id: 'guild' }, store: f.store, timezone: 'Europe/Paris', botId: 'bot',
    channel: { messages: { fetch: async () => new Map() } }, syncMemberRoles: async () => ({ members, errors: [] }),
    reminder: { messages: { fetch: async () => new Map() }, send: async message => { sent.push(message); return { id: 'reminder' }; } },
    now: () => Date.parse('2026-11-02T12:00:00Z') });
  automation.guild.members = { list: async () => members };
  f.store.data.nicknames.member = { original: null, applied: '[No Donation Proof]' };
  await automation.syncToday(); assert.equal(f.member.nickname, null);
  await automation.closeDay('2026-11-02'); assert.equal(sent.length, 0);
  await automation.closeDay('2026-11-03'); assert.equal(sent.length, 0);
  automation.now = () => Date.parse('2026-11-04T12:00:00Z');
  await automation.syncToday(); assert.match(f.member.nickname, /No Donation Proof/);
  await automation.closeDay('2026-11-04'); assert.equal(sent.length, 1);
});
