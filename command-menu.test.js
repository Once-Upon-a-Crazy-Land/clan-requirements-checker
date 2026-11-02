import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { commands, commandAction, registerCommands, CLAN_TIMEOFF_MODAL } from './command-menu.js';
import { checkAccess } from './access.js';
import { vacationModal, VACATION_MODAL } from './vacation-panel.js';

const interaction = action => ({ guildId: 'server', commandName: ['donation-link', 'donation-total', 'donation-scan', 'donation-void', 'donation-verify'].includes(action) ? 'donation' : 'clan', options: {
  getString: (name, required) => { assert.equal(name, 'action'); assert.equal(required, true); return action; },
} });

test('clan and donation commands expose separate actions and relevant options', () => {
  assert.equal(commands.length, 2);
  const command = commands[0].toJSON();
  assert.equal(command.name, 'clan');
  assert.equal(command.default_member_permissions, undefined);
  assert.equal(command.options[0].name, 'action');
  assert.equal(command.options[0].required, true);
  assert.deepEqual(command.options[0].choices.map(c => c.name), ['Donation report', 'Request time off', 'My time off', 'Admin panel', 'Setup', 'Donation breaks']);
  assert.deepEqual(command.options.map(o => o.name), ['action', 'date']);
  const donation = commands[1].toJSON();
  assert.equal(donation.name, 'donation');
  assert.deepEqual(donation.options[0].choices.map(c => c.name), ['Link member', 'Donation total', 'Scan proof', 'Void donation proof', 'Verify proof']);
  assert.deepEqual(donation.options.map(o => o.name), ['action', 'member', 'game-name', 'proof-id', 'repeat-confirmed']);
  for (const choice of donation.options[0].choices) assert.equal(commandAction(interaction(choice.value)), choice.value);
  assert.throws(() => commandAction({ ...interaction('donation-scan'), commandName: 'clan' }), /valid clan action/);
  assert.throws(() => commandAction({ ...interaction('timeoff'), commandName: 'donation' }), /valid donation action/);
  assert.equal(command.options[1].name, 'date');
  assert.ok(!command.options[1].required);
  for (const choice of command.options[0].choices) assert.equal(commandAction(interaction(choice.value)), choice.value);
  assert.throws(() => commandAction(interaction('unknown')), /valid clan action/);
});

test('action dropdown enforces report and admin permissions while member actions stay available', () => {
  for (const action of ['timeoff', 'timeoff-status']) assert.doesNotThrow(() => checkAccess(interaction(action), 'server'));
  assert.throws(() => checkAccess(interaction('donations'), 'server'), /Manage Server/);
  assert.doesNotThrow(() => checkAccess({ ...interaction('donations'), memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild) }, 'server'));
  assert.throws(() => checkAccess({ ...interaction('donation-admin'), memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild) }, 'server'), /administrators/);
  assert.doesNotThrow(() => checkAccess({ ...interaction('donation-admin'), memberPermissions: new PermissionsBitField(PermissionFlagsBits.Administrator) }, 'server'));
  assert.throws(() => checkAccess({ ...interaction('timeoff'), guildId: 'other' }, 'server'), /configured server/);
});

test('command request form has its own submission ID and keeps vacation-button form working', () => {
  const command = vacationModal('2026-10-20', CLAN_TIMEOFF_MODAL).toJSON();
  assert.equal(command.custom_id, CLAN_TIMEOFF_MODAL);
  assert.equal(vacationModal('2026-10-20').toJSON().custom_id, VACATION_MODAL);
  assert.deepEqual(command.components.map(row => row.components[0].custom_id), ['start', 'days', 'reason']);
});

test('donation management requires configured leadership even for administrators', () => {
  for (const action of ['donation-link', 'donation-scan', 'donation-verify', 'donation-void']) {
    assert.throws(() => checkAccess({ ...interaction(action), memberPermissions: new PermissionsBitField(PermissionFlagsBits.Administrator) }, 'server'), /Leaders or Co-leaders/);
    assert.doesNotThrow(() => checkAccess({ ...interaction(action), member: { roles: ['1532826140086112256'] } }, 'server'));
  }
  assert.doesNotThrow(() => checkAccess(interaction('donation-total'), 'server'));
});

test('registration replaces legacy commands only after the new command succeeds', async () => {
  const events = [];
  const registered = new Map(['donations', 'timeoff', 'timeoff-status', 'donation-admin', 'clan', 'other'].map(name => [name, { id: name, name }]));
  const guild = { commands: {
    create: async data => events.push(['create', data.name]),
    fetch: async () => registered,
    delete: async id => events.push(['delete', id]),
  } };
  await registerCommands(guild);
  assert.deepEqual(events, [['create', 'clan'], ['create', 'donation'], ['delete', 'donations'], ['delete', 'timeoff'], ['delete', 'timeoff-status'], ['delete', 'donation-admin']]);
  events.length = 0;
  guild.commands.create = async () => { throw new Error('Registration unavailable'); };
  await assert.rejects(registerCommands(guild), /Registration unavailable/);
  assert.deepEqual(events, []);
});
