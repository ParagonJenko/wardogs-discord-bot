import { describe, expect, it } from 'vitest';
import { buildNewPlayers, weekOf } from '../src/newplayers.ts';
import { buildFunnel } from '../src/funnel.ts';
import type { PlayerDay, PlayerTotals } from '../src/players.ts';

const totals = (matches: number): PlayerTotals => ({ name: 'x', seedingMinutes: 0, liveMinutes: 0, seedDays: 0, matches, kills: 0, deaths: 0 });
const day = (d: string, ...ids: string[]) => ({ day: d, players: Object.fromEntries(ids.map((id) => [id, totals(1)])) });

describe('buildNewPlayers', () => {
  it('finds the Monday of a week', () => {
    expect(weekOf('2026-10-20')).toBe('2026-10-19');
    expect(weekOf('2026-10-18')).toBe('2026-10-12');
  });

  it('counts who came back, once the days are over', () => {
    const r = buildNewPlayers(
      [day('2026-10-01', 'old'), day('2026-10-05', 'a', 'b', 'old'), day('2026-10-06', 'a'), day('2026-10-09', 'b'), day('2026-10-19', 'c')],
      '2026-10-20',
    );
    // old was there on the first day, so is not new; a, b and c are.
    expect(r.firstSeen.has('old')).toBe(false);
    const week1 = r.cohorts.find((c) => c.week === '2026-10-05');
    expect(week1?.newPlayers).toBe(2);
    const [d1, d7, d30] = week1?.windows ?? [];
    expect(d1).toEqual({ days: 1, eligible: 2, returned: 1 });
    // b came back on the 9th, 4 days later; a on the 6th.
    expect(d7).toEqual({ days: 7, eligible: 2, returned: 2 });
    expect(d30).toEqual({ days: 30, eligible: 0, returned: 0 });
    // c was new yesterday: its first day is not over for any window.
    expect(r.cohorts.find((c) => c.week === '2026-10-19')?.windows.map((w) => w.eligible)).toEqual([0, 0, 0]);
  });

  it('has nothing without days', () => {
    expect(buildNewPlayers([], '2026-10-20')).toMatchObject({ cohorts: [], lookbackDays: 0 });
  });
});

describe('buildFunnel', () => {
  it('counts linked accounts that played and play often', () => {
    const days: { players: PlayerDay }[] = [
      { players: { a: totals(2), b: totals(1) } },
      { players: { a: totals(4) } },
    ];
    expect(buildFunnel(['a', 'b', 'c', 'c'], days)).toEqual({ linked: 3, played: 2, regulars: 1 });
  });
});
