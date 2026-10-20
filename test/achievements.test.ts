import { describe, expect, it } from 'vitest';
import {
  dueMilestone,
  foldDays,
  isPersonalBest,
  LIFETIME_SHARDS,
  LONGEST_MILESTONE,
  markTold,
  milestoneText,
  nearlyTopTen,
  parseShard,
  personalBests,
  reached,
  shardOf,
  thousands,
  unfoldMatch,
  type LifetimeShard,
} from '../src/achievements.ts';
import type { MatchRecord, PlayerDay, PlayerTotals, RankedPlayer } from '../src/players.ts';

const totals = (over: Partial<PlayerTotals> = {}): PlayerTotals => ({
  name: 'Ash',
  seedingMinutes: 0,
  liveMinutes: 0,
  seedDays: 0,
  matches: 0,
  kills: 0,
  deaths: 0,
  ...over,
});

const A = '76561198000000001';
const B = '76561198000000002';

const empty = (): LifetimeShard[] => Array.from({ length: LIFETIME_SHARDS }, () => ({}));

describe('lifetime totals', () => {
  it('keeps each player in the shard of the last two digits of their Steam ID', () => {
    expect(shardOf('76561198000000001')).toBe(1);
    expect(shardOf('76561198000000031')).toBe(31);
    expect(shardOf('76561198000000032')).toBe(0);
    expect(shardOf('76561198000000099')).toBe(99 % LIFETIME_SHARDS);
  });

  it('adds days up, counting the milestones already passed as told on the first fold only', () => {
    const day: PlayerDay = { [A]: totals({ matches: 30, kills: 120, liveMinutes: 600, seedingMinutes: 30 }) };
    const first = foldDays(empty(), [day, day], true);

    expect(first[shardOf(A)]?.[A]).toEqual({ matches: 60, kills: 240, minutes: 1260, told: { matches: 50, kills: 100, hours: 10 } });

    const later = foldDays(empty(), [{ [B]: totals({ matches: 12 }) }], false);
    expect(later[shardOf(B)]?.[B]).toEqual({ matches: 12, kills: 0, minutes: 0, told: {} });
  });

  it('counts what was done earlier today as told on the first fold, without adding it to the totals', () => {
    const shards = foldDays(empty(), [{ [A]: totals({ matches: 9 }) }], true, [{ [A]: totals({ matches: 2 }), [B]: totals({ matches: 12 }) }]);

    expect(shards[shardOf(A)]?.[A]).toEqual({ matches: 9, kills: 0, minutes: 0, told: { matches: 10 } });
    expect(shards[shardOf(B)]?.[B]).toEqual({ matches: 0, kills: 0, minutes: 0, told: { matches: 10 } });
  });

  it('takes a removed match back off the totals, keeping what was told', () => {
    const shards = new Map([[shardOf(A), { [A]: { matches: 100, kills: 30, minutes: 5, told: { matches: 100 } } }]]);
    const next = unfoldMatch(shards, [
      { steamId: A, kills: 40 },
      { steamId: B, kills: 3 },
    ]);

    expect(next.get(shardOf(A))?.[A]).toEqual({ matches: 99, kills: 0, minutes: 5, told: { matches: 100 } });
    expect(next.get(shardOf(B))).toBeUndefined();
  });

  it('keeps what was told when it adds more days', () => {
    const shards = foldDays(empty(), [{ [A]: totals({ matches: 9 }) }], true);
    const next = foldDays(shards, [{ [A]: totals({ matches: 3 }) }], false);

    expect(next[shardOf(A)]?.[A]).toEqual({ matches: 12, kills: 0, minutes: 0, told: {} });
  });

  it('reads back what it saved, and nothing it cannot read', () => {
    const shard = { [A]: { matches: 1, kills: 2, minutes: 3, told: { kills: 100 } } };

    expect(parseShard(JSON.parse(JSON.stringify(shard)))).toEqual(shard);
    expect(parseShard({ [A]: { matches: 1, kills: 2, minutes: 3 } })).toEqual({ [A]: { matches: 1, kills: 2, minutes: 3, told: {} } });
    expect(parseShard('nonsense')).toEqual({});
  });
});

describe('milestones', () => {
  it('gives the highest step passed and not told, the first kind first', () => {
    expect(reached({ matches: 99, kills: 0, minutes: 0 }, 'matches')).toBe(50);
    expect(dueMilestone({ matches: 100, kills: 1000, minutes: 0 }, {})).toEqual({ kind: 'matches', value: 100 });
    expect(dueMilestone({ matches: 100, kills: 1000, minutes: 0 }, { matches: 100 })).toEqual({ kind: 'kills', value: 1000 });
    expect(dueMilestone({ matches: 9, kills: 99, minutes: 599 }, {})).toBeNull();
    expect(dueMilestone({ matches: 0, kills: 0, minutes: 600 }, {})).toEqual({ kind: 'hours', value: 10 });
  });

  it('remembers who was told of what, and never lowers it', () => {
    const shards = new Map([[shardOf(A), { [A]: { matches: 100, kills: 5, minutes: 0, told: { matches: 100 } } }]]);
    const next = markTold(shards, new Map([[A, { kind: 'matches' as const, value: 50 }], [B, { kind: 'kills' as const, value: 100 }]]));

    expect(next.get(shardOf(A))?.[A]?.told).toEqual({ matches: 100 });
    expect(next.get(shardOf(B))?.[B]).toEqual({ matches: 0, kills: 0, minutes: 0, told: { kills: 100 } });
  });

  it('says them as the messages do', () => {
    expect(thousands(1234567)).toBe('1,234,567');
    expect(thousands(999)).toBe('999');
    expect(milestoneText({ kind: 'matches', value: 100 })).toBe('your 100th match');
    expect(milestoneText({ kind: 'matches', value: 1000 })).toBe('your 1,000th match');
    expect(milestoneText({ kind: 'kills', value: 2500 })).toBe('your 2,500th kill');
    expect(milestoneText({ kind: 'hours', value: 10 })).toBe('10 hours played');
    expect(LONGEST_MILESTONE.length).toBe('your 50,000th kill'.length);
  });
});

const record = (startedAt: number, players: [string, number][]): MatchRecord => ({
  map: 'Ozeti',
  startedAt,
  liveAt: startedAt,
  endedAt: startedAt + 1,
  durationMs: 1,
  peakPlayers: 40,
  factionScores: [],
  players: players.map(([steamId, kills]) => ({ steamId, name: steamId, kills, deaths: 0 })),
});

describe('personal bests', () => {
  it("gives each player's most kills from 5 matches, leaving out the match ending now", () => {
    const records = [1, 2, 3, 4, 5, 6].map((at) => record(at, [[A, at * 3], ...(at <= 4 ? [[B, 50] as [string, number]] : [])]));

    expect(personalBests(records, 99)).toEqual(new Map([[A, 18]]));
    expect(personalBests(records, 6)).toEqual(new Map([[A, 15]]));
  });

  it('needs 10 kills, and more than the best', () => {
    expect(isPersonalBest(19, 18)).toBe(true);
    expect(isPersonalBest(18, 18)).toBe(false);
    expect(isPersonalBest(9, 5)).toBe(false);
    expect(isPersonalBest(40, undefined)).toBe(false);
  });
});

describe('nearlyTopTen', () => {
  const player = (steamId: string, kills: number, deaths = 0): RankedPlayer => ({ steamId, ...totals({ name: steamId, kills, deaths }) });

  it('says how many more kills would pass 10th place, for those 25 or fewer short', () => {
    const board = Array.from({ length: 10 }, (_, i) => player(`top${i}`, 100 - i));
    const near = nearlyTopTen([...board, player('close', 88), player('level', 91, 5), player('far', 60), player('none', 0)]);

    expect(near).toEqual(
      new Map([
        ['level', 1],
        ['close', 4],
      ]),
    );
  });

  it('says nothing without 10 players on the board', () => {
    expect(nearlyTopTen([player('a', 5), player('b', 3)])).toEqual(new Map());
  });

  it('tells a player with no kills yet, but never against a 10th place with none', () => {
    const board = Array.from({ length: 10 }, (_, i) => player(`top${i}`, 20 - i));
    expect(nearlyTopTen([...board, player('fresh', 0)]).get('fresh')).toBe(12);
    expect(nearlyTopTen([...Array.from({ length: 10 }, (_, i) => player(`p${i}`, 0)), player('fresh', 0)])).toEqual(new Map());
  });
});
