import { dayAt } from './tracking.js';
import { breakForDay } from './break-state.js';

const shiftDay = day => new Date(Date.parse(`${day}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
const excused = (data, id, day) => breakForDay(data, day) || Object.values(data.grants || {})
  .some(grant => grant.userId === id && !grant.revokedAt && grant.start <= day && day <= grant.end);

export function coverageOnDay(data, day) {
  const result = new Map();
  if (!data.donationCoverage || day < data.donationCoverage.startDay) return result;
  const users = new Map();
  for (const proof of Object.values(data.donations?.proofs || {})) {
    if (proof.status !== 'approved' || !proof.coverage || proof.coverage.startDay > day) continue;
    for (const credit of proof.credits) {
      if (!users.has(credit.userId)) users.set(credit.userId, []);
      users.get(credit.userId).push({ day: proof.coverage.startDay, rate: proof.coverage.dailyGems,
        amount: credit.amount, order: `${proof.approvedAt}:${proof.id}` });
    }
  }
  for (const [userId, events] of users) {
    events.sort((a, b) => a.day.localeCompare(b.day) || a.order.localeCompare(b.order));
    let remainingDays = 0, remainderGems = 0, index = 0, covered = false;
    for (let date = events[0].day; date <= day; date = shiftDay(date)) {
      while (index < events.length && events[index].day === date) {
        const event = events[index++];
        remainderGems += event.amount;
        remainingDays += Math.floor(remainderGems / event.rate);
        remainderGems %= event.rate;
      }
      covered = !excused(data, userId, date) && remainingDays > 0;
      if (covered) remainingDays--;
    }
    result.set(userId, { covered, remainingDays, remainderGems });
  }
  return result;
}

export function initializeCoverage(store, now = Date.now()) {
  if (store.data.donationCoverage) return;
  store.data.donationCoverage = { startDay: dayAt(now, store.data.timezone || 'Europe/Paris') };
  try { store.save(); }
  catch (error) { delete store.data.donationCoverage; throw error; }
}
