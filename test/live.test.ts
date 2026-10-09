import { describe, expect, it } from 'vitest';
import {
  isCurrent,
  LIVE_BYTES,
  LIVE_FEED_KEPT,
  liveStats,
  liveSteamIds,
  ON_FIRE,
  parseLiveMatch,
  recordLive,
  RIVALRY_KILLS,
  trimLive,
  type LiveMatch,
} from '../src/live.ts';
import { PRIVATE_NAME } from '../src/privacy.ts';
import type { FeedEvent } from '../src/weapons.ts';

const ASH = '76561198000000001';
const BO = '76561198000000002';
const CY = '76561198000000003';
const DEE = '76561198000000004';
const NAMES: Record<string, string> = { [ASH]: 'Ash', [BO]: 'Bo', [CY]: 'Cy', [DEE]: 'Dee' };
const SIDES: Record<string, string> = { [ASH]: 'Valkyra', [BO]: 'Lonestar', [CY]: 'Lonestar', [DEE]: 'VALKYRA' };
const factionOf = (steamId: string) => SIDES[steamId] ?? null;
const NOW = Date.UTC(2026, 9, 3, 18);

let next = 0;
// `killer` kills `victim` at `time` seconds on the match clock.
const death = (killer: string | null, victim: string, time: number, overrides: Partial<FeedEvent> = {}): FeedEvent => ({
  eventId: `e${next++}`,
  time,
  matchId: 'm1',
  map: 'Kavkazi',
  victimSteamId: victim,
  victimName: NAMES[victim] ?? '',
  killerSteamId: killer,
  killerName: killer === null ? '' : (NAMES[killer] ?? ''),
  cause: killer === null ? null : 'Id.Item.AK74M',
  distance: killer === null ? null : 40,
  headshot: false,
  tags: [],
  ...overrides,
});

const play = (events: FeedEvent[], match: LiveMatch | null = null, at = NOW): LiveMatch => {
  const result = recordLive(match, events, at, factionOf);
  if (result === null) throw new Error('no match');
  return result;
};

const ids: Record<string, string> = { [ASH]: 'a1a1a1a1a1a1', [BO]: 'b2b2b2b2b2b2' };
const stats = (match: LiveMatch) => liveStats(match, (steamId) => ids[steamId]);

describe('recordLive', () => {
  it('counts kills, deaths, headshots, streaks and the longest kill', () => {
    const match = play([
      death(ASH, BO, 10, { headshot: true }),
      death(ASH, CY, 40, { distance: 312.5, cause: 'Id.Item.SVDM' }),
      death(BO, ASH, 60),
      death(ASH, BO, 90),
    ]);
    const ash = match.players.find((p) => p.steamId === ASH);

    expect(ash).toMatchObject({ kills: 3, deaths: 1, headshots: 1, streak: 1, bestStreak: 2, longest: 312.5, longestCause: 'Id.Item.SVDM' });
    expect(ash?.weapons).toEqual({ 'Id.Item.AK74M': 2, 'Id.Item.SVDM': 1 });
    expect(match).toMatchObject({ kills: 4, headshots: 1, teamKills: 0, otherDeaths: 0, map: 'Kavkazi' });
  });

  it('takes the longest kill from hand-held weapons that do not lock on', () => {
    const match = play([
      death(ASH, BO, 10, { distance: 80, cause: 'Id.Item.SVDM' }),
      death(ASH, BO, 15, { distance: 1450.2, cause: 'Id.Item.Launcher_04' }),
      death(ASH, CY, 20, { distance: 851.1, cause: 'Id.Item.ATMine' }),
      death(ASH, BO, 30, { distance: 706.8, cause: 'Id.Vehicle.WeaponExtension.STN_03.MainBarrel' }),
      death(ASH, CY, 40, { distance: 300, cause: 'Id.Buildable.BarbedWire' }),
      death(BO, DEE, 50, { distance: 500, cause: 'Vehicle.Variant.Stationary.MistralAA' }),
    ]);

    expect(match.players.find((p) => p.steamId === ASH)).toMatchObject({ kills: 5, longest: 80, longestCause: 'Id.Item.SVDM' });
    expect(match.players.find((p) => p.steamId === BO)).toMatchObject({ kills: 1, longest: null, longestCause: null });
    expect(stats(match).highlights.longest).toEqual({ player: { name: 'Ash', id: 'a1a1a1a1a1a1', faction: 'Valkyra' }, weapon: 'SVD', distance: 80 });
  });

  it('lets a hand-held kill replace a longest kill saved before only hand-held weapons counted', () => {
    const match = play([death(CY, DEE, 10, { distance: 120 })]);
    const saved = { ...match, players: match.players.map((p) => (p.steamId === CY ? { ...p, longest: 851.1, longestCause: 'Id.Item.ATMine' } : p)) };
    const resumed = play([death(CY, ASH, 20, { distance: 300, cause: 'Id.Item.SVDM' })], saved);

    expect(resumed.players.find((p) => p.steamId === CY)).toMatchObject({ longest: 300, longestCause: 'Id.Item.SVDM' });
    expect(stats(resumed).highlights.longest).toEqual({ player: { name: 'Cy', faction: 'Lonestar' }, weapon: 'SVD', distance: 300 });
  });

  it('counts kills close together as a multi-kill', () => {
    const match = play([death(ASH, BO, 10), death(ASH, CY, 15), death(ASH, BO, 22), death(ASH, CY, 60)]);

    expect(match.feed.map((d) => d.chain)).toEqual([1, 2, 3, 1]);
    expect(match.players.find((p) => p.steamId === ASH)?.bestChain).toBe(3);
  });

  it('marks a kill of someone on the same side as a team kill, kept out of kills and streaks', () => {
    const match = play([death(ASH, BO, 10), death(ASH, DEE, 20)]);
    const ash = match.players.find((p) => p.steamId === ASH);

    expect(match.feed.map((d) => d.teamKill)).toEqual([false, true]);
    expect(ash).toMatchObject({ kills: 1, teamKills: 1, streak: 1 });
    expect(match.teamKills).toBe(1);
    expect(match.players.find((p) => p.steamId === DEE)?.deaths).toBe(1);
  });

  it('ends a streak on any death, a fall too, without counting it as anyone’s kill', () => {
    const match = play([death(ASH, BO, 10), death(ASH, CY, 20), death(null, ASH, 30, { tags: ['Falling'] })]);

    expect(match.players.find((p) => p.steamId === ASH)).toMatchObject({ kills: 2, deaths: 1, streak: 0, bestStreak: 2 });
    expect(match).toMatchObject({ kills: 2, otherDeaths: 1 });
  });

  it('starts a new match when the match clock starts again, the map or the game changes, or after a quiet spell', () => {
    const first = play([death(ASH, BO, 500)]);

    expect(play([death(BO, ASH, 520)], first).players).toHaveLength(2);
    expect(play([death(BO, ASH, 12)], first).feed).toHaveLength(1);
    expect(play([death(BO, ASH, 600, { map: 'Ozeti' })], first).map).toBe('Ozeti');
    expect(play([death(BO, ASH, 600, { matchId: 'm2' })], first).feed).toHaveLength(1);
    expect(play([death(BO, ASH, 600)], first, NOW + 21 * 60_000).feed).toHaveLength(1);
    expect(play([death(BO, ASH, 495)], first).feed).toHaveLength(2);
  });

  it(`keeps the last ${LIVE_FEED_KEPT} deaths, and the first blood`, () => {
    const match = play(Array.from({ length: LIVE_FEED_KEPT + 5 }, (_, i) => death(i % 2 === 0 ? ASH : BO, i % 2 === 0 ? BO : ASH, i * 20)));

    expect(match.feed).toHaveLength(LIVE_FEED_KEPT);
    const blood = match.firstBlood;
    expect([match.players[blood?.killer ?? -1]?.steamId, match.players[blood?.victim ?? -1]?.steamId]).toEqual([ASH, BO]);
    expect(match.kills).toBe(LIVE_FEED_KEPT + 5);
  });

  it('does not change the match it was given', () => {
    const before = play([death(ASH, BO, 10)]);
    const copy = JSON.parse(JSON.stringify(before));
    play([death(ASH, BO, 20)], before);

    expect(before).toEqual(copy);
  });

  it('reads back what it stored', () => {
    const match = play([death(ASH, BO, 10), death(null, CY, 12)]);

    expect(parseLiveMatch(JSON.parse(JSON.stringify(match)))).toEqual(match);
    expect(parseLiveMatch({ feed: 'nonsense' })).toBeNull();
  });
});

describe('liveStats', () => {
  it('names players by public id, never Steam ID, with their side', () => {
    const served = stats(play([death(ASH, BO, 10), death(CY, ASH, 20)]));

    expect(served.feed[0]).toMatchObject({ killer: { name: 'Cy', faction: 'Lonestar' }, victim: { name: 'Ash', id: 'a1a1a1a1a1a1', faction: 'Valkyra' } });
    expect(served.feed[0]?.killer).not.toHaveProperty('id');
    expect(JSON.stringify(served)).not.toMatch(/7656119|steamId/);
  });

  it('names a private profile [private profile], with no id, in the feed, the table and the highlights', () => {
    const match = play([death(ASH, BO, 10), death(ASH, CY, 20), death(CY, ASH, 30)]);
    const served = liveStats(match, (steamId) => (steamId === ASH ? null : ids[steamId]));

    expect(served.feed[0]).toMatchObject({ killer: { name: 'Cy', faction: 'Lonestar' }, victim: { name: PRIVATE_NAME, faction: 'Valkyra' } });
    expect(served.feed[2]?.killer).toEqual({ name: PRIVATE_NAME, faction: 'Valkyra' });
    expect(served.players[0]).toMatchObject({ name: PRIVATE_NAME, kills: 2 });
    expect(served.highlights.firstBlood?.killer).toEqual({ name: PRIVATE_NAME, faction: 'Valkyra' });
    expect(JSON.stringify(served)).not.toMatch(/"Ash"|a1a1a1a1a1a1|7656119/);
  });

  it('lists the feed newest first, with weapon names, and the players with the most kills', () => {
    const served = stats(play([death(ASH, BO, 10), death(ASH, CY, 15, { cause: 'Id.Item.SVDM', headshot: true }), death(BO, ASH, 30)]));

    expect(served.feed.map((f) => [f.killer?.name, f.victim.name, f.weapon])).toEqual([
      ['Bo', 'Ash', 'AK74'],
      ['Ash', 'Cy', 'SVD'],
      ['Ash', 'Bo', 'AK74'],
    ]);
    expect(served.players.map((p) => [p.name, p.kills, p.deaths])).toEqual([
      ['Ash', 2, 1],
      ['Bo', 1, 1],
      ['Cy', 0, 1],
    ]);
    expect(served.weapons).toEqual([
      { name: 'AK74', kind: 'weapon', kills: 2 },
      { name: 'SVD', kind: 'weapon', kills: 1 },
    ]);
    // Named as players know it.
    expect(served.map).toBe('Bakurani');
  });

  it('picks the highlights: first blood, longest kill, best streak, who is on fire, multi-kill, headshots and a rivalry', () => {
    // Ash kills at 100, 130, 160, 190 and 220, then 225 and 228: three close together.
    const kills = Array.from({ length: ON_FIRE }, (_, i) => death(ASH, i % 2 === 0 ? BO : CY, 100 + i * 30));
    const served = stats(
      play([
        death(BO, ASH, 5),
        death(CY, DEE, 6, { distance: 455.25, cause: 'Id.Item.Mosin', headshot: true }),
        ...kills,
        death(ASH, BO, 225),
        death(ASH, CY, 228),
      ]),
    );

    expect(served.highlights).toEqual({
      firstBlood: {
        killer: { name: 'Bo', id: 'b2b2b2b2b2b2', faction: 'Lonestar' },
        victim: { name: 'Ash', id: 'a1a1a1a1a1a1', faction: 'Valkyra' },
        weapon: 'AK74',
      },
      longest: { player: { name: 'Cy', faction: 'Lonestar' }, weapon: 'Mosin Nagant', distance: 455.3 },
      bestStreak: { player: { name: 'Ash', id: 'a1a1a1a1a1a1', faction: 'Valkyra' }, streak: ON_FIRE + 2 },
      onFire: [{ player: { name: 'Ash', id: 'a1a1a1a1a1a1', faction: 'Valkyra' }, streak: ON_FIRE + 2 }],
      bestMultiKill: { player: { name: 'Ash', id: 'a1a1a1a1a1a1', faction: 'Valkyra' }, kills: 3 },
      mostHeadshots: { player: { name: 'Cy', faction: 'Lonestar' }, headshots: 1 },
      rivalry: { killer: { name: 'Ash', id: 'a1a1a1a1a1a1', faction: 'Valkyra' }, victim: { name: 'Bo', id: 'b2b2b2b2b2b2', faction: 'Lonestar' }, kills: 4 },
    });
  });

  it('leaves out a longest kill saved before lock-on launchers were left out', () => {
    const match = play([death(ASH, BO, 10, { distance: 120 }), death(CY, DEE, 20, { distance: 300 })]);
    const saved = { ...match, players: match.players.map((p) => (p.steamId === CY ? { ...p, longest: 1450.2, longestCause: 'Id.Item.Launcher_04' } : p)) };

    expect(stats(saved).highlights.longest).toEqual({ player: { name: 'Ash', id: 'a1a1a1a1a1a1', faction: 'Valkyra' }, weapon: 'AK74', distance: 120 });
  });

  it('has no highlights it cannot back up', () => {
    // Bo and Cy are on the same side, so this is a team kill: no first blood.
    const served = stats(play([death(BO, CY, 5, { distance: null })]));

    expect(served.highlights).toEqual({
      firstBlood: null,
      longest: null,
      bestStreak: null,
      onFire: [],
      bestMultiKill: null,
      mostHeadshots: null,
      rivalry: null,
    });
  });

  it('names everyone in the match, so their public ids can be worked out first', () => {
    expect(liveSteamIds(play([death(ASH, BO, 10), death(null, CY, 12)]))).toEqual([BO, ASH, CY]);
    expect(liveSteamIds(null)).toEqual([]);
  });
});

describe('isCurrent', () => {
  const match = play([death(ASH, BO, 10)]);

  it('is the match on the server when it is on the same map and not over before that match started', () => {
    // The bot's checks name the map as players know it: Kavkazi is Bakurani.
    expect(isCurrent(match, { map: 'Bakurani', startedAt: NOW - 30 * 60_000 }, NOW)).toBe(true);
    // The first kills of a match can come before the check that sees it start.
    expect(isCurrent(match, { map: 'Bakurani', startedAt: NOW + 60_000 }, NOW + 60_000)).toBe(true);
    expect(isCurrent(match, { map: 'Bakurani', startedAt: NOW + 5 * 60_000 }, NOW + 5 * 60_000)).toBe(false);
    expect(isCurrent(match, { map: 'Ozeti', startedAt: NOW - 30 * 60_000 }, NOW)).toBe(false);
  });

  it('stays up a while after the server empties', () => {
    expect(isCurrent(match, null, NOW + 5 * 60_000)).toBe(true);
    expect(isCurrent(match, null, NOW + 11 * 60_000)).toBe(false);
  });
});

describe('trimLive', () => {
  const bytes = (match: LiveMatch) => new TextEncoder().encode(JSON.stringify(match)).length;
  const crowdMember = (i: number) => String(76561198100000000n + BigInt(i));
  // Ash kills 100 other players once each, then Cy kills Ash twice and Bo kills Dee RIVALRY_KILLS times: the crowd Ash
  // killed first are only in pairs of one, and out of the feed.
  const crowded = (): LiveMatch =>
    play([
      ...Array.from({ length: 100 }, (_, i) => death(ASH, crowdMember(i), i, { victimName: `Crowd ${i}` })),
      death(CY, ASH, 200),
      death(CY, ASH, 210),
      ...Array.from({ length: RIVALRY_KILLS }, (_, i) => death(BO, DEE, 300 + i * 20)),
    ]);
  const pair = (match: LiveMatch, killer: string, victim: string): string =>
    `${match.players.findIndex((p) => p.steamId === killer)}:${match.players.findIndex((p) => p.steamId === victim)}`;

  it('leaves a match that fits as it is', () => {
    const match = crowded();

    expect(trimLive(match)).toBe(match);
  });

  it('drops the pairs too few to be a rivalry first, fewest kills first', () => {
    const match = crowded();
    const trimmed = trimLive(match, bytes(match) - 1);

    expect(trimmed.pairs).toEqual({ [pair(match, CY, ASH)]: 2, [pair(match, BO, DEE)]: RIVALRY_KILLS });
    expect(trimmed.players).toEqual(match.players);
    expect(stats(trimmed)).toEqual(stats(match));
  });

  it('then drops the players who never show, and the page shows the same', () => {
    const match = crowded();
    const max = bytes(match) - 4_000;
    const trimmed = trimLive(match, max);

    expect(bytes(trimmed)).toBeLessThanOrEqual(max);
    expect(trimmed.players.length).toBeLessThan(match.players.length);
    // The deaths, first blood and rivalry name the same players in their new places.
    expect(stats(trimmed)).toEqual(stats(match));
    expect(stats(trimmed).highlights.rivalry).toMatchObject({ killer: { name: 'Bo' }, victim: { name: 'Dee' }, kills: RIVALRY_KILLS });
    expect(trimmed.pairs).toEqual({ [pair(trimmed, BO, DEE)]: RIVALRY_KILLS });
    // The quietest go first, in the order they joined: Crowd 2 is out of the feed and the table, Crowd 99 in the feed.
    expect(liveSteamIds(trimmed)).not.toContain(crowdMember(2));
    expect(liveSteamIds(trimmed)).toContain(crowdMember(99));
    expect(parseLiveMatch(JSON.parse(JSON.stringify(trimmed)))).toEqual(trimmed);
  });

  it('keeps only the favourite weapon of players who must stay, when they still do not fit', () => {
    // Ash kills Bo with 700 different weapons, with long tags: both are in the feed, so neither can go.
    const events = Array.from({ length: 700 }, (_, i) => death(ASH, BO, i, { cause: `Id.Item.${'X'.repeat(180)}_${i}` }));
    const match = play([...events, death(ASH, BO, 800, { cause: 'Id.Item.AK74M' }), death(ASH, BO, 801, { cause: 'Id.Item.AK74M' })]);
    const ash = match.players.find((p) => p.steamId === ASH);

    expect(bytes(match)).toBeLessThanOrEqual(LIVE_BYTES);
    expect(ash?.weapons).toEqual({ 'Id.Item.AK74M': 2 });
    expect(ash?.kills).toBe(702);
    expect(stats(match).players[0]).toMatchObject({ name: 'Ash', kills: 702, weapon: 'AK74' });
  });

  it('keeps only the totals as a last resort, so the batch can always be saved', () => {
    const match = crowded();
    const trimmed = trimLive(match, 1_000);

    expect(bytes(trimmed)).toBeLessThanOrEqual(1_000);
    expect(trimmed).toMatchObject({ players: [], pairs: {}, firstBlood: null, feed: [], kills: match.kills, map: 'Kavkazi' });
    expect(parseLiveMatch(JSON.parse(JSON.stringify(trimmed)))).toEqual(trimmed);
  });

  it('keeps a long, busy match under the limit storage has for one value', () => {
    const player = (i: number) => String(76561198200000000n + BigInt(i));
    const events = Array.from({ length: 5_000 }, (_, i) =>
      death(player((i * 7) % 400), player((i * 13 + 1) % 400), i, { killerName: `Long player name ${(i * 7) % 400}`, victimName: `Long player name ${(i * 13 + 1) % 400}` }),
    );
    const match = play(events);

    expect(bytes(match)).toBeLessThanOrEqual(LIVE_BYTES);
    expect(match.kills).toBe(5_000);
    expect(match.feed).toHaveLength(LIVE_FEED_KEPT);
    expect(stats(match).players).toHaveLength(10);
  });
});
