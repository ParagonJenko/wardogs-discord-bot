import { z } from 'zod';
import { factionKey } from './discord.ts';
import type { KillDaySummary } from './killfeed.ts';
import { leaderboard, totals, type MatchRecord, type PlayerDay, type RankedPlayer } from './players.ts';
import type { FactionScore } from './rcon.ts';
import { dayOf } from './stats.ts';
import { byKills } from './tracking.ts';
import { weaponKind, weaponName, weaponRole, type WeaponRole } from './weapons.ts';

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
// A team needs this many matches to be the best team.
export const TEAM_MIN_MATCHES = 3;
// A rookie is first seen in the period, by records going back at least this many days before it.
export const ROOKIE_LOOKBACK_DAYS = 28;

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

// How many days the whole week or month has, including those still to come of one going on now.
const fullLength = (period: Period): number =>
  Math.round((startOf(period.kind, period.start + (period.kind === 'week' ? 7 : 32) * DAY_MS) - period.start) / DAY_MS);

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
  // Time played the K/D board needs: the leaderboard's share for the whole week or month, even one still going.
  kdMinHours: number;
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
  // On the server on the most of the period's days (`of`; so far, for a period still going).
  regular: (RoundupPlayer & { days: number; of: number }) | null;
  // The rookie who played the most. See ROOKIE_LOOKBACK_DAYS.
  rookie: (RoundupPlayer & { minutes: number }) | null;
  // Null without the kill feed's records, or kills in them.
  awards: FeedAwards | null;
};

// The weapons the awards name the best players for: assault (assault rifles, SMGs, shotguns), support (mortars,
// artillery and the other emplacements), machine guns, marksman (marksman and sniper rifles, the bow), demolition
// (launchers, grenades, mines, C4) and a vehicle's guns. See weaponRole.
export const ROLE_AWARDS = [
  'assault',
  'support',
  'machine-gun',
  'marksman',
  'demolition',
  'vehicle-gun',
] as const satisfies readonly WeaponRole[];
export type RoleAward = (typeof ROLE_AWARDS)[number];

type Kills = RoundupPlayer & { kills: number };

// The awards from the kill feed. Team kills do not count, except on days saved before the bot kept them apart, which
// have no longest shots.
export type FeedAwards = {
  // The first UTC day of the period the feed covers: later than the period's first when the feed began during it.
  from: string;
  // The top 3 by kills with each role's weapons, in the order of ROLE_AWARDS.
  roles: { role: RoleAward; top: Kills[] }[];
  // Each award goes to one player, null when nobody earned it.
  headshots: (RoundupPlayer & { headshots: number }) | null;
  // With a hand-held weapon.
  longest: (RoundupPlayer & { distance: number; weapon: string }) | null;
  // Kills with the most different weapons.
  variety: (RoundupPlayer & { weapons: number }) | null;
  // Running someone over, or blowing up a vehicle with them in it.
  roadKills: Kills | null;
  melee: Kills | null;
  sidearm: Kills | null;
};

// Looks up a player's public id by Steam ID (see profiles.ts).
export type IdOf = (steamId: string) => string | undefined;

// The kill feed's records for the awards (see killfeed.ts).
export type FeedSources = {
  // The first UTC day the kill records have.
  since: string;
  // Each player's kill days. Days outside the period are left out.
  kills: KillDaySummary[];
};

export type RoundupSources = {
  period: Period;
  // Each UTC day's player totals. Days before the period tell rookies from the rest; days after it are left out.
  days: { day: string; players: PlayerDay }[];
  // Match records, in any order. Matches count in the period they ended in.
  matches: MatchRecord[];
  idOf: IdOf;
  // Left out without the kill feed.
  feed?: FeedSources;
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

const minutesOf = (p: { seedingMinutes: number; liveMinutes: number }): number => p.seedingMinutes + p.liveMinutes;

// The most first, then by name. Nobody without any.
const mostFirst = <T extends { name: string }>(rows: T[], value: (row: T) => number): T[] =>
  rows.filter((row) => value(row) > 0).sort((a, b) => value(b) - value(a) || a.name.localeCompare(b.name));

// The awards from the kill feed's records over the period's days. `named` gives a player their name and public id.
const feedAwards = (
  feed: FeedSources,
  covered: string[],
  named: <T extends object>(steamId: string, name: string, row: T) => RoundupPlayer & T,
  nameOf: Map<string, string>,
): FeedAwards | null => {
  const first = covered[0] ?? '';
  const from = feed.since > first ? feed.since : first;
  const inPeriod = new Set(covered.filter((day) => day >= from));
  type Tally = { roles: Map<WeaponRole, number>; headshots: number; kills: number; weapons: Set<string>; name: string };
  const players = new Map<string, Tally>();
  // With a hand-held weapon. Ties go to the earliest, which got there first.
  let longest: { distance: number; steamId: string; cause: string } | null = null;
  // Days are oldest first, so each player keeps their latest name, unless the player records have one.
  for (const d of [...feed.kills].sort((a, b) => a.day.localeCompare(b.day))) {
    if (!inPeriod.has(d.day)) continue;
    const known = players.get(d.steamId) ?? { roles: new Map(), headshots: 0, kills: 0, weapons: new Set(), name: d.steamId };
    if (d.name !== '') known.name = d.name;
    for (const [cause, w] of Object.entries(d.weapons)) {
      if (w.longest !== undefined && weaponKind(cause) === 'weapon' && (longest === null || w.longest > longest.distance)) {
        longest = { distance: w.longest, steamId: d.steamId, cause };
      }
      const kills = w.kills - (w.teamKills ?? 0);
      if (kills <= 0) continue;
      const role = weaponRole(cause);
      known.roles.set(role, (known.roles.get(role) ?? 0) + kills);
      known.kills += kills;
      known.headshots += w.headshots - (w.teamHeadshots ?? 0);
      known.weapons.add(weaponName(cause));
    }
    players.set(d.steamId, known);
  }
  const rows = [...players].map(([steamId, t]) => ({ steamId, ...t, name: nameOf.get(steamId) ?? t.name }));
  if (rows.every((row) => row.kills === 0)) return null;
  const roleKills = (role: WeaponRole) => (row: Tally) => row.roles.get(role) ?? 0;
  const board = (role: WeaponRole): Kills[] =>
    mostFirst(rows, roleKills(role))
      .slice(0, AWARDS_SHOWN)
      .map((row) => named(row.steamId, row.name, { kills: roleKills(role)(row) }));
  const winner = (role: WeaponRole): Kills | null => board(role)[0] ?? null;
  // Fewer kills for as many headshots is the better aim.
  const [headshots] = rows
    .filter((row) => row.headshots > 0)
    .sort((a, b) => b.headshots - a.headshots || a.kills - b.kills || a.name.localeCompare(b.name));
  const [variety] = mostFirst(rows, (row) => row.weapons.size);
  const holder = longest === null ? undefined : rows.find((row) => row.steamId === longest?.steamId);

  return {
    from,
    roles: ROLE_AWARDS.map((role) => ({ role, top: board(role) })),
    headshots: headshots === undefined ? null : named(headshots.steamId, headshots.name, { headshots: headshots.headshots }),
    longest:
      longest === null || holder === undefined
        ? null
        : named(longest.steamId, holder.name, { distance: longest.distance, weapon: weaponName(longest.cause) }),
    variety: variety === undefined ? null : named(variety.steamId, variety.name, { weapons: variety.weapons.size }),
    roadKills: winner('vehicle'),
    melee: winner('melee'),
    sidearm: winner('sidearm'),
  };
};

// Null when nobody was on the server in the period.
export const buildRoundup = ({ period, days, matches, idOf, feed }: RoundupSources): Roundup | null => {
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

  const board = leaderboard(inPeriod.map((d) => d.players), fullLength(period), AWARDS_SHOWN);

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

  // Each player's latest name in the period, the days they were on and their minutes.
  const nameOf = new Map<string, string>();
  const onDays = new Map<string, { name: string; days: number; minutes: number }>();
  for (const d of inPeriod) {
    for (const [steamId, t] of Object.entries(d.players)) {
      const known = onDays.get(steamId) ?? { days: 0, minutes: 0 };
      nameOf.set(steamId, t.name);
      onDays.set(steamId, { name: t.name, days: known.days + (minutesOf(t) > 0 ? 1 : 0), minutes: known.minutes + minutesOf(t) });
    }
  }
  // More minutes breaks a tie on days.
  const [regular] = [...onDays]
    .filter(([, p]) => p.days > 0)
    .sort(([, a], [, b]) => b.days - a.days || b.minutes - a.minutes || a.name.localeCompare(b.name));

  // Rookies: on in the period, and on none of the days kept before it, once those go back far enough to tell.
  const earlier = days.filter((d) => d.day < dayOf(period.start));
  const seen = new Set(
    earlier.flatMap((d) => Object.entries(d.players).flatMap(([steamId, t]) => (minutesOf(t) > 0 ? [steamId] : []))),
  );
  const recordsFrom = earlier.flatMap((d) => (Object.keys(d.players).length > 0 ? [d.day] : [])).sort()[0];
  const longEnough = recordsFrom !== undefined && recordsFrom <= dayOf(period.start - ROOKIE_LOOKBACK_DAYS * DAY_MS);
  const rookies = [...onDays].flatMap(([steamId, p]) => (seen.has(steamId) ? [] : [{ steamId, ...p }]));
  const [rookie] = longEnough ? mostFirst(rookies, (p) => p.minutes) : [];

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
    kdMinHours: board.kdMinHours,
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
    regular: regular === undefined ? null : named(regular[0], regular[1].name, { days: regular[1].days, of: covered.size }),
    rookie: rookie === undefined ? null : named(rookie.steamId, rookie.name, { minutes: rookie.minutes }),
    awards: feed === undefined ? null : feedAwards(feed, periodDays(period), named, nameOf),
  };
};
