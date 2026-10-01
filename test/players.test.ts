import { describe, expect, it } from 'vitest';
import {
  leaderboard,
  matchRecord,
  matchRecordKey,
  parseMatchRecord,
  parsePlayerDay,
  playerDayKey,
  rankSeeders,
  ranks,
  recentDayKeys,
  recordActivity,
  recordMatchPlayers,
  recordSeed,
  totals,
  unrecordMatchPlayers,
  type PlayerDay,
  type PlayerTotals,
} from '../src/players.ts';
import type { Player } from '../src/rcon.ts';
import type { MatchState } from '../src/tracking.ts';

// 2026-09-30T12:00:00Z
const NOON = Date.UTC(2026, 8, 30, 12);

const player = (steamId: string, name = `P${steamId}`): Player => ({ steamId, name, kills: 0, deaths: 0 });

const row = (name: string, values: Partial<PlayerTotals> = {}): PlayerTotals => ({
  name,
  seedingMinutes: 0,
  liveMinutes: 0,
  seedDays: 0,
  matches: 0,
  kills: 0,
  deaths: 0,
  ...values,
});

const match: MatchState = {
  key: 'Kavkazi#0',
  startedAt: NOON - 45 * 60_000,
  lastSeenAt: NOON,
  liveAt: NOON - 40 * 60_000,
  summarisable: true,
  peakPlayers: 30,
  players: {
    a: { name: 'Ash', kills: 12, deaths: 3, lastKills: 12, lastDeaths: 3 },
    b: { name: 'Bo', kills: 4, deaths: 9, lastKills: 4, lastDeaths: 9 },
  },
  factionScores: [
    { name: 'Valkyra', score: 300 },
    { name: 'Kharr', score: 250 },
  ],
};

describe('keys', () => {
  it('stores a day per UTC date and a match by its start time, in order', () => {
    expect(playerDayKey(NOON)).toBe('players:2026-09-30');
    expect(matchRecordKey(NOON)).toBe('match:001790769600000');
    expect(matchRecordKey(5) < matchRecordKey(NOON)).toBe(true);
  });

  it('lists today and the days before it, oldest first', () => {
    expect(recentDayKeys(NOON, 3)).toEqual(['players:2026-09-28', 'players:2026-09-29', 'players:2026-09-30']);
  });
});

describe('recordActivity', () => {
  it('counts seeding and live minutes for everyone online, by Steam ID', () => {
    const day = [
      { players: [player('a')], kind: 'seeding' as const },
      { players: [player('a'), player('b')], kind: 'seeding' as const },
      { players: [player('a'), player('b')], kind: 'live' as const },
    ].reduce<PlayerDay>((acc, check) => recordActivity(acc, check.players, check.kind, 1), {});

    expect(day).toEqual({
      a: row('Pa', { seedingMinutes: 2, liveMinutes: 1 }),
      b: row('Pb', { seedingMinutes: 1, liveMinutes: 1 }),
    });
  });

  it('keeps the latest name a player used', () => {
    const day = recordActivity(recordActivity({}, [player('a', 'Old')], 'seeding', 1), [player('a', 'New')], 'seeding', 1);

    expect(day['a']).toMatchObject({ name: 'New', seedingMinutes: 2 });
  });
});

describe('recordSeed', () => {
  it('marks the day for seeders on for more than the minimum, once however often it is recorded', () => {
    const seeders = [
      { steamId: 'a', name: 'Ash', minutes: 11 },
      { steamId: 'b', name: 'Bo', minutes: 10 },
    ];
    const day = recordSeed(recordSeed(recordActivity({}, [player('a', 'Ash')], 'seeding', 11), seeders, 10), seeders, 10);

    expect(day).toEqual({ a: row('Ash', { seedingMinutes: 11, seedDays: 1 }) });
  });
});

describe('recordMatchPlayers', () => {
  it('adds the match, kills and deaths to everyone who played, keeping their minutes', () => {
    const before = recordActivity({}, [player('a', 'Ash')], 'seeding', 5);

    expect(recordMatchPlayers(recordMatchPlayers(before, match), match)).toEqual({
      a: row('Ash', { seedingMinutes: 5, matches: 2, kills: 24, deaths: 6 }),
      b: row('Bo', { matches: 2, kills: 8, deaths: 18 }),
    });
  });
});

describe('unrecordMatchPlayers', () => {
  it('takes a match back off its players, leaving their minutes and anyone else alone', () => {
    const before = recordMatchPlayers(recordActivity({ c: row('Cy', { matches: 1 }) }, [player('a', 'Ash')], 'live', 30), match);

    expect(unrecordMatchPlayers(before, matchRecord(match, NOON).players)).toEqual({
      a: row('Ash', { liveMinutes: 30 }),
      b: row('Bo'),
      c: row('Cy', { matches: 1 }),
    });
  });

  it('never goes below zero, and skips players the day does not have', () => {
    const day = { a: row('Ash', { matches: 0, kills: 5, deaths: 1 }) };

    expect(unrecordMatchPlayers(day, matchRecord(match, NOON).players)).toEqual({ a: row('Ash') });
  });
});

describe('matchRecord', () => {
  it('keeps every player with their Steam ID, and the map name players see', () => {
    expect(matchRecord(match, NOON + 60_000)).toEqual({
      map: 'Bakurani',
      startedAt: NOON - 45 * 60_000,
      liveAt: NOON - 40 * 60_000,
      endedAt: NOON + 60_000,
      durationMs: 40 * 60_000,
      peakPlayers: 30,
      factionScores: match.factionScores,
      players: [
        { steamId: 'a', name: 'Ash', kills: 12, deaths: 3 },
        { steamId: 'b', name: 'Bo', kills: 4, deaths: 9 },
      ],
    });
  });
});

describe('totals and rankings', () => {
  const monday: PlayerDay = {
    a: row('Ash', { seedingMinutes: 30, liveMinutes: 60, seedDays: 1, matches: 2, kills: 20, deaths: 5 }),
    b: row('Bo', { seedingMinutes: 50 }),
  };
  const tuesday: PlayerDay = {
    a: row('Ash2', { seedingMinutes: 40, liveMinutes: 10, seedDays: 1, matches: 1, kills: 3, deaths: 1 }),
    c: row('Cy', { liveMinutes: 90, matches: 3, kills: 30, deaths: 12 }),
  };

  it('adds up days, keeping the most recent name', () => {
    expect(totals([monday, tuesday])).toEqual([
      { steamId: 'a', ...row('Ash2', { seedingMinutes: 70, liveMinutes: 70, seedDays: 2, matches: 3, kills: 23, deaths: 6 }) },
      { steamId: 'b', ...row('Bo', { seedingMinutes: 50 }) },
      { steamId: 'c', ...row('Cy', { liveMinutes: 90, matches: 3, kills: 30, deaths: 12 }) },
    ]);
  });

  it('ranks seeders by seed days, then minutes, leaving out players who never seeded', () => {
    const wednesday: PlayerDay = { b: row('Bo', { seedingMinutes: 100, seedDays: 1 }) };

    expect(rankSeeders([monday, tuesday], 5).map((p) => p.steamId)).toEqual(['a', 'b']);
    expect(rankSeeders([monday, tuesday, wednesday], 5).map((p) => [p.steamId, p.seedDays, p.seedingMinutes])).toEqual([
      ['a', 2, 70],
      ['b', 1, 150],
    ]);
    expect(rankSeeders([monday, tuesday], 1)).toHaveLength(1);
  });

  it('builds the leaderboard, keeping Steam IDs for publicStats to swap for public ids', () => {
    const board = leaderboard([monday, tuesday], 30, 2);

    expect(board).toMatchObject({ days: 30, kdMinMatches: 3 });
    expect(board.kills.map((p) => [p.name, p.kills])).toEqual([
      ['Cy', 30],
      ['Ash2', 23],
    ]);
    // Both played 3 matches: Ash2 23/6 = 3.83 beats Cy 30/12 = 2.5.
    expect(board.kd.map((p) => p.name)).toEqual(['Ash2', 'Cy']);
    expect(board.playtime.map((p) => p.name)).toEqual(['Ash2', 'Cy']);
    expect(board.seeding.map((p) => p.name)).toEqual(['Ash2', 'Bo']);
    expect(board.kills.map((p) => p.steamId)).toEqual(['c', 'a']);
  });

  it('leaves players with too few matches off the K/D board', () => {
    const lucky: PlayerDay = { d: row('Dee', { matches: 1, kills: 9, deaths: 0 }) };

    expect(leaderboard([monday, tuesday, lucky], 30, 10).kd.map((p) => p.name)).not.toContain('Dee');
  });
});

describe('ranks', () => {
  const days: PlayerDay[] = [
    {
      a: row('Ash', { liveMinutes: 100, matches: 3, kills: 30, deaths: 10, seedingMinutes: 5 }),
      b: row('Bo', { liveMinutes: 300, matches: 4, kills: 10, deaths: 1 }),
      c: row('Cy', { liveMinutes: 10, matches: 1, kills: 50, deaths: 1, seedingMinutes: 40, seedDays: 1 }),
    },
  ];

  it('places a player on each board by the leaderboard’s own rules', () => {
    // K/D needs 3 matches, so Cy's 50 is left off it.
    expect(ranks(totals(days), 'a', 30)).toEqual({ days: 30, kdMinMatches: 3, players: 3, kills: 2, kd: 2, playtime: 2, seeding: 2 });
    expect(ranks(totals(days), 'c', 30)).toMatchObject({ kills: 1, kd: null, seeding: 1 });
  });

  it('leaves a player off a board they have nothing for', () => {
    expect(ranks(totals(days), 'b', 30)).toMatchObject({ kd: 1, seeding: null });
    expect(ranks(totals(days), 'nobody', 30)).toMatchObject({ kills: null, kd: null, playtime: null, seeding: null });
  });
});

describe('parseMatchRecord', () => {
  it('reads back a stored match, and refuses anything else', () => {
    const record = matchRecord(match, NOON);

    expect(parseMatchRecord(structuredClone(record))).toEqual(record);
    expect(parseMatchRecord({ map: 'Ozeti' })).toBeNull();
  });

  it('keeps the side each player ended on, and reads matches recorded without sides', () => {
    const sided: MatchState = { ...match, players: { ...match.players, a: { ...match.players['a']!, faction: 'Valkyra' } } };
    const record = matchRecord(sided, NOON);

    expect(record.players).toEqual([
      { steamId: 'a', name: 'Ash', kills: 12, deaths: 3, faction: 'Valkyra' },
      { steamId: 'b', name: 'Bo', kills: 4, deaths: 9 },
    ]);
    expect(parseMatchRecord(structuredClone(record))).toEqual(record);
  });
});

describe('parsePlayerDay', () => {
  it('reads back what was saved, and treats nothing saved as an empty day', () => {
    const day = recordMatchPlayers(recordActivity({}, [player('a')], 'live', 1), match);

    expect(parsePlayerDay(structuredClone(day))).toEqual(day);
    expect(parsePlayerDay(undefined)).toEqual({});
  });
});
