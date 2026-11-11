import test from 'node:test';
import assert from 'node:assert/strict';
import { panel, adminTimeoffView } from './panel.js';
import { DonationLedger } from './donations.js';
import { timeoffView, timeoffBlocks, paginateBlocks, donationView, listMessage, timeoffRequestNotice, memberView } from './views.js';

const state = () => ({ data: { requests: {}, grants: {} } });

test('/me shows only the caller’s donation and time-off records', () => {
  const store = state();
  const day = '2026-09-14';
  const ledger = new DonationLedger(store);
  store.data.donationCoverage = { startDay: day };
  ledger.data.links = { caller: 'Caller name', other: 'Other name' };
  ledger.data.proofs.proof = { status: 'approved', coverage: { startDay: day, dailyGems: 1000 },
    credits: [{ userId: 'caller', amount: 2500 }, { userId: 'other', amount: 9000 }] };
  store.data.requests = { mine: { userId: 'caller', status: 'pending' }, theirs: { userId: 'other', status: 'pending' } };
  store.data.grants = { theirs: { userId: 'other', start: day, end: day } };

  const message = memberView(store.data, ledger, day, 'caller', 1000);
  const embed = message.embeds[0].toJSON();
  assert.match(embed.description, /Caller name/);
  assert.doesNotMatch(embed.description, /Other name/);
  assert.match(embed.fields[0].value, /2,500 Gems/);
  assert.match(embed.fields[0].value, /Prepaid days remaining after today: \*\*1\*\*/);
  assert.match(embed.fields[0].value, /Leftover Gems toward another day: \*\*500\*\*/);
  assert.match(embed.fields[1].value, /No active or upcoming approved time off/);
  assert.match(embed.fields[1].value, /Pending requests: \*\*1\*\*/);
  assert.deepEqual(message.allowedMentions, { parse: [] });
});
const automation = () => ({ nicknameErrors: [], lastError: null, lastCheck: null });
const noTextCards = message => {
  assert.ok(message.files.every(file => !file.name?.endsWith('.txt')));
  assert.deepEqual(message.attachments, []);
  assert.deepEqual(message.allowedMentions, { parse: [] });
  const embed = message.embeds[0].toJSON();
  assert.ok(embed.description.length <= 4096);
  const total = embed.description.length + embed.author.name.length + embed.footer.text.length
    + (embed.fields || []).reduce((sum, field) => sum + field.name.length + field.value.length, 0);
  assert.ok(total <= 6000);
};

test('admin command shows inline details but omits tracked members, timezone, and last check fields', () => {
  const bot = automation();
  bot.nicknameErrors.push('Cannot edit nickname for 641307116677758976: check Manage Nicknames and role hierarchy.');
  const message = panel(state(), bot, '2026-09-14', 'Europe/Paris');
  noTextCards(message);
  const embed = message.embeds[0].toJSON();
  assert.match(embed.description, /No time-off requests yet/);
  assert.match(embed.description, /No days off granted yet/);
  assert.match(embed.description, /<@641307116677758976>/);
  assert.match(embed.description, /Manage Nicknames/);
  assert.deepEqual(embed.fields, [{ name: 'Pending requests', value: '0', inline: true }]);
  assert.ok(!embed.fields.some(field => ['Tracked members', 'Timezone', 'Last check'].includes(field.name)));
  assert.equal(message.components[0].toJSON().components.length, 5);
});

test('admin list button provides the requests and grants view', () => {
  const store = state();
  store.data.requests.abc = { id: 'abc', userId: '123', status: 'pending', start: '2026-09-14', end: '2026-09-15', days: 2, reason: 'Away' };
  const message = adminTimeoffView(store, '2026-09-14', 'Europe/Paris');
  noTextCards(message);
  assert.match(message.embeds[0].toJSON().description, /Request `abc`/);
  assert.equal(message.components[0].toJSON().components.length, 5);
});

test('large admin lists paginate within embed limits and retain every request and reason', () => {
  const store = state();
  for (let i = 0; i < 70; i++) store.data.requests[`id${i}`] = {
    id: `id${i}`, userId: String(i), status: 'pending', start: '2026-09-14', end: '2026-09-15', days: 2,
    reason: `Reason-${i}: ${'x'.repeat(450)}`,
  };
  const blocks = timeoffBlocks(store, '2026-09-14');
  const count = paginateBlocks(blocks).length;
  assert.ok(count > 1);
  let combined = '';
  for (let page = 0; page < count; page++) {
    const message = adminTimeoffView(store, '2026-09-14', 'Europe/Paris', page);
    noTextCards(message);
    combined += message.embeds[0].toJSON().description;
    assert.equal(message.components.length, 2);
    const navigation = message.components[1].toJSON().components;
    assert.equal(navigation[0].disabled, page === 0);
    assert.equal(navigation[1].disabled, page === count - 1);
    assert.ok(navigation.every(button => button.custom_id.startsWith('admin:page:')));
  }
  for (let i = 0; i < 70; i++) {
    assert.ok(combined.includes(`\`id${i}\``));
    assert.ok(combined.includes(`Reason-${i}:`));
  }
});

test('personal time-off pages only reveal the requesting member records', () => {
  const store = state();
  for (const userId of ['self', 'other']) {
    store.data.requests[userId] = { id: userId, userId, start: '2026-09-14', end: '2026-09-14', days: 1, status: 'pending', reason: `private-${userId}` };
    store.data.grants[userId] = { id: userId, userId, start: '2026-09-14', end: '2026-09-14', adminId: 'admin' };
  }
  const message = timeoffView(store, '2026-09-14', 'Europe/Paris', 'self', 999);
  noTextCards(message);
  const description = message.embeds[0].toJSON().description;
  assert.ok(description.includes('private-self'));
  assert.ok(!description.includes('private-other'));
  assert.ok(!description.includes('<@other>'));
});

test('donation report embeds keep proof links and all three member categories', () => {
  const report = { roster: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], submitted: [{ id: 'a' }],
    missing: [{ id: 'b' }], excused: [{ id: 'c' }], submissions: new Map([['a', 'https://discord.com/channels/1/2/3']]) };
  const message = donationView(report, '2026-09-14', '2026-09-14', 'Europe/Paris');
  assert.match(message.embeds[0].data.description, /\*\*14 Sep\*\*/);
  assert.doesNotMatch(message.embeds[0].data.description, /2026/);
  noTextCards(message);
  const description = message.embeds[0].toJSON().description;
  assert.match(description, /https:\/\/discord.com\/channels\/1\/2\/3/);
  for (const id of ['a', 'b', 'c']) assert.ok(description.includes(`<@${id}>`));
  assert.match(description, /Today is still in progress/);
});

test('oversized entries split without losing content and invalid page indices are clamped', () => {
  const text = '😀'.repeat(5000);
  const pages = paginateBlocks([text]);
  assert.equal(pages.join(''), text);
  const message = listMessage('Issues', 'Review these issues.', [text], NaN, 'admin:page');
  noTextCards(message);
  assert.match(message.embeds[0].toJSON().description, /Page 1 of/);
});

test('new time-off request notice has approve and reject buttons without pinging the member', () => {
  const request = { id: 'abc123', userId: '12345678901234567', start: '2026-09-15', end: '2026-09-17', days: 3, reason: 'Holiday' };
  const message = timeoffRequestNotice(request);
  const dates = message.embeds[0].data.fields.find(field => field.name === 'Dates').value;
  assert.equal(dates, '15 Sep through 17 Sep');
  assert.doesNotMatch(dates, /2026/);
  noTextCards(message);
  const embed = message.embeds[0].toJSON();
  assert.match(embed.description, /<@12345678901234567>/);
  assert.equal(embed.fields.find(field => field.name === 'Status').value, 'Waiting for clan leader approval');
  assert.deepEqual(message.components[0].toJSON().components.map(button => [button.custom_id, button.style]), [
    ['timeoff-review:approve:abc123', 3],
    ['timeoff-review:reject:abc123', 4],
  ]);
});

test('reviewed time-off notice shows the administrator decision and removes its buttons', () => {
  const request = { id: 'abc123', userId: '12345678901234567', start: '2026-09-15', end: '2026-09-17', days: 3, reason: '' };
  request.latestScreenshot = { status: 'found', url: 'https://discord.com/channels/1/2/3' };
  for (const decision of ['approved', 'rejected']) {
    const message = timeoffRequestNotice(request, decision, '99999999999999999');
    noTextCards(message);
    assert.equal(message.embeds[0].data.fields.find(field => field.name === 'Latest donation screenshot').value,
      '[View screenshot](https://discord.com/channels/1/2/3)');
    assert.deepEqual(message.components, []);
    assert.match(message.embeds[0].toJSON().fields.find(field => field.name === 'Status').value, new RegExp(`${decision === 'approved' ? 'Approved' : 'Rejected'} by <@99999999999999999>`));
  }
});
