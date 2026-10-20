import { z } from 'zod';
import type { Sql } from './killfeed.ts';
import { dayOf } from './stats.ts';

// The staff page's Play time tab: how long players stay on the server each day, and when they leave. Made from the
// sessions table (see joinlog.ts) and the finished matches' start and end times, so it covers SESSION_DAYS_KEPT days.
//
// A leave is placed against the match it happened in:
//   early, mid, late: the first, middle and last third of a live match;
//   end: the last END_BEFORE_MS of a match, and the time after it until the next one starts (up to END_AFTER_MS), when
//        players leave on the scoreboard or the map change;
//   between: any other time with no live match, such as while it was seeding or the server was empty.
// And whether it was in the night's last match or after it. A night is a run of matches with less than NIGHT_GAP_MS
// between one's end and the next's start; its last match is the last full game of the night.
//
// Also here: leaves by map and by how one-sided the match was, how long people stay by when they joined, the seeding
// funnel, short stays by new players, and a week's leaves by hour. Players the staff kicked or banned are left out of
// all of it (REMOVAL_BEFORE_MS, REMOVAL_AFTER_MS), as they did not choose to go.
//
// Only leaves the game or a check noted at the time count for timing: after a gap in the checks (`leftFrom`) it is not
// known when they left. Sessions with no join (on when the log started) have no length. Both still count for the rest.

export const END_BEFORE_MS = 3 * 60_000;
export const END_AFTER_MS = 10 * 60_000;
export const NIGHT_GAP_MS = 2 * 60 * 60_000;
// The matches listed, newest first.
export const MATCHES_LISTED = 20;

export type Timing = 'early' | 'mid' | 'late' | 'end' | 'between';
export const TIMINGS: Timing[] = ['early', 'mid', 'late', 'end', 'between'];

// A kick or ban by staff: leaves just after it are not the player's choice.
export const REMOVAL_BEFORE_MS = 30_000;
export const REMOVAL_AFTER_MS = 3 * 60_000;
// A match that was seeded: it went live at least this long after its first player was seen.
export const SEED_MIN_MS = 2 * 60_000;
// A stay under this is a bounce.
export const BOUNCE_MINUTES = 10;
export const STAYED_MINUTES = 30;
export const SEEDING_LISTED = 10;

export type SessionRow = { steamId: string; joinedAt: number | null; joinedFrom?: number | null; leftAt: number; leftFrom: number | null };
// `scores` are the final scores of the match's sides, when known.
export type MatchTimes = { map: string; startedAt: number; liveAt: number; endedAt: number; scores?: number[] };
// A kick or ban by staff at `at`. For a ban, `until` is when it ends (null for a permanent one): the player can't have chosen
// to be on the server until then, so every leave in between is the ban's (a waiting ban is only put on the server, with a
// kick, when the player next joins, and is not logged then).
export type Removal = { steamId: string; at: number; until?: number | null };
// Someone in game now: when they joined, or null when they were on before the log started.
export type OngoingStay = { steamId: string; since: number | null };

const Row = z.object({
  steam_id: z.string(),
  joined_at: z.number().nullable(),
  joined_from: z.number().nullable(),
  left_at: z.number(),
  left_from: z.number().nullable(),
});

// The times on the server that ended at `from` or later.
export const sessionRows = (sql: Sql, from: number): SessionRow[] =>
  sql
    .exec('SELECT steam_id, joined_at, joined_from, left_at, left_from FROM sessions WHERE left_at >= ?', from)
    .toArray()
    .flatMap((row): SessionRow[] => {
      const parsed = Row.safeParse(row);
      if (!parsed.success) return [];
      const d = parsed.data;
      return [{ steamId: d.steam_id, joinedAt: d.joined_at, joinedFrom: d.joined_from, leftAt: d.left_at, leftFrom: d.left_from }];
    });

export type RetentionDay = { day: string; players: number; sessions: number; averageMinutes: number; medianMinutes: number; minutesPerPlayer: number };
export type LengthBucket = { label: string; sessions: number };
export type LeaveCounts = Record<Timing, number>;
export type RetentionMatch = { map: string; startedAt: number; endedAt: number; lastOfNight: boolean; present: number; leftBefore: number };
// In game when matches on a map (or of a kind) went live, and how many left before their last minutes.
export type MapRetention = { map: string; matches: number; present: number; leftBefore: number };
export type BalanceRetention = { label: string; matches: number; present: number; leftBefore: number };
export type JoinTiming = 'seeding' | Timing;
export const JOIN_TIMINGS: JoinTiming[] = ['seeding', 'early', 'mid', 'late', 'end', 'between'];
export type JoinStay = { timing: JoinTiming; sessions: number; medianMinutes: number; stayedShare: number };
export type SeedingMatch = { map: string; startedAt: number; liveAt: number; seedingMinutes: number; seeders: number; reachedLive: number };
export type Bounce = { sessions: number; short: number };
// The matches and seeding of the period, one entry each, for the long-term records (see lifetime.ts). Not sent to the page.
export type RetentionDetail = {
  matches: (RetentionMatch & { liveAt: number; scores?: number[] })[];
  seeding: SeedingMatch[];
};
export type Retention = {
  days: number;
  sessions: number;
  averageMinutes: number | null;
  medianMinutes: number | null;
  daily: RetentionDay[];
  lengths: LengthBucket[];
  // Leaves that could be placed, by when in a match; `finale` is those in the night's last match or after it.
  leaves: { total: number; timing: LeaveCounts; finale: LeaveCounts };
  matches: RetentionMatch[];
  // Sessions left out because staff kicked or banned the player.
  excluded: number;
  byMap: MapRetention[];
  byBalance: BalanceRetention[];
  joins: JoinStay[];
  seeding: { matches: number; averageMinutes: number | null; seeders: number; reachedLive: number; list: SeedingMatch[] };
  // Stays under BOUNCE_MINUTES, by new players and everyone else; null when who is new is not known.
  bounce: { newPlayers: Bounce; others: Bounce } | null;
  // Leaves and minutes on the server by hour of the week in UTC, Monday 00:00 first (index = weekday * 24 + hour).
  heat: { leaves: number[]; minutes: number[] };
  detail: RetentionDetail;
};

const LENGTHS: [label: string, under: number][] = [
  ['Under 15 minutes', 15],
  ['15 to 30', 30],
  ['30 to 60', 60],
  ['1 to 2 hours', 120],
  ['2 to 3 hours', 180],
  ['3 hours or more', Infinity],
];

const emptyCounts = (): LeaveCounts => ({ early: 0, mid: 0, late: 0, end: 0, between: 0 });

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

const mean = (values: number[]): number => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);

const round = (n: number): number => Math.round(n * 10) / 10;

// Matches in order, each with whether it is the last of its night.
const withNights = (matches: MatchTimes[]): (MatchTimes & { lastOfNight: boolean })[] => {
  const sorted = [...matches].sort((a, b) => a.startedAt - b.startedAt);
  return sorted.map((m, i) => {
    const next = sorted[i + 1];
    return { ...m, lastOfNight: next === undefined || next.startedAt - m.endedAt >= NIGHT_GAP_MS };
  });
};

// When in a match a leave at `at` was, and whether it was in the night's last match or after it.
export const placeLeave = (at: number, matches: (MatchTimes & { lastOfNight: boolean })[]): { timing: Timing; finale: boolean } => {
  // The latest match to have started by then; before the first, it was between matches.
  const i = matches.findLastIndex((m) => m.startedAt <= at);
  const m = matches[i];
  if (m === undefined) return { timing: 'between', finale: false };
  const until = Math.min(m.endedAt + END_AFTER_MS, matches[i + 1]?.startedAt ?? Infinity);
  let timing: Timing = 'between';
  if (at >= m.liveAt && at < until) {
    if (at >= m.endedAt - END_BEFORE_MS) timing = 'end';
    else {
      const through = (at - m.liveAt) / Math.max(1, m.endedAt - m.liveAt);
      timing = through < 1 / 3 ? 'early' : through < 2 / 3 ? 'mid' : 'late';
    }
  }
  // The night's last match: this one, or a later one when this leave was before it.
  const last = matches.slice(i).find((x) => x.lastOfNight) ?? m;
  return { timing, finale: at >= last.liveAt };
};

// When in a match a player joined at `at`: while it was seeding, or as a leave is placed.
export const placeJoin = (at: number, matches: (MatchTimes & { lastOfNight: boolean })[]): JoinTiming =>
  matches.some((m) => m.startedAt <= at && at < m.liveAt) ? 'seeding' : placeLeave(at, matches).timing;

const slot = (at: number): number => {
  const d = new Date(at);
  return ((d.getUTCDay() + 6) % 7) * 24 + d.getUTCHours();
};

// How one-sided a match was, from the winner's lead over the other side as a share of its score.
const balanceOf = (scores: number[] | undefined): string | null => {
  const [top, second] = [...(scores ?? [])].sort((a, b) => b - a);
  if (top === undefined || second === undefined || top <= 0) return null;
  const lead = (top - second) / top;
  return lead < 0.2 ? 'Close (lead under 20%)' : lead < 0.5 ? 'Clear win' : 'One-sided (lead over 50%)';
};
export const BALANCES = ['Close (lead under 20%)', 'Clear win', 'One-sided (lead over 50%)'];

// The Play time tab for the `days` UTC days up to `now`, from the sessions that ended in them and the matches that ended in them.
//
// `sessions` may reach back before the period, for those who left early from a match that began in it. `ongoing` is who
// is in game now, who stayed through any match they were in. `live` is the match on now, when it started and went live, if it is not among
// `matches` yet: leaves in it are left out of the timing until it ends and its length is known, and it is why the match
// before it is not the night's last.
export const buildRetention = (input: {
  now: number;
  days: number;
  sessions: SessionRow[];
  matches: MatchTimes[];
  ongoing?: OngoingStay[];
  live?: { startedAt: number; liveAt: number | null } | null;
  removed?: Removal[];
  // Only the days before this, for a day that is over (the default is up to now).
  until?: number;
  // Whether the heat only counts the period's own hours, as the page shows (the default). A day on the long-term records
  // keeps a stay that crossed midnight whole, as the day before did not count it, so every minute is counted once.
  clampHeat?: boolean;
  // Players who are new, by Steam ID, and the UTC day they were first seen.
  newOn?: Map<string, string> | null;
}): Retention => {
  const { now, days } = input;
  const first = Date.parse(dayOf(now - (days - 1) * 86_400_000));
  const until = input.until ?? Infinity;
  const removed = input.removed ?? [];
  const wasRemoved = (s: SessionRow): boolean =>
    removed.some(
      (r) => r.steamId === s.steamId && s.leftAt >= r.at - REMOVAL_BEFORE_MS && s.leftAt <= (r.until === undefined ? r.at + REMOVAL_AFTER_MS : (r.until ?? Infinity)),
    );
  const everyone = input.sessions.filter((s) => !wasRemoved(s));
  const inPeriodStay = (s: SessionRow): boolean => s.leftAt >= first && s.leftAt < until;
  const sessions = everyone.filter(inPeriodStay);
  const excluded = input.sessions.filter(inPeriodStay).length - sessions.length;
  const live = input.live ?? null;
  // The match on now stands in as a match that never ends, for the nights.
  const nights = withNights(live === null ? input.matches : [...input.matches, { map: '', startedAt: live.startedAt, liveAt: live.liveAt ?? Infinity, endedAt: Infinity }]);
  const finished = nights.filter((m) => m.endedAt !== Infinity);

  const byDay = new Map<string, { players: Set<string>; minutes: number[] }>();
  const all: number[] = [];
  for (const s of sessions) {
    const day = dayOf(s.leftAt);
    const entry = byDay.get(day) ?? { players: new Set<string>(), minutes: [] };
    entry.players.add(s.steamId);
    if (s.joinedAt !== null) {
      const minutes = Math.max(0, ((s.leftFrom ?? s.leftAt) - s.joinedAt) / 60_000);
      entry.minutes.push(minutes);
      all.push(minutes);
    }
    byDay.set(day, entry);
  }
  const daily = [...byDay]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, e]): RetentionDay => ({
      day,
      players: e.players.size,
      sessions: e.minutes.length,
      averageMinutes: round(mean(e.minutes)),
      medianMinutes: round(median(e.minutes)),
      minutesPerPlayer: round(e.players.size === 0 ? 0 : e.minutes.reduce((a, b) => a + b, 0) / e.players.size),
    }));

  const lengths = LENGTHS.map(([label]): LengthBucket => ({ label, sessions: 0 }));
  for (const minutes of all) {
    const i = LENGTHS.findIndex(([, under]) => minutes < under);
    const bucket = lengths[i];
    if (bucket !== undefined) bucket.sessions += 1;
  }

  const timing = emptyCounts();
  const finale = emptyCounts();
  let total = 0;
  for (const s of sessions) {
    if (s.leftFrom !== null || (live !== null && s.leftAt >= live.startedAt)) continue;
    const placed = placeLeave(s.leftAt, nights);
    total += 1;
    timing[placed.timing] += 1;
    if (placed.finale) finale[placed.timing] += 1;
  }

  // Who was in game when each match went live, and how many of them left before its last minutes. Someone who left after
  // a gap in the checks is counted when the gap shows they left in time, and left out when it can't say.
  const inPeriod = finished.filter((m) => m.endedAt >= first && m.endedAt < until).map((m): RetentionMatch & { liveAt: number; scores?: number[] } => {
    const cutoff = m.endedAt - END_BEFORE_MS;
    let present = 0;
    let leftBefore = 0;
    for (const s of everyone) {
      if (s.joinedAt === null || s.joinedAt > m.liveAt || s.leftAt <= m.liveAt) continue;
      if (s.leftAt < cutoff) leftBefore += 1;
      else if (s.leftFrom !== null && s.leftFrom < cutoff) continue;
      present += 1;
    }
    for (const o of input.ongoing ?? []) if (o.since !== null && o.since <= m.liveAt) present += 1;
    return { map: m.map, startedAt: m.startedAt, liveAt: m.liveAt, endedAt: m.endedAt, lastOfNight: m.lastOfNight, present, leftBefore, ...(m.scores === undefined ? {} : { scores: m.scores }) };
  });
  const matches = inPeriod.map(({ scores: _scores, liveAt: _liveAt, ...m }) => m).reverse().slice(0, MATCHES_LISTED);

  const maps = new Map<string, MapRetention>();
  const balances = new Map<string, BalanceRetention>(BALANCES.map((label) => [label, { label, matches: 0, present: 0, leftBefore: 0 }]));
  for (const m of inPeriod) {
    const row = maps.get(m.map) ?? { map: m.map, matches: 0, present: 0, leftBefore: 0 };
    row.matches += 1;
    row.present += m.present;
    row.leftBefore += m.leftBefore;
    maps.set(m.map, row);
    const label = balanceOf(m.scores);
    const balance = label === null ? undefined : balances.get(label);
    if (balance !== undefined) {
      balance.matches += 1;
      balance.present += m.present;
      balance.leftBefore += m.leftBefore;
    }
  }
  const byMap = [...maps.values()].sort((a, b) => b.matches - a.matches || (a.map < b.map ? -1 : 1));

  // How long people stayed by when in a match they joined.
  const stays = new Map<JoinTiming, number[]>(JOIN_TIMINGS.map((t) => [t, []]));
  for (const s of sessions) {
    if (s.joinedAt === null || (s.joinedFrom ?? null) !== null || (live !== null && s.joinedAt >= (live.liveAt ?? Infinity))) continue;
    stays.get(placeJoin(s.joinedAt, nights))?.push(Math.max(0, ((s.leftFrom ?? s.leftAt) - s.joinedAt) / 60_000));
  }
  const joins = JOIN_TIMINGS.map((timing): JoinStay => {
    const minutes = stays.get(timing) ?? [];
    return {
      timing,
      sessions: minutes.length,
      medianMinutes: round(median(minutes)),
      stayedShare: minutes.length === 0 ? 0 : minutes.filter((m) => m >= STAYED_MINUTES).length / minutes.length,
    };
  });

  // The seeding funnel: who was in game while a match was seeding, and how many were still there when it went live.
  const seeded = finished.filter((m) => m.endedAt >= first && m.endedAt < until && m.liveAt - m.startedAt >= SEED_MIN_MS);
  const seedList = seeded.map((m): SeedingMatch => {
    // Each player once, however often they reconnected, and only those known to have joined: someone already on when the
    // log began was not necessarily there for a match from before it.
    const seeders = new Set<string>();
    const reachedLive = new Set<string>();
    for (const s of everyone) {
      if (s.joinedAt === null || s.joinedAt >= m.liveAt || s.leftAt <= m.startedAt) continue;
      if (s.leftFrom !== null && s.leftFrom < m.liveAt && s.leftAt > m.liveAt) continue;
      seeders.add(s.steamId);
      if (s.leftAt > m.liveAt) reachedLive.add(s.steamId);
    }
    for (const o of input.ongoing ?? []) {
      if (o.since === null || o.since >= m.liveAt) continue;
      seeders.add(o.steamId);
      reachedLive.add(o.steamId);
    }
    return { map: m.map, startedAt: m.startedAt, liveAt: m.liveAt, seedingMinutes: round((m.liveAt - m.startedAt) / 60_000), seeders: seeders.size, reachedLive: reachedLive.size };
  });
  const seeding = {
    matches: seedList.length,
    averageMinutes: seedList.length === 0 ? null : round(mean(seedList.map((m) => m.seedingMinutes))),
    seeders: seedList.reduce((a, m) => a + m.seeders, 0),
    reachedLive: seedList.reduce((a, m) => a + m.reachedLive, 0),
    list: [...seedList].reverse().slice(0, SEEDING_LISTED),
  };

  // Short stays: new players against everyone else.
  const newOn = input.newOn ?? null;
  const bounce = newOn === null ? null : { newPlayers: { sessions: 0, short: 0 }, others: { sessions: 0, short: 0 } };
  if (bounce !== null && newOn !== null) {
    for (const s of sessions) {
      if (s.joinedAt === null || (s.joinedFrom ?? null) !== null) continue;
      const group = newOn.get(s.steamId) === dayOf(s.joinedAt) ? bounce.newPlayers : bounce.others;
      group.sessions += 1;
      if (((s.leftFrom ?? s.leftAt) - s.joinedAt) / 60_000 < BOUNCE_MINUTES) group.short += 1;
    }
  }

  // A week's leaves and time on the server, by hour.
  const heat = { leaves: Array.from({ length: 168 }, () => 0), minutes: Array.from({ length: 168 }, () => 0) };
  for (const s of sessions) {
    if (s.leftFrom === null) heat.leaves[slot(s.leftAt)] = (heat.leaves[slot(s.leftAt)] ?? 0) + 1;
    if (s.joinedAt === null) continue;
    const end = Math.min(s.leftFrom ?? s.leftAt, until);
    for (let t = input.clampHeat === false ? s.joinedAt : Math.max(s.joinedAt, first); t < end; ) {
      const next = Math.min(end, (Math.floor(t / 3_600_000) + 1) * 3_600_000);
      heat.minutes[slot(t)] = (heat.minutes[slot(t)] ?? 0) + (next - t) / 60_000;
      t = next;
    }
  }
  heat.minutes = heat.minutes.map(Math.round);

  return {
    days,
    sessions: all.length,
    averageMinutes: all.length === 0 ? null : round(mean(all)),
    medianMinutes: all.length === 0 ? null : round(median(all)),
    daily,
    lengths,
    leaves: { total, timing, finale },
    matches,
    excluded,
    byMap,
    byBalance: [...balances.values()],
    joins,
    seeding,
    bounce,
    heat,
    detail: { matches: inPeriod, seeding: seedList },
  };
};
