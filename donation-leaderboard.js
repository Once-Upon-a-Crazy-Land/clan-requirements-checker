import { createHash } from 'node:crypto';
import { brandedMessage } from './messages.js';
import { dayAt } from './tracking.js';
import { getSettings } from './configuration.js';

export function nextMonth(month) {
  const [year, value] = month.split('-').map(Number);
  return value === 12 ? `${year + 1}-01` : `${year}-${String(value + 1).padStart(2, '0')}`;
}

export function monthlyDonations(data, month, timezone) {
  const totals = new Map();
  for (const proof of Object.values(data.donations?.proofs || {})) {
    if (proof.status !== 'approved') continue;
    // Discord message IDs provide the original submission date even for old proofs scanned later.
    const timestamp = proof.submittedAt ?? (/^\d{17,20}$/.test(proof.id)
      ? Number((BigInt(proof.id) >> 22n) + 1420070400000n) : Date.parse(proof.createdAt));
    if (!Number.isFinite(timestamp) || dayAt(timestamp, timezone).slice(0, 7) !== month) continue;
    for (const credit of proof.credits) totals.set(credit.userId, (totals.get(credit.userId) || 0) + credit.amount);
  }
  return [...totals].map(([userId, amount]) => ({ userId, amount }))
    .sort((a, b) => b.amount - a.amount || a.userId.localeCompare(b.userId));
}

const marker = month => `Monthly donation leaderboard · ${month}`;
export function leaderboardMessage(job, timezone) {
  const label = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${job.month}-01T12:00:00Z`));
  const rows = job.rows.slice(0, 25).map((row, index) => `**${index + 1}.** <@${row.userId}> — **${row.amount.toLocaleString('en-US')} Gems**`);
  return brandedMessage('Crazyland clan monthly donation leaderboard.',
    `**${label}**\n\n${rows.join('\n') || 'No verified donations for this month.'}\n\n`
    + `**Total: ${job.rows.reduce((sum, row) => sum + row.amount, 0).toLocaleString('en-US')} Gems** · ${job.rows.length} donors\n`
    + `Top 25 · Verified donations by screenshot submission month (${timezone}).`, { content: marker(job.month) });
}

async function findPublished(channel, job, botId) {
  let before;
  for (let page = 0; page < 100; page++) {
    const batch = await channel.messages.fetch({ limit: 100, before, cache: false });
    for (const message of batch.values()) {
      if (message.author.id === botId && message.content === marker(job.month)) return message.id;
    }
    if (batch.size < 100 || Math.min(...[...batch.values()].map(m => m.createdTimestamp)) < job.createdAt) return null;
    before = [...batch.keys()].reduce((a, b) => BigInt(a) < BigInt(b) ? a : b);
  }
  throw new Error('Cannot safely check monthly leaderboard history; no duplicate was sent.');
}

export class MonthlyLeaderboard {
  constructor({ guild, store, timezone, botId, now = () => Date.now() }) {
    Object.assign(this, { guild, store, timezone, botId, now });
  }
  save(action) {
    const previous = structuredClone(this.store.data.monthlyLeaderboard);
    try { action(); this.store.save(); }
    catch (error) {
      if (previous === undefined) delete this.store.data.monthlyLeaderboard;
      else this.store.data.monthlyLeaderboard = previous;
      throw error;
    }
  }
  async tick() {
    const channelId = getSettings(this.store.data).leaderboardChannelId;
    if (!channelId) return;
    const current = dayAt(this.now(), this.timezone).slice(0, 7);
    if (!this.store.data.monthlyLeaderboard) {
      this.save(() => { this.store.data.monthlyLeaderboard = { nextMonth: current, jobs: {} }; });
      return; // Begin with the month enabled, never publish old months on first setup.
    }
    const state = this.store.data.monthlyLeaderboard;
    const month = state.nextMonth;
    if (month >= current) return;
    if (!state.jobs[month]) this.save(() => {
      state.jobs[month] = { month, channelId, rows: monthlyDonations(this.store.data, month, this.timezone), createdAt: this.now() };
    });
    const job = state.jobs[month];
    if (!job.messageId) {
      // A retry stays in its original channel even if Setup changed mid-send.
      const channel = await this.guild.channels.fetch(job.channelId);
      const found = await findPublished(channel, job, this.botId);
      if (found) this.save(() => { job.messageId = found; });
      else {
        const nonce = createHash('sha256').update(`${this.guild.id}:${month}:donation-leaderboard`).digest('hex').slice(0, 24);
        const message = await channel.send({ ...leaderboardMessage(job, this.timezone), nonce, enforceNonce: true });
        this.save(() => { job.messageId = message.id; });
      }
    }
    this.save(() => { state.nextMonth = nextMonth(month); });
  }
}
