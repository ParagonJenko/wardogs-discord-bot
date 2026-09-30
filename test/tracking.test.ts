import { describe, expect, it } from 'vitest';
import type { Player, ServerStatus } from '../src/rcon.ts';
import { observeMatch, summarise, tallySeeding, topSeeders, type MatchState } from '../src/tracking.ts';

const player = (steamId: string, kills = 0, deaths = 0): Player => ({ steamId, name: `P${steamId}`, kills, deaths });

const status = (overrides: Partial<ServerStatus> = {}): ServerStatus => ({
  name: 'UK Wardogs #1',
  players: 24,
  maxPlayers: 98,
  map: 'Kavkazi',
  rotationIndex: 0,
  factionScores: [
    { name: 'Valkyra', score: 100 },
    { name: 'Kharr', score: 80 },
  ],
  ...overrides,
});

describe('seeding tally', () => {
  it('ranks players by how many checks they were online for', () => {
    const tally = [
      [player('a'), player('b')],
      [player('a'), player('b'), player('c')],
      [player('a'), player('c'), player('d')],
      [player('a'), player('c'), player('d')],
    ].reduce(tallySeeding, {});

    expect(topSeeders(tally, 3)).toEqual([
      { name: 'Pa', checks: 4 },
      { name: 'Pc', checks: 3 },
      { name: 'Pb', checks: 2 },
    ]);
  });

  it('keeps the latest name a player used', () => {
    const tally = tallySeeding(tallySeeding({}, [player('a')]), [{ ...player('a'), name: 'Renamed' }]);

    expect(topSeeders(tally, 3)).toEqual([{ name: 'Renamed', checks: 2 }]);
  });
});

// Runs a sequence of observations one minute apart and collects any finished-match summaries.
// The bot is taken to have first seen the opening map while the server was still seeding (at time 0).
const observe = (steps: { status: ServerStatus; players: Player[]; live?: boolean }[]) =>
  steps.reduce<{ match: MatchState | null; finished: unknown[] }>(
    (acc, s, i) => {
      const result = observeMatch(acc.match, s.status, s.players, s.live ?? true, (i + 1) * 60_000);
      return { match: result.match, finished: result.finished ? [...acc.finished, summarise(result.finished)] : acc.finished };
    },
    { match: steps[0] ? observeMatch(null, steps[0].status, [], false, 0).match : null, finished: [] },
  );

describe('match tracking', () => {
  it('summarises the previous match when the map changes', () => {
    const { finished } = observe([
      { status: status(), players: [player('a', 1), player('b', 0)] },
      { status: status({ players: 30 }), players: [player('a', 9, 2), player('b', 4, 5), player('c', 12, 1)] },
      { status: status({ factionScores: [{ name: 'Valkyra', score: 250 }, { name: 'Kharr', score: 300 }] }), players: [player('a', 11, 2), player('b', 4, 6), player('c', 12, 3)] },
      { status: status({ map: 'Europe', rotationIndex: 1, factionScores: [] }), players: [player('a'), player('c')] },
    ]);

    expect(finished).toEqual([
      {
        map: 'Kavkazi',
        durationMs: 120_000,
        peakPlayers: 30,
        factionScores: [
          { name: 'Valkyra', score: 250 },
          { name: 'Kharr', score: 300 },
        ],
        top: [
          { name: 'Pc', kills: 12, deaths: 3 },
          { name: 'Pa', kills: 11, deaths: 2 },
          { name: 'Pb', kills: 4, deaths: 6 },
        ],
      },
    ]);
  });

  it('keeps the stats of players who left before the match ended', () => {
    const { finished } = observe([
      { status: status(), players: [player('a', 5), player('b', 20)] },
      { status: status(), players: [player('a', 6)] },
      { status: status({ rotationIndex: 1 }), players: [] },
    ]);

    expect(finished).toMatchObject([{ top: [{ name: 'Pb', kills: 20 }, { name: 'Pa', kills: 6 }] }]);
  });

  it('treats kills going backwards as a restarted match on the same map', () => {
    const { finished } = observe([
      { status: status(), players: [player('a', 5)] },
      { status: status(), players: [player('a', 8)] },
      { status: status(), players: [player('a', 0)] },
    ]);

    expect(finished).toMatchObject([{ top: [{ name: 'Pa', kills: 8 }] }]);
  });

  it('lists at most five players, most kills first and fewer deaths breaking ties', () => {
    const players = [player('a', 3, 1), player('b', 9, 4), player('c', 9, 2), player('d', 1), player('e', 7), player('f', 5), player('g', 2)];
    const { finished } = observe([
      { status: status(), players },
      { status: status({ map: 'Europe' }), players: [] },
    ]);

    expect(finished).toMatchObject([
      { top: [{ name: 'Pc' }, { name: 'Pb' }, { name: 'Pe' }, { name: 'Pf' }, { name: 'Pa' }] },
    ]);
  });

  it('times the match from when the server went live, not from when seeding started', () => {
    const { finished } = observe([
      { status: status(), players: [player('a')], live: false },
      { status: status(), players: [player('a')], live: false },
      { status: status(), players: [player('a', 1)], live: true },
      { status: status(), players: [player('a', 4)], live: true },
      { status: status({ map: 'Europe' }), players: [] },
    ]);

    expect(finished).toMatchObject([{ durationMs: 60_000 }]);
  });

  it('does not summarise a match that never went live', () => {
    const { finished } = observe([
      { status: status(), players: [player('a', 2)], live: false },
      { status: status({ map: 'Europe' }), players: [], live: false },
    ]);

    expect(finished).toEqual([]);
  });

  it('does not summarise the match already running when the bot starts', () => {
    const first = observeMatch(null, status(), [player('a', 3)], true, 0);
    const second = observeMatch(first.match, status(), [player('a', 5)], true, 60_000);
    const next = observeMatch(second.match, status({ map: 'Europe' }), [], true, 120_000);

    expect(first.finished).toBeNull();
    expect(next.finished).toBeNull();
  });

  it('does summarise a match the bot first saw while it was still seeding', () => {
    const first = observeMatch(null, status(), [player('a')], false, 0);
    const live = observeMatch(first.match, status(), [player('a', 2)], true, 60_000);

    expect(observeMatch(live.match, status({ map: 'Europe' }), [], true, 120_000).finished).not.toBeNull();
  });

  it('ends the match when the server empties, so a quiet night is not counted as match time', () => {
    const { finished } = observe([
      { status: status(), players: [player('a', 4)] },
      { status: status(), players: [player('a', 9)] },
      { status: status({ players: 0 }), players: [], live: false },
      { status: status({ players: 0 }), players: [], live: false },
      { status: status(), players: [player('b', 2)] },
      { status: status({ map: 'Europe' }), players: [] },
    ]);

    expect(finished).toEqual([
      expect.objectContaining({ map: 'Kavkazi', durationMs: 60_000, top: [{ name: 'Pa', kills: 9, deaths: 0 }] }),
      expect.objectContaining({ map: 'Kavkazi', durationMs: 0, top: [{ name: 'Pb', kills: 2, deaths: 0 }] }),
    ]);
  });

  it('starts the next match when someone joins, not when the server emptied', () => {
    const live = observeMatch(observeMatch(null, status(), [player('a')], false, 0).match, status(), [player('a', 3)], true, 60_000);
    const empty = observeMatch(live.match, status({ players: 0 }), [], false, 120_000);
    const stillEmpty = observeMatch(empty.match, status({ players: 0 }), [], false, 10 * 60_000);
    const joined = observeMatch(stillEmpty.match, status({ players: 1 }), [player('b')], false, 11 * 60_000);

    expect(empty.finished).toMatchObject({ startedAt: 0, liveAt: 60_000 });
    expect(stillEmpty.finished).toBeNull();
    expect(joined.finished).toBeNull();
    expect(joined.match).toMatchObject({ startedAt: 11 * 60_000, liveAt: null, peakPlayers: 1 });
  });

  it('keeps the last known kills when a reading leaves them out, without treating it as a restart', () => {
    const unknown = { ...player('a'), kills: null, deaths: null };
    const { finished } = observe([
      { status: status(), players: [player('a', 6, 2)] },
      { status: status(), players: [unknown] },
      { status: status({ map: 'Europe' }), players: [] },
    ]);

    expect(finished).toEqual([expect.objectContaining({ top: [{ name: 'Pa', kills: 6, deaths: 2 }] })]);
  });
});
