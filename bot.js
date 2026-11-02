import { Client, GatewayIntentBits, Events, MessageFlags, Partials, escapeMarkdown } from 'discord.js';
import { DonationLedger, CHECK_EMOJI_ID, attachmentSignature, canVerifyDonation, scanProof, proofView, visionEnabled } from './donations.js';
import { fileURLToPath } from 'node:url';
import { dayAt, validDay, hasImage, latestScreenshot } from './tracking.js';
import { canRequestTimeoff, Store, dateRange } from './state.js';
import { Automation } from './automation.js';
import { commands, panel, adminTimeoffView, modal } from './panel.js';
import { timeoffView, donationView, timeoffRequestNotice } from './views.js';
import { checkAccess } from './access.js';
import { commandAction, registerCommands, CLAN_TIMEOFF_MODAL } from './command-menu.js';
import { brandedMessage } from './messages.js';
import { formatTimeoffDate, parseTimeoffDate } from './timeoff-date.js';
import { VACATION_BUTTON, VACATION_MODAL, vacationModal, ensureVacationNotice } from './vacation-panel.js';

import { getSettings, validateSettings, saveSettings, isFormerMember, isClanLeader } from './configuration.js';
import { SetupSessions, setupView } from './setup.js';
import { DonationBreakManager } from './donation-breaks.js';
import { assignMemberRoles, reconcileMembershipRoles } from './member-roles.js';
import { updatePatientPresence } from './presence.js';
import { breakModal, breaksView, BREAK_MODAL } from './break-panel.js';

const { DISCORD_TOKEN, GUILD_ID } = process.env;
const timezone = process.env.TIMEZONE || 'Europe/Paris';
for (const [name, value] of Object.entries({ GUILD_ID })) {
  if (!/^\d{17,20}$/.test(value || '')) throw new Error(`Set a valid ${name} in .env`);
}
if (!DISCORD_TOKEN || DISCORD_TOKEN === 'put_your_bot_token_here') throw new Error('Set DISCORD_TOKEN in .env');
const today = () => dayAt(Date.now(), timezone);
today();
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
  allowedMentions: { parse: [] },
});
let automation;
let store;
let donationLedger;
let scanQueue = Promise.resolve();
const scanJobs = new Map();
function enqueueScan(message, force = false) {
  if (scanJobs.has(message.id)) return scanJobs.get(message.id);
  const job = scanQueue.then(async () => {
    const existing = donationLedger.data.proofs[message.id];
    if (!force && existing && existing.signature === attachmentSignature(message)) return existing;
    const proof = await scanProof(message, donationLedger);
    await removePublicProofNotice(message.channel, proof);
    return proof;
  });
  scanQueue = job.catch(() => {});
  scanJobs.set(message.id, job);
  job.finally(() => scanJobs.delete(message.id)).catch(() => {});
  return job;
}
async function removePublicProofNotice(channel, proof) {
  if (!proof.noticeId) return;
  try {
    const notice = await channel.messages.fetch(proof.noticeId);
    if (notice.author.id !== client.user.id) return;
    await notice.delete();
  } catch (error) {
    if (error.code !== 10008) {
      console.error('Could not remove old public donation scan:', error.message);
      return;
    }
  }
  delete proof.noticeId;
  store.save();
}
async function cleanPublicProofNotices() {
  for (const proof of Object.values(donationLedger.data.proofs)) {
    if (!proof.noticeId) continue;
    try {
      const channel = await configuredGuild.channels.fetch(proof.channelId);
      await removePublicProofNotice(channel, proof);
    } catch (error) { console.error('Old donation scan cleanup:', error.message); }
  }
}
let timer;
let adminChannel;
let configuredGuild;
let breakManager;
let configurationError = null;
const setupSessions = new SetupSessions();
const settings = () => getSettings(store?.data);
let queue = Promise.resolve();
const serialize = action => {
  const result = queue.then(action);
  queue = result.catch(() => {});
  return result;
};
let tickQueued = false;
const schedule = () => {
  if ((!automation && !breakManager) || tickQueued) return;
  tickQueued = true;
  void serialize(async () => {
    const errors = [];
    try { await breakManager?.sync(); } catch (error) { errors.push(error.message); }
    try { if (automation) await automation.tick(); } catch (error) { errors.push(error.message); }
    if (errors.length) { const message = errors.join('; '); if (automation) automation.lastError = message; throw new Error(message); }
  }).catch(error => console.error('Daily check failed:', error.message))
    .finally(() => { tickQueued = false; });
};
async function patient(userId) {
  const member = await automation.guild.members.fetch(userId);
  if (member.user.bot || isFormerMember(member, settings()) || !member.roles.cache.has(settings().memberRoleId)) throw new Error('This member must have the configured member role.');
  return member;
}
async function timeoffMember(userId) {
  const member = await automation.guild.members.fetch(userId);
  if (!canRequestTimeoff(member, settings())) throw new Error('This member does not have a role that can request time off.');
  return member;
}
async function updateRequestNotice(request, decision, adminId) {
  if (!request.noticeMessageId) return;
  try {
    const channel = await configuredGuild.channels.fetch(request.noticeChannelId || settings().adminChannelId);
    const message = await channel.messages.fetch(request.noticeMessageId);
    await message.edit(timeoffRequestNotice(request, decision, adminId));
  } catch (error) {
    console.error(`Could not update time-off request message ${request.id}:`, error.message);
  }
}
async function handleAdminSubmit(interaction, action) {
  const get = id => interaction.fields.getTextInputValue(id).trim();
  let response;
  if (action === 'grant') {
    const userId = get('user');
    if (!/^\d{17,20}$/.test(userId)) throw new Error('Enter the member Discord ID, not their name or a role ID.');
    await timeoffMember(userId);
    const grant = store.grant(userId, parseTimeoffDate(get('start'), today()), Number(get('days')), interaction.user.id);
    response = `Granted ${grant.days} days off to <@${userId}>: **${formatTimeoffDate(grant.start)} through ${formatTimeoffDate(grant.end)}**. Grant ID: ${grant.id}.`;
  } else if (action === 'approve') {
    const request = store.data.requests[get('id')];
    if (!request || request.status !== 'pending') throw new Error('Pending request not found.');
    await timeoffMember(request.userId);
    const grant = store.grant(request.userId, request.start, request.days, interaction.user.id, request.id);
    await updateRequestNotice(request, 'approved', interaction.user.id);
    response = `Approved request ${request.id}: **${formatTimeoffDate(grant.start)} through ${formatTimeoffDate(grant.end)}**. Grant ID: ${grant.id}.`;
  } else if (action === 'reject') {
    const request = store.data.requests[get('id')];
    store.reject(get('id'), interaction.user.id);
    await updateRequestNotice(request, 'rejected', interaction.user.id);
    response = 'Request rejected. The member can see this with /clan action:My time off.';
  } else if (action === 'revoke') {
    store.revoke(get('id'), interaction.user.id);
    response = 'Days off revoked. Daily checks apply again unless another approved period covers the member.';
  } else throw new Error('Unknown admin action.');
  await interaction.editReply(brandedMessage('Crazyland clan vacation updated.', `${response}\n\nNickname changes apply on the next check. Previously sent reminders cannot be withdrawn.`));
  schedule();
}

async function handleTimeoffReview(interaction) {
  const [, action, requestId] = interaction.customId.split(':');
  if (!['approve', 'reject'].includes(action)) throw new Error('Unknown review action.');
  const request = store.data.requests[requestId];
  if (!request || request.status !== 'pending') throw new Error('This request has already been reviewed or no longer exists.');
  if (interaction.channelId !== (request.noticeChannelId || settings().adminChannelId)
      || interaction.message.author.id !== client.user.id
      || (request.noticeMessageId && interaction.message.id !== request.noticeMessageId)) {
    throw new Error('This review button is not the saved request message.');
  }
  await timeoffMember(request.userId);
  if (action === 'approve') store.grant(request.userId, request.start, request.days, interaction.user.id, request.id);
  else store.reject(request.id, interaction.user.id);
  await interaction.message.edit(timeoffRequestNotice(request, action === 'approve' ? 'approved' : 'rejected', interaction.user.id));
  await interaction.editReply(brandedMessage(`Crazyland clan vacation ${action === 'approve' ? 'approved' : 'rejected'}.`,
    `<@${request.userId}> has been ${action === 'approve' ? 'excused for the requested dates' : 'kept on the donation requirement'}.`));
  schedule();
}

async function applyConfiguration(channels) {
  adminChannel = channels.adminChannelId;
  if (automation) Object.assign(automation, { channel: channels.donationChannelId, reminder: channels.reminderChannelId });
  else automation = new Automation({ guild: configuredGuild, channel: channels.donationChannelId,
    reminder: channels.reminderChannelId, store, timezone, botId: client.user.id,
    syncMemberRoles: async () => {
      const result = await assignMemberRoles(configuredGuild, settings());
      updatePatientPresence(client.user, result.members, settings());
      return result;
    } });
  configurationError = null;
  const oldNotice = store.data.vacationPanel ? { ...store.data.vacationPanel } : null;
  try {
    await ensureVacationNotice(channels.vacationChannelId, store, client.user.id);
    if (oldNotice && oldNotice.channelId !== channels.vacationChannelId.id) {
      try {
        const oldChannel = await configuredGuild.channels.fetch(oldNotice.channelId);
        const message = await oldChannel.messages.fetch(oldNotice.messageId);
        if (message.author.id === client.user.id) await message.edit({
          ...brandedMessage('Crazyland clan member vacations.',
            'Vacation requests have moved to <#' + channels.vacationChannelId.id + '>. You can also use /clan action:Request time off.'),
          components: [], attachments: [],
        });
      } catch (error) { console.error('Could not retire previous vacation notice:', error.message); }
    }
  } catch (error) {
    configurationError = 'Settings are active, but the vacation notice could not be updated: ' + error.message + '. Save Setup again to retry.';
    console.error(configurationError);
  }
}

async function handleSetup(interaction) {
  checkAccess(interaction, GUILD_ID, settings());
  const [, id, operation] = interaction.customId.split(':');
  const session = setupSessions.get(id, interaction.user.id, interaction.guildId);
  if (operation === 'visitor') {
    setupSessions.selectField(session, 'visitorRoleId');
    return interaction.editReply(setupView(session));
  }
  if (operation === 'cancel') {
    setupSessions.close(session);
    return interaction.editReply({ ...brandedMessage('Crazyland clan setup.', 'Setup cancelled. Your saved settings are unchanged.'), components: [], attachments: [] });
  }
  if (operation === 'field') setupSessions.selectField(session, interaction.values?.[0]);
  else if (operation === 'value') setupSessions.selectValues(session, interaction.values);
  else if (operation === 'save') {
    try {
      const channels = await validateSettings(configuredGuild, session.draft);
      saveSettings(store, session.draft, session.revision);
      session.revision = store.data.settingsRevision;
      session.draft = settings();
      await applyConfiguration(channels);
      schedule();
      return interaction.editReply(setupView(session, configurationError || '**Setup saved.** Your channel and role choices are now active.'));
    } catch (error) { return interaction.editReply(setupView(session, 'Could not save setup: ' + error.message)); }
  } else throw new Error('Unknown setup action.');
  return interaction.editReply(setupView(session));
}

client.once(Events.ClientReady, async () => {
  try {
    configuredGuild = await client.guilds.fetch(GUILD_ID);
    store = new Store(fileURLToPath(new URL('./data/state.json', import.meta.url)), today(), GUILD_ID, timezone);
    donationLedger = new DonationLedger(store);
    breakManager = new DonationBreakManager({ guild: configuredGuild, store, botId: client.user.id, timezone });
    // Keep Setup available even if a configured channel or role was deleted.
    await registerCommands(configuredGuild);
    try { await applyConfiguration(await validateSettings(configuredGuild, settings())); }
    catch (error) { configurationError = error.message; console.error('Open /clan action:Setup:', error.message); }
    console.log('Ready: clan commands in ' + timezone + '. Donation automation ' + (automation ? 'active.' : 'needs setup.'));
    timer = setInterval(schedule, 60000);
    schedule();
    void cleanPublicProofNotices().catch(error => console.error('Donation notice cleanup:', error.message));
  } catch (error) {
    console.error('Startup failed:', error.message);
    client.destroy();
    process.exitCode = 1;
  }
});

client.on(Events.GuildMemberAdd, member => {
  if (member.guild.id === GUILD_ID && !member.user.bot) schedule();
});
client.on(Events.GuildMemberRemove, member => {
  if (member.guild.id === GUILD_ID && !member.user.bot) schedule();
});
client.on(Events.GuildMemberUpdate, async (previous, member) => {
  if (member.guild.id !== GUILD_ID) return;
  const config = settings();
  try { await reconcileMembershipRoles(previous, member, config); }
  catch (error) { console.error('Membership roles for ' + member.id + ':', error.message); schedule(); return; }
  if (member.guild.id === GUILD_ID && (isFormerMember(previous, config) !== isFormerMember(member, config)
      || isClanLeader(previous, config) !== isClanLeader(member, config)
      || previous.roles.cache.has(config.memberRoleId) !== member.roles.cache.has(config.memberRoleId))) schedule();
});

client.on(Events.MessageCreate, async message => {
  if (!automation || message.guildId !== GUILD_ID || message.channelId !== settings().donationChannelId
      || message.author.bot || message.webhookId || !hasImage(message)) return;
  try {
    const author = await configuredGuild.members.fetch(message.author.id);
    if (isFormerMember(author, settings()) || !(author.roles.cache.has(settings().memberRoleId)
        || canVerifyDonation(author, settings()))) return;
    schedule();
    await message.react(CHECK_EMOJI_ID);
    if (visionEnabled()) {
      void enqueueScan(message).catch(error => {
        console.error('Donation scan:', error.message);
      });
    }
  } catch (error) { console.error('Screenshot acknowledgement:', error.message); }
});

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (!donationLedger || user.bot || reaction.emoji.id !== CHECK_EMOJI_ID
      || reaction.message.guildId !== GUILD_ID || reaction.message.channelId !== settings().donationChannelId) return;
  try {
    const member = await configuredGuild.members.fetch({ user: user.id, force: true });
    if (!canVerifyDonation(member, settings())) return;
    // Fetch the actual current attachments, including for messages outside the cache after restart.
    const message = await reaction.message.channel.messages.fetch({ message: reaction.message.id, force: true });
    if (message.author.bot || message.webhookId || !hasImage(message)) return;
    if (scanJobs.has(message.id)) await scanJobs.get(message.id);
    await serialize(async () => {
      const currentMember = await configuredGuild.members.fetch({ user: user.id, force: true });
      const currentMessage = await message.channel.messages.fetch({ message: message.id, force: true });
      const proof = donationLedger.approve(message.id, currentMember, settings(), attachmentSignature(currentMessage));
      await removePublicProofNotice(currentMessage.channel, proof);
      await currentMessage.react('✅');
    });
  } catch (error) {
    console.error('Donation verification:', error.message);
  }
});

client.on(Events.InteractionCreate, async interaction => {
  const isBreakSubmit = interaction.isModalSubmit() && interaction.customId === BREAK_MODAL;
  const isBreakButton = interaction.isButton() && interaction.customId.startsWith('breaks:');
  const isSetup = interaction.isMessageComponent() && interaction.customId.startsWith('setup:');
  const isCommand = interaction.isChatInputCommand() && commands.some(c => c.name === interaction.commandName);
  const isButton = interaction.isButton() && (interaction.customId === VACATION_BUTTON || ['admin:', 'timeoff-page:', 'report-page:', 'timeoff-review:'].some(prefix => interaction.customId.startsWith(prefix)));
  const isVacationSubmit = interaction.isModalSubmit() && [VACATION_MODAL, CLAN_TIMEOFF_MODAL].includes(interaction.customId);
  const isModal = interaction.isModalSubmit() && interaction.customId.startsWith('admin-submit:');
  if (!isCommand && !isButton && !isModal && !isVacationSubmit && !isSetup && !isBreakButton && !isBreakSubmit) return;
  try {
    if (!store || interaction.guildId !== GUILD_ID) throw new Error('Bot is starting or this is not the configured server.');
    checkAccess(interaction, GUILD_ID, settings());
    const action = commandAction(interaction);
    if (isCommand && action?.startsWith('donation-') && action !== 'donation-admin') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (action === 'donation-link') {
        const user = interaction.options.getUser('member');
        const name = interaction.options.getString('game-name');
        if (!user || user.bot || !name) throw new Error('Choose a human member and enter game-name.');
        await configuredGuild.members.fetch(user.id);
        await serialize(() => { checkAccess(interaction, GUILD_ID, settings()); donationLedger.link(user.id, name); });
        await interaction.editReply(brandedMessage('Crazyland clan name linked.', `<@${user.id}> is linked to **${escapeMarkdown(name)}**. Existing credited donations stay with their original Discord member.`));
      } else if (action === 'donation-total') {
        const user = interaction.options.getUser('member') || interaction.user;
        await interaction.editReply(brandedMessage('Crazyland clan donation total.', `<@${user.id}>: **${donationLedger.total(user.id).toLocaleString('en-US')} Gems** verified.`));
      } else {
        const id = interaction.options.getString('proof-id');
        if (!/^\d{17,20}$/.test(id || '')) throw new Error('Enter the original screenshot message ID in proof-id.');
        const channel = await configuredGuild.channels.fetch(settings().donationChannelId);
        const message = await channel.messages.fetch({ message: id, force: true });
        if (message.author.bot || message.webhookId || !hasImage(message)) throw new Error('Choose a member screenshot in the donation proof channel.');
        if (action === 'donation-scan') {
          const proof = await enqueueScan(message, true);
          await message.react(CHECK_EMOJI_ID);
          await interaction.editReply(proofView(proof));
        } else if (action === 'donation-verify') {
          if (scanJobs.has(id)) await scanJobs.get(id);
          const member = await configuredGuild.members.fetch({ user: interaction.user.id, force: true });
          const current = await channel.messages.fetch({ message: id, force: true });
          const proof = await serialize(() => donationLedger.approve(id, member, settings(), attachmentSignature(current),
            interaction.options.getBoolean('repeat-confirmed') === true));
          await removePublicProofNotice(current.channel, proof);
          await current.react('✅');
          await interaction.editReply(proofView(proof));
        } else {
          const member = await configuredGuild.members.fetch({ user: interaction.user.id, force: true });
          const proof = await serialize(() => donationLedger.void(id, member, settings()));
          await removePublicProofNotice(message.channel, proof);
          const verified = message.reactions.cache.find(r => r.emoji.name === '✅');
          if (verified?.me) await verified.users.remove(client.user.id);
          await interaction.editReply(proofView(proof));
        }
      }
      return;
    }
    if (isBreakButton && interaction.customId === 'breaks:create') {
      await interaction.showModal(breakModal(today()));
      return;
    }
    if ((isCommand && action === 'breaks') || isBreakButton || isBreakSubmit) {
      if (isBreakButton) await interaction.deferUpdate();
      else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await serialize(async () => {
        checkAccess(interaction, GUILD_ID, settings());
        let status = '';
        if (isBreakSubmit) {
          const get = id => interaction.fields.getTextInputValue(id).trim();
          await breakManager.create({ name: get('name'), start: parseTimeoffDate(get('start'), today()),
            end: parseTimeoffDate(get('end'), today()), reason: get('reason'), adminId: interaction.user.id });
          status = 'Break saved.';
        } else if (isBreakButton && interaction.customId.startsWith('breaks:end:')) {
          breakManager.end(interaction.customId.split(':')[2], interaction.user.id);
          status = 'Break ending or cancelled. Today remains excused if the break had already started.';
        }
        try { await breakManager.sync(); }
        catch (error) { status += '\nChannel update pending: ' + error.message + ' The bot will retry automatically.'; }
        schedule();
        await interaction.editReply(breaksView(store.data, today(), timezone, status));
      });
      return;
    }
    if (isSetup) {
      await interaction.deferUpdate();
      await serialize(() => handleSetup(interaction));
      return;
    }
    if (isCommand && action === 'setup') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await serialize(() => interaction.editReply(setupView(setupSessions.open(interaction.user.id, interaction.guildId, store.data), configurationError || '')));
      return;
    }
    if (!automation) throw new Error('An administrator needs to finish /clan action:Setup before using donation features.');
    if (interaction.customId === VACATION_BUTTON || interaction.customId === VACATION_MODAL) {
      if (interaction.channelId !== settings().vacationChannelId) throw new Error('Use the notice in the member vacations channel.');
      if (isButton) {
        if (interaction.message.author.id !== client.user.id) throw new Error('This is not the bot vacation notice.');
        await interaction.showModal(vacationModal(today()));
        return;
      }
    }
    if (isCommand && action === 'timeoff') {
      await interaction.showModal(vacationModal(today(), CLAN_TIMEOFF_MODAL));
      return;
    }
    if (isButton && interaction.customId.startsWith('admin:')
        && interaction.customId !== 'admin:list' && !interaction.customId.startsWith('admin:page:')) {
      const action = interaction.customId.split(':')[1];
      if (!['grant', 'approve', 'reject', 'revoke'].includes(action)) throw new Error('Unknown action.');
      await interaction.showModal(modal(action, today()));
      return;
    }
    const isReview = isButton && interaction.customId.startsWith('timeoff-review:');
    if (isReview) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    else if (isButton) await interaction.deferUpdate();
    else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await serialize(async () => {
      checkAccess(interaction, GUILD_ID, settings());
      if (isReview) return handleTimeoffReview(interaction);
      const page = isButton ? Number(interaction.customId.split(':').at(-1)) || 0 : 0;
      if (isModal) return handleAdminSubmit(interaction, interaction.customId.split(':')[1]);
      if (action === 'donation-admin') {
        return interaction.editReply(panel(store, automation, today(), timezone));
      }
      if (isButton && (interaction.customId === 'admin:list' || interaction.customId.startsWith('admin:page:'))) {
        return interaction.editReply(adminTimeoffView(store, today(), timezone, page));
      }
      if (isVacationSubmit) {
        await timeoffMember(interaction.user.id);
        const start = parseTimeoffDate(interaction.fields.getTextInputValue('start').trim(), today());
        const days = Number(interaction.fields.getTextInputValue('days').trim());
        const reason = interaction.fields.getTextInputValue('reason').trim();
        dateRange(start, days);
        if (start < today()) throw new Error('Requests must start today or later. Ask an admin for a retroactive exemption.');
        const request = store.request(interaction.user.id, start, days, reason);
        try {
          request.latestScreenshot = await latestScreenshot(automation.channel, interaction.user.id);
        } catch (error) {
          console.error(`Could not look up donation proof for request ${request.id}:`, error.message);
          request.latestScreenshot = { status: 'unavailable' };
        }
        store.save();
        try {
          const notice = await adminChannel.send(timeoffRequestNotice(request));
          request.noticeMessageId = notice.id;
          request.noticeChannelId = adminChannel.id;
          store.save();
        } catch (error) {
          console.error(`Could not notify admins about request ${request.id}:`, error.message);
          return interaction.editReply(brandedMessage('Crazyland clan vacation request saved.',
            `Request **${request.id}** was saved, but I could not post it in <#${settings().adminChannelId}>. An admin can still review it in \`/clan action:Admin panel\`.`));
        }
        return interaction.editReply(brandedMessage('Crazyland clan vacation request submitted.',
          'Your request is waiting for a configured clan leader. You are excused only after approval.\nUse `/clan action:My time off` to check for updates.', {
            fields: [
              { name: 'Dates', value: `${formatTimeoffDate(request.start)} through ${formatTimeoffDate(request.end)}` },
              { name: 'Days off', value: String(days), inline: true },
              { name: 'Request ID', value: request.id, inline: true },
            ],
          }));
      }
      if (action === 'timeoff-status' || (isButton && interaction.customId.startsWith('timeoff-page:'))) {
        return interaction.editReply(timeoffView(store, today(), timezone, interaction.user.id, page));
      }
      const enteredDay = isButton ? interaction.customId.split(':')[1] : interaction.options.getString('date');
      const day = enteredDay ? parseTimeoffDate(enteredDay, today()) : today();
      if (!validDay(day) || day > today() || day < '2015-01-01') throw new Error('Use a real date from 2015 through today.');
      const report = await automation.report(day);
      return interaction.editReply(donationView(report, day, today(), timezone, page));
    });
  } catch (error) {
    console.error('Interaction failed:', error.message);
    const payload = brandedMessage('Crazyland clan bot notice.', String(error.message).slice(0, 1900));
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply({ ...payload, attachments: [], components: [] });
      else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    } catch (replyError) { console.error('Could not respond:', replyError.message); }
  }
});
client.on(Events.Error, error => console.error('Discord client error:', error.message));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  clearInterval(timer);
  client.destroy();
  process.exit(0);
});
client.login(DISCORD_TOKEN).catch(error => {
  console.error('Login failed:', error.message);
  client.destroy();
  process.exitCode = 1;
});
