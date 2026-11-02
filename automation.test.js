import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, PATIENT_ROLE_ID, TIMEOFF_ROLE_IDS, TAG, VACATION_TAG, dateRange, isExcused, canRequestTimeoff, classify, shiftDay, taggedName } from './state.js';
import { Automation, syncNickname } from './automation.js';
import { commands, panel, modal } from './panel.js';

function makeStore(t, today = '2026-09-14') {
  const dir = mkdtempSync(join(tmpdir(), 'donation-bot-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new Store(join(dir, 'state.json'), today, 'guild', 'Europe/Paris');
}
function member(id, { role = true, bot = false, nickname = null, manageable = true, joinedTimestamp } = {}) {
  return {
    id, user: { bot }, nickname, manageable, joinedTimestamp, edits: [],
    get displayName() { return this.nickname || `Name-${id}`; },
    roles: { cache: new Map(role ? [[PATIENT_ROLE_ID, {}]] : []) },
    async setNickname(value) { this.edits.push(value); this.nickname = value; },
  };
}
test('time off uses inclusive calendar days across month and DST boundaries', () => {
  assert.deepEqual(dateRange('2026-03-28', 3), { start: '2026-03-28', end: '2026-03-30', days: 3 });
  assert.equal(dateRange('2026-12-31', 2).end, '2027-01-01');
  assert.equal(shiftDay('2026-03-01', -1), '2026-02-28');
  for (const days of [0, -1, 1.5, 366, NaN]) assert.throws(() => dateRange('2026-09-14', days));
  assert.throws(() => dateRange('2026-02-30', 1));
});
test('only Patients are required; pending requests do not excuse, approval does, expiry resumes checks', t => {
  const store = makeStore(t);
  const members = new Map(['a', 'b', 'c'].map(id => [id, member(id)]));
  members.set('outsider', member('outsider', { role: false }));
  members.set('bot', member('bot', { bot: true }));
  const request = store.request('b', '2026-09-14', 2, 'Away');
  assert.equal(isExcused(store.data, 'b', '2026-09-14'), false);
  const grant = store.grant('b', request.start, request.days, 'admin', request.id);
  const report = classify(members, new Map([['a', 'proof']]), store.data, '2026-09-14');
  assert.deepEqual(report.submitted.map(m => m.id), ['a']);
  assert.deepEqual(report.missing.map(m => m.id), ['c']);
  assert.deepEqual(report.excused.map(m => m.id), ['b']);
  assert.equal(isExcused(store.data, 'b', '2026-09-15'), true);
  assert.equal(isExcused(store.data, 'b', '2026-09-16'), false);
  assert.throws(() => store.grant('b', request.start, request.days, 'admin', request.id));
  store.revoke(grant.id, 'admin');
  assert.equal(isExcused(store.data, 'b', '2026-09-14'), false);
});

test('Patient and three additional roles can request time off without expanding donation tracking', () => {
  assert.deepEqual(TIMEOFF_ROLE_IDS, [
    '1532826238572298451', '1532826140086112256', '1532826772624769316', '1532826889499185302',
  ]);
  for (const roleId of TIMEOFF_ROLE_IDS) {
    const m = member(roleId, { role: false });
    m.roles.cache.set(roleId, {});
    assert.equal(canRequestTimeoff(m), true);
    const report = classify(new Map([[m.id, m]]), new Map(), { grants: {} }, '2026-09-14');
    assert.equal(report.roster.length, roleId === PATIENT_ROLE_ID ? 1 : 0);
  }
  assert.equal(canRequestTimeoff(member('none', { role: false })), false);
  const bot = member('bot', { role: false, bot: true });
  bot.roles.cache.set(TIMEOFF_ROLE_IDS[1], {});
  assert.equal(canRequestTimeoff(bot), false);
});
test('requests, grants and original nicknames survive restart; malformed state fails closed', t => {
  const store = makeStore(t);
  store.request('a', '2026-09-14', 1, 'Away');
  store.grant('a', '2026-09-14', 1, 'admin');
  store.data.nicknames.a = { original: null, applied: `A ${TAG}` };
  store.save();
  const loaded = new Store(store.path, '2026-09-15', 'guild', 'Europe/Paris');
  assert.deepEqual(loaded.data, store.data);
  assert.throws(() => new Store(store.path, '2026-09-15', 'another-guild', 'Europe/Paris'));
  writeFileSync(store.path, '{bad json');
  assert.throws(() => new Store(store.path, '2026-09-15', 'guild', 'Europe/Paris'));
});
test('nickname tag fits Discord limits, is not duplicated and restores full original', async t => {
  const store = makeStore(t);
  const original = 'A very long existing nickname';
  const m = member('a', { nickname: original });
  await syncNickname(m, true, store);
  assert.ok(m.nickname.length <= 32);
  assert.ok(m.nickname.endsWith(TAG));
  await syncNickname(m, true, store);
  assert.equal(m.edits.length, 1);
  await syncNickname(m, false, store);
  assert.equal(m.nickname, original);
  assert.equal(store.data.nicknames.a, undefined);
  assert.ok(taggedName('😀'.repeat(20)).length <= 32);
});
test('nickname cleanup restores null, preserves later edits and reports hierarchy failures', async t => {
  const store = makeStore(t);
  const m = member('a');
  await syncNickname(m, true, store);
  await syncNickname(m, false, store);
  assert.equal(m.nickname, null);
  await syncNickname(m, true, store);
  m.nickname = 'New nickname';
  await syncNickname(m, false, store);
  assert.equal(m.nickname, 'New nickname');
  await syncNickname(m, true, store);
  m.nickname = `Edited ${TAG}`;
  await syncNickname(m, true, store);
  await syncNickname(m, false, store);
  assert.equal(m.nickname, 'Edited');
  await assert.rejects(syncNickname(member('owner', { manageable: false }), true, store), /role hierarchy/);
});
test('approved time off applies Vacation and transitions cleanly between nickname states', async t => {
  const store = makeStore(t);
  const m = member('away', { nickname: 'Traveler' });
  await syncNickname(m, false, store, true);
  assert.equal(m.nickname, `Traveler ${VACATION_TAG}`);
  await syncNickname(m, true, store, false);
  assert.equal(m.nickname, `Traveler ${TAG}`);
  await syncNickname(m, false, store, false);
  assert.equal(m.nickname, 'Traveler');
  assert.equal(store.data.nicknames.away, undefined);
});
test('new members wait until their first 6 AM ping before receiving the missing tag', async t => {
  const store = makeStore(t);
  const { automation } = fakeAutomation(t, store);
  const newcomer = member('new', { joinedTimestamp: Date.parse('2026-09-15T01:00:00Z') });
  const members = new Map([[newcomer.id, newcomer]]);
  automation.report = async () => ({ missing: [newcomer], excused: [], pause: false, members });
  automation.now = () => Date.parse('2026-09-15T03:59:00Z');
  await automation.syncToday();
  assert.equal(newcomer.nickname, null);
  automation.now = () => Date.parse('2026-09-15T04:01:00Z');
  await automation.syncToday();
  assert.equal(newcomer.nickname, `Name-new ${TAG}`);
});
test('members are excluded from donation reports for days before they joined', async t => {
  const store = makeStore(t);
  const { automation } = fakeAutomation(t, store);
  const newcomer = member('new', { joinedTimestamp: Date.parse('2026-09-15T10:00:00Z') });
  const members = new Map([[newcomer.id, newcomer]]);
  automation.channel.messages = { fetch: async () => new Map() };
  assert.equal((await automation.report('2026-09-14', members)).roster.length, 0);
  assert.equal((await automation.report('2026-09-15', members)).roster.length, 1);
});

function fakeAutomation(t, store) {
  const history = new Map();
  const sent = [];
  const reminder = {
    messages: { fetch: async () => history },
    send: async payload => {
      const id = String(sent.length + 1);
      sent.push(payload);
      history.set(id, { id, author: { id: 'bot' }, content: payload.content,
        embeds: payload.embeds?.map(embed => embed.toJSON()), createdTimestamp: Date.parse('2026-09-14T22:01:00Z') });
      return { id };
    },
  };
  const automation = new Automation({ guild: { id: 'guild' }, channel: { id: 'donations' },
    reminder, store, timezone: 'Europe/Paris', botId: 'bot', now: () => Date.parse('2026-09-14T22:01:00Z') });
  return { automation, sent, history, reminder };
}
test('6 AM closes the previous local day once and skips pre-install days', async t => {
  const store = makeStore(t);
  const { automation, sent } = fakeAutomation(t, store);
  automation.now = () => Date.parse('2026-09-15T04:01:00Z');
  const m = member('a');
  const dates = [];
  automation.report = async day => { dates.push(day); return { missing: [m] }; };
  automation.syncToday = async () => {};
  await automation.tick();
  await automation.tick();
  assert.equal(dates.filter(day => day === '2026-09-14').length, 1);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].allowedMentions, { parse: [], users: ['a'] });
  assert.ok(sent[0].content.endsWith('<@a>'));
  assert.equal(sent[0].embeds[0].toJSON().color, 0xf45f77);
  assert.equal(store.data.lastClosedDay, '2026-09-14');
});
test('the previous day is not closed before 6 AM local time', async t => {
  const store = makeStore(t);
  const { automation, sent } = fakeAutomation(t, store);
  automation.now = () => Date.parse('2026-09-15T03:59:00Z');
  automation.report = async () => ({ missing: [member('a')] });
  automation.syncToday = async () => {};
  await automation.tick();
  assert.equal(sent.length, 0);
  assert.equal(store.data.lastClosedDay, '2026-09-13');
});
test('exempt and submitted Patients are excluded from actual reminder mentions', async t => {
  const store = makeStore(t);
  store.grant('off', '2026-09-14', 1, 'admin');
  const members = new Map(['off', 'done', 'missing'].map(id => [id, member(id)]));
  members.set('outsider', member('outsider', { role: false }));
  const { automation, sent } = fakeAutomation(t, store);
  automation.report = async day => classify(members, new Map([['done', 'proof']]), store.data, day);
  await automation.closeDay('2026-09-14');
  assert.deepEqual(sent[0].allowedMentions.users, ['missing']);
});
test('no missing members produces no ping; failed scan never closes the day', async t => {
  const store = makeStore(t);
  const { automation, sent } = fakeAutomation(t, store);
  automation.report = async () => { throw new Error('Missing history permission'); };
  await assert.rejects(automation.closeDay('2026-09-14'), /history permission/);
  assert.equal(store.data.lastClosedDay, '2026-09-13');
  assert.equal(sent.length, 0);
  automation.report = async () => ({ missing: [] });
  await automation.closeDay('2026-09-14');
  assert.equal(sent.length, 0);
  assert.equal(store.data.lastClosedDay, '2026-09-14');
});
test('a crash after sending a reminder is recovered from channel history without another ping', async t => {
  const store = makeStore(t);
  const { automation, sent, reminder } = fakeAutomation(t, store);
  automation.report = async () => ({ missing: [member('a')] });
  const realSend = reminder.send;
  reminder.send = async payload => { await realSend(payload); throw new Error('Connection lost after send'); };
  await assert.rejects(automation.closeDay('2026-09-14'), /Connection lost/);
  assert.equal(store.data.jobs['2026-09-14'].batches[0].sent, false);
  reminder.send = realSend;
  await automation.closeDay('2026-09-14');
  assert.equal(sent.length, 1);
  assert.equal(store.data.lastClosedDay, '2026-09-14');
});
test('unsent retry rechecks newly approved days off', async t => {
  const store = makeStore(t);
  const { automation, sent, reminder } = fakeAutomation(t, store);
  const members = new Map([['a', member('a')]]);
  automation.report = async day => classify(members, new Map(), store.data, day);
  const realSend = reminder.send;
  reminder.send = async () => { throw new Error('Offline'); };
  await assert.rejects(automation.closeDay('2026-09-14'), /Offline/);
  store.grant('a', '2026-09-14', 1, 'admin');
  reminder.send = realSend;
  await automation.closeDay('2026-09-14');
  assert.equal(sent.length, 0);
});

test('upgrading to embeds still recognizes an interrupted legacy plain-text reminder', async t => {
  const store = makeStore(t);
  const { automation, sent, history } = fakeAutomation(t, store);
  automation.report = async () => ({ missing: [member('a')] });
  history.set('old', { id: 'old', author: { id: 'bot' },
    content: '<@a>\n[donation-reminder:2026-09-14:0]', createdTimestamp: Date.parse('2026-09-14T22:01:00Z') });
  await automation.closeDay('2026-09-14');
  assert.equal(sent.length, 0);
});

test('simplifying the layout still recognizes an interrupted old-style embed', async t => {
  const store = makeStore(t);
  const { automation, sent, history } = fakeAutomation(t, store);
  automation.report = async () => ({ missing: [member('a')] });
  history.set('old', { id: 'old', author: { id: 'bot' }, content: '<@a>',
    embeds: [{ title: 'Donation proof reminder', footer: { text: 'Crazyland • 2026-09-14 • Reminder 1' } }],
    createdTimestamp: Date.parse('2026-09-14T22:01:00Z') });
  await automation.closeDay('2026-09-14');
  assert.equal(sent.length, 0);
});

test('another user copying the reminder embed cannot suppress the actual bot reminder', async t => {
  const store = makeStore(t);
  const { automation, sent, history } = fakeAutomation(t, store);
  automation.report = async () => ({ missing: [member('a')] });
  history.set('copy', { id: 'copy', author: { id: 'other' }, content: '<@a>',
    embeds: [{ title: 'Donation proof reminder', footer: { text: 'Crazyland • 2026-09-14 • Reminder 1' } }],
    createdTimestamp: Date.parse('2026-09-14T22:01:00Z') });
  await automation.closeDay('2026-09-14');
  assert.equal(sent.length, 1);
});
test('large missing lists are split below Discord message and mention limits', async t => {
  const store = makeStore(t);
  const { automation, sent } = fakeAutomation(t, store);
  const members = Array.from({ length: 105 }, (_, i) => member(String(1532826238572298451n + BigInt(i))));
  automation.report = async () => ({ missing: members });
  await automation.closeDay('2026-09-14');
  assert.equal(sent.length, 3);
  assert.equal(sent.flatMap(p => p.allowedMentions.users).length, 105);
  assert.ok(sent.every(p => p.content.length < 2000 && p.allowedMentions.users.length <= 40));
});
test('ten consecutive missing days move a member into the long-term reminder section', async t => {
  const store = makeStore(t, '2026-09-01');
  const { automation, sent } = fakeAutomation(t, store);
  automation.report = async day => ({ missing: day === '2026-09-01'
    ? [member('long'), member('recent')] : [member('long')] });
  store.data.missingStreaks.long = 9;
  await automation.closeDay('2026-09-01');
  assert.match(sent[0].content, /Haven't donated for 10 or more days:\n<@long>/);
  assert.match(sent[0].content, /Missing donation proof for \*\*1 Sep\*\*[\s\S]*<@recent>/);
  assert.equal(store.data.missingStreaks.long, 10);
  assert.equal(store.data.missingStreaks.recent, 1);
});
test('existing missing streaks are backfilled from nine prior proof reports', async t => {
  const store = makeStore(t, '2026-09-21');
  store.data.missingStreaks.long = 1; // Previous version started counting only at deployment.
  const { automation, sent } = fakeAutomation(t, store);
  automation.report = async day => ({ missing: day === '2026-09-21'
    ? [member('long'), member('recent')]
    : day >= '2026-09-12' ? [member('long')] : [] });
  await automation.closeDay('2026-09-21');
  assert.equal(store.data.missingStreaks.long, 10);
  assert.equal(store.data.missingStreaks.recent, 1);
  assert.match(sent[0].content, /Haven't donated for 10 or more days:\n<@long>/);
  assert.match(sent[0].content, /<@recent>/);
});
test('nickname checks clean up submitted, excused and former Patient members', async t => {
  const store = makeStore(t);
  const { automation } = fakeAutomation(t, store);
  const members = new Map(['done', 'off', 'former', 'missing'].map(id => [id, member(id)]));
  for (const m of members.values()) await syncNickname(m, true, store);
  members.get('former').roles.cache.clear();
  store.grant('off', '2026-09-15', 1, 'admin');
  automation.report = async day => ({ ...classify(members, new Map([['done', 'proof']]), store.data, day), members });
  await automation.syncToday();
  for (const id of ['done', 'former']) assert.equal(members.get(id).nickname, null);
  assert.equal(members.get('off').nickname, `Name-off ${VACATION_TAG}`);
  assert.ok(members.get('missing').nickname.endsWith(TAG));
});
test('slash commands, private admin panel and all modals serialize against installed Discord library', t => {
  const store = makeStore(t);
  const { automation } = fakeAutomation(t, store);
  assert.equal(commands.length, 2);
  for (const command of commands) assert.ok(command.toJSON().name);
  const data = panel(store, automation, '2026-09-14', 'Europe/Paris');
  assert.equal(data.components[0].toJSON().components.length, 5);
  for (const action of ['grant', 'approve', 'reject', 'revoke']) assert.ok(modal(action, '2026-09-14').toJSON().custom_id);
});

test('failed end-of-day reminder still allows today nickname cleanup and retries next tick', async t => {
  const store = makeStore(t);
  const { automation } = fakeAutomation(t, store);
  automation.now = () => Date.parse('2026-09-15T04:01:00Z');
  let synced = 0;
  automation.closeDay = async () => { throw new Error('Cannot send reminder'); };
  automation.syncToday = async () => { synced++; };
  await assert.rejects(automation.tick(), /Cannot send reminder/);
  assert.equal(synced, 1);
  assert.equal(store.data.lastClosedDay, '2026-09-13');
  assert.equal(automation.lastError, 'Cannot send reminder');
});
