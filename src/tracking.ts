import type { FactionScore, Player, ServerStatus } from './rcon.ts';

// Seeding: how many checks each player was online for while the server was filling up.
export type SeedingTally = Record<string, { name: string; checks: number }>;

export const tallySeeding = (tally: SeedingTally, players: Player[]): SeedingTally =>
  players.reduce<SeedingTally>(
    (acc, p) => ({ ...acc, [p.steamId]: { name: p.name, checks: (acc[p.steamId]?.checks ?? 0) + 1 } }),
    tally,
  );

export const topSeeders = (tally: SeedingTally, count: number): { name: string; checks: number }[] =>
  Object.values(tally)
    .sort((a, b) => b.checks - a.checks)
    .slice(0, count);

// Matches: WARDOGS RCON does not report when a match ends, so a new match is recognised by the map or
// rotation slot changing, or by a player's kills or deaths going backwards (a restart on the same map).
// The summary uses the last stats seen before that, so it can miss up to one check of the final minute.
export type PlayerStats = { name: string; kills: number; deaths: number };

export type MatchState = {
  key: string;
  startedAt: number;
  lastSeenAt: number;
  // When the server was first seen live during this match; null while it has only been seeding.
  liveAt: number | null;
  peakPlayers: number;
  players: Record<string, PlayerStats>;
  factionScores: FactionScore[];
};

export type MatchSummary = {
  map: string;
  durationMs: number;
  peakPlayers: number;
  factionScores: FactionScore[];
  top: PlayerStats[];
};

const TOP_PLAYERS = 5;

const matchKey = (status: ServerStatus): string => `${status.map}#${status.rotationIndex ?? ''}`;

const statsWentBackwards = (match: MatchState, players: Player[]): boolean =>
  players.some((p) => {
    const before = match.players[p.steamId];
    return before !== undefined && (p.kills < before.kills || p.deaths < before.deaths);
  });

export const topPlayers = (players: Record<string, PlayerStats>, count = TOP_PLAYERS): PlayerStats[] =>
  Object.values(players)
    .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
    .slice(0, count);

const summarise = (match: MatchState): MatchSummary => ({
  map: match.key.split('#')[0] ?? '',
  durationMs: match.lastSeenAt - (match.liveAt ?? match.lastSeenAt),
  peakPlayers: match.peakPlayers,
  factionScores: match.factionScores,
  top: topPlayers(match.players),
});

const freshMatch = (status: ServerStatus, now: number): MatchState => ({
  key: matchKey(status),
  startedAt: now,
  lastSeenAt: now,
  liveAt: null,
  peakPlayers: 0,
  players: {},
  factionScores: [],
});

export const observeMatch = (
  previous: MatchState | null,
  status: ServerStatus,
  players: Player[],
  live: boolean,
  now: number,
): { match: MatchState; finished: MatchSummary | null } => {
  const isNew =
    previous === null || previous.key !== matchKey(status) || statsWentBackwards(previous, players);
  const base = isNew ? freshMatch(status, now) : previous;

  const match: MatchState = {
    ...base,
    lastSeenAt: now,
    liveAt: base.liveAt ?? (live ? now : null),
    peakPlayers: Math.max(base.peakPlayers, status.players),
    players: {
      ...base.players,
      ...Object.fromEntries(players.map((p) => [p.steamId, { name: p.name, kills: p.kills, deaths: p.deaths }])),
    },
    factionScores: status.factionScores.length > 0 ? status.factionScores : base.factionScores,
  };

  const finished = isNew && previous !== null && previous.liveAt !== null ? summarise(previous) : null;
  return { match, finished };
};
