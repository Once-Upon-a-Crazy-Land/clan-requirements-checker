import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { donationBreaks } from './break-state.js';

export function defaultSettings() {
  const donation = process.env.DONATION_CHANNEL_ID || '1535655837828382740';
  return {
    donationChannelId: donation, reminderChannelId: donation, leaderboardChannelId: null, dailyDonationGems: 1000,
    vacationChannelId: '1549128315095355422', adminChannelId: '1537173435611090944',
    memberRoleId: '1532826238572298451', formerMemberRoleId: null, visitorRoleId: null, staffRoleId: null,
    leaderRoleIds: ['1532826140086112256', '1532826772624769316'],
    timeoffRoleIds: ['1532826889499185302'],
  };
}
export function getSettings(data = {}) {
  return structuredClone({ ...defaultSettings(), ...data.settings });
}
export const isFormerMember = (member, settings) => Boolean([settings.formerMemberRoleId, settings.visitorRoleId].some(id => id && member.roles.cache.has(id)));
export const hasStaffRole = (member, settings) => Boolean(settings.staffRoleId && member.roles.cache.has(settings.staffRoleId));
export const isAsylumStaff = member => [...member.roles.cache.values()]
  .some(role => role.name?.trim().replace(/\s+/g, ' ').toLowerCase() === 'asylum staff');
export const isClanLeader = (member, settings) => isAsylumStaff(member)
  || settings.leaderRoleIds.some(roleId => member.roles.cache.has(roleId));
export const requestRoleIds = settings => [...new Set([
  settings.memberRoleId, ...settings.leaderRoleIds, ...settings.timeoffRoleIds,
])];
export const SETTINGS_FIELDS = {
  dailyDonationGems: { label: 'Daily required donation (Gems)', kind: 'number' },
  vacationChannelId: { label: 'Vacation notice channel', kind: 'channel' },
  donationChannelId: { label: 'Donation proof channel', kind: 'channel' },
  reminderChannelId: { label: 'Donation reminder channel', kind: 'channel' },
  leaderboardChannelId: { label: 'Monthly donation leaderboard channel', kind: 'channel', min: 0 },
  adminChannelId: { label: 'Time-off review channel', kind: 'channel' },
  memberRoleId: { label: 'Tracked member role', kind: 'role' },
  formerMemberRoleId: { label: 'No longer a member role', kind: 'role', min: 0 },
  visitorRoleId: { label: 'Visitor role', kind: 'role', min: 0 },
  staffRoleId: { label: 'Staff role (elders / co-leaders / leaders)', kind: 'role', min: 0 },
  leaderRoleIds: { label: 'Leader / approval roles', kind: 'roles', min: 1 },
  timeoffRoleIds: { label: 'Additional time-off roles', kind: 'roles', min: 0 },
};

export function normalizeSettings(settings) {
  const result = {};
  const id = value => typeof value === 'string' && /^\d{17,20}$/.test(value);
  for (const [key, field] of Object.entries(SETTINGS_FIELDS)) {
    const value = settings[key];
    if (field.kind === 'number') {
      if (!Number.isSafeInteger(value) || value < 1 || value > 1000000000) throw new Error('Daily required donation must be 1–1,000,000,000 whole Gems.');
      result[key] = value;
    } else if (field.kind === 'roles') {
      if (!Array.isArray(value) || value.length < field.min || value.length > 10 || !value.every(id)) {
        throw new Error(`Choose ${field.min}–10 roles for ${field.label}.`);
      }
      result[key] = [...new Set(value)];
    } else if (field.min === 0 && value == null) {
      result[key] = null;
    } else {
      if (!id(value)) throw new Error(`Choose a valid ${field.label}.`);
      result[key] = value;
    }
  }
  if (result.formerMemberRoleId === result.memberRoleId) throw new Error('Choose different tracked member and no-longer-a-member roles.');
  const roles = [result.memberRoleId, result.formerMemberRoleId, result.visitorRoleId].filter(Boolean);
  if (new Set(roles).size !== roles.length) throw new Error('Choose different Patient, Patient No More and Visitor roles.');
  if (roles.includes(result.staffRoleId)) throw new Error('Choose a staff role different from the three membership roles.');
  return result;
}

export async function validateSettings(guild, settings) {
  settings = normalizeSettings(settings);
  const me = await guild.members.fetchMe();
  const channels = {};
  for (const [key, field] of Object.entries(SETTINGS_FIELDS)) {
    if (field.kind !== 'channel') continue;
    if (settings[key] == null && field.min === 0) { channels[key] = null; continue; }
    const channel = await guild.channels.fetch(settings[key]);
    if (!channel || channel.guildId !== guild.id || channel.type !== ChannelType.GuildText) {
      throw new Error(`${field.label} must be a text channel in this server.`);
    }
    const permissions = channel.permissionsFor(me);
    const required = ['ViewChannel', 'ReadMessageHistory', 'SendMessages', 'AttachFiles', 'EmbedLinks'];
    if (key === 'donationChannelId') required.push('AddReactions');
    for (const permission of required) {
      if (!permissions?.has(PermissionFlagsBits[permission])) throw new Error(`${field.label}: bot needs ${permission}.`);
    }
    channels[key] = channel;
  }
  const membershipRoles = [];
  for (const roleId of new Set([...requestRoleIds(settings), ...[settings.formerMemberRoleId, settings.visitorRoleId, settings.staffRoleId].filter(Boolean)])) {
    const role = await guild.roles.fetch(roleId);
    if (!role || role.guild.id !== guild.id || role.id === guild.id || role.managed) {
      throw new Error('Choose member and leadership roles from this server; everyone and bot-managed roles are not supported.');
    }
    if ([settings.memberRoleId, settings.formerMemberRoleId, settings.visitorRoleId].includes(roleId)) membershipRoles.push(role);
  }
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error('Bot needs Manage Roles to switch membership roles.');
  for (const role of membershipRoles) {
    if (!role.editable) throw new Error(`Place the bot highest role above ${role.name || role.id} so it can remove conflicting membership roles.`);
  }
  if (!me.permissions.has(PermissionFlagsBits.ManageNicknames)) throw new Error('Bot needs Manage Nicknames permission.');
  return channels;
}

export function saveSettings(store, settings, expectedRevision) {
  if ((store.data.settingsRevision || 0) !== expectedRevision) {
    throw new Error('Another admin changed setup. Open Setup again to use the latest settings.');
  }
  const normalized = normalizeSettings(settings);
  if (normalized.donationChannelId !== getSettings(store.data).donationChannelId
      && donationBreaks(store.data).some(item => !item.finished)) {
    throw new Error('End or cancel donation breaks and restore the channel before changing the donation proof channel.');
  }
  const previous = { settings: store.data.settings, revision: store.data.settingsRevision, requests: store.data.requests };
  const oldChannel = getSettings(store.data).adminChannelId;
  // Keep pending approvals usable after the review channel moves.
  const requests = Object.fromEntries(Object.entries(store.data.requests).map(([id, request]) => [id,
    request.noticeMessageId && !request.noticeChannelId ? { ...request, noticeChannelId: oldChannel } : request]));
  Object.assign(store.data, { settings: normalized, settingsRevision: expectedRevision + 1, requests });
  try { store.save(); }
  catch (error) {
    if (previous.settings === undefined) delete store.data.settings;
    else store.data.settings = previous.settings;
    if (previous.revision === undefined) delete store.data.settingsRevision;
    else store.data.settingsRevision = previous.revision;
    store.data.requests = previous.requests;
    throw error;
  }
  return getSettings(store.data);
}
