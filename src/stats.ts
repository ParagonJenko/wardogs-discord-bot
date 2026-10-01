import { z } from 'zod';
import type { Phase } from './alerts.ts';
import type { VipRule } from './config.ts';
import { mapName } from './discord.ts';
import type { Leaderboard } from './players.ts';
import type { FactionScore, Player, ServerStatus } from './rcon.ts';
import { topPlayers, type MatchState, type MatchSummary, type PlayerStats } from './tracking.ts';

// Numbers for the community website, served by the Worker at GET /api/stats. Anyone can read them, so they
// hold nothing private: no Steam IDs, no RCON address or password.

export type Sample = [at: number, players: number];

export type DayStats = { day: string; peak: number; liveMinutes: number };

// Each UTC day's readings by UTC hour (index 0 to 23): the players summed over the readings, how many readings, and
// how many of them had at least the busy threshold.
export type HourTotals = { day: string; players: number[]; readings: number[]; busy: number[] };

// For each UTC hour over the last `days` days: the average players, and the share of readings (0 to 1) with at least
// the busy threshold. Null for an hour with no readings.
export type Hourly = { days: number; players: (number | null)[]; busy: (number | null)[] };

export type Thresholds = { seeding: number; live: number; busy: number };

export type RecentMatch = MatchSummary & { endedAt: number };

export type CurrentMatch = {
  map: string;
  startedAt: number;
  liveAt: number | null;
  peakPlayers: number;
  factionScores: FactionScore[];
  top: PlayerStats[];
};

export type ServerSnapshot = {
  name: string;
  players: number;
  maxPlayers: number;
  map: string;
  phase: Phase;
  factionScores: FactionScore[];
  seenAt: number;
};

export type DiscordCounts = { name: string | null; members: number; online: number; fetchedAt: number };

export type SiteStats = {
  server: ServerSnapshot | null;
  history: Sample[];
  days: DayStats[];
  // Kept for the site's busiest times, and sent to it as `hourly`.
  hours: HourTotals[];
  matches: RecentMatch[];
  currentMatch: CurrentMatch | null;
  discord: DiscordCounts | null;
};

export type Observation = {
  at: number;
  status: ServerStatus;
  // Who is online, for the private player records. Never copied into the public stats.
  players: Player[];
  phase: Phase;
  // True while the server is seeding: filling up from empty, or building back up after a drop from live.
  seeding: boolean;
  match: MatchState;
};

const DAY_MS = 24 * 60 * 60_000;
export const HISTORY_MS = DAY_MS;
export const DAYS_KEPT = 14;
export const MATCHES_KEPT = 10;
export const DISCORD_REFRESH_MS = 10 * 60_000;

export const emptyStats = (): SiteStats => ({
  server: null,
  history: [],
  days: [],
  hours: [],
  matches: [],
  currentMatch: null,
  discord: null,
});

const Scores = z.array(z.object({ name: z.string(), score: z.number(), colorHex: z.string().optional() }));
const Players = z.array(z.object({ name: z.string(), kills: z.number(), deaths: z.number() }));

const SiteStatsSchema = z.object({
  server: z
    .object({
      name: z.string(),
      players: z.number(),
      maxPlayers: z.number(),
      map: z.string(),
      phase: z.enum(['empty', 'seeding', 'live']),
      factionScores: Scores,
      seenAt: z.number(),
    })
    .nullable(),
  history: z.array(z.tuple([z.number(), z.number()])),
  days: z.array(z.object({ day: z.string(), peak: z.number(), liveMinutes: z.number() })),
  // Missing from stats saved before it was added, and `busy` from stats saved before that.
  hours: z
    .array(
      z.object({
        day: z.string(),
        players: z.array(z.number()),
        readings: z.array(z.number()),
        busy: z.array(z.number()).optional(),
      }),
    )
    .optional(),
  matches: z.array(
    z.object({
      map: z.string(),
      endedAt: z.number(),
      durationMs: z.number(),
      peakPlayers: z.number(),
      factionScores: Scores,
      top: Players,
    }),
  ),
  currentMatch: z
    .object({
      map: z.string(),
      startedAt: z.number(),
      liveAt: z.number().nullable(),
      peakPlayers: z.number(),
      factionScores: Scores,
      top: Players,
    })
    .nullable(),
  discord: z
    .object({ name: z.string().nullable(), members: z.number(), online: z.number(), fetchedAt: z.number() })
    .nullable(),
});

// Days are UTC dates, so every visitor sees the same boundaries.
export const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);

const noHours = (): number[] => Array(24).fill(0);

// Adds one reading to its UTC hour, keeping the hours inside the last DAYS_KEPT calendar days like recordDay.
const recordHour = (hours: HourTotals[], at: number, players: number, busy: boolean): HourTotals[] => {
  const day = dayOf(at);
  const oldest = dayOf(at - (DAYS_KEPT - 1) * DAY_MS);
  const hour = new Date(at).getUTCHours();
  const today = hours.find((h) => h.day === day) ?? { day, players: noHours(), readings: noHours(), busy: noHours() };
  const add = (counts: number[], amount: number) => counts.map((count, h) => (h === hour ? count + amount : count));
  const updated = {
    day,
    players: add(today.players, players),
    readings: add(today.readings, 1),
    busy: add(today.busy, busy ? 1 : 0),
  };
  return [...hours.filter((h) => h.day !== day && h.day >= oldest), updated].sort((a, b) => a.day.localeCompare(b.day));
};

// Reads what a store saved. Anything unrecognisable starts fresh rather than breaking the page. Stats saved before
// the hours were kept start them from the last 24 hours of readings, so the busiest times do not start empty.
// Readings saved before busy ones were counted count as not busy; they are gone after DAYS_KEPT days.
export const parseStats = (raw: unknown): SiteStats => {
  const parsed = SiteStatsSchema.safeParse(raw);
  if (!parsed.success) return emptyStats();
  const { hours, ...stats } = parsed.data;
  const fromHistory = () =>
    stats.history.reduce<HourTotals[]>((acc, [at, players]) => recordHour(acc, at, players, false), []);
  return { ...stats, hours: hours?.map((h) => ({ ...h, busy: h.busy ?? noHours() })) ?? fromHistory() };
};

// Keeps the days inside the last DAYS_KEPT calendar days, so days from before an outage do not linger.
const recordDay = (days: DayStats[], at: number, players: number, liveMinutes: number): DayStats[] => {
  const day = dayOf(at);
  const oldest = dayOf(at - (DAYS_KEPT - 1) * DAY_MS);
  const today = days.find((d) => d.day === day) ?? { day, peak: 0, liveMinutes: 0 };
  const updated = { day, peak: Math.max(today.peak, players), liveMinutes: today.liveMinutes + liveMinutes };
  return [...days.filter((d) => d.day !== day && d.day >= oldest), updated].sort((a, b) => a.day.localeCompare(b.day));
};

const currentMatch = (match: MatchState, status: ServerStatus): CurrentMatch | null =>
  status.players === 0
    ? null
    : {
        map: mapName(status.map),
        startedAt: match.startedAt,
        liveAt: match.liveAt,
        peakPlayers: match.peakPlayers,
        factionScores: status.factionScores,
        top: topPlayers(match.players),
      };

export const recordObservation = (
  stats: SiteStats,
  obs: Observation,
  minutesPerCheck: number,
  busyThreshold: number,
): SiteStats => ({
  ...stats,
  server: {
    name: obs.status.name,
    players: obs.status.players,
    maxPlayers: obs.status.maxPlayers,
    map: mapName(obs.status.map),
    phase: obs.phase,
    factionScores: obs.status.factionScores,
    seenAt: obs.at,
  },
  history: [...stats.history.filter(([at]) => at > obs.at - HISTORY_MS), [obs.at, obs.status.players]],
  days: recordDay(stats.days, obs.at, obs.status.players, obs.phase === 'live' ? minutesPerCheck : 0),
  hours: recordHour(stats.hours, obs.at, obs.status.players, obs.status.players >= busyThreshold),
  currentMatch: currentMatch(obs.match, obs.status),
});

// Newest first.
export const recordMatch = (stats: SiteStats, summary: MatchSummary, at: number): SiteStats => ({
  ...stats,
  matches: [{ ...summary, map: mapName(summary.map), endedAt: at }, ...stats.matches].slice(0, MATCHES_KEPT),
});

// Takes a match off the recent matches, as when it was recorded by mistake. A match is picked by when it ended.
export const removeRecentMatch = (stats: SiteStats, endedAt: number): { stats: SiteStats; removed: RecentMatch | null } => {
  const removed = stats.matches.find((m) => m.endedAt === endedAt) ?? null;
  return { stats: { ...stats, matches: stats.matches.filter((m) => m !== removed) }, removed };
};

export const discordDue = (stats: SiteStats, now: number): boolean =>
  stats.discord === null || now - stats.discord.fetchedAt >= DISCORD_REFRESH_MS;

export const recordDiscord = (stats: SiteStats, discord: DiscordCounts): SiteStats => ({ ...stats, discord });

// The leaderboard (names only) and what seeding earns come from the player records, which are read separately.
export type PublicExtras = { leaderboard: Leaderboard; vip: VipRule | null };

export type PublicStats = Omit<SiteStats, 'hours'> &
  PublicExtras & {
    generatedAt: number;
    thresholds: Thresholds;
    hourly: Hourly;
  };

// Every reading in the last DAYS_KEPT days (today included) counts once, so an hour's average is its players
// summed over its readings, and its busy share is its busy readings over its readings. Averages are rounded to a
// tenth and shares to a hundredth to keep the JSON short.
export const hourlyAverages = (hours: HourTotals[], now: number): Hourly => {
  const oldest = dayOf(now - (DAYS_KEPT - 1) * DAY_MS);
  const kept = hours.filter((h) => h.day >= oldest);
  const sum = (pick: (h: HourTotals) => number[], hour: number) =>
    kept.reduce((total, h) => total + (pick(h)[hour] ?? 0), 0);
  const per = (pick: (h: HourTotals) => number[], places: number) =>
    Array.from({ length: 24 }, (_, hour) => {
      const readings = sum((h) => h.readings, hour);
      return readings === 0 ? null : Math.round((sum(pick, hour) / readings) * places) / places;
    });
  return { days: DAYS_KEPT, players: per((h) => h.players, 10), busy: per((h) => h.busy, 100) };
};

export const publicStats = (
  { hours, ...stats }: SiteStats,
  thresholds: Thresholds,
  now: number,
  extras: PublicExtras,
): PublicStats => ({
  generatedAt: now,
  thresholds,
  ...stats,
  hourly: hourlyAverages(hours, now),
  ...extras,
});
