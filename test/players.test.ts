import { describe, expect, it } from 'vitest';
import {
  matchRecord,
  matchRecordKey,
  parsePlayerDay,
  playerDayKey,
  rankSeeders,
  recentDayKeys,
  recordActivity,
  recordMatchPlayers,
  totals,
  type PlayerDay,
} from '../src/players.ts';
import type { Player } from '../src/rcon.ts';
import type { MatchState } from '../src/tracking.ts';

// 2026-09-30T12:00:00Z
const NOON = Date.UTC(2026, 8, 30, 12);
const DAY = 24 * 60 * 60_000;

const player = (steamId: string, name = `P${steamId}`): Player => ({ steamId, name, kills: 0, deaths: 0 });

const match: MatchState = {
  key: 'Kavkazi#0',
  startedAt: NOON - 45 * 60_000,
  lastSeenAt: NOON,
  liveAt: NOON - 40 * 60_000,
  summarisable: true,
  peakPlayers: 30,
  players: {
    a: { name: 'Ash', kills: 12, deaths: 3 },
    b: { name: 'Bo', kills: 4, deaths: 9 },
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
      { players: [player('a')], phase: 'seeding' as const },
      { players: [player('a'), player('b')], phase: 'seeding' as const },
      { players: [player('a'), player('b')], phase: 'live' as const },
      { players: [player('a')], phase: 'empty' as const },
    ].reduce<PlayerDay>((acc, check) => recordActivity(acc, check.players, check.phase, 1), {});

    expect(day).toEqual({
      a: { name: 'Pa', seedingMinutes: 2, liveMinutes: 1, matches: 0, kills: 0, deaths: 0 },
      b: { name: 'Pb', seedingMinutes: 1, liveMinutes: 1, matches: 0, kills: 0, deaths: 0 },
    });
  });

  it('keeps the latest name a player used', () => {
    const day = recordActivity(recordActivity({}, [player('a', 'Old')], 'seeding', 1), [player('a', 'New')], 'seeding', 1);

    expect(day['a']).toMatchObject({ name: 'New', seedingMinutes: 2 });
  });
});

describe('recordMatchPlayers', () => {
  it('adds the match, kills and deaths to everyone who played, keeping their minutes', () => {
    const before = recordActivity({}, [player('a', 'Ash')], 'seeding', 5);

    expect(recordMatchPlayers(recordMatchPlayers(before, match), match)).toEqual({
      a: { name: 'Ash', seedingMinutes: 5, liveMinutes: 0, matches: 2, kills: 24, deaths: 6 },
      b: { name: 'Bo', seedingMinutes: 0, liveMinutes: 0, matches: 2, kills: 8, deaths: 18 },
    });
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

describe('totals and rankSeeders', () => {
  const monday: PlayerDay = {
    a: { name: 'Ash', seedingMinutes: 30, liveMinutes: 60, matches: 2, kills: 20, deaths: 5 },
    b: { name: 'Bo', seedingMinutes: 50, liveMinutes: 0, matches: 0, kills: 0, deaths: 0 },
  };
  const tuesday: PlayerDay = {
    a: { name: 'Ash2', seedingMinutes: 40, liveMinutes: 10, matches: 1, kills: 3, deaths: 1 },
    c: { name: 'Cy', seedingMinutes: 0, liveMinutes: 90, matches: 3, kills: 30, deaths: 12 },
  };

  it('adds up days, keeping the most recent name', () => {
    expect(totals([monday, tuesday])).toEqual([
      { steamId: 'a', name: 'Ash2', seedingMinutes: 70, liveMinutes: 70, matches: 3, kills: 23, deaths: 6 },
      { steamId: 'b', name: 'Bo', seedingMinutes: 50, liveMinutes: 0, matches: 0, kills: 0, deaths: 0 },
      { steamId: 'c', name: 'Cy', seedingMinutes: 0, liveMinutes: 90, matches: 3, kills: 30, deaths: 12 },
    ]);
  });

  it('ranks seeders by minutes, leaving out players who never seeded', () => {
    expect(rankSeeders([monday, tuesday], 5).map((p) => [p.steamId, p.seedingMinutes])).toEqual([
      ['a', 70],
      ['b', 50],
    ]);
    expect(rankSeeders([monday, tuesday], 1)).toHaveLength(1);
  });
});

describe('parsePlayerDay', () => {
  it('reads back what was saved, and treats nothing saved as an empty day', () => {
    const day = recordMatchPlayers(recordActivity({}, [player('a')], 'live', 1), match);

    expect(parsePlayerDay(structuredClone(day))).toEqual(day);
    expect(parsePlayerDay(undefined)).toEqual({});
  });
});
