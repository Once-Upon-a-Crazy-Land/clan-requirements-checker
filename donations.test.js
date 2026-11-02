import test from 'node:test';
import assert from 'node:assert/strict';
import { DonationLedger, canVerifyDonation, scanProof, scanImage, validateScan, visionConfiguration, visionEnabled, proofReviewToken, proofView } from './donations.js';
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
    assert.match(body.instructions, /must not block other complete readable rows/);
    return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ unclear: false, rows: [{ name: 'Bunrey', amount: 66666, time: '00:21' }] }) }] }] });
  } });
  assert.equal(result.rows[0].amount, 66666);
  await assert.rejects(scanImage('x', { apiKey: 'x', fetcher: async () => new Response('', { status: 429 }) }), /HTTP 429/);
});

test('authentication diagnostics never expose provider messages or credentials', async () => {
  await assert.rejects(scanImage('x', { apiKey: 'test-key', fetcher: async () => Response.json({ error: {
    code: 'invalid_api_key', message: 'Incorrect API key provided: secret-key-fragment',
  } }, { status: 401 }) }), error => {
    assert.match(error.message, /401; invalid_api_key/);
    assert.match(error.message, /running Railway service/);
    assert.doesNotMatch(error.message, /secret-key-fragment/);
    return true;
  });
  for (const apiKey of ['Bearer test-key', '"test-key"', 'test key']) {
    await assert.rejects(scanImage('x', { apiKey, fetcher: () => { throw new Error('Must not call API'); } }), /Paste only the key/);
  }
  await assert.rejects(scanImage('x', { apiKey: '  test-key\n', fetcher: async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    return new Response('', { status: 401 });
  } }), /401/);
});

test('Gemini configuration selects Google credentials independently of OpenAI', () => {
  assert.equal(visionConfiguration({ GEMINI_API_KEY: 'google', OPENAI_API_KEY: 'openai' }).provider, 'gemini');
  assert.equal(visionConfiguration({ AI_PROVIDER: 'openai', GEMINI_API_KEY: 'google', OPENAI_API_KEY: 'openai' }).apiKey, 'openai');
  assert.equal(visionConfiguration({ AI_PROVIDER: 'gemini' }).model, 'gemini-3.5-flash-lite');
  assert.equal(visionEnabled({ GEMINI_API_KEY: 'google' }), true);
  assert.equal(visionEnabled({ AI_PROVIDER: 'gemini', OPENAI_API_KEY: 'wrong-provider' }), false);
  assert.throws(() => visionConfiguration({ AI_PROVIDER: 'unknown' }), /AI_PROVIDER/);
});

test('Gemini sends inline image and shared schema to Google and validates donation output', async () => {
  const scan = await scanImage('data:image/png;base64,aA==', { provider: 'gemini', apiKey: ' test-google-key ', fetcher: async (url, options) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
    assert.equal(options.headers['x-goog-api-key'], 'test-google-key');
    assert.equal(options.headers.Authorization, undefined);
    assert.ok(!url.includes('test-google-key'));
    const body = JSON.parse(options.body);
    assert.deepEqual(body.contents[0].parts[0].inlineData, { mimeType: 'image/png', data: 'aA==' });
    assert.equal(body.generationConfig.responseFormat.text.mimeType, 'APPLICATION_JSON');
    assert.deepEqual(body.generationConfig.responseFormat.text.schema.required, ['rows', 'unclear']);
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'ignore thoughts' }, { text: JSON.stringify({ unclear: false,
      rows: [{ name: 'Sterio', amount: 10000, time: '12:51' }] }) }] } }] });
  } });
  assert.equal(scan.rows[0].amount, 10000);
});

test('Gemini quota, blocked, unfinished and malformed responses fail without exposing secrets', async () => {
  const options = { provider: 'gemini', apiKey: 'google-test' };
  await assert.rejects(scanImage('data:image/png;base64,aA==', { ...options,
    fetcher: async () => Response.json({ error: { message: 'secret-key-fragment' } }, { status: 429 }),
  }), error => /quota or rate limit/.test(error.message) && !error.message.includes('secret-key-fragment'));
  for (const response of [
    { promptFeedback: { blockReason: 'SAFETY' } },
    { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{}' }] } }] },
    { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'not json' }] } }] },
    { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"rows":[],"unclear":"wrong"}' }] } }] },
  ]) {
    await assert.rejects(scanImage('data:image/png;base64,aA==', { ...options, fetcher: async () => Response.json(response) }), /No donation was credited/);
  }
  await assert.rejects(scanImage('x', { provider: 'openai', apiKey: 'AIza-test', fetcher: () => { throw new Error('Must not call OpenAI'); } }), /GEMINI_API_KEY/);
});

test('a partial-only attachment does not block another readable donation, but uncertain returned rows do', async () => {
  const { ledger } = fixture();
  const message = { id: 'mixed-proof', channelId: 'channel', author: { id: 'uploader' }, attachments: new Map(
    ['a', 'b'].map(id => [id, { id, url: `https://cdn.discordapp.com/attachments/${id}.png`, contentType: 'image/png', width: 200, height: 20, size: 10 }])) };
  let call = 0;
  const proof = await scanProof(message, ledger, { fetcher: async () => new Response(`image-${call}`), scanner: async () => ++call === 1
    ? { unclear: true, rows: [] } : { unclear: false, rows: [{ name: 'Panos', amount: 5000, time: '23:15' }] } });
  assert.equal(proof.status, 'pending');
  assert.deepEqual(proof.rows, [{ name: 'Panos', amount: 5000, time: '23:15' }]);
  const uncertain = await scanProof(message, ledger, { fetcher: async () => new Response('uncertain'), scanner: async () =>
    ({ unclear: true, rows: [{ name: 'Panos', amount: 5000, time: '23:15' }] }) });
  assert.equal(uncertain.status, 'review');
});

test('removing the approving leader reaction undoes credit once; others cannot undo it by removing their reactions', () => {
  const { ledger } = fixture();
  ledger.approve('proof', leader, settings, 'attachment', false, 'reaction');
  const other = { ...member('coleader'), id: 'other-leader' };
  ledger.unverify('proof', other, settings, true);
  assert.equal(ledger.total('discord-user'), 2000);
  assert.throws(() => ledger.unverify('proof', member('normal'), settings, true), /Only/);
  ledger.unverify('proof', leader, settings, true);
  assert.equal(ledger.total('discord-user'), 0);
  assert.equal(ledger.data.proofs.proof.status, 'pending');
  assert.equal(ledger.data.proofs.proof.approvalHistory.length, 1);
  ledger.unverify('proof', leader, settings, true);
  assert.equal(ledger.data.proofs.proof.approvalHistory.length, 1);
  ledger.approve('proof', leader, settings, 'attachment', false, 'reaction');
  assert.equal(ledger.total('discord-user'), 2000);
});

test('private review buttons identify the displayed proof version and switch to undo after approval', () => {
  const { ledger, proof } = fixture();
  const firstToken = proofReviewToken(proof);
  const button = proofView(proof).components[0].toJSON().components[0];
  assert.equal(button.custom_id, `donation-review:approve:proof:${firstToken}`);
  assert.match(proofView(proof).embeds[0].toJSON().description, /2,000 Gems/);
  ledger.approve('proof', leader, settings, 'attachment');
  const approved = ledger.data.proofs.proof;
  assert.notEqual(proofReviewToken(approved), firstToken);
  assert.match(proofView(approved).components[0].toJSON().components[0].custom_id, /donation-review:undo:/);
  ledger.unverify('proof', leader, settings);
  const token = proofReviewToken(ledger.data.proofs.proof);
  ledger.data.proofs.proof.rows[0].amount = 3000;
  assert.notEqual(proofReviewToken(ledger.data.proofs.proof), token);
});
