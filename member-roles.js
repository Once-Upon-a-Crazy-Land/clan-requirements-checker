import { PermissionFlagsBits } from 'discord.js';
import { fetchMembers } from './members.js';
import { isFormerMember, isClanLeader, hasStaffRole } from './configuration.js';

export { isAsylumStaff } from './configuration.js';
const excludesMemberRole = (member, settings) => isFormerMember(member, settings) || isClanLeader(member, settings) || hasStaffRole(member, settings);

const transitioning = new Set();

export async function reconcileMembershipRoles(previous, member, settings) {
  if (member.user.bot) return;
  const statuses = [settings.memberRoleId, settings.formerMemberRoleId, settings.visitorRoleId].filter(Boolean);
  const added = statuses.filter(id => member.roles.cache.has(id) && !previous.roles.cache.has(id));
  const staff = hasStaffRole(member, settings);
  if (!staff && !added.length) return;
  // The newly assigned status wins. Removal events never advance membership.
  const selected = added.at(-1);
  const conflicts = statuses.filter(id => (staff || id !== selected) && member.roles.cache.has(id));
  if (!conflicts.length) return;
  const key = member.guild.id + ':' + member.id;
  transitioning.add(key);
  try {
    for (const id of conflicts) {
      const role = await member.guild.roles.fetch(id);
      if (!role || role.managed || !role.editable || role.id === member.guild.id) {
        throw new Error('Place the bot role above all three membership roles.');
      }
    }
    for (const id of conflicts) member = await member.roles.remove(id, staff
      ? 'Staff role takes precedence over membership roles'
      : 'Newly assigned membership role replaces other membership roles');
  } finally { transitioning.delete(key); }
}

export async function assignMemberRoles(guild, settings) {
  const members = await fetchMembers(guild);
  const errors = [];
  for (const member of members.values()) {
    if (member.user.bot || !hasStaffRole(member, settings)) continue;
    const conflicts = [settings.memberRoleId, settings.formerMemberRoleId, settings.visitorRoleId]
      .filter(id => id && member.roles.cache.has(id));
    let updated = member;
    try {
      for (const id of conflicts) {
        const role = await guild.roles.fetch(id);
        if (!role || role.managed || !role.editable || role.id === guild.id) {
          throw new Error('Place the bot role above all three membership roles.');
        }
      }
      for (const id of conflicts) {
        updated = await updated.roles.remove(id, 'Staff role takes precedence over membership roles');
        members.set(member.id, updated);
      }
    } catch (error) { errors.push(`Cannot remove membership roles from staff ${member.id}: ${error.message}`); }
  }
  const candidates = [...members.values()].filter(member => !member.user.bot
    && !transitioning.has(guild.id + ':' + member.id)
    && excludesMemberRole(member, settings) === member.roles.cache.has(settings.memberRoleId));
  if (!candidates.length) return { members, errors };
  let role;
  try {
    const me = await guild.members.fetchMe();
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error('Bot needs Manage Roles to automatically manage the member role.');
    role = await guild.roles.fetch(settings.memberRoleId);
    if (!role || role.managed || role.id === guild.id || !role.editable) {
      throw new Error('Place the bot role above the configured member role and choose a normal, assignable role in Setup.');
    }

  } catch (error) { return { members, errors: [...errors, error.message] }; }
  const privileged = role.permissions.has(PermissionFlagsBits.Administrator) || role.permissions.has(PermissionFlagsBits.ManageRoles);
  if (privileged && candidates.some(member => !excludesMemberRole(member, settings))) errors.push('Choose a regular member role without Administrator or Manage Roles for automatic assignment.');
  for (const member of candidates) {
    if (transitioning.has(guild.id + ':' + member.id)) continue;
    const excluded = excludesMemberRole(member, settings);
    if (!excluded && privileged) continue;
    try {
      // Use the single-role endpoint; preserve all other manually assigned roles.
      const updated = excluded
        ? await member.roles.remove(role.id, 'Leadership, staff or visitor/no-longer-a-member role takes precedence')
        : await member.roles.add(role.id, 'Automatically assign clan member role');
      members.set(member.id, updated);
    } catch (error) { errors.push(`Cannot ${excluded ? 'remove' : 'assign'} member role ${excluded ? 'from' : 'to'} ${member.id}: ${error.message}`); }
  }
  return { members, errors };
}
