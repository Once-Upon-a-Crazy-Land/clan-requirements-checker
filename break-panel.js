import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, escapeMarkdown } from 'discord.js';
import { donationBreaks } from './break-state.js';
import { brandedMessage } from './messages.js';
export const BREAK_MODAL = 'breaks:create-submit';
export function breakModal(today) {
  const specs = [
    ['name', 'Break name', 'Halloween break', 80, true],
    ['start', 'Start date (inclusive)', today, 10, true],
    ['end', 'End date (inclusive)', '1 Nov', 10, true],
    ['reason', 'Announcement message (optional)', 'Use your gems to enjoy the Halloween event!', 1000, false],
  ];
  return new ModalBuilder().setCustomId(BREAK_MODAL).setTitle('Create a donation break')
    .addComponents(specs.map(([id, label, placeholder, max, required]) => new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId(id).setLabel(label).setPlaceholder(placeholder)
        .setStyle(id === 'reason' ? TextInputStyle.Paragraph : TextInputStyle.Short).setRequired(required).setMaxLength(max))));
}
export function breaksView(data, today, timezone, status = '') {
  const pending = donationBreaks(data).filter(item => !item.finished).sort((a, b) => a.start.localeCompare(b.start));
  const current = pending[0];
  const lines = pending.slice(0, 8).map(item => `**${escapeMarkdown(item.name)}** · ${item.start} → ${item.end}\n`
    + `${item.cancelledAt || item.endedAt || item.end < today ? 'Finishing / restoring channel' : item.start > today ? 'Scheduled' : 'Active'} · <#${item.channelId}>`);
  return {
    ...brandedMessage('Crazyland clan donation breaks.',
      `Break dates include both the start and end date (${timezone}). Donations, reminders and missing-proof labels pause during the break. The proof channel becomes read-only and its posting permissions are restored when the break ends.\n\n`
      + 'Discord administrators can still post. The bot needs Manage Permissions (Manage Roles) in the donation channel.\n\n'
      + (lines.join('\n\n') + (pending.length > 8 ? '\n\nMore breaks are scheduled; finish the earliest to manage the next.' : '') || 'No active or scheduled donation breaks.') + (status ? `\n\n${status.slice(0, 1200)}` : '')),
    attachments: [],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('breaks:create').setLabel('Create break').setStyle(ButtonStyle.Danger),
      ...(current ? [new ButtonBuilder().setCustomId(`breaks:end:${current.id}`).setLabel(current.start > today ? 'Cancel next break' : 'End current break').setStyle(ButtonStyle.Danger)] : []),
      new ButtonBuilder().setCustomId('breaks:refresh').setLabel('Refresh').setStyle(ButtonStyle.Danger))],
  };
}
