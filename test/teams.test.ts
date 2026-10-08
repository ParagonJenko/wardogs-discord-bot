import { describe, expect, it } from 'vitest';
import type { MatchRecord } from '../src/players.ts';
import { teamBoard } from '../src/teams.ts';

const DAY = 24 * 60 * 60_000;
const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 3, 12);

// A match that ended `ago` before NOW, with each team's score, as in the game: [name, score, colour].
const match = (map: string, ago: number, scores: [string, number, string?][], durationMs = 40 * MIN): MatchRecord => ({
  map,
  startedAt: NOW - ago - durationMs,
  liveAt: NOW - ago - durationMs,
  endedAt: NOW - ago,
  durationMs,
  peakPlayers: 60,
  factionScores: scores.map(([name, score, colorHex]) => ({ name, score, ...(colorHex === undefined ? {} : { colorHex }) })),
  players: [],
});

describe('teamBoard', () => {
  it('counts each team’s wins, most first, named and coloured as in their latest match', () => {
    const board = teamBoard(
      [
        match('Ozeti', 3 * DAY, [['VALKYRA', 300, '#ff0000'], ['Kharr', 250]]),
        match('Ozeti', 2 * DAY, [['Kharr', 300, '#0000ff'], ['Valkyra', 120]]),
        match('Bakurani', DAY, [['Valkyra', 300], ['Kharr', 280, '#0000ff']]),
      ],
      30,
      NOW,
    );

    expect(board.teams).toEqual([
      { name: 'Valkyra', colorHex: '#ff0000', matches: 3, wins: 2 },
      { name: 'Kharr', colorHex: '#0000ff', matches: 3, wins: 1 },
    ]);
    expect(board).toMatchObject({ days: 30, matches: 3, averageMs: 40 * MIN });
  });

  it('breaks the wins down by map, most played first, with the average length', () => {
    const board = teamBoard(
      [
        match('Bakurani', 4 * DAY, [['Valkyra', 300], ['Kharr', 100], ['Haldor', 90]], 30 * MIN),
        match('Ozeti', 3 * DAY, [['Kharr', 300], ['Valkyra', 120]], 50 * MIN),
        match('Ozeti', DAY, [['Valkyra', 300], ['Kharr', 10]], 40 * MIN),
      ],
      30,
      NOW,
    );

    expect(board.maps).toEqual([
      { map: 'Ozeti', matches: 2, averageMs: 45 * MIN, teams: [{ name: 'Kharr', wins: 1 }, { name: 'Valkyra', wins: 1 }] },
      {
        map: 'Bakurani',
        matches: 1,
        averageMs: 30 * MIN,
        teams: [{ name: 'Valkyra', wins: 1 }, { name: 'Haldor', wins: 0 }, { name: 'Kharr', wins: 0 }],
      },
    ]);
    expect(board.teams.find((t) => t.name === 'Haldor')).toEqual({ name: 'Haldor', matches: 1, wins: 0 });
  });

  it('only counts matches with a result, from two teams’ scores, that ended in the days asked, by UTC day', () => {
    const startOfFirstDay = Date.UTC(2026, 8, 4);
    const board = teamBoard(
      [
        { ...match('Ozeti', 0, [['Valkyra', 300], ['Kharr', 1]]), endedAt: startOfFirstDay },
        { ...match('Ozeti', 0, [['Valkyra', 300], ['Kharr', 1]]), endedAt: startOfFirstDay - 1 },
        match('Ozeti', DAY, [['Valkyra', 300]]),
        match('Ozeti', DAY, []),
      ],
      30,
      NOW,
    );

    expect(board.matches).toBe(1);
  });

  it('leaves out a match with the top teams level: teams never draw, so the bot missed who won', () => {
    const board = teamBoard(
      [
        match('Ozeti', 2 * DAY, [['Valkyra', 300], ['Kharr', 100]], 30 * MIN),
        match('Bakurani', DAY, [['Valkyra', 0], ['Kharr', 0], ['Haldor', 0]], 170 * MIN),
        match('Ozeti', DAY, [['Kharr', 299], ['Valkyra', 299], ['Haldor', 50]]),
      ],
      30,
      NOW,
    );

    expect(board).toMatchObject({ matches: 1, averageMs: 30 * MIN });
    expect(board.teams).toEqual([
      { name: 'Valkyra', matches: 1, wins: 1 },
      { name: 'Kharr', matches: 1, wins: 0 },
    ]);
    expect(board.maps.map((m) => m.map)).toEqual(['Ozeti']);
  });

  it('follows the latest winner’s streak, which another team’s win ends and a match with no result does not', () => {
    const won = (ago: number, winner: string, loser: string) => match('Ozeti', ago, [[winner, 300], [loser, 100]]);

    expect(teamBoard([won(4 * DAY, 'Valkyra', 'Kharr'), won(3 * DAY, 'Kharr', 'Valkyra'), won(2 * DAY, 'Kharr', 'Valkyra'), won(DAY, 'Kharr', 'Valkyra')], 30, NOW).streak).toEqual({
      name: 'Kharr',
      wins: 3,
    });
    expect(teamBoard([won(3 * DAY, 'Kharr', 'Valkyra'), match('Ozeti', 2 * DAY, [['Kharr', 300], ['Valkyra', 300]]), won(DAY, 'Kharr', 'Valkyra')], 30, NOW).streak).toEqual({
      name: 'Kharr',
      wins: 2,
    });
    expect(teamBoard([match('Ozeti', DAY, [['Kharr', 300], ['Valkyra', 300]])], 30, NOW).streak).toBeNull();
  });

  it('finds the closest finish and the biggest win over the next team, the later on a tie, never a match with no result', () => {
    const narrow = match('Ozeti', 4 * DAY, [['Valkyra', 300], ['Kharr', 299]]);
    const narrowLater = match('Bakurani', 3 * DAY, [['Kharr', 300], ['Valkyra', 299], ['Haldor', 5]]);
    const rout = match('Zestafona', 2 * DAY, [['Valkyra', 300], ['Kharr', 20]]);
    const level = match('Ozeti', DAY, [['Valkyra', 300], ['Kharr', 300]]);

    const board = teamBoard([narrow, narrowLater, rout, level], 30, NOW);

    expect(board.closest).toEqual({
      map: 'Bakurani',
      endedAt: narrowLater.endedAt,
      durationMs: narrowLater.durationMs,
      factionScores: narrowLater.factionScores,
    });
    expect(board.biggest?.map).toBe('Zestafona');
  });

  it('is empty without matches', () => {
    expect(teamBoard([], 30, NOW)).toEqual({
      days: 30,
      matches: 0,
      averageMs: 0,
      teams: [],
      maps: [],
      streak: null,
      closest: null,
      biggest: null,
    });
  });
});
