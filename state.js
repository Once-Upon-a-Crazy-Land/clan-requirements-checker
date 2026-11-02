import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validDay } from './tracking.js';
import { breakForDay } from './break-state.js';
import { getSettings, defaultSettings, requestRoleIds, isFormerMember, isClanLeader } from './configuration.js';
import { coverageOnDay } from './donation-coverage.js';

export const PATIENT_ROLE_ID = '1532826238572298451';
export const TIMEOFF_ROLE_IDS = [
  PATIENT_ROLE_ID,
  '1532826140086112256',
  '1532826772624769316',
  '1532826889499185302',
];
export const TAG = '[No Donation Proof]';
export const VACATION_TAG = '[Vacation]';
export const shiftDay = (day, offset) => new Date(Date.parse(`${day}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
export const isExcused = (state, userId, day) => Object.values(state.grants)
  .some(g => g.userId === userId && !g.revokedAt && g.start <= day && day <= g.end);
export const canRequestTimeoff = (member, settings = defaultSettings()) => !member.user.bot && !isFormerMember(member, settings)
  && requestRoleIds(settings).some(roleId => member.roles.cache.has(roleId));

export function dateRange(start, days) {
  if (!validDay(start) || !Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error('Use a valid start date and 1–365 whole days.');
  }
  const end = shiftDay(start, days - 1);
  if (!validDay(end) || start < '2015-01-01') throw new Error('Choose a date range between 2015 and 9999.');
  return { start, end, days };
}

export function taggedName(base, tag = TAG) {
  const clean = base.replace(/\s*\[(?:No Donation Proof|Vacation)\]/g, '').trim() || 'Member';
  // Discord limits nicknames to 32 characters. Save the full original separately.
  let prefix = '';
  for (const character of clean) {
    if ((prefix + character).length > 32 - tag.length - 1) break;
    prefix += character;
  }
  return `${prefix.trimEnd()} ${tag}`;
}

export function classify(members, submissions, state, day) {
  const settings = getSettings(state);
  const roster = [...members.values()].filter(m => !m.user.bot && m.roles.cache.has(settings.memberRoleId) && !isFormerMember(m, settings) && !isClanLeader(m, settings));
  const pause = breakForDay(state, day);
  const excused = roster.filter(m => pause || isExcused(state, m.id, day));
  const required = roster.filter(m => !pause && !isExcused(state, m.id, day));
  const useCoverage = state.donationCoverage && day >= state.donationCoverage.startDay;
  const coverage = useCoverage ? coverageOnDay(state, day) : new Map();
  const paid = member => useCoverage ? coverage.get(member.id)?.covered : submissions.has(member.id);
  return { roster, excused, pause, coverage, useCoverage, submitted: required.filter(paid),
    missing: required.filter(m => !paid(m)) };
}

export class Store {
  constructor(path, today, guildId, timezone) {
    this.path = path;
    try {
      this.data = JSON.parse(readFileSync(path, 'utf8'));
      if (this.data.version !== 1 || this.data.guildId !== guildId || this.data.timezone !== timezone
          || !validDay(this.data.lastClosedDay)
          || !['requests', 'grants', 'nicknames', 'jobs'].every(k => this.data[k] && typeof this.data[k] === 'object')) {
        throw new Error('State is incompatible with this server/timezone. Restore a valid backup or migrate it before starting.');
      }
      if (!this.data.missingStreaks || typeof this.data.missingStreaks !== 'object') {
        this.data.missingStreaks = {};
        this.save();
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.data = { version: 1, guildId, timezone, lastClosedDay: shiftDay(today, -1),
        requests: {}, grants: {}, nicknames: {}, jobs: {}, missingStreaks: {} };
      this.save();
    }
  }
  save() {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(temp, this.path);
  }
  request(userId, start, days, reason) {
    const pending = Object.values(this.data.requests).filter(r => r.userId === userId && r.status === 'pending');
    if (pending.length >= 5) throw new Error('You already have five pending requests. Ask an admin to review them.');
    const id = randomUUID().slice(0, 8);
    this.data.requests[id] = { id, userId, ...dateRange(start, days), reason: reason.slice(0, 500),
      status: 'pending', createdAt: new Date().toISOString() };
    this.save();
    return this.data.requests[id];
  }
  grant(userId, start, days, adminId, requestId) {
    const range = dateRange(start, days);
    const request = requestId ? this.data.requests[requestId] : null;
    if (requestId && (!request || request.status !== 'pending')) throw new Error('That request is no longer pending.');
    const id = randomUUID().slice(0, 8);
    this.data.grants[id] = { id, userId, ...range, adminId, createdAt: new Date().toISOString() };
    if (request) Object.assign(request, { status: 'approved', adminId, grantId: id });
    this.save();
    return this.data.grants[id];
  }
  reject(id, adminId) {
    const request = this.data.requests[id];
    if (!request || request.status !== 'pending') throw new Error('Pending request not found.');
    Object.assign(request, { status: 'rejected', adminId });
    this.save();
  }
  revoke(id, adminId) {
    const grant = this.data.grants[id];
    if (!grant || grant.revokedAt) throw new Error('Active grant not found.');
    Object.assign(grant, { revokedAt: new Date().toISOString(), revokedBy: adminId });
    this.save();
  }
}
