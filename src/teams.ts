import { factionKey } from './discord.ts';
import type { MatchRecord } from './players.ts';
import type { FactionScore } from './rcon.ts';
import { dayOf } from './stats.ts';

// Which team wins most, for the website's teams page: the matches the bot recorded over a number of UTC days, by team
// and by map. A match goes to the team with the most points. Teams never draw, so a match recorded with the top teams
// level has no result: the bot missed the winning points, or the match was cut short. Those are left out, and so are
// matches recorded without two teams' scores. Teams are matched by name whatever its case or spacing, and named and
// coloured as in their latest match.

export type TeamStanding = { name: string; colorHex?: string; matches: number; wins: number };

// A map's matches, how long they took on average, and each team that played it, most wins first.
export type MapTeams = { map: string; matches: number; averageMs: number; teams: { name: string; wins: number }[] };

export type TeamMatch = { map: string; endedAt: number; durationMs: number; factionScores: FactionScore[] };

export type TeamBoard = {
  days: number;
  matches: number;
  averageMs: number;
  // Most wins first.
  teams: TeamStanding[];
  // Most played first.
  maps: MapTeams[];
  // The team that won the latest match, and how many in a row it has won since a match it did not win.
  streak: { name: string; wins: number } | null;
  // The win by the fewest and by the most points over the next team.
  closest: TeamMatch | null;
  biggest: TeamMatch | null;
};

type Scored = { record: MatchRecord; ranked: FactionScore[]; winner: string; margin: number };

const scored = (record: MatchRecord): Scored | null => {
  const ranked = [...record.factionScores].sort((a, b) => b.score - a.score);
  const [first, second] = ranked;
  if (first === undefined || second === undefined || first.score === second.score) return null;
  return { record, ranked, winner: factionKey(first.name), margin: first.score - second.score };
};

const average = (list: Scored[]): number =>
  list.length === 0 ? 0 : Math.round(list.reduce((sum, s) => sum + s.record.durationMs, 0) / list.length);

const teamMatch = ({ record }: Scored): TeamMatch => ({
  map: record.map,
  endedAt: record.endedAt,
  durationMs: record.durationMs,
  factionScores: record.factionScores,
});

const byWins = <T extends { name: string; wins: number }>(a: T, b: T): number => b.wins - a.wins || a.name.localeCompare(b.name);

// The board for the matches that ended in the last `days` UTC days, today included.
export const teamBoard = (records: MatchRecord[], days: number, now: number): TeamBoard => {
  const first = dayOf(now - (days - 1) * 24 * 60 * 60_000);
  const matches = records
    .filter((r) => dayOf(r.endedAt) >= first && r.endedAt <= now)
    .sort((a, b) => a.endedAt - b.endedAt)
    .flatMap((r) => scored(r) ?? []);

  // Oldest first, so each team keeps the name and colour of its latest match.
  const teams = new Map<string, TeamStanding>();
  const maps = new Map<string, { list: Scored[]; wins: Map<string, number> }>();
  for (const match of matches) {
    const onMap = maps.get(match.record.map) ?? { list: [], wins: new Map<string, number>() };
    onMap.list.push(match);
    maps.set(match.record.map, onMap);
    for (const s of match.ranked) {
      const key = factionKey(s.name);
      const known = teams.get(key);
      const won = match.winner === key ? 1 : 0;
      const colorHex = s.colorHex ?? known?.colorHex;
      teams.set(key, {
        name: s.name,
        ...(colorHex === undefined ? {} : { colorHex }),
        matches: (known?.matches ?? 0) + 1,
        wins: (known?.wins ?? 0) + won,
      });
      onMap.wins.set(key, (onMap.wins.get(key) ?? 0) + won);
    }
  }
  const nameOf = (key: string): string => teams.get(key)?.name ?? key;

  const latest = matches.at(-1);
  const streakTeam = latest?.winner ?? null;
  let streak = 0;
  for (let i = matches.length - 1; i >= 0 && matches[i]?.winner === streakTeam; i--) streak++;

  // A tie goes to the later match.
  const pick = (better: (a: Scored, b: Scored) => boolean): TeamMatch | null => {
    const found = matches.reduce<Scored | null>((best, m) => (best === null || !better(best, m) ? m : best), null);
    return found === null ? null : teamMatch(found);
  };

  return {
    days,
    matches: matches.length,
    averageMs: average(matches),
    teams: [...teams.values()].sort(byWins),
    maps: [...maps]
      .map(([map, { list, wins }]) => ({
        map,
        matches: list.length,
        averageMs: average(list),
        teams: [...wins].map(([key, w]) => ({ name: nameOf(key), wins: w })).sort(byWins),
      }))
      .sort((a, b) => b.matches - a.matches || a.map.localeCompare(b.map)),
    streak: streakTeam === null ? null : { name: nameOf(streakTeam), wins: streak },
    closest: pick((best, m) => best.margin < m.margin),
    biggest: pick((best, m) => best.margin > m.margin),
  };
};
