import { describe, expect, it } from 'vitest';
import { addBounties, bountyEnds, parseBountyPending, planBounties } from '../src/bounty.ts';

const DAY = 24 * 60 * 60_000;
const NOON = Date.UTC(2026, 9, 23, 12);
const win = (eventId: string, steamId: string, streak = 15) => ({ eventId, steamId, name: steamId, victim: 'Ash', streak });

describe('bountyEnds', () => {
  it('is the end of tomorrow, however late the win was', () => {
    expect(bountyEnds(NOON, 1)).toBe(Date.UTC(2026, 9, 25));
    expect(bountyEnds(Date.UTC(2026, 9, 23, 23, 59), 1)).toBe(Date.UTC(2026, 9, 25));
    expect(bountyEnds(NOON, 2)).toBe(Date.UTC(2026, 9, 26));
  });
});

describe('planBounties', () => {
  const pending = addBounties({}, [win('a', 'p1'), win('b', 'p1'), win('c', 'p2')], NOON);

  it('pays each player once, for the end of tomorrow, and settles all their wins', () => {
    const plan = planBounties(pending, { days: 1 }, NOON + 60_000);
    expect(plan.drop).toEqual([]);
    expect(plan.pay.map((p) => [p.win.steamId, p.until, p.events])).toEqual([
      ['p1', Date.UTC(2026, 9, 25), ['a', 'b']],
      ['p2', Date.UTC(2026, 9, 25), ['c']],
    ]);
  });

  it('drops wins whose time is up, and every win when the reward is off', () => {
    expect(planBounties(pending, { days: 1 }, NOON + 3 * DAY)).toEqual({ pay: [], drop: ['a', 'b', 'c'] });
    expect(planBounties(pending, null, NOON)).toEqual({ pay: [], drop: ['a', 'b', 'c'] });
  });

  it('reads nothing saved, or something unreadable, as no wins', () => {
    expect(parseBountyPending(undefined)).toEqual({});
    expect(parseBountyPending({ a: { eventId: 1 } })).toEqual({});
    expect(parseBountyPending(pending)).toEqual(pending);
  });
});
