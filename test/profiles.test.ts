import { describe, expect, it } from 'vitest';
import type { MatchRecord, PlayerDay, PlayerTotals } from '../src/players.ts';
import {
  buildProfile,
  directory,
  importIdKey,
  isIdKey,
  newIdKey,
  parseOnline,
  PLAYER_ID,
  playerMatch,
  PROFILE_MATCHES,
  publicId,
  type DayRecords,
  type ProfileSources,
} from '../src/profiles.ts';

// 2026-09-30T12:00:00Z
const NOON = Date.UTC(2026, 8, 30, 12);
const DAY = 24 * 60 * 60_000;
const ASH = '76561198000000001';
const BO = '76561198000000002';
const CY = '76561198000000003';

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

// The last `count` UTC days up to today, with what each player did on them.
const daysOf = (count: number, filled: Record<number, PlayerDay> = {}): DayRecords[] =>
  Array.from({ length: count }, (_, i) => ({
    day: new Date(NOON - (count - 1 - i) * DAY).toISOString().slice(0, 10),
    players: filled[count - 1 - i] ?? {},
  }));

const record = (overrides: Partial<MatchRecord> = {}): MatchRecord => ({
  map: 'Ozeti',
  startedAt: NOON - 50 * 60_000,
  liveAt: NOON - 45 * 60_000,
  endedAt: NOON,
  durationMs: 45 * 60_000,
  peakPlayers: 64,
  factionScores: [
    { name: 'Valkyra', score: 100 },
    { name: 'LONESTAR', score: 72 },
  ],
  players: [
    { steamId: ASH, name: 'Ash', kills: 12, deaths: 4, faction: 'Valkyra' },
    { steamId: BO, name: 'Bo', kills: 20, deaths: 2, faction: 'Lone Star' },
    { steamId: CY, name: 'Cy', kills: 12, deaths: 4 },
  ],
  ...overrides,
});

describe('public ids', () => {
  it('turns a Steam ID into 12 hex characters, the same every time for the same key', async () => {
    const key = await importIdKey(newIdKey());
    const id = await publicId(key, ASH);

    expect(id).toMatch(PLAYER_ID);
    expect(await publicId(key, ASH)).toBe(id);
    expect(await publicId(key, BO)).not.toBe(id);
  });

  it('gives different ids under a different key, so nobody without the key can work them out', async () => {
    const one = await publicId(await importIdKey(newIdKey()), ASH);
    const two = await publicId(await importIdKey(newIdKey()), ASH);

    expect(one).not.toBe(two);
    expect(one).not.toContain(ASH.slice(-6));
  });

  it('only takes a stored key that looks like one', () => {
    expect(isIdKey(newIdKey())).toBe(true);
    expect(isIdKey('abc')).toBe(false);
    expect(isIdKey(undefined)).toBe(false);
    expect(isIdKey('z'.repeat(64))).toBe(false);
  });
});

describe('parseOnline', () => {
  it('reads back who was in game, and nothing for anything else', () => {
    const online = {
      at: NOON,
      map: 'Europe',
      players: [
        { steamId: ASH, name: 'Ash', kills: 3, deaths: null, faction: 'Valkyra' },
        { steamId: BO, name: 'Bo', kills: null, deaths: 1 },
      ],
    };

    expect(parseOnline(structuredClone(online))).toEqual(online);
    expect(parseOnline(undefined)).toBeNull();
    expect(parseOnline({ at: NOON, players: 'none' })).toBeNull();
  });
});

describe('playerMatch', () => {
  it('gives their kills, deaths and place, sharing a place with a player level on both', () => {
    expect(playerMatch(record(), ASH)).toMatchObject({ kills: 12, deaths: 4, place: 2, players: 3 });
    expect(playerMatch(record(), CY)).toMatchObject({ place: 2 });
    expect(playerMatch(record(), BO)).toMatchObject({ place: 1 });
    expect(playerMatch(record(), 'nobody')).toBeNull();
  });

  it('says whether their side won, however the server spells the faction', () => {
    expect(playerMatch(record(), ASH)).toMatchObject({ faction: 'Valkyra', result: 'won' });
    expect(playerMatch(record(), BO)).toMatchObject({ faction: 'Lone Star', result: 'lost' });
  });

  it('sends every side’s score, with its colour when the server reported it', () => {
    const scores = [
      { name: 'Valkyra', score: 100, colorHex: '#ff3333' },
      { name: 'Lonestar', score: 72, colorHex: '#3366ff' },
      { name: 'Manticore', score: 41, colorHex: '#f4900c' },
    ];

    expect(playerMatch(record({ factionScores: scores }), ASH)).toMatchObject({ result: 'won', factionScores: scores });
  });

  it('has no result for a side level at the top, as teams never draw, and a loss for a side below them', () => {
    const level = [{ name: 'Valkyra', score: 80 }, { name: 'Lonestar', score: 80 }, { name: 'Manticore', score: 10 }];
    const below = record({ factionScores: level, players: [{ steamId: ASH, name: 'Ash', kills: 1, deaths: 1, faction: 'Manticore' }] });

    expect(playerMatch(record({ factionScores: level }), ASH)?.result).toBeNull();
    expect(playerMatch(below, ASH)?.result).toBe('lost');
  });

  it('has no result without a side, or for a side the scores do not name', () => {
    const elsewhere = record({ players: [{ steamId: ASH, name: 'Ash', kills: 1, deaths: 1, faction: 'Manticore' }] });

    expect(playerMatch(record(), CY)).toMatchObject({ faction: null, result: null });
    expect(playerMatch(elsewhere, ASH)?.result).toBeNull();
    expect(playerMatch(record({ factionScores: [] }), ASH)?.result).toBeNull();
  });
});

describe('buildProfile', () => {
  const rule = { seedDays: 3, seedMinutes: 10, windowDays: 7, lengthDays: 7 };
  const sources = (overrides: Partial<ProfileSources> = {}): ProfileSources => ({
    steamId: ASH,
    id: 'a1a1a1a1a1a1',
    now: NOON,
    days: daysOf(90, {
      0: { [ASH]: row('Ash', { liveMinutes: 60, matches: 1, kills: 12, deaths: 4, seedDays: 1, seedingMinutes: 20 }), [BO]: row('Bo', { liveMinutes: 90, kills: 40 }) },
      3: { [ASH]: row('Ash', { seedDays: 1, seedingMinutes: 15 }) },
      8: { [ASH]: row('Ash', { seedDays: 1, seedingMinutes: 30 }) },
      45: { [ASH]: row('Ashley', { liveMinutes: 30, kills: 2, deaths: 5 }) },
    }),
    matches: [record(), record({ startedAt: NOON - 5 * DAY, endedAt: NOON - 5 * DAY, map: 'Bakurani' })],
    rankDays: 30,
    online: null,
    vip: null,
    rule,
    weapons: null,
    ...overrides,
  });

  it('lists the days they played, oldest first, with their latest name', () => {
    const profile = buildProfile(sources());

    expect(profile?.name).toBe('Ash');
    expect(profile?.days).toBe(90);
    expect(profile?.activity.map((d) => d.day)).toEqual(['2026-08-16', '2026-09-22', '2026-09-27', '2026-09-30']);
    expect(profile?.activity.at(-1)).toEqual({
      day: '2026-09-30',
      seedingMinutes: 20,
      liveMinutes: 60,
      seedDays: 1,
      matches: 1,
      kills: 12,
      deaths: 4,
    });
  });

  it('lists their matches newest first, leaving out matches they were not in', () => {
    const profile = buildProfile(sources({ matches: [record({ endedAt: NOON - DAY, map: 'Bakurani' }), record(), record({ players: [] })] }));

    expect(profile?.matches.map((m) => m.map)).toEqual(['Ozeti', 'Bakurani']);
  });

  it(`sends at most ${PROFILE_MATCHES} matches`, () => {
    const many = Array.from({ length: PROFILE_MATCHES + 5 }, (_, i) => record({ endedAt: NOON - i * 60_000 }));

    expect(buildProfile(sources({ matches: many }))?.matches).toHaveLength(PROFILE_MATCHES);
  });

  it('ranks them on each leaderboard board over the rank days', () => {
    expect(buildProfile(sources())?.ranks).toEqual({ days: 30, kdMinHours: 10, players: 2, kills: 2, kd: null, playtime: 1, seeding: 1 });
  });

  it('counts their seed days in the VIP window, as the bot does', () => {
    expect(buildProfile(sources())?.seeding).toEqual({ rule, seedDays: 2 });
    expect(buildProfile(sources({ rule: null }))?.seeding).toBeNull();
  });

  it('shows VIP until it ends', () => {
    const vip = { name: 'Ash', grantedAt: NOON - DAY, expiresAt: NOON + 6 * DAY };

    expect(buildProfile(sources({ vip }))?.vip).toEqual({ until: NOON + 6 * DAY });
    expect(buildProfile(sources({ vip, now: NOON + 7 * DAY }))?.vip).toBeNull();
  });

  it('passes on their weapons from the kill feed, or null without the feed', () => {
    const weapons = { since: '2026-09-01', used: [{ day: '2026-09-30', name: 'AK74', kind: 'weapon' as const, lockOn: false, kills: 4, headshots: 1, longest: 88.2 }] };

    expect(buildProfile(sources({ weapons }))?.weapons).toEqual(weapons);
    expect(buildProfile(sources())?.weapons).toBeNull();
  });

  it('is null for a player the bot has nothing on', () => {
    expect(buildProfile(sources({ steamId: 'nobody' }))).toBeNull();
  });

  it('never includes a Steam ID', () => {
    const online = { map: 'Ozeti', faction: 'Valkyra', kills: 3, deaths: 1 };

    expect(JSON.stringify(buildProfile(sources({ online })))).not.toMatch(/7656119|steamId/);
  });
});

describe('directory', () => {
  const ids: Record<string, string> = { [ASH]: 'a1a1a1a1a1a1', [BO]: 'b2b2b2b2b2b2' };

  it('lists everyone with an id, most time played first, with the last day they played and who is online', () => {
    const days = daysOf(3, {
      2: { [ASH]: row('Ash', { liveMinutes: 30 }), [BO]: row('Bo', { liveMinutes: 10 }) },
      0: { [BO]: row('Bo', { seedingMinutes: 50 }), [CY]: row('Cy', { liveMinutes: 500 }) },
    });

    expect(directory(days, (steamId) => ids[steamId], new Set([ASH]), NOON)).toEqual({
      generatedAt: NOON,
      days: 3,
      players: [
        { id: 'b2b2b2b2b2b2', name: 'Bo', minutes: 60, lastSeen: '2026-09-30', online: false },
        { id: 'a1a1a1a1a1a1', name: 'Ash', minutes: 30, lastSeen: '2026-09-28', online: true },
      ],
    });
  });

  it('leaves out private profiles', () => {
    const days = daysOf(1, { 0: { [ASH]: row('Ash', { liveMinutes: 30 }), [BO]: row('Bo', { liveMinutes: 10 }) } });

    expect(directory(days, (steamId) => (steamId === ASH ? null : ids[steamId]), new Set([ASH]), NOON).players).toEqual([
      { id: 'b2b2b2b2b2b2', name: 'Bo', minutes: 10, lastSeen: '2026-09-30', online: false },
    ]);
  });
});
