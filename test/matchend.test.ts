import { describe, expect, it } from 'vitest';
import { MATCH_END } from '../src/lines.ts';
import type { LiveMatch, LivePlayer } from '../src/live.ts';
import { feedRecordOf, hasWinner, honours, killCount, LONGEST_EARNED, matchEndMessages, ordinal, type MatchEndRule } from '../src/matchend.ts';
import { MAX_LENGTH } from '../src/messages.ts';
import type { MatchState, TrackedPlayer } from '../src/tracking.ts';

const rule: MatchEndRule = { count: 3, awards: true, siteHost: 'gaminginit.com' };

const tracked = (name: string, kills: number, deaths = 0): TrackedPlayer => ({ name, kills, deaths, lastKills: kills, lastDeaths: deaths });

// The scoreboard, as the checks track it: a 9 kills, b 4 (1 death), c 4 (3 deaths), d 2, e none.
const match: MatchState = {
  key: 'Europe#1',
  startedAt: 0,
  lastSeenAt: 0,
  liveAt: 0,
  summarisable: true,
  peakPlayers: 40,
  players: { a: tracked('Ash', 9), b: tracked('Bo', 4, 1), c: tracked('Cy', 4, 3), d: tracked('Dee', 2), e: tracked('Eve', 0) },
  factionScores: [],
};

const fed = (steamId: string, name: string, overrides: Partial<LivePlayer> = {}): LivePlayer => ({
  steamId,
  name,
  faction: null,
  kills: 0,
  deaths: 0,
  headshots: 0,
  teamKills: 0,
  streak: 0,
  bestStreak: 0,
  chain: 0,
  chainTime: null,
  bestChain: 0,
  longest: null,
  longestCause: null,
  weapons: {},
  ...overrides,
});

const live = (players: LivePlayer[]): LiveMatch => ({
  matchId: 'm1',
  map: 'Europe',
  startedAt: 0,
  lastAt: 0,
  lastTime: 0,
  players,
  pairs: {},
  firstBlood: null,
  feed: [],
  kills: 0,
  headshots: 0,
  teamKills: 0,
  otherDeaths: 0,
});

// From the kill feed: d is the best at demolitions and the longest kill, a has the most headshots, f (not in the top 3)
// is the best machine gunner and has the best streak. b has 2 marksman kills, too few for an award.
const feed = live([
  fed('a', 'Ash', { headshots: 5, bestStreak: 4, weapons: { 'Id.Item.M4': 9 } }),
  fed('b', 'Bo', { weapons: { 'Id.Item.SKS': 2 } }),
  fed('d', 'Dee', { longest: 412.4, longestCause: 'Id.Item.SKS', weapons: { 'Id.Item.RPG7': 3, 'Id.Item.M67Grenade': 2 } }),
  fed('f', 'Fay', { bestStreak: 6, weapons: { 'Id.Item.M249': 7 } }),
]);

describe('the words', () => {
  it('says places and kills as players read them', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 100, 101, 111, 112].map(ordinal)).toEqual([
      '1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '100th', '101st', '111th', '112th',
    ]);
    expect([killCount(1), killCount(0), killCount(23)]).toEqual(['1 kill', '0 kills', '23 kills']);
  });
});

describe('honours', () => {
  it('names the top of the scoreboard, then the award winners, each once with their place first', () => {
    expect(honours(match, feed, rule)).toEqual([
      { steamId: 'a', name: 'Ash', earned: ['1st on the scoreboard (9 kills)', 'best assaulter (9 kills)', 'most headshots (5)'] },
      { steamId: 'b', name: 'Bo', earned: ['2nd on the scoreboard (4 kills)'] },
      { steamId: 'c', name: 'Cy', earned: ['3rd on the scoreboard (4 kills)'] },
      { steamId: 'f', name: 'Fay', earned: ['best machine gunner (7 kills)', 'best kill streak (6)'] },
      { steamId: 'd', name: 'Dee', earned: ['best demolitions (5 kills)', 'longest kill (412 m)'] },
    ]);
  });

  it('names at most 3 things a player earned', () => {
    const all = live([fed('a', 'Ash', { headshots: 9, bestStreak: 9, longest: 300, longestCause: 'Id.Item.M4', weapons: { 'Id.Item.M4': 9, 'Id.Item.M249': 4 } })]);

    expect(honours(match, all, rule)[0]?.earned).toEqual(['1st on the scoreboard (9 kills)', 'best assaulter (9 kills)', 'best machine gunner (4 kills)']);
  });

  it('gives no place to a player without a kill, and none at all for a count of 0', () => {
    expect(honours(match, null, { ...rule, count: 10 }).map((h) => h.steamId)).toEqual(['a', 'b', 'c', 'd']);
    expect(honours(match, feed, { ...rule, count: 0 }).map((h) => h.steamId)).toEqual(['a', 'f', 'd']);
  });

  it('leaves the awards out without the kill feed, or when they are off', () => {
    expect(honours(match, null, rule).map((h) => h.earned.length)).toEqual([1, 1, 1]);
    expect(honours(match, feed, { ...rule, awards: false }).map((h) => h.steamId)).toEqual(['a', 'b', 'c']);
  });

  it('gives the longest kill however short it is', () => {
    const close = live([fed('x', 'Xi', { longest: 0.4, longestCause: 'Id.Item.M4' })]);

    expect(honours(match, close, { ...rule, count: 0 })).toEqual([{ steamId: 'x', name: 'Xi', earned: ['longest kill (0 m)'] }]);
  });

  it('does not count a longest kill with a weapon that locks on, or a mine', () => {
    const locked = live([fed('x', 'Xi', { longest: 900, longestCause: 'Id.Item.Launcher_04' })]);

    expect(honours(match, locked, { ...rule, count: 0 })).toEqual([]);
  });
});

describe('matchEndMessages', () => {
  const [line0, line1, line2] = MATCH_END;
  const fill = (line: string | undefined, earned: string) => (line ?? '').replace('{earned}', earned).replace('{site}', 'gaminginit.com');

  it('sends each player in game one message with all they earned, each with a line it has not used lately', () => {
    const { messages, recent } = matchEndMessages(match, feed, new Set(['a', 'b', 'd']), new Set(), rule, () => 0);

    expect(messages).toEqual([
      { steamId: 'a', name: 'Ash', text: fill(line0, '1st on the scoreboard (9 kills), best assaulter (9 kills) and most headshots (5)') },
      { steamId: 'b', name: 'Bo', text: fill(line1, '2nd on the scoreboard (4 kills)') },
      { steamId: 'd', name: 'Dee', text: fill(line2, 'best demolitions (5 kills) and longest kill (412 m)') },
    ]);
    expect(recent['matchEnd']).toEqual([line0, line1, line2]);
  });

  it('sends a private profile nothing, and the others the place the match summary gives them', () => {
    const { messages } = matchEndMessages(match, null, new Set(['a', 'b', 'c']), new Set(['a']), rule, () => 0);

    expect(messages.map((m) => m.steamId)).toEqual(['b', 'c']);
    expect(messages[0]?.text).toContain('2nd on the scoreboard');
  });

  it('fits every line in the game without cutting it, with the most a player can earn', () => {
    expect(MATCH_END.every((line) => line.includes('{site}') && line.includes('{earned}'))).toBe(true);
    for (const line of MATCH_END) {
      expect(fill(line, LONGEST_EARNED).length).toBeLessThanOrEqual(MAX_LENGTH);
    }
  });
});

describe('feedRecordOf', () => {
  const MINUTE = 60_000;
  // The checks saw the match on Ozeti from minute 10 to minute 40.
  const round: MatchState = { ...match, key: 'Ozeti_KOTH_01#2', startedAt: 10 * MINUTE, lastSeenAt: 40 * MINUTE };
  const record = (startedAt: number, lastAt: number, map = 'Ozeti_KOTH_01'): LiveMatch => ({ ...live([]), map, startedAt, lastAt });

  it("takes the feed's record of this match, even one that began a little before the checks saw it start", () => {
    expect(feedRecordOf(record(9 * MINUTE, 39 * MINUTE), round, 40 * MINUTE)).not.toBeNull();
  });

  it('leaves out the round before on the same map, as after a restart while the feed was down', () => {
    expect(feedRecordOf(record(-20 * MINUTE, 9 * MINUTE), round, 40 * MINUTE)).toBeNull();
  });

  it('leaves out the next match, another map, and no record at all', () => {
    expect(feedRecordOf(record(41 * MINUTE, 42 * MINUTE), round, 42 * MINUTE)).toBeNull();
    expect(feedRecordOf(record(11 * MINUTE, 39 * MINUTE, 'Bakurani_KOTH_01'), round, 40 * MINUTE)).toBeNull();
    expect(feedRecordOf(null, round, 40 * MINUTE)).toBeNull();
  });
});

describe('hasWinner', () => {
  it('needs one team alone on the points', () => {
    const scores = (...points: number[]) => points.map((score, i) => ({ name: `T${i}`, score }));

    expect(hasWinner(scores(100, 60, 40), 100)).toBe(true);
    expect(hasWinner(scores(99, 60), 100)).toBe(false);
    expect(hasWinner(scores(99, 60), 99)).toBe(true);
    expect(hasWinner(scores(100, 100), 100)).toBe(false);
    expect(hasWinner([], 100)).toBe(false);
  });
});
