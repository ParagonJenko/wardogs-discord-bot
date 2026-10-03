import { z } from 'zod';
import type { Phase } from './alerts.ts';
import type { VipRule } from './config.ts';
import { mapName } from './discord.ts';
import type { Leaderboard, RankedPlayer } from './players.ts';
import type { FactionScore, Player, ServerStatus } from './rcon.ts';
import { topPlayers, type MatchState, type MatchSummary, type RankedStats } from './tracking.ts';
import type { WeaponBoard } from './weapons.ts';

// Numbers for the community website, served by the Worker at GET /api/stats. Anyone can read them, so what is served
// holds nothing private: no RCON address or password, and no Steam IDs. The stored stats keep the Steam IDs of the
// players they name, and publicStats swaps them for the players' public ids, which link to their player pages.

export type Sample = [at: number, players: number];

export type DayStats = { day: string; peak: number; liveMinutes: number };

// Each UTC day's readings by UTC hour (index 0 to 23): the players summed over the readings and how many readings.
// Then the busy threshold the day's busy counts use, how many readings were checked against it, and how many of those
// had at least that many players. The threshold is null before busy readings were counted.
export type HourTotals = {
  day: string;
  players: number[];
  readings: number[];
  busyThreshold: number | null;
  checked: number[];
  busy: number[];
};

// For each UTC hour over the last `days` days: the average players, null for an hour with no readings, and the share of
// readings (0 to 1) with at least the busy threshold, null for an hour with no readings checked against it.
export type Hourly = { days: number; players: (number | null)[]; busy: (number | null)[] };

export type Thresholds = { seeding: number; live: number; busy: number };

export type RecentMatch = MatchSummary & { endedAt: number };

export type CurrentMatch = {
  map: string;
  startedAt: number;
  liveAt: number | null;
  peakPlayers: number;
  factionScores: FactionScore[];
  top: RankedStats[];
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
// The Steam ID is missing from stats saved before it was kept.
const Players = z.array(z.object({ steamId: z.string().optional(), name: z.string(), kills: z.number(), deaths: z.number() }));

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
  // Missing from stats saved before it was added, and the busy counts from stats saved before those.
  hours: z
    .array(
      z.object({
        day: z.string(),
        players: z.array(z.number()),
        readings: z.array(z.number()),
        busyThreshold: z.number().nullable().optional(),
        checked: z.array(z.number()).optional(),
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

// Adds one reading to its UTC hour, keeping the hours inside the last DAYS_KEPT calendar days like recordDay. A null
// threshold adds the reading without checking whether it was busy.
const recordHour = (hours: HourTotals[], at: number, players: number, busyThreshold: number | null): HourTotals[] => {
  const day = dayOf(at);
  const oldest = dayOf(at - (DAYS_KEPT - 1) * DAY_MS);
  const hour = new Date(at).getUTCHours();
  const today = hours.find((h) => h.day === day) ?? {
    day,
    players: noHours(),
    readings: noHours(),
    busyThreshold,
    checked: noHours(),
    busy: noHours(),
  };
  // Busy counts only add up under one threshold, so a new threshold starts the day's busy counts again.
  const same = today.busyThreshold === busyThreshold;
  const add = (counts: number[], amount: number) => counts.map((count, h) => (h === hour ? count + amount : count));
  const updated = {
    day,
    players: add(today.players, players),
    readings: add(today.readings, 1),
    busyThreshold,
    checked: add(same ? today.checked : noHours(), busyThreshold === null ? 0 : 1),
    busy: add(same ? today.busy : noHours(), busyThreshold !== null && players >= busyThreshold ? 1 : 0),
  };
  return [...hours.filter((h) => h.day !== day && h.day >= oldest), updated].sort((a, b) => a.day.localeCompare(b.day));
};

// Brings every day's busy counts to `busyThreshold`, dropping counts made under another threshold. An hour with more
// readings in `recent` than were checked takes its counts from those readings, so after a new threshold, or the
// deploy that started busy counts, the last 24 hours count straight away.
const recheckHours = (hours: HourTotals[], recent: Sample[], busyThreshold: number): HourTotals[] => {
  const fromRecent = new Map<string, { checked: number[]; busy: number[] }>();
  for (const [at, players] of recent) {
    const day = dayOf(at);
    const counts = fromRecent.get(day) ?? { checked: noHours(), busy: noHours() };
    const hour = new Date(at).getUTCHours();
    counts.checked[hour] += 1;
    if (players >= busyThreshold) counts.busy[hour] += 1;
    fromRecent.set(day, counts);
  }
  return hours.map((h) => {
    const same = h.busyThreshold === busyThreshold;
    const checked = same ? h.checked : noHours();
    const busy = same ? h.busy : noHours();
    const counts = fromRecent.get(h.day) ?? { checked: noHours(), busy: noHours() };
    const better = (hour: number) => counts.checked[hour] > checked[hour];
    return {
      ...h,
      busyThreshold,
      checked: checked.map((count, hour) => (better(hour) ? counts.checked[hour] : count)),
      busy: busy.map((count, hour) => (better(hour) ? counts.busy[hour] : count)),
    };
  });
};

// Reads what a store saved. Anything unrecognisable starts fresh rather than breaking the page. Stats saved before
// the hours were kept start them from the last 24 hours of readings, so the busiest times do not start empty.
// Readings saved before busy ones were counted are not checked, so they are left out of the busy shares until
// recheckHours checks the ones still in the history.
export const parseStats = (raw: unknown): SiteStats => {
  const parsed = SiteStatsSchema.safeParse(raw);
  if (!parsed.success) return emptyStats();
  const { hours, ...stats } = parsed.data;
  const fromHistory = () =>
    stats.history.reduce<HourTotals[]>((acc, [at, players]) => recordHour(acc, at, players, null), []);
  const saved = hours?.map((h) => ({
    ...h,
    busyThreshold: h.busyThreshold ?? null,
    checked: h.checked ?? noHours(),
    busy: h.busy ?? noHours(),
  }));
  return { ...stats, hours: saved ?? fromHistory() };
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
): SiteStats => {
  const recent = stats.history.filter(([at]) => at > obs.at - HISTORY_MS);
  return {
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
    history: [...recent, [obs.at, obs.status.players]],
    days: recordDay(stats.days, obs.at, obs.status.players, obs.phase === 'live' ? minutesPerCheck : 0),
    hours: recordHour(recheckHours(stats.hours, recent, busyThreshold), obs.at, obs.status.players, busyThreshold),
    currentMatch: currentMatch(obs.match, obs.status),
  };
};

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

// The leaderboard and what seeding earns come from the player records, which are read separately. The weapons come
// from the kill feed's records, already with public ids; null when the bot has never had the feed.
export type PublicExtras = { leaderboard: Leaderboard; vip: VipRule | null; weapons: WeaponBoard | null };

// Looks up a player's public id by Steam ID (see profiles.ts).
export type IdOf = (steamId: string) => string | undefined;

// A player as the website sees them: the Steam ID swapped for their public id, or left out when there is none.
export type Public<T> = Omit<T, 'steamId'> & { id?: string };

export type PublicMatch = Omit<RecentMatch, 'top'> & { top: Public<RankedStats>[] };

export type PublicStats = Omit<SiteStats, 'hours' | 'matches' | 'currentMatch'> & {
  generatedAt: number;
  thresholds: Thresholds;
  hourly: Hourly;
  matches: PublicMatch[];
  currentMatch: (Omit<CurrentMatch, 'top'> & { top: Public<RankedStats>[] }) | null;
  leaderboard: Leaderboard<Public<RankedPlayer>>;
  vip: VipRule | null;
  weapons: WeaponBoard | null;
};

const named = <T extends { steamId?: string }>(rows: T[], idOf: IdOf): Public<T>[] =>
  rows.map(({ steamId, ...row }) => {
    const id = steamId === undefined ? undefined : idOf(steamId);
    return id === undefined ? row : { ...row, id };
  });

// Everyone the public stats name, so their public ids can be worked out before publicStats needs them.
export const namedSteamIds = (stats: SiteStats, leaderboard: Leaderboard): string[] => {
  const rows = [
    ...stats.matches.flatMap((m) => m.top),
    ...(stats.currentMatch?.top ?? []),
    ...leaderboard.kills,
    ...leaderboard.kd,
    ...leaderboard.playtime,
    ...leaderboard.seeding,
  ];
  return [...new Set(rows.flatMap((p) => (p.steamId === undefined ? [] : [p.steamId])))];
};

// Every reading in the last DAYS_KEPT days (today included) counts once, so an hour's average is its players summed
// over its readings. Its busy share is its busy readings over the readings checked against `busyThreshold`; days
// counted under another threshold, or before busy readings were counted, are left out. Averages are rounded to a
// tenth and shares to a hundredth to keep the JSON short.
export const hourlyAverages = (hours: HourTotals[], now: number, busyThreshold: number): Hourly => {
  const oldest = dayOf(now - (DAYS_KEPT - 1) * DAY_MS);
  const kept = hours.filter((h) => h.day >= oldest);
  const sameThreshold = kept.filter((h) => h.busyThreshold === busyThreshold);
  const total = (days: HourTotals[], pick: (h: HourTotals) => number[], hour: number) =>
    days.reduce((sum, h) => sum + (pick(h)[hour] ?? 0), 0);
  const ratio = (part: number, whole: number, places: number) =>
    whole === 0 ? null : Math.round((part / whole) * places) / places;
  return {
    days: DAYS_KEPT,
    players: Array.from({ length: 24 }, (_, hour) =>
      ratio(total(kept, (h) => h.players, hour), total(kept, (h) => h.readings, hour), 10),
    ),
    busy: Array.from({ length: 24 }, (_, hour) =>
      ratio(total(sameThreshold, (h) => h.busy, hour), total(sameThreshold, (h) => h.checked, hour), 100),
    ),
  };
};

export const publicStats = (
  { hours, matches, currentMatch, ...stats }: SiteStats,
  thresholds: Thresholds,
  now: number,
  { leaderboard, vip, weapons }: PublicExtras,
  idOf: IdOf,
): PublicStats => ({
  generatedAt: now,
  thresholds,
  ...stats,
  matches: matches.map((m) => ({ ...m, top: named(m.top, idOf) })),
  currentMatch: currentMatch === null ? null : { ...currentMatch, top: named(currentMatch.top, idOf) },
  hourly: hourlyAverages(hours, now, thresholds.busy),
  leaderboard: {
    days: leaderboard.days,
    kdMinMatches: leaderboard.kdMinMatches,
    kills: named(leaderboard.kills, idOf),
    kd: named(leaderboard.kd, idOf),
    playtime: named(leaderboard.playtime, idOf),
    seeding: named(leaderboard.seeding, idOf),
  },
  vip,
  weapons,
});
