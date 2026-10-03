import type { FactionScore, Player, ServerStatus } from './rcon.ts';

// Seeding: how many checks each player was online for while the server was filling up.
export type SeedingTally = Record<string, { name: string; checks: number }>;

export const tallySeeding = (tally: SeedingTally, players: Player[]): SeedingTally =>
  players.reduce<SeedingTally>(
    (acc, p) => ({ ...acc, [p.steamId]: { name: p.name, checks: (acc[p.steamId]?.checks ?? 0) + 1 } }),
    tally,
  );

// Staff (`staff`, by Steam ID) are never top seeders.
export const topSeeders = (
  tally: SeedingTally,
  count: number,
  staff: ReadonlySet<string> = new Set(),
): { name: string; checks: number }[] =>
  Object.entries(tally)
    .flatMap(([steamId, s]) => (staff.has(steamId) ? [] : [s]))
    .sort((a, b) => b.checks - a.checks)
    .slice(0, count);

// Matches: WARDOGS RCON does not report when a match ends, so a new match is recognised by the map changing, by a
// restart on the same map (the faction scores drop and most players' counters start again from 0), or by the server
// emptying. One player's counters starting again (they rejoined) is not a new match. The summary uses the last stats
// seen before that, so it can miss up to one check of the final minute.
export type PlayerStats = { name: string; kills: number; deaths: number };

// A player on a match's scoreboard. The Steam ID is missing from summaries saved before it was kept; it never goes on
// the website as it is (see profiles.ts).
export type RankedStats = PlayerStats & { steamId?: string };

// A player's totals for the match, and the counters RCON last reported for them. The counters start again from 0
// when a player rejoins, so the totals only ever add what is new since the last reading. `faction` is the side they
// were last seen on, when the server says.
export type TrackedPlayer = PlayerStats & { lastKills: number; lastDeaths: number; faction?: string };

export type MatchState = {
  key: string;
  startedAt: number;
  lastSeenAt: number;
  // When the server was first seen live during this match; null while it has only been seeding.
  liveAt: number | null;
  // False for a match that was already live when the bot started: its start was never seen.
  summarisable: boolean;
  peakPlayers: number;
  players: Record<string, TrackedPlayer>;
  factionScores: FactionScore[];
};

export type MatchSummary = {
  map: string;
  durationMs: number;
  peakPlayers: number;
  factionScores: FactionScore[];
  top: RankedStats[];
};

const TOP_PLAYERS = 5;

const matchKey = (status: ServerStatus): string => `${status.map}#${status.rotationIndex ?? ''}`;

const keyMap = (key: string): string => key.slice(0, key.lastIndexOf('#'));

// The map a match is on, as RCON names it, or '' when no reading has had it yet.
export const matchMap = (match: MatchState): string => keyMap(match.key);

// Only the map counts: the rotation slot can move when an admin edits the rotation, and a reading can leave the map out.
const mapChanged = (match: MatchState, status: ServerStatus): boolean => {
  const before = keyMap(match.key);
  return status.map !== '' && before !== '' && status.map !== before;
};

const totalScore = (scores: FactionScore[]): number => scores.reduce((sum, s) => sum + s.score, 0);

// A restart on the same map: most players' counters start again from 0, and the faction scores (which only go up
// during a match) drop. Either alone is one player rejoining, or a bad reading.
const restarted = (match: MatchState, status: ServerStatus, players: Player[]): boolean => {
  const compared = players.flatMap((p) => {
    const known = match.players[p.steamId];
    if (known === undefined || p.kills === null || p.deaths === null || known.lastKills + known.lastDeaths === 0) return [];
    return [p.kills < known.lastKills || p.deaths < known.lastDeaths];
  });
  const reset = compared.filter(Boolean).length;
  if (reset === 0 || reset * 2 <= compared.length) return false;
  const before = totalScore(match.factionScores);
  const scoresDropped = status.factionScores.length > 0 && before > 0 && totalScore(status.factionScores) < before / 2;
  return scoresDropped || status.factionScores.length === 0 || match.factionScores.length === 0;
};

// Adds what is new since the last reading; a counter below the last one has started again from 0.
const counted = (total: number, last: number, now: number | null): number =>
  now === null ? total : now >= last ? total + now - last : total + now;

// A reading without the faction keeps the one seen before.
const sideOf = (known: TrackedPlayer | undefined, p: Player): { faction?: string } => {
  const faction = p.faction ?? known?.faction;
  return faction ? { faction } : {};
};

const track = (known: TrackedPlayer | undefined, p: Player): TrackedPlayer => {
  if (known === undefined) {
    const kills = p.kills ?? 0;
    const deaths = p.deaths ?? 0;
    return { name: p.name, kills, deaths, lastKills: kills, lastDeaths: deaths, ...sideOf(known, p) };
  }
  return {
    name: p.name,
    kills: counted(known.kills, known.lastKills, p.kills),
    deaths: counted(known.deaths, known.lastDeaths, p.deaths),
    lastKills: p.kills ?? known.lastKills,
    lastDeaths: p.deaths ?? known.lastDeaths,
    ...sideOf(known, p),
  };
};

// Most kills first, then fewest deaths: the order of every scoreboard the bot shows.
export const byKills = (a: PlayerStats, b: PlayerStats): number => b.kills - a.kills || a.deaths - b.deaths;

export const topPlayers = (players: Record<string, PlayerStats>, count = TOP_PLAYERS): RankedStats[] =>
  Object.entries(players)
    .sort(([, a], [, b]) => byKills(a, b))
    .slice(0, count)
    .map(([steamId, { name, kills, deaths }]) => ({ steamId, name, kills, deaths }));

export const summarise = (match: MatchState): MatchSummary => ({
  map: keyMap(match.key),
  durationMs: match.lastSeenAt - (match.liveAt ?? match.lastSeenAt),
  peakPlayers: match.peakPlayers,
  factionScores: match.factionScores,
  top: topPlayers(match.players),
});

// The bot reads the server once a minute, so the last reading before a match ends can come just before the winning
// point. A side alone on one point short of the winning score when its match ends won it, so it gets the winning score.
// The same scores come back when nothing changes.
export const settleWin = (scores: FactionScore[], scoreToWin: number): FactionScore[] => {
  const [first, second] = [...scores].sort((a, b) => b.score - a.score);
  if (first === undefined || first.score !== scoreToWin - 1 || second?.score === first.score) return scores;
  return scores.map((s) => (s === first ? { ...s, score: scoreToWin } : s));
};

const freshMatch = (status: ServerStatus, now: number, summarisable: boolean): MatchState => ({
  key: matchKey(status),
  startedAt: now,
  lastSeenAt: now,
  liveAt: null,
  summarisable,
  peakPlayers: 0,
  players: {},
  factionScores: [],
});

// Without this, a server left empty overnight on the same map would carry on the evening's match the next day.
const emptied = (match: MatchState, status: ServerStatus, players: Player[]): boolean =>
  match.peakPlayers > 0 && status.players === 0 && players.length === 0;

// `finished` is the match that just ended, when it went live and the bot saw it start.
export const observeMatch = (
  previous: MatchState | null,
  status: ServerStatus,
  players: Player[],
  live: boolean,
  now: number,
): { match: MatchState; finished: MatchState | null } => {
  const isNew =
    previous === null ||
    mapChanged(previous, status) ||
    restarted(previous, status, players) ||
    emptied(previous, status, players);
  const base = isNew ? freshMatch(status, now, !(previous === null && live)) : previous;

  const match: MatchState = {
    ...base,
    // Keeps the latest map and slot, but not a reading that left the map out.
    key: status.map === '' ? base.key : matchKey(status),
    // A match starts when someone is first seen in it, not while the server sits empty on the map.
    startedAt: base.peakPlayers === 0 ? now : base.startedAt,
    lastSeenAt: now,
    liveAt: base.liveAt ?? (live ? now : null),
    peakPlayers: Math.max(base.peakPlayers, status.players),
    players: {
      ...base.players,
      ...Object.fromEntries(
        players.map((p) => [p.steamId, track(base.players[p.steamId], p)]),
      ),
    },
    factionScores: status.factionScores.length > 0 ? status.factionScores : base.factionScores,
  };

  const finished = isNew && previous !== null && previous.summarisable && previous.liveAt !== null ? previous : null;
  return { match, finished };
};
