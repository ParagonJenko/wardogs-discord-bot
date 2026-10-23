import { z } from 'zod';
import type { StreakBreak, StreakStart } from './live.ts';

// Streak breaker VIP (BOUNTY_STREAK): a kill that ends a long kill streak earns the killer a whitelist slot for the next
// calendar day(s). A win is kept here, by the kill's event ID, from the moment the feed batch is counted until the slot
// is written to the whitelist, so a server that cannot be reached at that moment does not cost anyone their reward.

const DAY_MS = 24 * 60 * 60_000;

export const BOUNTY_KEY = 'bountyPending';

export type BountyWin = StreakBreak & { wonAt: number };
export type BountyPending = Record<string, BountyWin>;

const BountyPendingSchema = z.record(
  z.string(),
  z.object({ eventId: z.string(), steamId: z.string(), name: z.string(), victim: z.string(), streak: z.number(), wonAt: z.number() }),
);

export const parseBountyPending = (raw: unknown): BountyPending => {
  const parsed = BountyPendingSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
};

export const addBounties = (pending: BountyPending, found: StreakBreak[], now: number): BountyPending => ({
  ...pending,
  ...Object.fromEntries(found.map((b) => [b.eventId, { ...b, wonAt: now }])),
});

// When the slot ends: the end of the last of the next `days` calendar days (UTC) after the win, however late it was won.
export const bountyEnds = (wonAt: number, days: number): number => (Math.floor(wonAt / DAY_MS) + 1 + days) * DAY_MS;

export type BountyPlan = {
  // One per player: their latest win still worth paying, and the events it stands for (all their wins).
  pay: { win: BountyWin; until: number; events: string[] }[];
  // Wins whose time is up, or all of them when the reward is off: dropped without paying.
  drop: string[];
};

export const planBounties = (pending: BountyPending, rule: { days: number } | null, now: number): BountyPlan => {
  const byPlayer = new Map<string, BountyWin[]>();
  const drop: string[] = [];
  for (const win of Object.values(pending)) {
    if (rule === null || bountyEnds(win.wonAt, rule.days) <= now) drop.push(win.eventId);
    else byPlayer.set(win.steamId, [...(byPlayer.get(win.steamId) ?? []), win]);
  }
  const pay = [...byPlayer.values()].map((wins) => {
    const latest = wins.reduce((a, b) => (b.wonAt >= a.wonAt ? b : a));
    return { win: latest, until: bountyEnds(latest.wonAt, rule?.days ?? 0), events: wins.map((w) => w.eventId) };
  });
  return { pay, drop };
};

// What the whole server is told in game. A player's name is cleaned of line breaks and cut short, as it is typed by the player.
const shown = (name: string): string => {
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() || 'Someone';
  return clean.length > 32 ? `${clean.slice(0, 31)}…` : clean;
};

const reward = (days: number): string => (days === 1 ? 'VIP for tomorrow' : `VIP for the next ${days} days`);

// A player has reached the streak: everyone is told, so they can hunt them.
export const bountyOnText = (start: StreakStart, days: number): string =>
  `BOUNTY: ${shown(start.name)} is on a ${start.streak} kill streak! Kill them to win ${reward(days)}.`;

// The streak was ended: who did it, and whose it was.
export const bountyEndedText = (win: StreakBreak, days: number): string =>
  `${shown(win.name)} ended ${shown(win.victim)}'s ${win.streak} kill streak and wins ${reward(days)}!`;
