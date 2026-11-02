import { randomUUID } from 'node:crypto';
import { ActionRowBuilder, StringSelectMenuBuilder, ChannelSelectMenuBuilder, RoleSelectMenuBuilder,
  ButtonBuilder, ButtonStyle, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { brandedMessage } from './messages.js';
import { getSettings, SETTINGS_FIELDS } from './configuration.js';

export class SetupSessions {
  constructor(now = () => Date.now()) { this.now = now; this.sessions = new Map(); }
  open(userId, guildId, data) {
    for (const [id, value] of this.sessions) if (value.expires <= this.now()) this.sessions.delete(id);
    const session = { id: randomUUID(), userId, guildId, draft: getSettings(data),
      revision: data.settingsRevision || 0, field: 'vacationChannelId', expires: this.now() + 30 * 60000 };
    this.sessions.set(session.id, session);
    return session;
  }
  get(id, userId, guildId) {
    const session = this.sessions.get(id);
    if (!session || session.expires <= this.now()) {
      this.sessions.delete(id);
      throw new Error('This setup has expired. Open /clan action:Setup again.');
    }
    if (session.userId !== userId || session.guildId !== guildId) throw new Error('Open your own Setup panel to change settings.');
    return session;
  }
  selectField(session, field) {
    if (!Object.hasOwn(SETTINGS_FIELDS, field)) throw new Error('Unknown setup setting.');
    session.field = field;
  }
  selectValues(session, values, selectedField = session.field) {
    if (selectedField !== session.field) throw new Error('This selector is from an older Setup view. Choose Staff role (or your setting) again, then select its value.');
    const field = SETTINGS_FIELDS[session.field];
    if (field.kind === 'number') throw new Error('Use the daily Gems amount form for this setting.');
    if (!Array.isArray(values) || values.length < (field.min ?? 1) || values.length > (field.kind === 'roles' ? 10 : 1)
      || !values.every(id => /^\d{17,20}$/.test(id))) throw new Error('Choose valid channels or roles from the menu.');
    session.draft[session.field] = field.kind === 'roles' ? [...new Set(values)] : values[0] ?? null;
  }
  setDailyGems(session, input) {
    if (!/^\d{1,10}$/.test(input) || Number(input) < 1 || Number(input) > 1000000000) {
      throw new Error('Enter 1–1,000,000,000 whole Gems, without spaces or commas.');
    }
    session.draft.dailyDonationGems = Number(input);
  }
  close(session) { this.sessions.delete(session.id); }
}

export function setupView(session, status = '') {
  const fields = Object.entries(SETTINGS_FIELDS).map(([key, field]) => {
    const values = Array.isArray(session.draft[key]) ? session.draft[key] : [session.draft[key]].filter(Boolean);
    return { name: field.label, value: field.kind === 'number' ? `${session.draft[key].toLocaleString('en-US')} Gems / day`
      : values.map(id => field.kind === 'channel' ? `<#${id}>` : `<@&${id}>`).join(', ') || 'None', inline: true };
  });
  const prefix = `setup:${session.id}`;
  const field = SETTINGS_FIELDS[session.field];
  const settingMenu = new StringSelectMenuBuilder().setCustomId(`${prefix}:field`).setPlaceholder('Choose a setting to edit')
    .addOptions(Object.entries(SETTINGS_FIELDS).map(([key, value]) => ({ label: value.label, value: key, default: key === session.field })));
  const values = Array.isArray(session.draft[session.field]) ? session.draft[session.field] : [session.draft[session.field]].filter(Boolean);
  const valueMenu = field.kind === 'number'
    ? new ButtonBuilder().setCustomId(`${prefix}:amount`).setLabel('Set daily required Gems').setStyle(ButtonStyle.Primary)
    : field.kind === 'channel'
    ? new ChannelSelectMenuBuilder().setChannelTypes(ChannelType.GuildText).setDefaultChannels(...values)
    : new RoleSelectMenuBuilder().setDefaultRoles(...values);
  if (field.kind !== 'number') valueMenu.setCustomId(`${prefix}:value:${session.field}`).setPlaceholder(`Choose ${field.label.toLowerCase()}`)
    .setMinValues(field.min ?? 1).setMaxValues(field.kind === 'roles' ? 10 : 1);
  return {
    ...brandedMessage('Crazyland clan setup.',
      (status ? `${status.slice(0, 1200)}\n\n` : '')
      + `**Editing: ${field.label}**\nChoose the actual ${field.kind === 'channel' ? 'channel' : field.kind === 'number' ? 'amount using the button' : 'role(s)'} below, then press **Save setup**. Choosing a setting in the first menu alone does not change its value.\n\n`
      + 'The member role is automatically assigned to human users who lack it, except Patient No More and Visitor. Members, leaders and additional time-off roles can request vacations. Leadership roles can approve them.\n'
      + 'Assigning Patient, Patient No More or Visitor removes the other two membership roles. Use **Set Visitor role** below to configure Visitor. Patient No More and Visitor stop donation tracking and remove bot nickname tags.\n'
      + 'Choose an optional Staff role shared by elders, co-leaders and leaders. Anyone with it has Patient, Patient No More and Visitor removed, and will not receive the member role. Approval permissions still use Leader / approval roles.\n'
      + 'Choose a Monthly donation leaderboard channel to post the previous month’s verified Gems on the first of each month. Clear it to disable.\n'
      + 'Daily required Gems converts verified donations into prepaid days. Leftover Gems carry forward. Change the amount, then Save setup.\n'
      + 'Saving posts or updates the Vacation notice in your chosen channel.\n', { fields }),
    attachments: [],
    components: [new ActionRowBuilder().addComponents(settingMenu), new ActionRowBuilder().addComponents(valueMenu),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${prefix}:visitor`).setLabel('Set Visitor role').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`${prefix}:save`).setLabel('Save setup').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`${prefix}:cancel`).setLabel('Cancel').setStyle(ButtonStyle.Secondary))],
  };
}

export function dailyGemsModal(session) {
  return new ModalBuilder().setCustomId(`setup:${session.id}:amount-submit`).setTitle('Daily required donation')
    .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('gems')
      .setLabel('Gems required per day (whole number)').setStyle(TextInputStyle.Short).setRequired(true)
      .setMaxLength(10).setValue(String(session.draft.dailyDonationGems))));
}
