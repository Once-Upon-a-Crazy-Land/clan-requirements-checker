import { ActionRowBuilder,
  ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { listMessage, timeoffBlocks, issueBlocks } from './views.js';
import { formatTimeoffDate } from './timeoff-date.js';

export { commands } from './command-menu.js';
function adminButtons() {
  const buttons = [ ['list', 'Requests & days off'], ['grant', 'Grant days off'],
    ['approve', 'Approve request'], ['reject', 'Reject request'], ['revoke', 'Revoke days off'] ];
  return new ActionRowBuilder().addComponents(buttons.map(([action, label]) =>
    new ButtonBuilder().setCustomId(`admin:${action}`).setLabel(label).setStyle(ButtonStyle.Danger)));
}

export function panel(store, automation, today, timezone) {
  const pending = Object.values(store.data.requests).filter(r => r.status === 'pending').length;
  const message = listMessage('Crazyland clan donation admin.',
      'Manage donation requirements and time off with the buttons below.',
      [...issueBlocks(automation), ...timeoffBlocks(store, today)], 0, 'admin:page', {
        fields: [
          { name: 'Pending requests', value: String(pending), inline: true },
        ],
      });
  message.components.unshift(adminButtons());
  return message;
}

export function adminTimeoffView(store, today, timezone, page = 0) {
  const message = listMessage('Crazyland clan member vacations.',
    `${timezone} · Start and end dates are inclusive. Pending requests still need approval.`,
    timeoffBlocks(store, today), page, 'admin:page');
  message.components.unshift(adminButtons());
  return message;
}
export function modal(action, today) {
  const specs = action === 'grant' ? [
    ['user', 'Member Discord ID', 'Paste the member ID, not the role ID'], ['start', `First day off (today: ${formatTimeoffDate(today)})`, formatTimeoffDate(today)], ['days', 'Number of days (1–365)', '1'],
  ] : [[ 'id', action === 'revoke' ? 'Grant ID from the panel list' : 'Request ID from the panel list', '8-character ID' ]];
  return new ModalBuilder().setCustomId(`admin-submit:${action}`).setTitle({ grant: 'Grant days off', approve: 'Approve request', reject: 'Reject request', revoke: 'Revoke days off' }[action])
    .addComponents(specs.map(([id, label, placeholder]) => new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId(id).setLabel(label).setPlaceholder(placeholder)
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(40))));
}
