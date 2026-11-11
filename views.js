import { ActionRowBuilder, ButtonBuilder, ButtonStyle, escapeMarkdown } from 'discord.js';
import { brandedMessage } from './messages.js';
import { formatTimeoffDate } from './timeoff-date.js';
import { coverageOnDay } from './donation-coverage.js';

const safe = value => escapeMarkdown(String(value).replace(/[\r\n\t]/g, ' '));

export function donationSummary(state, ledger, day, userId, dailyGems) {
  const credit = coverageOnDay(state, day).get(userId);
  return `Verified donations: **${ledger.total(userId).toLocaleString('en-US')} Gems**\n`
    + `Today covered by donations: **${credit?.covered ? 'Yes' : 'No'}**\n`
    + `Prepaid days remaining after today: **${credit?.remainingDays ?? 0}**\n`
    + `Leftover Gems toward another day: **${(credit?.remainderGems ?? 0).toLocaleString('en-US')}**\n`
    + `Daily requirement for new approvals: **${dailyGems.toLocaleString('en-US')} Gems**`;
}

export function memberView(state, ledger, day, userId, dailyGems) {
  const name = ledger.data.links[userId];
  const pending = Object.values(state.requests).filter(request => request.userId === userId && request.status === 'pending').length;
  const approved = Object.values(state.grants)
    .filter(grant => grant.userId === userId && !grant.revokedAt && grant.end >= day)
    .sort((a, b) => a.start.localeCompare(b.start))[0];
  const timeoff = approved
    ? `${approved.start <= day ? 'Active' : 'Next approved'}: **${formatTimeoffDate(approved.start)} – ${formatTimeoffDate(approved.end)}**`
    : 'No active or upcoming approved time off.';
  return brandedMessage('Your Crazyland clan info', `<@${userId}>\nLinked game name: **${name ? safe(name) : 'None'}**`, {
    fields: [
      { name: 'Donations', value: donationSummary(state, ledger, day, userId, dailyGems) },
      { name: 'Time off', value: `${timeoff}\nPending requests: **${pending}**` },
    ],
  });
}

export function paginateBlocks(blocks, limit = 2800) {
  const pages = [];
  let current = '';
  for (const block of blocks) {
    // Requests are short, but an external API error can be arbitrarily long.
    // Split oversized entries instead of silently dropping any list items.
    const pieces = [];
    let piece = '';
    for (const character of block) {
      if (piece.length + character.length > limit) { pieces.push(piece); piece = ''; }
      piece += character;
    }
    if (piece) pieces.push(piece);
    for (const part of pieces) {
      if (current && current.length + part.length + 2 > limit) { pages.push(current); current = ''; }
      current += `${current ? '\n\n' : ''}${part}`;
    }
  }
  if (current) pages.push(current);
  return pages.length ? pages : ['Nothing to show yet.'];
}

export function listMessage(title, intro, blocks, requestedPage, buttonPrefix, options = {}) {
  const pages = paginateBlocks(blocks);
  const page = Math.max(0, Math.min(Number.isSafeInteger(requestedPage) ? requestedPage : 0, pages.length - 1));
  const message = brandedMessage(title, `${intro}\n\n${pages[page]}${pages.length > 1 ? `\n\nPage ${page + 1} of ${pages.length}` : ''}`, options);
  // Editing an old panel explicitly removes its obsolete text-file cards.
  message.attachments = [];
  message.components = pages.length > 1 ? [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${buttonPrefix}:${Math.max(0, page - 1)}`).setLabel('Previous').setStyle(ButtonStyle.Danger).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`${buttonPrefix}:${page + 1}`).setLabel('Next').setStyle(ButtonStyle.Danger).setDisabled(page === pages.length - 1),
  )] : [];
  return message;
}

export function timeoffBlocks(store, today, userId) {
  const requests = Object.values(store.data.requests).filter(r => !userId || r.userId === userId)
    .sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending') || b.start.localeCompare(a.start));
  const grants = Object.values(store.data.grants).filter(g => !userId || g.userId === userId)
    .sort((a, b) => b.start.localeCompare(a.start));
  return [
    ...(requests.length ? requests.map(r => `**Request \`${r.id}\` · ${safe(r.status)}**\n<@${r.userId}> · ${formatTimeoffDate(r.start)} → ${formatTimeoffDate(r.end)} · ${r.days} day(s)${r.reason ? `\nReason: ${safe(r.reason)}` : ''}`) : ['**Requests**\nNo time-off requests yet.']),
    ...(grants.length ? grants.map(g => {
      const status = g.revokedAt ? 'Revoked' : g.end < today ? 'Expired' : g.start > today ? 'Scheduled' : 'Active';
      return `**Days off \`${g.id}\` · ${status}**\n<@${g.userId}> · ${formatTimeoffDate(g.start)} → ${formatTimeoffDate(g.end)}\nApproved by <@${g.adminId}>`;
    }) : ['**Approved days off**\nNo days off granted yet.']),
  ];
}

export function issueBlocks(automation) {
  const errors = [...automation.nicknameErrors, ...(automation.lastError ? [automation.lastError] : [])];
  return errors.map(error => {
    const member = /^Cannot edit nickname for (\d+):/.exec(error);
    return member
      ? `**Nickname update needs attention**\nI can’t edit <@${member[1]}>. Check **Manage Nicknames** and place the bot’s role above this member’s highest role. The server owner cannot be renamed.`
      : `**Automation needs attention**\n${safe(error)}`;
  });
}

export function timeoffView(store, today, timezone, userId, page = 0) {
  return listMessage('Crazyland clan member vacations.', `${timezone} · Start and end dates are inclusive.\nPending requests need admin approval.`,
    timeoffBlocks(store, today, userId), page, 'timeoff-page');
}

export function timeoffRequestNotice(request, decision, adminId) {
  const status = decision
    ? `${decision === 'approved' ? 'Approved' : 'Rejected'} by <@${adminId}>`
    : 'Waiting for clan leader approval';
  const message = brandedMessage('Crazyland clan vacation request.',
    `<@${request.userId}> requested time off.`, {
      fields: [
        { name: 'Dates', value: `${formatTimeoffDate(request.start)} through ${formatTimeoffDate(request.end)}` },
        { name: 'Days', value: String(request.days), inline: true },
        { name: 'Request ID', value: `\`${request.id}\``, inline: true },
        { name: 'Reason', value: safe(request.reason || 'No reason provided') },
        { name: 'Latest donation screenshot', value: request.latestScreenshot?.url
          ? `[View screenshot](${request.latestScreenshot.url})`
          : request.latestScreenshot?.status === 'not-found' ? 'No screenshot found in the donation channel.'
            : request.latestScreenshot?.status === 'limit' ? 'No screenshot found in the latest 10,000 channel messages.'
              : 'Screenshot lookup unavailable.' },
        { name: 'Status', value: status },
      ],
    });
  message.attachments = [];
  message.components = decision ? [] : [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`timeoff-review:approve:${request.id}`)
      .setLabel('Approve').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`timeoff-review:reject:${request.id}`)
      .setLabel('Reject').setStyle(ButtonStyle.Danger),
  )];
  return message;
}

export function donationView(report, day, today, timezone, page = 0) {
  const blocks = [
    ...(report.submitted.length ? report.submitted.map(m => report.useCoverage
      ? `**Covered by verified donations** · <@${m.id}>\n${report.coverage.get(m.id).remainingDays} prepaid day(s) remaining after this date.`
      : `**Submitted** · <@${m.id}>\n[View donation proof](${report.submissions.get(m.id)})`) : [report.useCoverage ? '**Covered**\nNo members covered by verified donations.' : '**Submitted**\nNo proof received.']),
    ...(report.missing.length ? report.missing.map(m => `**Missing proof** · <@${m.id}>`) : ['**Missing proof**\nNobody is missing proof.']),
    ...(report.excused.length ? report.excused.map(m => `**Excused** · <@${m.id}>`) : ['**Excused**\nNo members on approved days off.']),
  ];
  return listMessage('Crazyland clan donation report.', `**${formatTimeoffDate(day)}** · ${timezone}\nTracking **${report.roster.length}** current members.${report.pause ? `\nDonations paused: **${safe(report.pause.name)}**.` : ''}${day === today ? '\nToday is still in progress.' : ''}`,
    blocks, page, `report-page:${day}`, { fields: [
      { name: report.useCoverage ? 'Covered' : 'Submitted', value: String(report.submitted.length), inline: true },
      { name: 'Missing proof', value: String(report.missing.length), inline: true },
      { name: 'Excused', value: String(report.excused.length), inline: true },
    ] });
}
