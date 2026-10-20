import { z } from 'zod';
import { ordinal } from './messages.ts';
import { totals, type MatchRecord, type PlayerDay, type RankedPlayer } from './players.ts';
import { byKills } from './tracking.ts';

// What a player did that the end of a match tells them of, beyond the scoreboard and the awards (see matchend.ts): a
// milestone (their 100th match, 1,000th kill or 100 hours on the server), a personal best (the most kills they have had in a
// match lately), and how close they are to the leaderboard's top 10 for kills. Worked out by the Cloudflare version, which
// keeps the records.

// ---- Milestones ----

export type MilestoneKind = 'matches' | 'kills' | 'hours';
export type Milestone = { kind: MilestoneKind; value: number };

export const LADDERS: Record<MilestoneKind, number[]> = {
  matches: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  kills: [100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000],
  hours: [10, 25, 50, 100, 250, 500, 1000, 2500],
};

// When a match takes a player past more than one kind at once, the first of these is the one they are told of; the others
// wait for a later match.
const KINDS: MilestoneKind[] = ['matches', 'kills', 'hours'];

export type Lifetime = { matches: number; kills: number; minutes: number };

// One player's lifetime: their totals over every day before LIFETIME_THROUGH_KEY's, and the highest milestone of each kind
// they were told of (or had passed before the bot kept these).
export type LifetimeEntry = Lifetime & { told: Partial<Record<MilestoneKind, number>> };
export type LifetimeShard = Record<string, LifetimeEntry>;

// Everyone's lifetime is kept in this many values, by the last two digits of their Steam ID, so none comes near the 128 KiB
// a stored value can be (about 1,500 players each), and the end of a match reads only the ones its players are in.
export const LIFETIME_SHARDS = 32;
export const lifetimeKey = (shard: number): string => `lifetime:${shard}`;
export const shardOf = (steamId: string): number => {
  const digits = Number(steamId.slice(-2));
  return Number.isInteger(digits) && digits >= 0 ? digits % LIFETIME_SHARDS : 0;
};
// The first UTC day ("2026-10-20") whose totals are not in the shards yet. Missing until the first fold.
export const LIFETIME_THROUGH_KEY = 'lifetimeThrough';

const TOLD = z.number().int().nonnegative().optional();
const ShardSchema = z.record(
  z.string(),
  z.object({
    matches: z.number(),
    kills: z.number(),
    minutes: z.number(),
    told: z.object({ matches: TOLD, kills: TOLD, hours: TOLD }).default({}),
  }),
);

export const parseShard = (raw: unknown): LifetimeShard => {
  const parsed = ShardSchema.safeParse(raw);
  if (!parsed.success) return {};
  // Without the told kinds that were never set, as the type says.
  return Object.fromEntries(
    Object.entries(parsed.data).map(([steamId, e]) => [
      steamId,
      { ...e, told: Object.fromEntries(Object.entries(e.told).filter(([, v]) => v !== undefined)) as LifetimeEntry['told'] },
    ]),
  );
};

const valueOf = (t: Lifetime, kind: MilestoneKind): number => (kind === 'hours' ? Math.floor(t.minutes / 60) : t[kind]);

// The highest step of a kind the totals have reached, or 0 for none.
export const reached = (t: Lifetime, kind: MilestoneKind): number => LADDERS[kind].findLast((step) => valueOf(t, kind) >= step) ?? 0;

const reachedAll = (t: Lifetime): LifetimeEntry['told'] =>
  Object.fromEntries(KINDS.flatMap((kind) => (reached(t, kind) > 0 ? [[kind, reached(t, kind)]] : [])));

const sumDays = (shards: LifetimeShard[], days: PlayerDay[]): LifetimeShard[] => {
  const next = shards.map((s) => ({ ...s }));
  for (const p of totals(days)) {
    const shard = next[shardOf(p.steamId)] ?? {};
    const known = shard[p.steamId] ?? { matches: 0, kills: 0, minutes: 0, told: {} };
    shard[p.steamId] = {
      matches: known.matches + p.matches,
      kills: known.kills + p.kills,
      minutes: known.minutes + p.seedingMinutes + p.liveMinutes,
      told: known.told,
    };
    next[shardOf(p.steamId)] = shard;
  }
  return next;
};

// Adds closed days to the shards. On the first fold (`first`), milestones already passed count as told, so nobody is told
// of a milestone they passed before the bot kept these, counting what they did earlier today (`today`, which is not added).
export const foldDays = (shards: LifetimeShard[], days: PlayerDay[], first: boolean, today: PlayerDay[] = []): LifetimeShard[] => {
  const next = sumDays(shards, days);
  if (!first) return next;
  const withToday = sumDays(next, today);
  return withToday.map((shard, i) =>
    Object.fromEntries(
      Object.entries(shard).map(([steamId, e]) => [
        steamId,
        { ...(next[i]?.[steamId] ?? { matches: 0, kills: 0, minutes: 0 }), told: reachedAll(e) },
      ]),
    ),
  );
};

// The shards after a match was taken off the records (see removeMatch), when its day was already added to them. What the
// players were told of stays.
export const unfoldMatch = (shards: Map<number, LifetimeShard>, players: { steamId: string; kills: number }[]): Map<number, LifetimeShard> => {
  const next = new Map(shards);
  for (const p of players) {
    const shard = { ...(next.get(shardOf(p.steamId)) ?? {}) };
    const known = shard[p.steamId];
    if (known === undefined) continue;
    shard[p.steamId] = { ...known, matches: Math.max(0, known.matches - 1), kills: Math.max(0, known.kills - p.kills) };
    next.set(shardOf(p.steamId), shard);
  }
  return next;
};

// The milestone a player's totals have passed that they have not been told of: the highest step of the first kind with one.
export const dueMilestone = (t: Lifetime, told: LifetimeEntry['told']): Milestone | null => {
  for (const kind of KINDS) {
    const step = reached(t, kind);
    if (step > (told[kind] ?? 0)) return { kind, value: step };
  }
  return null;
};

// The shards after these players were told of these milestones.
export const markTold = (shards: Map<number, LifetimeShard>, told: ReadonlyMap<string, Milestone>): Map<number, LifetimeShard> => {
  const next = new Map(shards);
  for (const [steamId, m] of told) {
    const shard = { ...(next.get(shardOf(steamId)) ?? {}) };
    const known = shard[steamId] ?? { matches: 0, kills: 0, minutes: 0, told: {} };
    shard[steamId] = { ...known, told: { ...known.told, [m.kind]: Math.max(known.told[m.kind] ?? 0, m.value) } };
    next.set(shardOf(steamId), shard);
  }
  return next;
};

// 1234567 as "1,234,567".
export const thousands = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// A milestone as {milestone} says it: "your 100th match", "your 1,000th kill", "100 hours played".
export const milestoneText = (m: Milestone): string => {
  if (m.kind === 'hours') return `${thousands(m.value)} hours played`;
  const nth = ordinal(m.value).replace(String(m.value), thousands(m.value));
  return `your ${nth} ${m.kind === 'matches' ? 'match' : 'kill'}`;
};

// {milestone} at its longest, for the Lines tab.
export const LONGEST_MILESTONE = [...KINDS.flatMap((kind) => LADDERS[kind].map((value) => milestoneText({ kind, value })))].sort(
  (a, b) => b.length - a.length,
)[0] as string;

// ---- Personal bests ----

// A personal best needs at least this many kills, and this many matches before it in the records, so a new player's
// second match is not a personal best.
export const BEST_LEAST_KILLS = 10;
export const BEST_LEAST_MATCHES = 5;

// Each player's most kills in a match in `records`, by Steam ID, for those with BEST_LEAST_MATCHES or more of them. The
// match ending now (by when it started) is left out, as it may be recorded already.
export const personalBests = (records: MatchRecord[], ending: number): Map<string, number> => {
  const seen = new Map<string, { best: number; matches: number }>();
  for (const record of records) {
    if (record.startedAt === ending) continue;
    for (const p of record.players) {
      const known = seen.get(p.steamId) ?? { best: 0, matches: 0 };
      seen.set(p.steamId, { best: Math.max(known.best, p.kills), matches: known.matches + 1 });
    }
  }
  return new Map([...seen].flatMap(([steamId, s]) => (s.matches >= BEST_LEAST_MATCHES ? [[steamId, s.best] as const] : [])));
};

// Whether these kills beat a player's best (`best`, undefined without one).
export const isPersonalBest = (kills: number, best: number | undefined): boolean => best !== undefined && kills >= BEST_LEAST_KILLS && kills > best;

// ---- Nearly on the leaderboard ----

// The leaderboard's top 10, and how many kills short a player can be to be told.
export const BOARD_SIZE = 10;
export const NEARLY_MOST = 25;

// For each player outside the top BOARD_SIZE for kills, how many more kills would take them past the last place in it, by
// Steam ID, when that is NEARLY_MOST or fewer. `players` are everyone's totals over the leaderboard's days.
export const nearlyTopTen = (players: RankedPlayer[]): Map<string, number> => {
  // Everyone, so a player with no kills yet can be told too; the board itself only lists players with a kill.
  const board = [...players].sort(byKills);
  const last = board[BOARD_SIZE - 1];
  if (last === undefined || last.kills === 0) return new Map();
  return new Map(
    board.slice(BOARD_SIZE).flatMap((p) => {
      const short = last.kills - p.kills + 1;
      return short <= NEARLY_MOST ? [[p.steamId, short] as const] : [];
    }),
  );
};
