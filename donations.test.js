import test from 'node:test';
import assert from 'node:assert/strict';
import { DonationLedger, canVerifyDonation, scanProof, scanImage, validateScan } from './donations.js';
const settings = { leaderRoleIds: ['leader', 'coleader'] };
const member = role => ({ id: 'officer', user: { bot: false }, roles: { cache: new Map([[role, {}]]) } });
const leader = member('leader');
function fixture() {
  const store = { data: {}, save() {} };
  const ledger = new DonationLedger(store);
  ledger.link('discord-user', 'TomHawky');
  const proof = { id: 'proof', signature: 'attachment', hashes: ['hash'], status: 'pending',
    rows: [{ name: 'Tomhawky', amount: 2000, time: '08:09' }] };
  ledger.saveProof(proof);
  return { store, ledger, proof };
}
test('only leadership roles can credit; approval is idempotent across reload and reaction removals', () => {
  const { store, ledger } = fixture();
  assert.equal(canVerifyDonation(member('normal'), settings), false);
  assert.equal(canVerifyDonation(member('coleader'), settings), true);
  assert.equal(canVerifyDonation(member('asylum staff'), settings), false);
  assert.throws(() => ledger.approve('proof', member('normal'), settings, 'attachment'), /Only/);
  assert.equal(ledger.total('discord-user'), 0);
  ledger.approve('proof', leader, settings, 'attachment');
  const restored = new DonationLedger({ data: JSON.parse(JSON.stringify(store.data)), save() {} });
  restored.approve('proof', leader, settings, 'attachment');
  assert.equal(restored.total('discord-user'), 2000);
  restored.void('proof', leader, settings);
  assert.equal(restored.total('discord-user'), 0);
  assert.throws(() => restored.approve('proof', leader, settings, 'attachment'), /readable/);
});
test('unknown names, changed attachments, unclear scans and duplicates never partially credit', () => {
  const { ledger, proof } = fixture();
  assert.throws(() => ledger.link('other', 'tomhawky'), /already linked/);
  assert.throws(() => ledger.approve('proof', leader, settings, 'edited'), /changed/);
  proof.rows.push({ name: 'Unknown', amount: 300, time: null });
  assert.throws(() => ledger.approve('proof', leader, settings, 'attachment'), /Link/);
  assert.equal(ledger.total('discord-user'), 0);
  ledger.data.proofs.proof.rows.pop();
  ledger.approve('proof', leader, settings, 'attachment');
  ledger.saveProof({ ...structuredClone(ledger.data.proofs.proof), id: 'repeat', status: 'pending' });
  assert.throws(() => ledger.approve('repeat', leader, settings, 'attachment'), /image has already/);
  ledger.data.proofs.repeat.hashes = ['recompressed'];
  assert.throws(() => ledger.approve('repeat', leader, settings, 'attachment'), /duplicate donation line/);
  ledger.data.proofs.repeat.status = 'review';
  assert.throws(() => ledger.approve('repeat', leader, settings, 'attachment'), /readable/);
  assert.equal(ledger.total('discord-user'), 2000);
});
test('save failure rolls back approval and totals', () => {
  const { store, ledger } = fixture();
  store.save = () => { throw new Error('Disk full'); };
  assert.throws(() => ledger.approve('proof', leader, settings, 'attachment'), /Disk full/);
  assert.equal(ledger.total('discord-user'), 0);
  assert.equal(ledger.data.proofs.proof.status, 'pending');
});

test('explicit leader confirmation allows legitimate matching lines but never identical files', () => {
  const { ledger } = fixture();
  ledger.approve('proof', leader, settings, 'attachment');
  const repeat = { ...structuredClone(ledger.data.proofs.proof), id: 'repeat', status: 'pending' };
  ledger.saveProof(repeat);
  assert.throws(() => ledger.approve('repeat', leader, settings, 'attachment', true), /image has already/);
  ledger.data.proofs.repeat.hashes = ['different-file'];
  ledger.approve('repeat', leader, settings, 'attachment', true);
  assert.equal(ledger.total('discord-user'), 4000);
  assert.equal(ledger.data.proofs.repeat.repeatConfirmed, true);
});
test('scanner hashes attachments, reads multiple lines and blocks unclear results', async () => {
  const { ledger } = fixture();
  const message = { id: 'new-proof', channelId: 'channel', author: { id: 'uploader' }, attachments: new Map([
    ['a', { id: 'a', url: 'https://cdn.discordapp.com/attachments/test.png', contentType: 'image/png', width: 200, height: 20, size: 10 }],
  ]) };
  const proof = await scanProof(message, ledger, { fetcher: async () => new Response('image bytes'), scanner: async () => ({ unclear: false,
    rows: [{ name: 'Sterio', amount: 10000, time: '12:51' }, { name: 'Bunrey', amount: 66666, time: '00:21' }] }) });
  assert.equal(proof.hashes[0].length, 64);
  assert.deepEqual(proof.rows.map(r => r.amount), [10000, 66666]);
  assert.equal(proof.status, 'pending');
  assert.equal(ledger.total('uploader'), 0);
  const review = await scanProof(message, ledger, { fetcher: async () => new Response('other'), scanner: async () => ({ unclear: true, rows: [] }) });
  assert.equal(review.status, 'review');
  assert.throws(() => validateScan({ unclear: false, rows: [{ name: 'X', amount: -1, time: null }] }), /Invalid/);
});
test('Responses request uses strict schema, high detail and no response storage', async () => {
  const result = await scanImage('data:image/png;base64,aA==', { apiKey: 'test-key', fetcher: async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(options.body);
    assert.equal(body.store, false);
    assert.equal(body.text.format.strict, true);
    assert.equal(body.input[0].content[0].detail, 'high');
    return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ unclear: false, rows: [{ name: 'Bunrey', amount: 66666, time: '00:21' }] }) }] }] });
  } });
  assert.equal(result.rows[0].amount, 66666);
  await assert.rejects(scanImage('x', { apiKey: 'x', fetcher: async () => new Response('', { status: 429 }) }), /HTTP 429/);
});
