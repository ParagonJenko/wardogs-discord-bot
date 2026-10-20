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
// Only leaves the game or a check noted at the time count for timing: after a gap in the checks (`leftFrom`) it is not
// known when they left. Sessions with no join (on when the log started) have no length. Both still count for the rest.

export const END_BEFORE_MS = 3 * 60_000;
export const END_AFTER_MS = 10 * 60_000;
export const NIGHT_GAP_MS = 2 * 60 * 60_000;
// The matches listed, newest first.
export const MATCHES_LISTED = 20;

export type Timing = 'early' | 'mid' | 'late' | 'end' | 'between';
export const TIMINGS: Timing[] = ['early', 'mid', 'late', 'end', 'between'];

export type SessionRow = { steamId: string; joinedAt: number | null; leftAt: number; leftFrom: number | null };
export type MatchTimes = { map: string; startedAt: number; liveAt: number; endedAt: number };

const Row = z.object({ steam_id: z.string(), joined_at: z.number().nullable(), left_at: z.number(), left_from: z.number().nullable() });

// The times on the server that ended at `from` or later.
export const sessionRows = (sql: Sql, from: number): SessionRow[] =>
  sql
    .exec('SELECT steam_id, joined_at, left_at, left_from FROM sessions WHERE left_at >= ?', from)
    .toArray()
    .flatMap((row): SessionRow[] => {
      const parsed = Row.safeParse(row);
      return parsed.success ? [{ steamId: parsed.data.steam_id, joinedAt: parsed.data.joined_at, leftAt: parsed.data.left_at, leftFrom: parsed.data.left_from }] : [];
    });

export type RetentionDay = { day: string; players: number; sessions: number; averageMinutes: number; medianMinutes: number; minutesPerPlayer: number };
export type LengthBucket = { label: string; sessions: number };
export type LeaveCounts = Record<Timing, number>;
export type RetentionMatch = { map: string; startedAt: number; endedAt: number; lastOfNight: boolean; present: number; leftBefore: number };
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

// The Play time tab for the `days` UTC days up to `now`, from the sessions that ended in them and the matches that ended in them.
export const buildRetention = (input: { now: number; days: number; sessions: SessionRow[]; matches: MatchTimes[] }): Retention => {
  const { now, days } = input;
  const first = Date.parse(dayOf(now - (days - 1) * 86_400_000));
  const sessions = input.sessions.filter((s) => s.leftAt >= first);
  const nights = withNights(input.matches);

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
    if (s.leftFrom !== null) continue;
    const placed = placeLeave(s.leftAt, nights);
    total += 1;
    timing[placed.timing] += 1;
    if (placed.finale) finale[placed.timing] += 1;
  }

  const matches = nights
    .filter((m) => m.endedAt >= first)
    .map((m): RetentionMatch => {
      const present = input.sessions.filter((s) => s.joinedAt !== null && s.joinedAt <= m.liveAt && s.leftAt > m.liveAt);
      const leftBefore = present.filter((s) => s.leftFrom === null && s.leftAt < m.endedAt - END_BEFORE_MS).length;
      return { map: m.map, startedAt: m.startedAt, endedAt: m.endedAt, lastOfNight: m.lastOfNight, present: present.length, leftBefore };
    })
    .reverse()
    .slice(0, MATCHES_LISTED);

  return {
    days,
    sessions: all.length,
    averageMinutes: all.length === 0 ? null : round(mean(all)),
    medianMinutes: all.length === 0 ? null : round(median(all)),
    daily,
    lengths,
    leaves: { total, timing, finale },
    matches,
  };
};
