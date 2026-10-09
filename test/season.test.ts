import { describe, expect, it } from 'vitest';
import type { KillDaySummary } from '../src/killfeed.ts';
import type { MatchPlayer, MatchRecord, PlayerDay, PlayerTotals } from '../src/players.ts';
import { PRIVATE_NAME } from '../src/privacy.ts';
import {
  buildSeason,
  keptSeason,
  keptSteamIds,
  parseKeptSeason,
  publicSeason,
  SEASON,
  SEASON_SHOWN,
  SEASON_VERSION,
  seasonPeriod,
  type SeasonRoundup,
  type SeasonSources,
} from '../src/season.ts';
import type { WeaponDay } from '../src/weapons.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (date: string, hour = 0): number => Date.parse(`${date}T00:00:00Z`) + hour * HOUR;

// The season ends at the start of 15 Oct 2026, UTC.
const AFTER = at('2026-10-15', 12);

const totals = (name: string, values: Partial<PlayerTotals> = {}): PlayerTotals => ({
  name,
  seedingMinutes: 0,
  liveMinutes: 0,
  seedDays: 0,
  matches: 0,
  kills: 0,
  deaths: 0,
  ...values,
});

const p = (steamId: string, name: string, kills: number, deaths: number, faction: string): MatchPlayer => ({ steamId, name, kills, deaths, faction });

const match = (endedAt: number, map: string, scores: [string, number][], players: MatchPlayer[], minutes = 50, peak = 40): MatchRecord => ({
  map,
  startedAt: endedAt - (minutes + 5) * MINUTE,
  liveAt: endedAt - minutes * MINUTE,
  endedAt,
  durationMs: minutes * MINUTE,
  peakPlayers: peak,
  factionScores: scores.map(([name, score]) => ({ name, score, ...(name === 'Valkyra' ? { colorHex: '#3366ff' } : {}) })),
  players,
});

const day = (date: string, players: PlayerDay) => ({ day: date, players });

const days = [
  day('2026-10-12', {
    a: totals('Ash', { liveMinutes: 120, seedingMinutes: 30, seedDays: 1, matches: 2, kills: 20, deaths: 10 }),
    b: totals('Bo', { liveMinutes: 60, matches: 1, kills: 5, deaths: 5 }),
  }),
  day('2026-10-13', { a: totals('Ash', { liveMinutes: 90, matches: 1, kills: 12, deaths: 4 }) }),
  day('2026-10-14', {
    a: totals('Ash', { liveMinutes: 30, matches: 1, kills: 2, deaths: 1 }),
    c: totals('Cy', { liveMinutes: 200, seedingMinutes: 15, seedDays: 1, matches: 1, kills: 30, deaths: 2 }),
  }),
  // After the wipe: Season 2.
  day('2026-10-15', { d: totals('Di', { liveMinutes: 500, kills: 900 }) }),
];

const matches = [
  match(at('2026-10-12', 18), 'Ozeti', [['Valkyra', 100], ['Lonestar', 60]], [p('a', 'Ash', 10, 5, 'Valkyra'), p('b', 'Bo', 5, 5, 'Lonestar')], 45, 60),
  match(at('2026-10-12', 20), 'Ozeti', [['Valkyra', 100], ['Lonestar', 98]], [p('a', 'Ash', 10, 5, 'Valkyra')], 70, 64),
  match(at('2026-10-13', 20), 'Bakurani', [['Valkyra', 100], ['Lonestar', 20]], [p('a', 'Ash', 12, 4, 'Valkyra')], 30, 50),
  // Cut short by a map change: a result, but nobody reached the winning score, so it is not the quickest win.
  match(at('2026-10-14', 19), 'Bakurani', [['Lonestar', 12], ['Valkyra', 8]], [p('c', 'Cy', 3, 0, 'Lonestar')], 10, 30),
  match(at('2026-10-14', 21), 'Zestafona', [['Lonestar', 100], ['Valkyra', 40]], [p('a', 'Ash', 2, 1, 'Valkyra'), p('c', 'Cy', 27, 2, 'Lonestar')], 55, 40),
  // Level: no result.
  match(at('2026-10-14', 23), 'Ozeti', [['Lonestar', 50], ['Valkyra', 50]], [], 80, 20),
  // Ended after the wipe.
  match(at('2026-10-15', 1), 'Ozeti', [['Lonestar', 100], ['Valkyra', 0]], [p('d', 'Di', 900, 0, 'Lonestar')], 5, 64),
];

const weaponDays: WeaponDay[] = [
  { 'Id.Item.AK74M': { kills: 30, headshots: 6, ranged: 30, distance: 1500, longest: { distance: 210, steamId: 'a', name: 'Ash' } } },
  { 'Id.Item.SV98': { kills: 10, headshots: 8, ranged: 10, distance: 4000, longest: { distance: 640.4, steamId: 'c', name: 'Cy' } } },
  {},
];

const sources = (values: Partial<SeasonSources> = {}): SeasonSources => ({
  firstDay: '2026-10-12',
  now: AFTER,
  days,
  matches,
  weaponDays,
  weaponsSince: '2026-10-12',
  scoreToWin: 100,
  ...values,
});

const season = buildSeason(sources()) as SeasonRoundup;

describe('the season', () => {
  it('runs from the first day of the records to the wipe, or to now while it is going on', () => {
    expect(SEASON.endsAt).toBe(at('2026-10-15'));
    expect(seasonPeriod('2026-10-12', AFTER)).toEqual({ kind: 'season', start: at('2026-10-12'), end: at('2026-10-15'), partial: false });
    const now = at('2026-10-14', 9);
    expect(seasonPeriod('2026-10-12', now)).toEqual({ kind: 'season', start: at('2026-10-12'), end: now, partial: true });
  });

  it('has no season before the records start', () => {
    expect(seasonPeriod('2026-10-16', AFTER)).toBeNull();
    expect(seasonPeriod('not a day', AFTER)).toBeNull();
    expect(buildSeason(sources({ firstDay: '2026-10-16' }))).toBeNull();
  });

  it('has no roundup when nobody played', () => {
    expect(buildSeason(sources({ days: [] }))).toBeNull();
  });
});

describe('buildSeason', () => {
  it('counts only the matches and days before the wipe', () => {
    expect(season.kind).toBe('season');
    expect(season.partial).toBe(false);
    expect(season.matches).toBe(6);
    expect(season.players).toBe(3);
    expect(season.kills.map((row) => row.name)).toEqual(['Ash', 'Cy', 'Bo']);
  });

  it('has each day: players, their minutes, the matches that ended and the peak', () => {
    expect(season.days).toEqual([
      { day: '2026-10-12', players: 2, minutes: 210, matches: 2, peak: 64 },
      { day: '2026-10-13', players: 1, minutes: 90, matches: 1, peak: 50 },
      { day: '2026-10-14', players: 2, minutes: 245, matches: 3, peak: 40 },
    ]);
  });

  it('adds up everyone', () => {
    expect(season.totals).toEqual({ kills: 69, deaths: 22, minutes: 545, seedingMinutes: 45, seedDays: 2 });
  });

  it("lists each board's top 10", () => {
    const many = Object.fromEntries(
      Array.from({ length: 14 }, (_, i) => [`p${i}`, totals(`Player ${i}`, { liveMinutes: 600, kills: 100 - i, deaths: 10 })]),
    );
    const big = buildSeason(sources({ days: [day('2026-10-12', many)], matches: [] })) as SeasonRoundup;
    expect(big.kills).toHaveLength(SEASON_SHOWN);
    expect(big.playtime).toHaveLength(SEASON_SHOWN);
    // The K/D board's time is the leaderboard's share for the season's days: 10 hours over 30 days, so 1 for 3 days.
    expect(big.kdMinHours).toBe(1);
  });

  it("has each map's wins and the average length of the matches with a result", () => {
    expect(season.maps.map((m) => [m.map, m.matches, m.teams])).toEqual([
      ['Bakurani', 2, [{ name: 'Lonestar', wins: 1 }, { name: 'Valkyra', wins: 1 }]],
      ['Ozeti', 2, [{ name: 'Valkyra', wins: 2 }, { name: 'Lonestar', wins: 0 }]],
      ['Zestafona', 1, [{ name: 'Lonestar', wins: 1 }, { name: 'Valkyra', wins: 0 }]],
    ]);
    expect(season.averageMs).toBe(42 * MINUTE);
  });

  it('finds the longest winning streak, the longest match and the quickest win to the winning score', () => {
    expect(season.streak).toEqual({ name: 'Valkyra', colorHex: '#3366ff', wins: 3, from: at('2026-10-12', 18), to: at('2026-10-13', 20) });
    expect(season.longestMatch).toMatchObject({ map: 'Ozeti', endedAt: at('2026-10-14', 23), durationMs: 80 * MINUTE });
    expect(season.quickestWin).toMatchObject({ map: 'Bakurani', endedAt: at('2026-10-13', 20), durationMs: 30 * MINUTE });
  });

  it('gives a streak tie to the latest', () => {
    const two = [matches[0], matches[3], matches[4]].flatMap((m) => (m === undefined ? [] : [m]));
    expect(buildSeason(sources({ matches: two }))?.streak).toMatchObject({ name: 'Lonestar', wins: 2 });
  });

  it("has the season's weapons, only with the kill feed", () => {
    expect(season.weapons).toMatchObject({
      days: 3,
      since: '2026-10-12',
      kills: 40,
      headshots: 14,
      top: [{ name: 'AK74', kills: 30 }, { name: 'SV98', kills: 10 }],
      longest: { weapon: 'SV98', distance: 640.4, name: 'Cy', id: 'c' },
    });
    expect(buildSeason(sources({ weaponsSince: null }))?.weapons).toBeNull();
  });

  it('lists the most deaths, fewer kills first when level', () => {
    expect(season.deaths).toEqual([
      { name: 'Ash', id: 'a', deaths: 15, kills: 34 },
      { name: 'Bo', id: 'b', deaths: 5, kills: 5 },
      { name: 'Cy', id: 'c', deaths: 2, kills: 30 },
    ]);
    const level = [day('2026-10-12', { a: totals('Ash', { deaths: 4, kills: 9 }), b: totals('Bo', { deaths: 4, kills: 2 }) })];
    expect(buildSeason(sources({ days: level, matches: [] }))?.deaths.map((row) => row.name)).toEqual(['Bo', 'Ash']);
  });

  it('lists the most team kills from the kill feed, only with it', () => {
    const kills: KillDaySummary[] = [
      { day: '2026-10-12', steamId: 'a', name: 'Ash (old)', kills: 9, headshots: 0, weapons: { 'Id.Item.AK74M': { kills: 9, headshots: 0, teamKills: 2 } } },
      { day: '2026-10-13', steamId: 'a', name: 'Ash', kills: 3, headshots: 0, weapons: { 'Id.Item.M249': { kills: 3, headshots: 0, teamKills: 1 } } },
      { day: '2026-10-14', steamId: 'b', name: 'Bo', kills: 5, headshots: 0, weapons: { 'Id.Item.AK74M': { kills: 5, headshots: 0, teamKills: 5 } } },
      { day: '2026-10-14', steamId: 'c', name: 'Cy', kills: 4, headshots: 0, weapons: { 'Id.Item.AK74M': { kills: 4, headshots: 0 } } },
      // After the wipe.
      { day: '2026-10-15', steamId: 'c', name: 'Cy', kills: 9, headshots: 0, weapons: { 'Id.Item.AK74M': { kills: 9, headshots: 0, teamKills: 9 } } },
    ];
    expect(buildSeason(sources({ feed: { since: '2026-10-12', kills } }))?.teamKills).toEqual([
      { name: 'Bo', id: 'b', teamKills: 5 },
      { name: 'Ash', id: 'a', teamKills: 3 },
    ]);
    expect(season.teamKills).toBeNull();
  });

  it('has the awards from the kill feed', () => {
    const kills: KillDaySummary[] = [
      { day: '2026-10-13', steamId: 'b', name: 'Bo', kills: 4, headshots: 4, weapons: { 'Id.Item.SV98': { kills: 4, headshots: 4, longest: 512 } } },
    ];
    const awarded = buildSeason(sources({ feed: { since: '2026-10-12', kills } }))?.awards;
    expect(awarded?.longest).toEqual({ name: 'Bo', id: 'b', distance: 512, weapon: 'SV98' });
    expect(season.awards).toBeNull();
  });
});

describe('publicSeason', () => {
  const ids: Record<string, string> = { a: 'aaaaaaaaaaaa', b: 'bbbbbbbbbbbb', c: 'cccccccccccc' };

  it('finds everyone it names, by Steam ID', () => {
    expect(keptSteamIds(season).sort()).toEqual(['a', 'b', 'c']);
  });

  it("swaps Steam IDs for public ids, and hides private profiles' names", () => {
    const shown = publicSeason(season, (steamId) => (steamId === 'c' ? null : ids[steamId]));
    expect(shown.kills).toEqual([
      { name: 'Ash', id: 'aaaaaaaaaaaa', kills: 34 },
      { name: PRIVATE_NAME, kills: 30 },
      { name: 'Bo', id: 'bbbbbbbbbbbb', kills: 5 },
    ]);
    expect(shown.weapons?.longest).toEqual({ weapon: 'SV98', distance: 640.4, name: PRIVATE_NAME });
    expect(JSON.stringify(shown)).not.toMatch(/"id":"[abc]"/);
    // Teams and weapons have names but no ids, so they stay as they are.
    expect(shown.teams).toEqual(season.teams);
    expect(shown.weapons?.top.map((w) => w.name)).toEqual(['AK74', 'SV98']);
  });
});

describe('the kept roundup', () => {
  it('reads back what was kept', () => {
    const stored: unknown = JSON.parse(JSON.stringify(keptSeason(season)));
    expect(parseKeptSeason(stored)).toEqual(season);
  });

  it('builds it again for another version, or one kept before the season was over', () => {
    expect(parseKeptSeason({ version: SEASON_VERSION + 1, roundup: season })).toBeNull();
    expect(parseKeptSeason(keptSeason({ ...season, partial: true }))).toBeNull();
    expect(parseKeptSeason(undefined)).toBeNull();
    expect(parseKeptSeason({ version: SEASON_VERSION, roundup: { kind: 'week' } })).toBeNull();
  });
});
