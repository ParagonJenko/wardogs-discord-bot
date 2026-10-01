import { z } from 'zod';
import type { AlertRules, Phase } from './alerts.ts';
import type { VipRule } from './config.ts';
import { mapName } from './discord.ts';
import type { Leaderboard } from './players.ts';
import type { FactionScore, Player, ServerStatus } from './rcon.ts';
import { topPlayers, type MatchState, type MatchSummary, type PlayerStats } from './tracking.ts';

// Numbers for the community website, served by the Worker at GET /api/stats. Anyone can read them, so they
// hold nothing private: no Steam IDs, no RCON address or password.

export type Sample = [at: number, players: number];

export type DayStats = { day: string; peak: number; liveMinutes: number };

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

// Reads what a store saved. Anything unrecognisable starts fresh rather than breaking the page.
export const parseStats = (raw: unknown): SiteStats => {
  const parsed = SiteStatsSchema.safeParse(raw);
  return parsed.success ? parsed.data : emptyStats();
};

// Days are UTC dates, so every visitor sees the same boundaries.
export const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);

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

export const recordObservation = (stats: SiteStats, obs: Observation, minutesPerCheck: number): SiteStats => ({
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

export type PublicStats = SiteStats &
  PublicExtras & {
    generatedAt: number;
    thresholds: { seeding: number; live: number };
  };

export const publicStats = (stats: SiteStats, rules: AlertRules, now: number, extras: PublicExtras): PublicStats => ({
  generatedAt: now,
  thresholds: { seeding: rules.seeding, live: rules.live },
  ...stats,
  ...extras,
});
