import { PermissionFlagsBits } from 'discord.js';
import { commandAction } from './command-menu.js';
import { defaultSettings } from './configuration.js';

export function checkAccess(interaction, guildId, settings = defaultSettings()) {
  if (interaction.guildId !== guildId) throw new Error('This is not the configured server.');
  const action = commandAction(interaction);
  if (['donation-link', 'donation-scan', 'donation-void', 'donation-verify'].includes(action)) {
    const roles = interaction.member?.roles;
    const hasRole = id => Array.isArray(roles) ? roles.includes(id) : roles?.cache?.has(id);
    if (!settings.leaderRoleIds.some(hasRole)) throw new Error('Only configured Leaders or Co-leaders can manage donation proofs and name links.');
    return;
  }
  const approval = interaction.customId?.startsWith('timeoff-review:approve:')
    || interaction.customId === 'admin:approve'
    || interaction.customId === 'admin-submit:approve';
  if (approval) {
    const roles = interaction.member?.roles;
    const hasRole = id => Array.isArray(roles) ? roles.includes(id) : roles?.cache?.has(id);
    if (!settings.leaderRoleIds.some(hasRole)) {
      throw new Error('Only members of the configured leadership roles can approve time-off requests.');
    }
    return;
  }
  const admin = action === 'breaks' || interaction.customId?.startsWith('breaks:') || action === 'setup' || interaction.customId?.startsWith('setup:')
    || interaction.customId?.startsWith('admin:')
    || interaction.customId?.startsWith('admin-submit:')
    || interaction.customId?.startsWith('timeoff-review:')
    || action === 'donation-admin';
  if (admin && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    throw new Error('Only server administrators can manage clan settings, donation breaks and days off.');
  }
  if ((action === 'donations' || interaction.customId?.startsWith('report-page:'))
      && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    throw new Error('You need Manage Server permission to view donation reports.');
  }
}
