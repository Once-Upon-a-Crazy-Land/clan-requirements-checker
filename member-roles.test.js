import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits as P, PermissionsBitField } from 'discord.js';
import { assignMemberRoles, reconcileMembershipRoles } from './member-roles.js';
import { defaultSettings } from './configuration.js';
import { Automation } from './automation.js';

function fixture() {
  const config = { ...defaultSettings(), formerMemberRoleId: '88888888888888888' };
  const members = new Map(), assigned = [];
  const role = { id: config.memberRoleId, editable: true, managed: false, permissions: new PermissionsBitField(0n) };
  const make = (id, roles = [], bot = false) => {
    const m = { id, user: { bot }, nickname: null, manageable: true, displayName: id, async setNickname(value) { this.nickname = value; } };
    m.roles = { cache: new Map(roles.map(id => [id, {}])), async add(roleId) {
      assigned.push([id, roleId]);
      const clone = make(id, [...this.cache.keys(), roleId], bot);
      members.set(id, clone);
      return clone;
    } };
    return m;
  };
  const guild = { id: 'guild', members: { list: async () => new Map(members), fetchMe: async () => ({ permissions: new PermissionsBitField(P.ManageRoles) }) },
    roles: { fetch: async () => role } };
  return { config, members, assigned, role, guild, make };
}

test('auto assignment adds only the member role and skips bots, former members and existing members', async () => {
  const f = fixture();
  const outsider = f.make('new', ['77777777777777777']);
  for (const m of [outsider, f.make('existing', [f.config.memberRoleId]), f.make('former', [f.config.formerMemberRoleId]), f.make('bot', [], true)]) f.members.set(m.id, m);
  const result = await assignMemberRoles(f.guild, f.config);
  assert.deepEqual(f.assigned, [['new', f.config.memberRoleId]]);
  assert.deepEqual(result.errors, []);
  assert.ok(result.members.get('new').roles.cache.has(f.config.memberRoleId));
  assert.ok(result.members.get('new').roles.cache.has('77777777777777777'));
  assert.equal(outsider.roles.cache.has(f.config.memberRoleId), false, 'SDK returns a clone; original object remains stale');
  await assignMemberRoles(f.guild, f.config);
  assert.equal(f.assigned.length, 1);
});

test('failed assignments do not stop other users and are returned for the admin panel', async () => {
  const f = fixture(); const denied = f.make('denied'); denied.roles.add = async () => { throw Error('Missing Permissions'); };
  f.members.set('denied', denied); f.members.set('ok', f.make('ok'));
  const result = await assignMemberRoles(f.guild, f.config);
  assert.deepEqual(f.assigned, [['ok', f.config.memberRoleId]]);
  assert.match(result.errors[0], /denied: Missing Permissions/);
});

test('missing Manage Roles, role hierarchy and privileged role choices prevent automatic grants', async () => {
  for (const issue of ['permission', 'hierarchy', 'administrator', 'manage-roles']) {
    const f = fixture(); f.members.set('new', f.make('new'));
    if (issue === 'permission') f.guild.members.fetchMe = async () => ({ permissions: new PermissionsBitField(0n) });
    if (issue === 'hierarchy') f.role.editable = false;
    if (issue === 'administrator') f.role.permissions = new PermissionsBitField(P.Administrator);
    if (issue === 'manage-roles') f.role.permissions = new PermissionsBitField(P.ManageRoles);
    const result = await assignMemberRoles(f.guild, f.config);
    assert.equal(result.errors.length, 1); assert.deepEqual(f.assigned, []);
  }
});

test('today tracking immediately uses the SDK member clone after successful assignment', async () => {
  const f = fixture(); f.members.set('new', f.make('new'));
  const store = { data: { settings: f.config, grants: {}, nicknames: {} }, save() {} };
  const automation = new Automation({ guild: f.guild, channel: { messages: { fetch: async () => new Map() } }, store,
    timezone: 'Europe/Paris', now: () => Date.parse('2026-10-21T12:00:00Z'), syncMemberRoles: () => assignMemberRoles(f.guild, f.config) });
  const report = await automation.syncToday();
  assert.deepEqual(report.missing.map(m => m.id), ['new']);
  assert.match(report.members.get('new').nickname, /\[No Donation Proof\]/);
});


test('former role removes conflicting member role, preserves other roles and retries failures', async () => {
  const f = fixture();
  const former = f.make('former', [f.config.memberRoleId, f.config.formerMemberRoleId, 'other']);
  let attempts = 0;
  former.roles.remove = async roleId => {
    attempts++;
    if (attempts === 1) throw Error('Missing Permissions');
    assert.equal(roleId, f.config.memberRoleId);
    return f.make('former', [f.config.formerMemberRoleId, 'other']);
  };
  f.members.set('former', former);
  f.members.set('new', f.make('new'));
  let result = await assignMemberRoles(f.guild, f.config);
  assert.match(result.errors[0], /remove member role from former: Missing Permissions/);
  assert.deepEqual(f.assigned, [['new', f.config.memberRoleId]]);
  result = await assignMemberRoles(f.guild, f.config);
  assert.deepEqual(result.errors, []);
  assert.deepEqual([...result.members.get('former').roles.cache.keys()], [f.config.formerMemberRoleId, 'other']);
  assert.equal(attempts, 2);
});

test('privileged member role can be removed but never automatically granted', async () => {
  const f = fixture(); f.role.permissions = new PermissionsBitField(P.Administrator);
  const former = f.make('former', [f.config.memberRoleId, f.config.formerMemberRoleId]);
  let removed = false;
  former.roles.remove = async () => { removed = true; return f.make('former', [f.config.formerMemberRoleId]); };
  f.members.set('former', former); f.members.set('new', f.make('new'));
  const result = await assignMemberRoles(f.guild, f.config);
  assert.equal(removed, true);
  assert.equal(result.errors.length, 1);
  assert.deepEqual(f.assigned, []);
});


test('Asylum Staff removes member role, blocks reassignments and allows membership after staff removal', async () => {
  const f = fixture();
  const staffId = '99999999999999999';
  const staff = f.make('leader', [f.config.memberRoleId, staffId, 'other']);
  staff.roles.cache.set(staffId, { name: 'Asylum Staff' });
  let removed = 0;
  staff.roles.remove = async roleId => {
    removed++;
    assert.equal(roleId, f.config.memberRoleId);
    const updated = f.make('leader', [staffId, 'other']);
    updated.roles.cache.set(staffId, { name: 'Asylum Staff' });
    f.members.set('leader', updated);
    return updated;
  };
  f.members.set('leader', staff);
  let result = await assignMemberRoles(f.guild, f.config);
  assert.deepEqual(result.errors, []);
  assert.equal(removed, 1);
  assert.deepEqual([...result.members.get('leader').roles.cache.keys()], [staffId, 'other']);
  await assignMemberRoles(f.guild, f.config);
  assert.deepEqual(f.assigned, []);
  f.members.set('leader', f.make('leader', ['other']));
  await assignMemberRoles(f.guild, f.config);
  assert.deepEqual(f.assigned, [['leader', f.config.memberRoleId]]);
});

test('all configured leadership roles remove membership, preserve other roles and block reassignment', async () => {
  for (const leaderRoleId of fixture().config.leaderRoleIds) {
    const f = fixture();
    const leader = f.make('leader', [leaderRoleId, f.config.memberRoleId, 'other']);
    let removals = 0;
    leader.roles.remove = async roleId => {
      assert.equal(roleId, f.config.memberRoleId);
      removals++;
      const updated = f.make('leader', [leaderRoleId, 'other']);
      f.members.set('leader', updated);
      return updated;
    };
    f.members.set('leader', leader);
    const result = await assignMemberRoles(f.guild, f.config);
    assert.deepEqual(result.errors, []);
    assert.deepEqual([...result.members.get('leader').roles.cache.keys()], [leaderRoleId, 'other']);
    await assignMemberRoles(f.guild, f.config);
    assert.equal(removals, 1);
    assert.deepEqual(f.assigned, []);
    f.members.set('leader', f.make('leader', ['other']));
    await assignMemberRoles(f.guild, f.config);
    assert.deepEqual(f.assigned, [['leader', f.config.memberRoleId]]);
  }
});

test('newly assigned membership status replaces either other status and preserves unrelated roles', async () => {
  const { reconcileMembershipRoles } = await import('./member-roles.js');
  const f = fixture();
  f.config.visitorRoleId = '77777777777777777';
  const statuses = [f.config.memberRoleId, f.config.formerMemberRoleId, f.config.visitorRoleId];
  for (const selected of statuses) {
    for (const old of statuses.filter(id => id !== selected)) {
      const previous = f.make('person', [old, 'other']);
      const current = f.make('person', [old, selected, 'other']);
      current.guild = f.guild;
      const removed = [];
      current.roles.remove = async id => { removed.push(id); current.roles.cache.delete(id); return current; };
      f.guild.roles.fetch = async id => ({ ...f.role, id });
      await reconcileMembershipRoles(previous, current, f.config);
      assert.deepEqual(removed, [old]);
      assert.deepEqual([...current.roles.cache.keys()], [selected, 'other']);
      await reconcileMembershipRoles(previous, current, f.config);
      assert.equal(removed.length, 1);
    }
  }
});

test('removal alone does not cycle membership roles', async () => {
  const { reconcileMembershipRoles } = await import('./member-roles.js');
  const f = fixture();
  const current = f.make('person');
  await reconcileMembershipRoles(f.make('person', [f.config.memberRoleId]), current, f.config);
  assert.deepEqual(f.assigned, []);
});

test('Visitor prevents automatic Patient assignment', async () => {
  const f = fixture();
  f.config.visitorRoleId = '77777777777777777';
  f.members.set('visitor', f.make('visitor', [f.config.visitorRoleId]));
  const result = await assignMemberRoles(f.guild, f.config);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(f.assigned, []);
});

test('configured staff removes all membership statuses on updates and periodic sync, preserving rank roles', async () => {
  for (const mode of ['update', 'sync']) {
    const f = fixture();
    f.config.staffRoleId = '66666666666666666';
    f.config.visitorRoleId = '77777777777777777';
    const statuses = [f.config.memberRoleId, f.config.formerMemberRoleId, f.config.visitorRoleId];
    const current = f.make('staff', [...statuses, f.config.staffRoleId, 'elder']);
    current.guild = f.guild;
    const removed = [];
    current.roles.remove = async id => { removed.push(id); current.roles.cache.delete(id); return current; };
    f.guild.roles.fetch = async id => ({ ...f.role, id });
    f.members.set(current.id, current);
    if (mode === 'update') {
      await reconcileMembershipRoles(f.make('staff', statuses), current, f.config);
      // Adding a membership status while staff is already present must also be corrected.
      const previous = f.make('staff', [f.config.staffRoleId, 'elder']);
      current.roles.cache.set(f.config.visitorRoleId, {});
      await reconcileMembershipRoles(previous, current, f.config);
      assert.deepEqual(removed, [...statuses, f.config.visitorRoleId]);
    } else {
      const result = await assignMemberRoles(f.guild, f.config);
      assert.deepEqual(result.errors, []);
      assert.deepEqual(removed, statuses);
    }
    assert.deepEqual([...current.roles.cache.keys()], [f.config.staffRoleId, 'elder']);
    await assignMemberRoles(f.guild, f.config);
    assert.deepEqual(f.assigned, []);
    f.members.set('staff', f.make('staff', ['elder']));
    await assignMemberRoles(f.guild, f.config);
    assert.deepEqual(f.assigned, [['staff', f.config.memberRoleId]]);
  }
});
