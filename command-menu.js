import { SlashCommandBuilder } from 'discord.js';

export const CLAN_TIMEOFF_MODAL = 'clan:timeoff-submit';
export const LEGACY_COMMANDS = ['donations', 'timeoff', 'timeoff-status', 'donation-admin'];
export const ACTIONS = [
  { name: 'Donation report', value: 'donations' },
  { name: 'Request time off', value: 'timeoff' },
  { name: 'My time off', value: 'timeoff-status' },
  { name: 'Admin panel', value: 'donation-admin' },
  { name: 'Setup', value: 'setup' },
  { name: 'Donation breaks', value: 'breaks' },
];
export const DONATION_ACTIONS = [
  { name: 'Link member', value: 'donation-link' },
  { name: 'Donation total', value: 'donation-total' },
  { name: 'Scan proof', value: 'donation-scan' },
  { name: 'Void donation proof', value: 'donation-void' },
  { name: 'Verify proof', value: 'donation-verify' },
];
export const commands = [new SlashCommandBuilder()
  .setName('clan').setDescription('Donation reports and member time off')
  .addStringOption(o => o.setName('action').setDescription('Choose a clan action')
    .setRequired(true).addChoices(...ACTIONS))
  .addStringOption(o => o.setName('date').setDescription('Donation report date; leave empty for today')),
  new SlashCommandBuilder()
  .setName('donation').setDescription('Link game names, scan proofs and manage verified donation totals')
  .addStringOption(o => o.setName('action').setDescription('Choose a donation action')
    .setRequired(true).addChoices(...DONATION_ACTIONS))
  .addUserOption(o => o.setName('member').setDescription('Member to link or view; totals default to yourself'))
  .addStringOption(o => o.setName('game-name').setDescription('Exact in-game name to link').setMaxLength(80))
  .addStringOption(o => o.setName('proof-id').setDescription('Original screenshot message ID to scan, verify or void'))
  .addBooleanOption(o => o.setName('repeat-confirmed').setDescription('Verify proof only: I checked that a matching line is a separate donation')),
  new SlashCommandBuilder().setName('me').setDescription('Privately view your clan donation and time-off information')];

export function commandAction(interaction) {
  if (!['clan', 'donation'].includes(interaction.commandName)) return interaction.commandName;
  const action = interaction.options.getString('action', true);
  const choices = interaction.commandName === 'donation' ? DONATION_ACTIONS : ACTIONS;
  if (!choices.some(choice => choice.value === action)) throw new Error(`Choose a valid ${interaction.commandName} action.`);
  return action;
}

export async function registerCommands(guild) {
  // Register the replacement before removing old entries. Keep unrelated commands.
  for (const command of commands) await guild.commands.create(command.toJSON());
  const registered = await guild.commands.fetch();
  for (const command of registered.values()) {
    if (LEGACY_COMMANDS.includes(command.name)) await guild.commands.delete(command.id);
  }
}
