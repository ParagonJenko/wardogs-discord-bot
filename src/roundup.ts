import { z } from 'zod';
import { factionKey } from './discord.ts';
import { leaderboard, totals, type MatchRecord, type PlayerDay, type RankedPlayer } from './players.ts';
import type { FactionScore } from './rcon.ts';
import { dayOf } from './stats.ts';
import { byKills } from './tracking.ts';

// Weekly and monthly roundups: the best players and the best team over a UTC week (Monday to Sunday) or calendar month,
// from the player records. Posted to Discord when a week or month ends, and shown by /roundup. Players are named with
// their public ids, never their Steam IDs, so a roundup can go anywhere.

export type RoundupKind = 'week' | 'month';

// A UTC week or month: from `start` up to, not including, `end`. A period still going (`partial`) ends now.
export type Period = { kind: RoundupKind; start: number; end: number; partial: boolean };

// What /roundup can show: the last full week or month, or the one going on now.
export const ROUNDUP_CHOICES = ['week', 'month', 'this-week', 'this-month'] as const;
export type RoundupChoice = (typeof ROUNDUP_CHOICES)[number];

const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;

// Each board's top this many.
export const AWARDS_SHOWN = 3;
// As on the leaderboard's K/D board: a team needs this many matches to be the best team.
export const TEAM_MIN_MATCHES = 3;

const startOf = (kind: RoundupKind, at: number): number => {
  const d = new Date(at);
  if (kind === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  // getUTCDay is 0 on Sunday; weeks start on Monday.
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
};

// The last full week or month before `now`.
export const lastPeriod = (kind: RoundupKind, now: number): Period => {
  const end = startOf(kind, now);
  return { kind, start: startOf(kind, end - 1), end, partial: false };
};

// The week or month going on at `now`, up to now.
export const currentPeriod = (kind: RoundupKind, now: number): Period => ({ kind, start: startOf(kind, now), end: now, partial: true });

export const periodFor = (choice: RoundupChoice, now: number): Period =>
  choice === 'this-week'
    ? currentPeriod('week', now)
    : choice === 'this-month'
      ? currentPeriod('month', now)
      : lastPeriod(choice, now);

// The UTC days a period covers, oldest first.
export const periodDays = (period: Period): string[] =>
  Array.from({ length: Math.ceil((period.end - period.start) / DAY_MS) }, (_, i) => dayOf(period.start + i * DAY_MS)).filter(
    (day) => Date.parse(`${day}T00:00:00Z`) < period.end,
  );

// Which roundups have gone out: the first day of the last week and the last month posted.
export type RoundupsPosted = { week?: string; month?: string };

const PostedSchema = z.object({ week: z.string().optional(), month: z.string().optional() });

export const parseRoundupsPosted = (raw: unknown): RoundupsPosted => {
  const parsed = PostedSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
};

// The roundups to post now: the week or month just ended, from `hour` (UTC) on the first day of the next one. Not
// after that day, so a bot deployed mid-week waits for the next week rather than posting a stale one.
export const dueRoundups = (posted: RoundupsPosted, now: number, hour: number): Period[] =>
  (['week', 'month'] as const).flatMap((kind) => {
    const period = lastPeriod(kind, now);
    const from = period.end + hour * HOUR_MS;
    const due = now >= from && now < period.end + DAY_MS && posted[kind] !== dayOf(period.start);
    return due ? [period] : [];
  });

export const markPosted = (posted: RoundupsPosted, period: Period): RoundupsPosted => ({ ...posted, [period.kind]: dayOf(period.start) });

// A player in a roundup, by their public id when they have one.
export type RoundupPlayer = { name: string; id?: string };

export type TeamStanding = { name: string; colorHex?: string; matches: number; wins: number; losses: number; draws: number };

export type MatchHighlight = { map: string; endedAt: number; factionScores: FactionScore[] };

export type Roundup = {
  kind: RoundupKind;
  start: number;
  end: number;
  partial: boolean;
  matches: number;
  // The matches' length added up, from when each went live.
  playedMs: number;
  // Everyone seen on the server.
  players: number;
  // The most players in any match. Null without matches.
  peakPlayers: number | null;
  // The day with the most players on.
  busiestDay: { day: string; players: number } | null;
  // Best first: win rate, then wins, then fewest losses, among the teams with TEAM_MIN_MATCHES; the rest after.
  teams: TeamStanding[];
  // The best team, when one is clearly ahead of the rest.
  bestTeam: TeamStanding | null;
  teamMinMatches: number;
  kdMinMatches: number;
  kills: (RoundupPlayer & { kills: number })[];
  kd: (RoundupPlayer & { kd: number })[];
  playtime: (RoundupPlayer & { minutes: number })[];
  seeding: (RoundupPlayer & { seedDays: number; minutes: number })[];
  // Matches won on the winning side, out of the matches they played with a result.
  wins: (RoundupPlayer & { wins: number; played: number })[];
  // Times top of a match's scoreboard.
  mvps: (RoundupPlayer & { mvps: number })[];
  // Each player's best match, by kills.
  bestMatch: (RoundupPlayer & { kills: number; deaths: number; map: string })[];
  biggestWin: MatchHighlight | null;
  closestMatch: MatchHighlight | null;
  // The map played most, when one was played more than any other.
  topMap: { map: string; matches: number } | null;
};

// Looks up a player's public id by Steam ID (see profiles.ts).
export type IdOf = (steamId: string) => string | undefined;

export type RoundupSources = {
  period: Period;
  // Each UTC day's player totals. Days outside the period are left out.
  days: { day: string; players: PlayerDay }[];
  // Match records, in any order. Matches count in the period they ended in.
  matches: MatchRecord[];
  idOf: IdOf;
};

const ranked = (scores: FactionScore[]): FactionScore[] => [...scores].sort((a, b) => b.score - a.score);

// The winning side's key, 'draw', or null for a match without two sides' scores.
const winner = (scores: FactionScore[]): string | null => {
  const [first, second] = ranked(scores);
  if (first === undefined || second === undefined) return null;
  return first.score === second.score ? 'draw' : factionKey(first.name);
};

const margin = (scores: FactionScore[]): number => {
  const [first, second] = ranked(scores);
  return (first?.score ?? 0) - (second?.score ?? 0);
};

const winRate = (t: TeamStanding): number => t.wins / Math.max(t.matches, 1);

const qualified = (t: TeamStanding): boolean => t.matches >= TEAM_MIN_MATCHES;

const byStanding = (a: TeamStanding, b: TeamStanding): number =>
  Number(qualified(b)) - Number(qualified(a)) ||
  winRate(b) - winRate(a) ||
  b.wins - a.wins ||
  a.losses - b.losses ||
  a.name.localeCompare(b.name);

// Every side's wins, losses and draws, oldest match first so each keeps its latest name and colour.
const standings = (matches: MatchRecord[]): TeamStanding[] => {
  const teams = new Map<string, TeamStanding>();
  for (const match of matches) {
    const won = winner(match.factionScores);
    if (won === null) continue;
    const top = ranked(match.factionScores)[0]?.score;
    for (const side of match.factionScores) {
      const key = factionKey(side.name);
      const known = teams.get(key) ?? { name: side.name, matches: 0, wins: 0, losses: 0, draws: 0 };
      const draw = won === 'draw' && side.score === top;
      const win = won === key;
      const colorHex = side.colorHex ?? known.colorHex;
      teams.set(key, {
        name: side.name,
        ...(colorHex === undefined ? {} : { colorHex }),
        matches: known.matches + 1,
        wins: known.wins + (win ? 1 : 0),
        losses: known.losses + (win || draw ? 0 : 1),
        draws: known.draws + (draw ? 1 : 0),
      });
    }
  }
  return [...teams.values()].sort(byStanding);
};

// The top team, when it played enough, won something, and is ahead of the next on win rate or else on wins.
const best = (teams: TeamStanding[]): TeamStanding | null => {
  const [first, second] = teams;
  if (first === undefined || !qualified(first) || first.wins === 0) return null;
  if (second === undefined || !qualified(second)) return first;
  return winRate(first) > winRate(second) || (winRate(first) === winRate(second) && first.wins > second.wins) ? first : null;
};

const top = <T>(rows: T[], order: (a: T, b: T) => number): T[] => [...rows].sort(order).slice(0, AWARDS_SHOWN);

// Null when nobody was on the server in the period.
export const buildRoundup = ({ period, days, matches, idOf }: RoundupSources): Roundup | null => {
  const covered = new Set(periodDays(period));
  const inPeriod = days.filter((d) => covered.has(d.day) && Object.keys(d.players).length > 0);
  if (inPeriod.length === 0) return null;
  const played = matches
    .filter((m) => m.endedAt >= period.start && m.endedAt < period.end)
    .sort((a, b) => a.endedAt - b.endedAt);

  const named = <T extends object>(steamId: string, name: string, row: T): RoundupPlayer & T => {
    const id = idOf(steamId);
    return { name, ...(id === undefined ? {} : { id }), ...row };
  };
  const fromBoard = <T extends object>(rows: RankedPlayer[], pick: (p: RankedPlayer) => T) =>
    rows.map((p) => named(p.steamId, p.name, pick(p)));

  const board = leaderboard(inPeriod.map((d) => d.players), covered.size, AWARDS_SHOWN);

  // Matches are oldest first, so each player keeps the name from their latest match.
  const wins = new Map<string, { name: string; wins: number; played: number }>();
  const mvps = new Map<string, { name: string; mvps: number }>();
  const bests = new Map<string, { name: string; kills: number; deaths: number; map: string }>();
  for (const match of played) {
    const won = winner(match.factionScores);
    for (const p of match.players) {
      if (won !== null && p.faction !== undefined) {
        const known = wins.get(p.steamId) ?? { wins: 0, played: 0 };
        const win = won === factionKey(p.faction);
        wins.set(p.steamId, { name: p.name, wins: known.wins + (win ? 1 : 0), played: known.played + 1 });
      }
      const mine = bests.get(p.steamId);
      const better = mine === undefined || byKills(p, mine) < 0;
      bests.set(p.steamId, { ...(better ? { kills: p.kills, deaths: p.deaths, map: match.map } : mine), name: p.name });
    }
    // Everyone level with the top of the scoreboard is an MVP, once they have a kill.
    const [first] = [...match.players].sort(byKills);
    if (first === undefined || first.kills === 0) continue;
    for (const p of match.players) {
      if (byKills(p, first) === 0) mvps.set(p.steamId, { name: p.name, mvps: (mvps.get(p.steamId)?.mvps ?? 0) + 1 });
    }
  }
  const rows = <T extends { name: string }>(tally: Map<string, T>): (RoundupPlayer & Omit<T, 'name'>)[] =>
    [...tally].map(([steamId, { name, ...row }]) => named(steamId, name, row));

  const decisive = played.filter((m) => {
    const won = winner(m.factionScores);
    return won !== null && won !== 'draw';
  });
  // Ties go to the latest match.
  const pickBy = (score: (m: MatchRecord) => number): MatchRecord | null =>
    decisive.reduce<MatchRecord | null>((chosen, m) => (chosen === null || score(m) >= score(chosen) ? m : chosen), null);
  const biggest = pickBy((m) => margin(m.factionScores));
  const closest = pickBy((m) => -margin(m.factionScores));
  const highlight = (m: MatchRecord | null): MatchHighlight | null =>
    m === null ? null : { map: m.map, endedAt: m.endedAt, factionScores: m.factionScores };

  const maps = new Map<string, number>();
  for (const m of played) maps.set(m.map, (maps.get(m.map) ?? 0) + 1);
  const [mostPlayed, nextMost] = [...maps].sort((a, b) => b[1] - a[1]);

  const busiest = inPeriod
    .map((d) => ({ day: d.day, players: Object.keys(d.players).length }))
    .reduce<{ day: string; players: number } | null>((chosen, d) => (chosen === null || d.players > chosen.players ? d : chosen), null);

  const teams = standings(played);
  return {
    kind: period.kind,
    start: period.start,
    end: period.end,
    partial: period.partial,
    matches: played.length,
    playedMs: played.reduce((sum, m) => sum + m.durationMs, 0),
    players: totals(inPeriod.map((d) => d.players)).length,
    peakPlayers: played.length === 0 ? null : Math.max(...played.map((m) => m.peakPlayers)),
    busiestDay: busiest,
    teams,
    bestTeam: best(teams),
    teamMinMatches: TEAM_MIN_MATCHES,
    kdMinMatches: board.kdMinMatches,
    kills: fromBoard(board.kills, (p) => ({ kills: p.kills })),
    kd: fromBoard(board.kd, (p) => ({ kd: p.kills / Math.max(p.deaths, 1) })),
    playtime: fromBoard(board.playtime, (p) => ({ minutes: p.seedingMinutes + p.liveMinutes })),
    seeding: fromBoard(board.seeding, (p) => ({ seedDays: p.seedDays, minutes: p.seedingMinutes })),
    wins: top(
      rows(wins).filter((p) => p.wins > 0),
      (a, b) => b.wins - a.wins || a.played - b.played || a.name.localeCompare(b.name),
    ),
    mvps: top(rows(mvps), (a, b) => b.mvps - a.mvps || a.name.localeCompare(b.name)),
    bestMatch: top(
      rows(bests).filter((p) => p.kills > 0),
      (a, b) => byKills(a, b) || a.name.localeCompare(b.name),
    ),
    biggestWin: highlight(biggest),
    // Only one decisive match, or all won by as much, has no closest finish of its own.
    closestMatch: closest === biggest ? null : highlight(closest),
    topMap: mostPlayed !== undefined && (nextMost === undefined || mostPlayed[1] > nextMost[1]) ? { map: mostPlayed[0], matches: mostPlayed[1] } : null,
  };
};
