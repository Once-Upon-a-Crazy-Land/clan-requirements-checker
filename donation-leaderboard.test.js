import test from 'node:test';
import assert from 'node:assert/strict';
import { MonthlyLeaderboard, monthlyDonations, nextMonth, leaderboardMessage } from './donation-leaderboard.js';

function fixture() {
  let now = Date.parse('2026-11-15T12:00:00Z');
  const messages = new Map(); let sends = 0;
  const store = { data: { settings: { leaderboardChannelId: 'channel' }, donations: { proofs: {} } }, save() {} };
  const channel = { messages: { fetch: async () => messages }, send: async payload => {
    sends++;
    const message = { id: String(sends), author: { id: 'bot' }, content: payload.content, createdTimestamp: now };
    messages.set(message.id, message);
    return message;
  } };
  const guild = { id: 'guild', channels: { fetch: async id => { assert.equal(id, 'channel'); return channel; } } };
  const make = () => new MonthlyLeaderboard({ guild, store, timezone: 'Europe/Paris', botId: 'bot', now: () => now });
  return { store, channel, messages, make, setNow: value => { now = Date.parse(value); }, sends: () => sends };
}
test('monthly totals use original screenshot month, timezone, approved credits and stable ranking', () => {
  const snowflake = ((BigInt(Date.parse('2026-11-30T23:30:00Z')) - 1420070400000n) << 22n).toString();
  const proof = (submittedAt, userId, amount, status = 'approved') => ({ submittedAt: Date.parse(submittedAt), status, credits: [{ userId, amount }] });
  const data = { donations: { proofs: {
    a: proof('2026-11-15T00:00:00Z', 'a', 2000), b: proof('2026-11-29T00:00:00Z', 'a', 3000),
    c: proof('2026-11-20T00:00:00Z', 'b', 10000), d: proof('2026-11-20T00:00:00Z', 'c', 90000, 'void'),
    e: { id: snowflake, status: 'approved', credits: [{ userId: 'd', amount: 777 }] },
  } } };
  assert.deepEqual(monthlyDonations(data, '2026-11', 'Europe/Paris'), [{ userId: 'b', amount: 10000 }, { userId: 'a', amount: 5000 }]);
  assert.deepEqual(monthlyDonations(data, '2026-12', 'Europe/Paris'), [{ userId: 'd', amount: 777 }]);
  assert.equal(nextMonth('2026-12'), '2027-01');
});
test('first setup starts current month; first local day sends once and restart never repeats', async () => {
  const f = fixture(); const manager = f.make();
  await manager.tick(); assert.equal(f.sends(), 0);
  assert.equal(f.store.data.monthlyLeaderboard.nextMonth, '2026-11');
  f.setNow('2026-11-30T22:59:00Z'); await manager.tick(); assert.equal(f.sends(), 0);
  f.setNow('2026-11-30T23:00:00Z'); await manager.tick(); assert.equal(f.sends(), 1);
  assert.match([...f.messages.values()][0].content, /2026-11/);
  await manager.tick(); await f.make().tick(); assert.equal(f.sends(), 1);
  f.setNow('2027-01-01T00:00:00Z'); await f.make().tick(); assert.equal(f.sends(), 2);
});
test('interrupted send recovers from bot history even if saving message ID failed', async () => {
  const f = fixture(); await f.make().tick(); f.setNow('2026-12-01T12:00:00Z');
  const send = f.channel.send;
  f.channel.send = async payload => { const result = await send(payload); f.store.save = () => { throw Error('Disk full'); }; return result; };
  await assert.rejects(f.make().tick(), /Disk full/); assert.equal(f.sends(), 1);
  f.store.save = () => {}; f.channel.send = send;
  await f.make().tick(); assert.equal(f.sends(), 1);
  assert.equal(f.store.data.monthlyLeaderboard.nextMonth, '2026-12');
});
test('disabled setting and failed history never send; missed months catch up one per tick', async () => {
  const f = fixture(); f.store.data.settings.leaderboardChannelId = null;
  await f.make().tick(); assert.equal(f.store.data.monthlyLeaderboard, undefined);
  f.store.data.settings.leaderboardChannelId = 'channel'; await f.make().tick();
  f.setNow('2027-02-01T12:00:00Z');
  const fetch = f.channel.messages.fetch; f.channel.messages.fetch = async () => { throw Error('No history'); };
  await assert.rejects(f.make().tick(), /No history/); assert.equal(f.sends(), 0);
  f.channel.messages.fetch = fetch;
  await f.make().tick(); await f.make().tick(); await f.make().tick();
  assert.equal(f.sends(), 3); assert.equal(f.store.data.monthlyLeaderboard.nextMonth, '2027-02');
});
test('leaderboard message fits Discord limits and never pings members', () => {
  const payload = leaderboardMessage({ month: '2026-11', rows: Array.from({ length: 100 }, (_, i) => ({ userId: '123456789012345678', amount: 100000 - i })) }, 'Europe/Paris');
  const embed = payload.embeds[0].toJSON();
  assert.ok(embed.description.length < 4096);
  assert.match(embed.description, /100 donors/);
  assert.equal((embed.description.match(/<@/g) || []).length, 25);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
});
