import { z } from 'zod';
import { mapName } from './discord.ts';
import type { FactionScore, Player } from './rcon.ts';
import { dayOf } from './stats.ts';
import { summarise, type MatchState } from './tracking.ts';

// Per-player records for leaderboards and seeder rewards, kept for good. They are keyed by Steam ID, so they are
// private: /api/stats only ever shows names.

export type PlayerTotals = {
  name: string;
  // Minutes online while the server was seeding.
  seedingMinutes: number;
  // Minutes online once it had gone live, until it emptied.
  liveMinutes: number;
  // Days with a successful seed: on for more than the minimum while it seeded, and it then went live. 0 or 1 in a day.
  seedDays: number;
  matches: number;
  kills: number;
  deaths: number;
};

// One UTC day's totals, by Steam ID. Stored as one value per day, so a check writes one row however many are online.
export type PlayerDay = Record<string, PlayerTotals>;

// `faction` is the side they were last seen on, missing from matches recorded before sides were kept.
export type MatchPlayer = { steamId: string; name: string; kills: number; deaths: number; faction?: string };

// Every player's final stats for one finished match.
export type MatchRecord = {
  map: string;
  startedAt: number;
  liveAt: number;
  endedAt: number;
  durationMs: number;
  peakPlayers: number;
  factionScores: FactionScore[];
  players: MatchPlayer[];
};

export type RankedPlayer = PlayerTotals & { steamId: string };

// A seeder's time in the seed that just got the server live.
export type SeedCredit = { steamId: string; name: string; minutes: number };

const DAY_MS = 24 * 60 * 60_000;

export const playerDayKey = (at: number): string => `players:${dayOf(at)}`;

// Zero-padded so the keys sort by start time.
export const matchRecordKey = (startedAt: number): string => `match:${String(startedAt).padStart(15, '0')}`;

// The UTC date a day's key is for.
export const dayOfKey = (key: string): string => key.slice(key.indexOf(':') + 1);

// The keys for today (UTC) and the days before it, oldest first.
export const recentDayKeys = (now: number, days: number): string[] =>
  Array.from({ length: days }, (_, i) => playerDayKey(now - (days - 1 - i) * DAY_MS));

const PlayerDaySchema = z.record(
  z.string(),
  z.object({
    name: z.string(),
    seedingMinutes: z.number(),
    liveMinutes: z.number(),
    seedDays: z.number(),
    matches: z.number(),
    kills: z.number(),
    deaths: z.number(),
  }),
);

// Reads what a store saved. Nothing saved yet is an empty day.
export const parsePlayerDay = (raw: unknown): PlayerDay => {
  const parsed = PlayerDaySchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
};

const blank = (name: string): PlayerTotals => ({
  name,
  seedingMinutes: 0,
  liveMinutes: 0,
  seedDays: 0,
  matches: 0,
  kills: 0,
  deaths: 0,
});

const update = (day: PlayerDay, entries: [steamId: string, name: string, change: (t: PlayerTotals) => Partial<PlayerTotals>][]) => ({
  ...day,
  ...Object.fromEntries(
    entries.map(([steamId, name, change]) => {
      const known = day[steamId] ?? blank(name);
      return [steamId, { ...known, name, ...change(known) }];
    }),
  ),
});

// Time online, as seeding or live minutes.
export const recordActivity = (day: PlayerDay, players: Player[], kind: 'seeding' | 'live', minutes: number): PlayerDay => {
  const field = kind === 'seeding' ? 'seedingMinutes' : 'liveMinutes';
  return update(
    day,
    players.map((p) => [p.steamId, p.name, (t) => ({ [field]: t[field] + minutes })]),
  );
};

// Marks the day for everyone who seeded for more than `minMinutes` before the server went live. Marking twice is
// harmless, so a retried check cannot count a seed twice.
export const recordSeed = (day: PlayerDay, seeders: SeedCredit[], minMinutes: number): PlayerDay =>
  update(
    day,
    seeders.filter((s) => s.minutes > minMinutes).map((s) => [s.steamId, s.name, () => ({ seedDays: 1 })]),
  );

// Takes a match back off the totals of everyone who played in it, for the day it was credited to. Used when a match
// was recorded by mistake.
export const unrecordMatchPlayers = (day: PlayerDay, players: MatchPlayer[]): PlayerDay =>
  update(
    day,
    players.flatMap((p) => {
      const known = day[p.steamId];
      if (known === undefined) return [];
      return [
        [
          p.steamId,
          known.name,
          (t: PlayerTotals) => ({
            matches: Math.max(0, t.matches - 1),
            kills: Math.max(0, t.kills - p.kills),
            deaths: Math.max(0, t.deaths - p.deaths),
          }),
        ] as const,
      ];
    }),
  );

// Credits a finished match to everyone who played in it, on the day it ended.
export const recordMatchPlayers = (day: PlayerDay, match: MatchState): PlayerDay =>
  update(
    day,
    Object.entries(match.players).map(([steamId, p]) => [
      steamId,
      p.name,
      (t) => ({ matches: t.matches + 1, kills: t.kills + p.kills, deaths: t.deaths + p.deaths }),
    ]),
  );

export const matchRecord = (match: MatchState, endedAt: number): MatchRecord => {
  const summary = summarise(match);
  return {
    map: mapName(summary.map),
    startedAt: match.startedAt,
    liveAt: match.liveAt ?? match.lastSeenAt,
    endedAt,
    durationMs: summary.durationMs,
    peakPlayers: summary.peakPlayers,
    factionScores: summary.factionScores,
    players: Object.entries(match.players).map(([steamId, p]) => ({
      steamId,
      name: p.name,
      kills: p.kills,
      deaths: p.deaths,
      ...(p.faction ? { faction: p.faction } : {}),
    })),
  };
};

const MatchRecordSchema = z.object({
  map: z.string(),
  startedAt: z.number(),
  liveAt: z.number(),
  endedAt: z.number(),
  durationMs: z.number(),
  peakPlayers: z.number(),
  // Each side's colour in game is kept when the server reported it, for the player pages.
  factionScores: z.array(z.object({ name: z.string(), score: z.number(), colorHex: z.string().optional() })),
  players: z.array(
    z.object({ steamId: z.string(), name: z.string(), kills: z.number(), deaths: z.number(), faction: z.string().optional() }),
  ),
});

export const parseMatchRecord = (raw: unknown): MatchRecord | null => {
  const parsed = MatchRecordSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

// A day as everything but the records themselves sees it: staff (see staffprofiles.ts) never seed, so their seeding
// minutes count as live ones, keeping their time played, and they have no seed days. Seeder VIP, the top seeders and
// the seeding ranks are then for the players who seed. The records keep what happened, so unlinking a staff member's
// Steam account gives them their seeding back.
export const withoutStaffSeeding = (day: PlayerDay, staff: ReadonlySet<string>): PlayerDay => {
  if (!Object.keys(day).some((steamId) => staff.has(steamId))) return day;
  return Object.fromEntries(
    Object.entries(day).map(([steamId, t]) => [
      steamId,
      staff.has(steamId) ? { ...t, seedingMinutes: 0, liveMinutes: t.liveMinutes + t.seedingMinutes, seedDays: 0 } : t,
    ]),
  );
};

// Adds up days, oldest first, so each player keeps the name they used most recently.
export const totals = (days: PlayerDay[]): RankedPlayer[] => {
  const sum = new Map<string, PlayerTotals>();
  for (const day of days) {
    for (const [steamId, t] of Object.entries(day)) {
      const known = sum.get(steamId) ?? blank(t.name);
      sum.set(steamId, {
        name: t.name,
        seedingMinutes: known.seedingMinutes + t.seedingMinutes,
        liveMinutes: known.liveMinutes + t.liveMinutes,
        seedDays: known.seedDays + t.seedDays,
        matches: known.matches + t.matches,
        kills: known.kills + t.kills,
        deaths: known.deaths + t.deaths,
      });
    }
  }
  return [...sum].map(([steamId, t]) => ({ steamId, ...t }));
};

// Seed days first, as they earn VIP, then minutes.
export const rankSeeders = (days: PlayerDay[], count: number): RankedPlayer[] =>
  totals(days)
    .filter((p) => p.seedingMinutes > 0)
    .sort((a, b) => b.seedDays - a.seedDays || b.seedingMinutes - a.seedingMinutes)
    .slice(0, count);

export type BoardKey = 'kills' | 'kd' | 'playtime' | 'seeding';

// Rows keep their Steam IDs until the stats go out, when publicStats swaps them for public ids.
export type Leaderboard<Row = RankedPlayer> = { days: number; kdMinMatches: number } & Record<BoardKey, Row[]>;

// The K/D board only lists players who played this many matches over 30 days, so one big match is not the best K/D. A
// match counts for anyone seen in it, even for one reading, so it takes 10, more than one evening (say, on the mortar)
// can reach. A shorter period needs its share, to the nearest match, and never fewer than 3: 3 for a week, 9 or 10 for a
// calendar month.
const KD_MIN_MATCHES = 10;
const KD_MIN_MATCHES_DAYS = 30;
const KD_MIN_MATCHES_FLOOR = 3;

export const kdMinMatches = (days: number): number =>
  Math.max(KD_MIN_MATCHES_FLOOR, Math.round((days * KD_MIN_MATCHES) / KD_MIN_MATCHES_DAYS));

const ratio = (p: PlayerTotals): number => p.kills / Math.max(p.deaths, 1);
const played = (p: PlayerTotals): number => p.seedingMinutes + p.liveMinutes;

// Who each board lists, and in what order. Player pages rank players by the same rules.
const BOARDS: Record<
  BoardKey,
  { keep: (p: PlayerTotals, kdMatches: number) => boolean; order: (a: PlayerTotals, b: PlayerTotals) => number }
> = {
  kills: { keep: (p) => p.kills > 0, order: (a, b) => b.kills - a.kills || a.deaths - b.deaths },
  kd: { keep: (p, kdMatches) => p.kills > 0 && p.matches >= kdMatches, order: (a, b) => ratio(b) - ratio(a) || b.kills - a.kills },
  playtime: { keep: (p) => played(p) > 0, order: (a, b) => played(b) - played(a) },
  seeding: { keep: (p) => p.seedingMinutes > 0, order: (a, b) => b.seedDays - a.seedDays || b.seedingMinutes - a.seedingMinutes },
};

const board = (players: RankedPlayer[], key: BoardKey, kdMatches: number): RankedPlayer[] =>
  players.filter((p) => BOARDS[key].keep(p, kdMatches)).sort(BOARDS[key].order);

// `period` is how many days the board covers, which sets the matches a player needs for the K/D board.
export const leaderboard = (days: PlayerDay[], period: number, count: number): Leaderboard => {
  const players = totals(days);
  const kdMatches = kdMinMatches(period);
  const top = (key: BoardKey) => board(players, key, kdMatches).slice(0, count);
  return { days: period, kdMinMatches: kdMatches, kills: top('kills'), kd: top('kd'), playtime: top('playtime'), seeding: top('seeding') };
};

// A player's place on each board over `period` days (1 is the top), or null when the board leaves them out, and how
// many players played in that time.
export type Ranks = { days: number; kdMinMatches: number; players: number } & Record<BoardKey, number | null>;

export const ranks = (players: RankedPlayer[], steamId: string, period: number): Ranks => {
  const kdMatches = kdMinMatches(period);
  const place = (key: BoardKey): number | null => {
    const index = board(players, key, kdMatches).findIndex((p) => p.steamId === steamId);
    return index === -1 ? null : index + 1;
  };
  return {
    days: period,
    kdMinMatches: kdMatches,
    players: players.length,
    kills: place('kills'),
    kd: place('kd'),
    playtime: place('playtime'),
    seeding: place('seeding'),
  };
};
