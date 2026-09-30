import { z } from 'zod';
import type { Phase } from './alerts.ts';
import { mapName } from './discord.ts';
import type { FactionScore, Player } from './rcon.ts';
import { dayOf } from './stats.ts';
import { summarise, type MatchState } from './tracking.ts';

// Per-player records for leaderboards and seeder rewards, kept for good. They are keyed by Steam ID, so they are
// private: /api/stats never includes them.

export type PlayerTotals = {
  name: string;
  seedingMinutes: number;
  liveMinutes: number;
  matches: number;
  kills: number;
  deaths: number;
};

// One UTC day's totals, by Steam ID. Stored as one value per day, so a check writes one row however many are online.
export type PlayerDay = Record<string, PlayerTotals>;

export type MatchPlayer = { steamId: string; name: string; kills: number; deaths: number };

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

const DAY_MS = 24 * 60 * 60_000;

export const playerDayKey = (at: number): string => `players:${dayOf(at)}`;

// Zero-padded so the keys sort by start time.
export const matchRecordKey = (startedAt: number): string => `match:${String(startedAt).padStart(15, '0')}`;

// The keys for today (UTC) and the days before it, oldest first.
export const recentDayKeys = (now: number, days: number): string[] =>
  Array.from({ length: days }, (_, i) => playerDayKey(now - (days - 1 - i) * DAY_MS));

const PlayerDaySchema = z.record(
  z.string(),
  z.object({
    name: z.string(),
    seedingMinutes: z.number(),
    liveMinutes: z.number(),
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

const blank = (name: string): PlayerTotals => ({ name, seedingMinutes: 0, liveMinutes: 0, matches: 0, kills: 0, deaths: 0 });

// Time online: while the server seeds it counts as seeding, while live as time played. The same rule as the
// top seeders on the live alert, so the check that finds the server live counts as live.
export const recordActivity = (day: PlayerDay, players: Player[], phase: Phase, minutes: number): PlayerDay => {
  if (phase === 'empty') return day;
  const field = phase === 'seeding' ? 'seedingMinutes' : 'liveMinutes';
  return {
    ...day,
    ...Object.fromEntries(
      players.map((p) => {
        const known = day[p.steamId] ?? blank(p.name);
        return [p.steamId, { ...known, name: p.name, [field]: known[field] + minutes }];
      }),
    ),
  };
};

// Credits a finished match to everyone who played in it, on the day it ended.
export const recordMatchPlayers = (day: PlayerDay, match: MatchState): PlayerDay => ({
  ...day,
  ...Object.fromEntries(
    Object.entries(match.players).map(([steamId, p]) => {
      const known = day[steamId] ?? blank(p.name);
      return [
        steamId,
        { ...known, name: p.name, matches: known.matches + 1, kills: known.kills + p.kills, deaths: known.deaths + p.deaths },
      ];
    }),
  ),
});

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
    players: Object.entries(match.players).map(([steamId, p]) => ({ steamId, ...p })),
  };
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
        matches: known.matches + t.matches,
        kills: known.kills + t.kills,
        deaths: known.deaths + t.deaths,
      });
    }
  }
  return [...sum].map(([steamId, t]) => ({ steamId, ...t }));
};

export const rankSeeders = (days: PlayerDay[], count: number): RankedPlayer[] =>
  totals(days)
    .filter((p) => p.seedingMinutes > 0)
    .sort((a, b) => b.seedingMinutes - a.seedingMinutes)
    .slice(0, count);
