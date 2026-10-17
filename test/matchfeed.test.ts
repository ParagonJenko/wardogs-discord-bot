import { describe, expect, it } from 'vitest';
import { NO_MATCH_FEED, parseMatchFeed, recordMatchFeed, resultScores, sameMap, type MatchResult } from '../src/matchfeed.ts';
import type { FeedMatchEvent } from '../src/weapons.ts';

const NOW = Date.UTC(2026, 9, 17, 18);

const state = (value: string): FeedMatchEvent => ({ eventId: value, type: 'state', state: value, time: 0, matchId: 'm1', map: 'Kavkazi' });

const ended: FeedMatchEvent = {
  eventId: 'r1',
  type: 'result',
  time: 7658.5,
  matchId: 'm1',
  map: 'Kavkazi',
  players: 98,
  winner: 'Lonestar',
  factionScores: [
    { name: 'Lonestar', score: 100 },
    { name: 'Valkyra', score: 0 },
  ],
};

describe('recordMatchFeed', () => {
  it('keeps the latest state, and when the latest match started being played', () => {
    const loading = recordMatchFeed(NO_MATCH_FEED, [state('MatchState.PreMatch.WaitingForWorldLoad'), state('MatchState.PreMatch.WaitingForPlayers')], NOW);
    expect(loading).toEqual({ state: 'MatchState.PreMatch.WaitingForPlayers', stateAt: NOW, playingAt: null, result: null });

    const playing = recordMatchFeed(loading, [state('MatchState.Playing')], NOW + 60_000);
    // A state under Playing is the same match going on.
    const koth = recordMatchFeed(playing, [state('MatchState.Playing.KOTH')], NOW + 61_000);
    expect(koth).toMatchObject({ state: 'MatchState.Playing.KOTH', stateAt: NOW + 61_000, playingAt: NOW + 60_000 });

    const next = recordMatchFeed(recordMatchFeed(koth, [state('MatchState.PostMatch')], NOW + 90_000), [state('MatchState.Playing.KOTH')], NOW + 120_000);
    expect(next.playingAt).toBe(NOW + 120_000);
  });

  it('takes a match started after a result in the same batch as after it, and one started before as before it', () => {
    const post = recordMatchFeed(NO_MATCH_FEED, [state('MatchState.PostMatch')], NOW - 60_000);

    const after = recordMatchFeed(post, [ended, state('MatchState.PreMatch.WaitingForWorldLoad'), state('MatchState.Playing.KOTH')], NOW);
    expect([after.result?.at, after.playingAt]).toEqual([NOW, NOW + 1]);
    const before = recordMatchFeed(post, [state('MatchState.Playing.KOTH'), ended], NOW);
    expect([before.result?.at, before.playingAt]).toEqual([NOW, NOW]);
  });

  it("keeps the latest result, with when the bot got it, and leaves the state as it was", () => {
    const playing = recordMatchFeed(NO_MATCH_FEED, [state('MatchState.Playing.KOTH')], NOW);

    expect(recordMatchFeed(playing, [ended], NOW + 60_000)).toEqual({
      ...playing,
      result: { at: NOW + 60_000, map: 'Kavkazi', matchId: 'm1', winner: 'Lonestar', factionScores: ended.type === 'result' ? ended.factionScores : [], players: 98 },
    });
  });

  it('reads back what it stored, and anything else as a feed that has said nothing', () => {
    const feed = recordMatchFeed(NO_MATCH_FEED, [state('MatchState.Playing'), ended], NOW);

    expect(parseMatchFeed(JSON.parse(JSON.stringify(feed)))).toEqual(feed);
    expect(parseMatchFeed(undefined)).toEqual(NO_MATCH_FEED);
    expect(parseMatchFeed({ state: 3 })).toEqual(NO_MATCH_FEED);
  });
});

describe('resultScores', () => {
  const result: MatchResult = {
    at: NOW,
    map: 'Kavkazi',
    matchId: 'm1',
    winner: 'Lonestar',
    factionScores: [
      { name: 'Lonestar', score: 100 },
      { name: 'Valkyra', score: 59 },
    ],
    players: 98,
  };

  it("takes the game's scores, with each side's colour from the checks however its name is written", () => {
    expect(resultScores(result, [{ name: 'VALKYRA', score: 58, colorHex: '#3366ff' }, { name: 'Manticore', score: 3, colorHex: '#ff0000' }])).toEqual([
      { name: 'Lonestar', score: 100 },
      { name: 'Valkyra', score: 59, colorHex: '#3366ff' },
    ]);
  });
});

describe('sameMap', () => {
  it('is the same map, or one is not known', () => {
    expect([sameMap('Kavkazi', 'Kavkazi'), sameMap('', 'Europe'), sameMap('Kavkazi', ''), sameMap('Kavkazi', 'Europe')]).toEqual([true, true, true, false]);
  });
});
