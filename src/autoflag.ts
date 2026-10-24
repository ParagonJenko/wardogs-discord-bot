import { z } from 'zod';
import type { SteamFlag } from './steam.ts';

// Shadow mode for automatic action on cheating. The bot judges the players in game for unlikely headshots (see
// killfeed.ts) and, for those who would have been acted on automatically, writes down what it would have done and why,
// and does nothing. Staff then say what they found on the Queue (an outcome, see dealt.ts), and the alert review
// (review.ts) says how often the bot was right. Acting for real waits for that: a false ban costs more than a missed one.
//
// The marks come from the review's first 30 days: 2,079 judged player-days, against the 2.1 that luck alone puts below 1
// in 1,000. At 25,000 judged days a year, 1 in 1,000,000 is 0.025 false actions a year if the model is right, so it has
// room to be wrong by a factor of 40.

export const AUTO_SHADOW_KEY = 'autoShadow';
export const OUTCOMES_KEY = 'outcomes';
export const SHADOW_DAYS = 60;
// Small enough to keep as one value: the oldest go first.
const MAX_SHADOW = 300;
const MAX_OUTCOMES = 1_000;
const DAY_MS = 24 * 60 * 60_000;

export const AUTO_RULES = {
  // Kills a day needs for the stronger marks: a handful of kills can be luck however it looks.
  minKills: 25,
  // Tier 1 (would kick and ban for a day or so): a day this unlikely by luck, 1 in `strong`, or 1 in `withBan` when the
  // account has a VAC or game ban in the last year.
  strong: 100_000,
  withBan: 10_000,
  // Tier 2 (would ban for a week): a day 1 in `extreme` by luck, or `repeat.flagged` flagged days (see HEADSHOT_FLAG)
  // within `repeat.days`. Two days each below 1 in 1,000 is 1 in 1,000,000 by luck.
  extreme: 1_000_000,
  repeat: { days: 14, flagged: 2 },
} as const;

export type Tier = 1 | 2;
export type AutoRule = 'strong-day' | 'ban-and-headshots' | 'extreme-day' | 'repeat-days';

// One of a player's days with kills, as headshotsOn judges it.
export type DayEvidence = { day: string; kills: number; headshots: number; chance: number | null; flagged: boolean };

export type AutoDecision = { tier: Tier; rule: AutoRule; flaggedDays: number };

const odds = (d: DayEvidence, below: number): boolean => d.chance !== null && d.chance * below < 1;

// What the bot would do about a player whose day is `today`, with their other days in the last AUTO_RULES.repeat.days (
// `earlier`, today's not among them), and their Steam account's flags. Null when nothing: `today` must itself be flagged.
export const decide = (today: DayEvidence, earlier: DayEvidence[], steam: readonly SteamFlag[]): AutoDecision | null => {
  if (!today.flagged || today.chance === null) return null;
  const days = new Set([today.day, ...earlier.filter((d) => d.flagged && d.day !== today.day).map((d) => d.day)]);
  const flaggedDays = days.size;
  const enough = today.kills >= AUTO_RULES.minKills;
  if (enough && odds(today, AUTO_RULES.extreme)) return { tier: 2, rule: 'extreme-day', flaggedDays };
  if (flaggedDays >= AUTO_RULES.repeat.flagged) return { tier: 2, rule: 'repeat-days', flaggedDays };
  if (enough && odds(today, AUTO_RULES.strong)) return { tier: 1, rule: 'strong-day', flaggedDays };
  const banned = steam.includes('recentBan') && (steam.includes('vacBan') || steam.includes('gameBan'));
  if (banned && odds(today, AUTO_RULES.withBan)) return { tier: 1, rule: 'ban-and-headshots', flaggedDays };
  return null;
};

// What the shadow log keeps for each: enough to judge it by, and to find the player.
export type ShadowEntry = {
  steamId: string;
  name: string;
  day: string;
  at: number;
  tier: Tier;
  rule: AutoRule;
  kills: number;
  headshots: number;
  chance: number;
  flaggedDays: number;
};

const RULES = ['strong-day', 'ban-and-headshots', 'extreme-day', 'repeat-days'] as const;
const ShadowSchema = z.array(
  z.object({
    steamId: z.string(),
    name: z.string(),
    day: z.string(),
    at: z.number(),
    tier: z.union([z.literal(1), z.literal(2)]),
    rule: z.enum(RULES),
    kills: z.number(),
    headshots: z.number(),
    chance: z.number(),
    flaggedDays: z.number(),
  }),
);

export const parseShadow = (raw: unknown): ShadowEntry[] => {
  const parsed = ShadowSchema.safeParse(raw);
  return parsed.success ? parsed.data : [];
};

// The log with `entry` added, unless the player already has one for the day at that tier or higher. The last
// SHADOW_DAYS days, the newest MAX_SHADOW. Null when nothing changed.
export const recordShadow = (log: ShadowEntry[], entry: ShadowEntry): ShadowEntry[] | null => {
  if (log.some((e) => e.steamId === entry.steamId && e.day === entry.day && e.tier >= entry.tier)) return null;
  const oldest = entry.at - SHADOW_DAYS * DAY_MS;
  return [...log.filter((e) => e.at >= oldest), entry].slice(-MAX_SHADOW);
};

// What staff found when they dealt with a player on the Queue.
export const OUTCOMES = ['cheating', 'false-alarm', 'griefing', 'other'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export type OutcomeEntry = { steamId: string; at: number; by: string; outcome: Outcome; headshotDay: string | null };

const OutcomesSchema = z.array(
  z.object({ steamId: z.string(), at: z.number(), by: z.string(), outcome: z.enum(OUTCOMES), headshotDay: z.string().nullable() }),
);

export const parseOutcomes = (raw: unknown): OutcomeEntry[] => {
  const parsed = OutcomesSchema.safeParse(raw);
  return parsed.success ? parsed.data : [];
};

// Kept for good: these are the labels the marks are judged by, and a later model would learn from. The newest MAX_OUTCOMES.
export const addOutcome = (log: OutcomeEntry[], entry: OutcomeEntry): OutcomeEntry[] => [...log, entry].slice(-MAX_OUTCOMES);

const tally = (values: string[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const v of values) counts[v] = (counts[v] ?? 0) + 1;
  return counts;
};

// For the alert review, over the last `days`: what the bot would have done by tier and rule, how many players, and for
// each such player the latest outcome staff gave from that day on: cheating, a false alarm, something else, or none yet.
// `precision` is cheating over cheating and false alarms, null until there is one.
export const summariseShadow = (shadow: ShadowEntry[], outcomes: OutcomeEntry[], now: number, days: number) => {
  const from = now - days * DAY_MS;
  const recent = shadow.filter((e) => e.at >= from);
  const first = new Map<string, number>();
  for (const e of recent) first.set(e.steamId, Math.min(first.get(e.steamId) ?? e.at, e.at));
  const judged = { cheating: 0, falseAlarm: 0, other: 0, pending: 0 };
  for (const [steamId, since] of first) {
    const latest = outcomes.filter((o) => o.steamId === steamId && o.at >= since).sort((a, b) => b.at - a.at)[0];
    if (latest === undefined) judged.pending++;
    else if (latest.outcome === 'cheating') judged.cheating++;
    else if (latest.outcome === 'false-alarm') judged.falseAlarm++;
    else judged.other++;
  }
  const decided = judged.cheating + judged.falseAlarm;
  return {
    marks: AUTO_RULES,
    entries: recent.length,
    players: first.size,
    byTier: tally(recent.map((e) => String(e.tier))),
    byRule: tally(recent.map((e) => e.rule)),
    judged,
    precision: decided === 0 ? null : Math.round((judged.cheating / decided) * 1000) / 1000,
    outcomes: tally(outcomes.filter((o) => o.at >= from).map((o) => o.outcome)),
  };
};
