import { describe, expect, it } from 'vitest';
import {
  crashed,
  GIVE_UP_MS,
  observeFailure,
  observeReading,
  type Outage,
  type OutageEvent,
  type Reading,
} from '../src/outages.ts';

const MINUTE = 60_000;
const LIVE = 20;

// Replays checks a minute apart: a number is a reading with that many players, null a check that could not reach the
// server. Returns each event with the minute it came at, and the outage left at the end.
const replay = (checks: (number | null)[], map = 'Bakurani'): { events: [number, OutageEvent][]; outage: Outage | null } => {
  let outage: Outage | null = null;
  let last: Reading | null = null;
  const events: [number, OutageEvent][] = [];
  checks.forEach((players, minute) => {
    const at = minute * MINUTE;
    const result =
      players === null ? observeFailure(outage, last, at) : observeReading(outage, last, { at, players, map }, LIVE);
    outage = result.outage;
    if (players !== null) last = { at, players, map };
    if (result.event !== null) events.push([minute, result.event]);
  });
  return { events, outage };
};

const failing = (minutes: number): null[] => Array<null>(minutes).fill(null);

describe('crashes', () => {
  it('confirms a crash 3 minutes on, and says it is over once the players are back, as on 6 October at 15:06', () => {
    // 99 players, then nobody; a few back; the server unreachable for 13 minutes; empty; then refilling.
    const { events, outage } = replay([99, 0, 0, 1, 3, 3, 4, 4, ...failing(13), 0, 0, 0, 2, 5, 11, 23, 59, 83, 94]);

    expect(events.map(([minute, e]) => [minute, e.type])).toEqual([
      [4, 'down'],
      [30, 'back'],
    ]);
    expect(events[0]?.[1]).toMatchObject({ players: 3, outage: { kind: 'crash', at: MINUTE, before: 99, lowest: 0 } });
    expect(events[1]?.[1]).toMatchObject({
      players: 94,
      refilled: true,
      outage: { kind: 'crash', before: 99, lowest: 0, unreachableMs: 13 * MINUTE, unreachableSince: null },
    });
    expect(outage).toBeNull();
  });

  it('forgets a map change that empties the server for a minute, as on 6 October at 17:07', () => {
    expect(replay([100, 1, 75, 92, 100, 100, 100])).toEqual({ events: [], outage: null });
  });

  it('never counts losing under three quarters of the players, as on 6 October at 13:37', () => {
    expect(replay([100, 46, 55, 51, 48, 49, 54, 62, 77, 99])).toEqual({ events: [], outage: null });
  });

  it('confirms a big drop that stays down, and says when the players are back, as on 6 October at 20:29', () => {
    const { events } = replay([99, 22, 46, 39, 40, 47, 52, 59, 66, 70, 82, 88, 93]);

    expect(events.map(([minute, e]) => [minute, e.type, e.players])).toEqual([
      [4, 'down', 40],
      [12, 'back', 93],
    ]);
  });

  it('only watches a server that was live', () => {
    expect(replay([19, 0, 0, 0, 0, 0])).toEqual({ events: [], outage: null });
  });

  it('gives up on players who never come back, after 3 hours', () => {
    const minutes = GIVE_UP_MS / MINUTE;
    const { events, outage } = replay([40, 0, ...Array<number>(minutes).fill(3)]);

    expect(events.map(([minute, e]) => [minute, e.type])).toEqual([
      [4, 'down'],
      [minutes + 1, 'back'],
    ]);
    expect(events[1]?.[1]).toMatchObject({ refilled: false, players: 3 });
    expect(outage).toBeNull();
  });
});

describe('unreachable', () => {
  it('confirms a server with players the bot cannot reach for 5 minutes, and says when it is back, as on 6 October at 12:00', () => {
    const { events } = replay([99, ...failing(53), 100]);

    expect(events.map(([minute, e]) => [minute, e.type])).toEqual([
      [5, 'down'],
      [54, 'back'],
    ]);
    expect(events[0]?.[1]).toMatchObject({ players: null, outage: { kind: 'unreachable', at: 0, before: 99, lowest: null } });
    expect(events[1]?.[1]).toMatchObject({ players: 100, refilled: true, outage: { kind: 'unreachable', unreachableMs: 53 * MINUTE } });
  });

  it('forgets a few minutes out of reach when the players are still there', () => {
    expect(replay([99, null, null, null, 98])).toEqual({ events: [], outage: null });
  });

  it('calls it a crash when the server comes back without half its players', () => {
    const quick = replay([60, null, 2, 4, 6]);
    expect(quick.events.map(([minute, e]) => [minute, e.type, e.outage.kind])).toEqual([[3, 'down', 'crash']]);

    const slow = replay([60, ...failing(10), 0, 30, 60]);
    expect(slow.events.map(([minute, e]) => [minute, e.type, e.outage.kind])).toEqual([
      [5, 'down', 'unreachable'],
      [13, 'back', 'crash'],
    ]);
  });

  it('pays no mind to a server nobody was on, or one never reached', () => {
    expect(replay([0, ...failing(20)])).toEqual({ events: [], outage: null });
    expect(replay(failing(20))).toEqual({ events: [], outage: null });
  });
});

describe('crashed', () => {
  it('is only true for a confirmed crash', () => {
    const at = (checks: (number | null)[]): Outage | null => replay(checks).outage;

    expect(crashed(null)).toBe(false);
    expect(crashed(at([99, 0, 0]))).toBe(false);
    expect(crashed(at([99, 0, 0, 0, 0]))).toBe(true);
    // Unreachable, with the players most likely still in game.
    expect(crashed(at([99, ...failing(10)]))).toBe(false);
  });
});
