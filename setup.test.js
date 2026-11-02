import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionsBitField, PermissionFlagsBits, ChannelType, Collection } from 'discord.js';
import { defaultSettings, getSettings, validateSettings, saveSettings, SETTINGS_FIELDS } from './configuration.js';
import { SetupSessions, setupView, dailyGemsModal } from './setup.js';
import { Store, classify, canRequestTimeoff } from './state.js';
import { checkAccess } from './access.js';
import { Automation } from './automation.js';
import { ensureVacationNotice } from './vacation-panel.js';

const ids = { member: '11111111111111111', leader: '22222222222222222', extra: '33333333333333333', channel: '44444444444444444' };
const chosen = () => ({ ...defaultSettings(), memberRoleId: ids.member, leaderRoleIds: [ids.leader], timeoffRoleIds: [ids.extra],
  donationChannelId: ids.channel, reminderChannelId: '55555555555555555', vacationChannelId: '66666666666666666', adminChannelId: '77777777777777777' });
const member = (id, role, bot = false) => ({ id, user: { bot }, roles: { cache: new Map([[role, {}]]) } });
const admin = new PermissionsBitField(PermissionFlagsBits.Administrator);
const setupInteraction = { guildId: 'guild', commandName: 'clan', options: { getString: () => 'setup' } };

function guildFixture(settings = chosen()) {
  const guild = { id: 'guild', members: { fetchMe: async () => ({ permissions: admin }) },
    channels: { fetch: async id => ({ id, guildId: 'guild', type: ChannelType.GuildText, permissionsFor: () => admin }) },
    roles: { fetch: async id => ({ id, guild: { id: 'guild' }, managed: false, editable: true }) } };
  return guild;
}

test('setup and every setup component require Administrator and the correct server', () => {
  for (const action of [setupInteraction, { guildId: 'guild', customId: 'setup:session:save' }, { guildId: 'guild', customId: 'setup:session:value' }]) {
    assert.throws(() => checkAccess(action, 'guild'), /administrators/);
    assert.throws(() => checkAccess({ ...action, memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild) }, 'guild'), /administrators/);
    assert.doesNotThrow(() => checkAccess({ ...action, memberPermissions: admin }, 'guild'));
    assert.throws(() => checkAccess({ ...action, memberPermissions: admin, guildId: 'other' }, 'guild'), /configured server/);
  }
});

test('chosen member role controls reports; chosen leader roles control approvals and requests', () => {
  const settings = chosen();
  const tracked = member('tracked', ids.member), old = member('old', defaultSettings().memberRoleId);
  const leader = member('leader', ids.leader), extra = member('extra', ids.extra);
  const report = classify(new Map([tracked, old, leader, extra].map(m => [m.id, m])), new Map(), { grants: {}, settings }, '2026-10-20');
  assert.deepEqual(report.missing.map(m => m.id), ['tracked']);
  for (const m of [tracked, leader, extra]) assert.equal(canRequestTimeoff(m, settings), true);
  assert.equal(canRequestTimeoff(old, settings), false);
  assert.equal(canRequestTimeoff(member('bot', ids.member, true), settings), false);
  const approval = { guildId: 'guild', customId: 'timeoff-review:approve:request', member: leader };
  assert.doesNotThrow(() => checkAccess(approval, 'guild', settings));
  assert.throws(() => checkAccess({ ...approval, member: member('former', defaultSettings().leaderRoleIds[0]), memberPermissions: admin }, 'guild', settings), /configured leadership roles/);
});

test('settings survive restart and migrate existing review notices without changing requests or grants', t => {
  const dir = mkdtempSync(join(tmpdir(), 'clan-setup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');
  const store = new Store(file, '2026-10-20', 'guild', 'Europe/Paris');
  const request = store.request('member', '2026-10-20', 2, 'Away');
  request.noticeMessageId = 'notice';
  const original = getSettings(store.data);
  saveSettings(store, chosen(), 0);
  const restored = new Store(file, '2026-10-21', 'guild', 'Europe/Paris');
  assert.deepEqual(getSettings(restored.data), chosen());
  assert.equal(restored.data.requests[request.id].noticeChannelId, original.adminChannelId);
  assert.equal(restored.data.requests[request.id].reason, 'Away');
  assert.equal(restored.data.settingsRevision, 1);
  assert.equal(restored.data.lastClosedDay, '2026-10-19');
  assert.throws(() => saveSettings(restored, defaultSettings(), 0), /Another admin/);
});

test('failed persistence keeps the current settings and request metadata unchanged', () => {
  const data = { requests: { r: { noticeMessageId: 'message' } } };
  assert.throws(() => saveSettings({ data, save() { throw Error('Disk full'); } }, chosen(), 0), /Disk full/);
  assert.deepEqual(data, { requests: { r: { noticeMessageId: 'message' } } });
});

test('setup drafts are isolated, cancel does not save, sessions enforce owner and expiry', () => {
  let now = 0;
  const sessions = new SetupSessions(() => now);
  const data = { settings: chosen() };
  const first = sessions.open('admin', 'guild', data), second = sessions.open('other', 'guild', data);
  sessions.selectField(first, 'memberRoleId');
  sessions.selectValues(first, [ids.extra]);
  assert.equal(data.settings.memberRoleId, ids.member);
  assert.equal(second.draft.memberRoleId, ids.member);
  assert.throws(() => sessions.get(first.id, 'other', 'guild'), /own Setup/);
  assert.throws(() => sessions.get(first.id, 'admin', 'other'), /own Setup/);
  assert.throws(() => sessions.selectField(first, '__proto__'), /Unknown/);
  assert.throws(() => sessions.selectValues(first, []), /valid/);
  sessions.close(first);
  assert.equal(data.settings.memberRoleId, ids.member);
  assert.throws(() => sessions.get(first.id, 'admin', 'guild'), /expired/);
  now = 31 * 60000;
  assert.throws(() => sessions.get(second.id, 'other', 'guild'), /expired/);
});

test('every setup field renders native channel/role pickers and optional roles can be cleared', () => {
  const sessions = new SetupSessions();
  const session = sessions.open('admin', 'guild', { settings: chosen() });
  for (const [key, field] of Object.entries(SETTINGS_FIELDS)) {
    sessions.selectField(session, key);
    const view = setupView(session);
    assert.equal(view.components.length, 3);
    const menu = view.components[1].toJSON().components[0];
    assert.equal(menu.type, field.kind === 'number' ? 2 : field.kind === 'channel' ? 8 : 6);
    if (field.kind === 'channel') assert.deepEqual(menu.channel_types, [ChannelType.GuildText]);
    assert.equal(view.allowedMentions.parse.length, 0);
  }
  sessions.selectField(session, 'timeoffRoleIds');
  sessions.selectValues(session, []);
  assert.deepEqual(session.draft.timeoffRoleIds, []);
  assert.equal(setupView(session).components[1].toJSON().components[0].min_values, 0);
});

test('daily required Gems editor validates whole amounts, isolates drafts and persists after save', () => {
  const sessions = new SetupSessions();
  const store = { data: { requests: {} }, save() {} };
  const session = sessions.open('admin', 'guild', store.data);
  assert.equal(session.draft.dailyDonationGems, 1000);
  for (const value of ['0', '-1', '1.5', '1e3', '1000000001', 'abc', '1,000']) {
    assert.throws(() => sessions.setDailyGems(session, value), /whole Gems/);
  }
  sessions.setDailyGems(session, '2500');
  assert.equal(getSettings(store.data).dailyDonationGems, 1000);
  saveSettings(store, session.draft, 0);
  assert.equal(getSettings(store.data).dailyDonationGems, 2500);
  const modal = dailyGemsModal(session).toJSON();
  assert.equal(modal.custom_id, `setup:${session.id}:amount-submit`);
  assert.equal(modal.components[0].components[0].value, '2500');
  assert.throws(() => saveSettings(store, { ...session.draft, dailyDonationGems: 0 }, 1), /whole Gems/);
  assert.throws(() => checkAccess({ guildId: 'guild', customId: modal.custom_id }, 'guild'), /administrators/);
});

test('validation resolves all selected channels and roles and rejects inaccessible or foreign selections', async () => {
  const guild = guildFixture();
  const channels = await validateSettings(guild, chosen());
  assert.equal(channels.reminderChannelId.id, chosen().reminderChannelId);
  assert.equal(channels.vacationChannelId.id, chosen().vacationChannelId);
  guild.channels.fetch = async id => ({ id, guildId: 'other', type: ChannelType.GuildText });
  await assert.rejects(validateSettings(guild, chosen()), /this server/);
  const denied = guildFixture();
  denied.channels.fetch = async id => ({ id, guildId: 'guild', type: ChannelType.GuildText, permissionsFor: () => new PermissionsBitField(PermissionFlagsBits.ViewChannel) });
  await assert.rejects(validateSettings(denied, chosen()), /ReadMessageHistory/);
  const missing = guildFixture(); missing.roles.fetch = async () => null;
  await assert.rejects(validateSettings(missing, chosen()), /roles from this server/);
  await assert.rejects(validateSettings(guildFixture(), { ...chosen(), leaderRoleIds: [] }), /1–10/);
});

test('monthly leaderboard channel is optional, selectable, clearable and permission checked', async () => {
  assert.equal(defaultSettings().leaderboardChannelId, null);
  const sessions = new SetupSessions();
  const session = sessions.open('admin', 'guild', {});
  sessions.selectField(session, 'leaderboardChannelId');
  sessions.selectValues(session, [ids.channel]);
  assert.equal(session.draft.leaderboardChannelId, ids.channel);
  const view = setupView(session);
  assert.equal(view.components[1].toJSON().components[0].min_values, 0);
  const channels = await validateSettings(guildFixture(), session.draft);
  assert.equal(channels.leaderboardChannelId.id, ids.channel);
  sessions.selectValues(session, []);
  assert.equal(session.draft.leaderboardChannelId, null);
  assert.equal((await validateSettings(guildFixture(), session.draft)).leaderboardChannelId, null);
  const denied = guildFixture();
  const fetch = denied.channels.fetch;
  denied.channels.fetch = async id => id === ids.channel ? { id, guildId: 'guild', type: ChannelType.GuildText,
    permissionsFor: () => new PermissionsBitField(PermissionFlagsBits.ViewChannel) } : fetch(id);
  await assert.rejects(validateSettings(denied, { ...defaultSettings(), leaderboardChannelId: ids.channel }), /leaderboard channel: bot needs ReadMessageHistory/);
});

test('configured roster is used by the donation automation report', async () => {
  const tracked = member('tracked', ids.member);
  const automation = new Automation({ guild: { members: { list: async () => new Map([[tracked.id, tracked]]) } },
    channel: { messages: { fetch: async () => new Map() } }, store: { data: { settings: chosen(), grants: {} } }, timezone: 'Europe/Paris' });
  assert.deepEqual((await automation.report('2026-10-20')).missing.map(m => m.id), ['tracked']);
});

test('changing vacation channel creates a notice there and persists its new location', async () => {
  const store = { data: { vacationPanel: { channelId: 'old', messageId: 'old-notice' } }, save() {} };
  const calls = [];
  const channel = { id: chosen().vacationChannelId,
    messages: { fetch: async query => { calls.push(query); return new Collection(); } },
    send: async payload => { assert.equal(payload.components.length, 1); return { id: 'new-notice' }; } };
  await ensureVacationNotice(channel, store, 'bot');
  assert.equal(typeof calls[0], 'object');
  assert.deepEqual(store.data.vacationPanel, { channelId: channel.id, messageId: 'new-notice' });
});

test('Visitor role is selectable in Setup, displayed and saved', () => {
  const sessions = new SetupSessions();
  const store = { data: { requests: {} }, save() {} };
  const session = sessions.open('admin', 'guild', store.data);
  sessions.selectField(session, 'visitorRoleId');
  const initial = setupView(session);
  assert.ok(initial.components[2].toJSON().components.some(button => button.label === 'Set Visitor role' && button.custom_id.endsWith(':visitor')));
  assert.ok(initial.components[0].toJSON().components[0].options.some(option => option.value === 'visitorRoleId' && option.label === 'Visitor role'));
  const visitorId = '88888888888888888';
  sessions.selectValues(session, [visitorId]);
  const view = setupView(session);
  assert.equal(view.embeds[0].toJSON().fields.find(field => field.name === 'Visitor role').value, `<@&${visitorId}>`);
  assert.deepEqual(view.components[1].toJSON().components[0].default_values, [{ id: visitorId, type: 'role' }]);
  saveSettings(store, session.draft, session.revision);
  assert.equal(getSettings(store.data).visitorRoleId, visitorId);
});

test('Setup explains missing membership role permissions and hierarchy', async () => {
  const config = { ...chosen(), formerMemberRoleId: '88888888888888888', visitorRoleId: '99999999999999999' };
  for (const id of [config.memberRoleId, config.formerMemberRoleId, config.visitorRoleId]) {
    const guild = guildFixture(config);
    guild.roles.fetch = async roleId => ({ id: roleId, name: 'Selected role', guild: { id: 'guild' }, editable: roleId !== id });
    await assert.rejects(validateSettings(guild, config), /above Selected role/);
  }
  const guild = guildFixture(config);
  guild.members.fetchMe = async () => ({ permissions: new PermissionsBitField(PermissionFlagsBits.ManageNicknames) });
  await assert.rejects(validateSettings(guild, config), /Manage Roles/);
});

test('staff role is optional, persisted, clearable and distinct from membership roles', async () => {
  const sessions = new SetupSessions();
  const store = { data: { requests: {} }, save() {} };
  const session = sessions.open('admin', 'guild', store.data);
  sessions.selectField(session, 'staffRoleId');
  sessions.selectValues(session, [ids.extra]);
  assert.equal(setupView(session).components[1].toJSON().components[0].min_values, 0);
  await validateSettings(guildFixture(), session.draft);
  saveSettings(store, session.draft, 0);
  assert.equal(getSettings(store.data).staffRoleId, ids.extra);
  for (const key of ['memberRoleId', 'formerMemberRoleId', 'visitorRoleId']) {
    await assert.rejects(validateSettings(guildFixture(), { ...chosen(), [key]: ids.extra, staffRoleId: ids.extra }), /staff role different/);
  }
  sessions.selectValues(session, []);
  assert.equal(session.draft.staffRoleId, null);
});

test('staff role selection survives real state reload and a reopened Setup session', t => {
  const dir = mkdtempSync(join(tmpdir(), 'staff-setup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const store = new Store(path, '2026-11-02', 'guild', 'Europe/Paris');
  const sessions = new SetupSessions();
  const session = sessions.open('admin', 'guild', store.data);
  sessions.selectField(session, 'staffRoleId');
  const selector = setupView(session).components[1].toJSON().components[0];
  assert.equal(selector.custom_id, `setup:${session.id}:value:staffRoleId`);
  sessions.selectValues(session, [ids.extra], 'staffRoleId');
  saveSettings(store, session.draft, session.revision);
  const restored = new Store(path, '2026-11-03', 'guild', 'Europe/Paris');
  const reopened = new SetupSessions().open('admin', 'guild', restored.data);
  assert.equal(reopened.draft.staffRoleId, ids.extra);
  assert.equal(setupView(reopened).embeds[0].toJSON().fields.find(f => f.name.startsWith('Staff role')).value, `<@&${ids.extra}>`);
});

test('a delayed selector cannot clear or replace a different setup field and save status is prominent', () => {
  const sessions = new SetupSessions();
  const session = sessions.open('admin', 'guild', {});
  sessions.selectField(session, 'staffRoleId');
  sessions.selectValues(session, [ids.extra], 'staffRoleId');
  assert.throws(() => sessions.selectValues(session, [], 'visitorRoleId'), /older Setup view/);
  assert.equal(session.draft.staffRoleId, ids.extra);
  const view = setupView(session, 'Could not save setup: permission error');
  assert.ok(view.embeds[0].toJSON().description.startsWith('Could not save setup: permission error'));
});
