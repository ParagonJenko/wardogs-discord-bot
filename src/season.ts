import { z } from 'zod';
import { factionKey } from './discord.ts';
import type { MatchRecord, PlayerDay } from './players.ts';
import { publicPlayer, type PublicIdOf } from './privacy.ts';
import type { FactionScore } from './rcon.ts';
import { buildRoundup, periodDays, type FeedSources, type MatchHighlight, type Period, type Roundup } from './roundup.ts';
import { dayOf } from './stats.ts';
import { teamBoard, type MapTeams } from './teams.ts';
import { weaponBoard, type WeaponBoard, type WeaponDay } from './weapons.ts';

// The season roundup, for the website's season page: everything the bot recorded in a game season, from the first day of
// its records up to the wipe that ends the season. The same records and rules as the weekly and monthly roundups (see
// roundup.ts), with each board's top 10, and on top of them each day's players and matches, the season's totals, each
// map's wins, the longest winning streak, the longest match and the quickest win, and the weapons. The public only sees
// it once the season is over; staff can see the season so far. Once the season is over the bot keeps it, so it stays the
// same when the kill feed's records of those days are gone (KILL_DAYS_STORED in killfeed.ts).

// The wipe that ends the season: 15 October 2026, 00:00 UTC (1am in the UK). Matches count in the season they ended in.
export const SEASON = { number: 1, name: 'Season 1', endsAt: Date.UTC(2026, 9, 15) } as const;

// Each board's top this many.
export const SEASON_SHOWN = 10;

// The roundup is kept once the season has been over this long, so the last check before the end has saved its records.
export const SEASON_SETTLE_MS = 10 * 60_000;

// Where the kept roundup is stored. Changing SEASON_VERSION has it built again, from the records still kept.
export const SEASON_KEY = `season:${SEASON.number}`;
export const SEASON_VERSION = 1;

// One UTC day: everyone on the server, their minutes added up, the matches that ended, and the most players in them.
export type SeasonDay = { day: string; players: number; minutes: number; matches: number; peak: number | null };

// Everyone's kills, deaths (from the matches' scoreboards), time played, seeding time and seed days, added up.
export type SeasonTotals = { kills: number; deaths: number; minutes: number; seedingMinutes: number; seedDays: number };

export type SeasonMatch = MatchHighlight & { durationMs: number };

// The most matches one team won in a row, from the first of them to the last.
export type SeasonStreak = { name: string; colorHex?: string; wins: number; from: number; to: number };

export type SeasonRoundup = Roundup & {
  days: SeasonDay[];
  totals: SeasonTotals;
  // The matches with a result: their average length, and each map's, with each team's wins there (as in teams.ts).
  averageMs: number;
  maps: MapTeams[];
  streak: SeasonStreak | null;
  longestMatch: SeasonMatch | null;
  // The shortest match a team won by reaching the winning score, so not one cut short.
  quickestWin: SeasonMatch | null;
  // Null without the kill feed.
  weapons: WeaponBoard | null;
};

// What /api/season serves. `open` once the season is over, when the public gets the roundup; before that, only staff
// do. `roundup` is null for the public before then, and when nobody played.
export type SeasonPage = { number: number; name: string; endsAt: number; open: boolean; roundup: SeasonRoundup | null };

export type SeasonSources = {
  // The first UTC day of the records.
  firstDay: string;
  now: number;
  // Each UTC day's player totals, staff's seeding counted as playing (see withoutStaffSeeding). Days outside the season
  // are left out.
  days: { day: string; players: PlayerDay }[];
  // Match records, in any order. Matches count in the season they ended in.
  matches: MatchRecord[];
  // Each of the season's UTC days' weapons, and the first day of the kill feed (null before it), for the weapons.
  weaponDays: WeaponDay[];
  weaponsSince: string | null;
  // Left out without the kill feed.
  feed?: FeedSources;
  // The score that wins a match, for the quickest win.
  scoreToWin: number;
};

// From the first day of the records up to the end of the season, or up to now while it is still going. Null before the
// records start.
export const seasonPeriod = (firstDay: string, now: number): Period | null => {
  const start = Date.parse(`${firstDay}T00:00:00Z`);
  const end = Math.min(now, SEASON.endsAt);
  return Number.isNaN(start) || start >= end ? null : { kind: 'season', start, end, partial: now < SEASON.endsAt };
};

// The roundup is built with every player's Steam ID as their `id`, so it can be kept and still follow players making
// their profiles private or public: publicSeason swaps them for public ids each time it is served.
const steamIds: PublicIdOf = (steamId) => steamId;

const winnerOf = (scores: FactionScore[]): FactionScore | null => {
  const [first, second] = [...scores].sort((a, b) => b.score - a.score);
  return first === undefined || second === undefined || first.score === second.score ? null : first;
};

const seasonMatch = (m: MatchRecord): SeasonMatch => ({ map: m.map, endedAt: m.endedAt, factionScores: m.factionScores, durationMs: m.durationMs });

// The match `better` picks, ties going to the latest. `matches` are oldest first.
const pick = (matches: MatchRecord[], better: (a: MatchRecord, b: MatchRecord) => boolean): SeasonMatch | null => {
  const found = matches.reduce<MatchRecord | null>((chosen, m) => (chosen === null || !better(chosen, m) ? m : chosen), null);
  return found === null ? null : seasonMatch(found);
};

// The longest run of wins by one team, ties going to the latest. `matches` are oldest first.
const longestStreak = (matches: MatchRecord[]): SeasonStreak | null => {
  const runs: SeasonStreak[] = [];
  for (const m of matches) {
    const won = winnerOf(m.factionScores);
    if (won === null) continue;
    const last = runs.at(-1);
    const going = last !== undefined && factionKey(last.name) === factionKey(won.name) ? last : undefined;
    const colorHex = won.colorHex ?? going?.colorHex;
    const run: SeasonStreak = {
      name: won.name,
      ...(colorHex === undefined ? {} : { colorHex }),
      wins: (going?.wins ?? 0) + 1,
      from: going?.from ?? m.endedAt,
      to: m.endedAt,
    };
    if (going === undefined) runs.push(run);
    else runs[runs.length - 1] = run;
  }
  return runs.reduce<SeasonStreak | null>((best, run) => (best === null || run.wins >= best.wins ? run : best), null);
};

// Null when nobody was on the server in the season, or the records have not started.
export const buildSeason = (sources: SeasonSources): SeasonRoundup | null => {
  const period = seasonPeriod(sources.firstDay, sources.now);
  if (period === null) return null;
  const { days, matches, feed } = sources;
  const roundup = buildRoundup({ period, days, matches, idOf: steamIds, shown: SEASON_SHOWN, ...(feed === undefined ? {} : { feed }) });
  if (roundup === null) return null;

  const covered = periodDays(period);
  const played = matches.filter((m) => m.endedAt >= period.start && m.endedAt < period.end).sort((a, b) => a.endedAt - b.endedAt);
  const byDay = new Map(days.map((d) => [d.day, d.players]));
  const seasonDays = covered.map((day): SeasonDay => {
    const players = Object.values(byDay.get(day) ?? {});
    const ended = played.filter((m) => dayOf(m.endedAt) === day);
    return {
      day,
      players: players.length,
      minutes: players.reduce((sum, t) => sum + t.seedingMinutes + t.liveMinutes, 0),
      matches: ended.length,
      peak: ended.length === 0 ? null : Math.max(...ended.map((m) => m.peakPlayers)),
    };
  });
  const totals = covered
    .flatMap((day) => Object.values(byDay.get(day) ?? {}))
    .reduce<SeasonTotals>(
      (sum, t) => ({
        kills: sum.kills + t.kills,
        deaths: sum.deaths + t.deaths,
        minutes: sum.minutes + t.seedingMinutes + t.liveMinutes,
        seedingMinutes: sum.seedingMinutes + t.seedingMinutes,
        seedDays: sum.seedDays + t.seedDays,
      }),
      { kills: 0, deaths: 0, minutes: 0, seedingMinutes: 0, seedDays: 0 },
    );
  // The board takes the matches of the days up to `end`; the season's are all of them.
  const teams = teamBoard(played, covered.length, period.end - 1);
  const timed = played.filter((m) => m.durationMs > 0);
  const won = timed.filter((m) => (winnerOf(m.factionScores)?.score ?? 0) >= sources.scoreToWin);

  return {
    ...roundup,
    days: seasonDays,
    totals,
    averageMs: teams.averageMs,
    maps: teams.maps,
    streak: longestStreak(played),
    longestMatch: pick(timed, (chosen, m) => chosen.durationMs > m.durationMs),
    quickestWin: pick(won, (chosen, m) => chosen.durationMs < m.durationMs),
    weapons:
      sources.weaponsSince === null ? null : weaponBoard(sources.weaponDays, covered.length, sources.weaponsSince, SEASON_SHOWN, steamIds),
  };
};

type Kept = { id: string; name: string };

// A player in a roundup built by buildSeason: the only objects in it with both a string `id` and `name`.
const isKept = (value: unknown): value is Kept =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Partial<Kept>).id === 'string' &&
  typeof (value as Partial<Kept>).name === 'string';

// The Steam IDs of everyone in a roundup built by buildSeason.
export const keptSteamIds = (roundup: SeasonRoundup): string[] => {
  const found = new Set<string>();
  JSON.stringify(roundup, (_key, value: unknown) => {
    if (isKept(value)) found.add(value.id);
    return value;
  });
  return [...found];
};

// A roundup built by buildSeason as the public sees it: each player with their public id, or a private profile's name
// and no id.
export const publicSeason = (roundup: SeasonRoundup, idOf: PublicIdOf): SeasonRoundup =>
  JSON.parse(JSON.stringify(roundup), (_key, value: unknown) => {
    if (!isKept(value)) return value;
    const { id, name, ...rest } = value;
    return { ...rest, ...publicPlayer(id, name, idOf) };
  }) as SeasonRoundup;

// The roundup as kept in storage, once the season is over.
export const keptSeason = (roundup: SeasonRoundup) => ({ version: SEASON_VERSION, roundup });

const KeptSchema = z.object({
  version: z.number(),
  roundup: z.looseObject({ kind: z.literal('season'), start: z.number(), end: z.number(), partial: z.literal(false) }),
});

// The kept roundup, or null when there is none, or it was built by another SEASON_VERSION. Only the bot writes it, as
// keptSeason, so the rest is taken as it is.
export const parseKeptSeason = (raw: unknown): SeasonRoundup | null => {
  const parsed = KeptSchema.safeParse(raw);
  return parsed.success && parsed.data.version === SEASON_VERSION ? (parsed.data.roundup as unknown as SeasonRoundup) : null;
};

