import { describe, expect, it } from 'vitest';
import { buildRetention, placeLeave, type MatchTimes, type SessionRow } from '../src/retention.ts';

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 20, 23);
const T0 = Date.UTC(2026, 9, 20, 19);

// Two matches in one night: 19:00 to 20:00, then 20:10 to 21:10, and a third the day before.
const match = (map: string, startedAt: number, minutes: number): MatchTimes => ({ map, startedAt, liveAt: startedAt, endedAt: startedAt + minutes * MIN });
const first = match('Narva', T0, 60);
const second = match('Mutaha', T0 + 70 * MIN, 60);
const before = match('Kokan', T0 - 24 * 60 * MIN, 60);
const nights = [before, first, second].map((m, i, all) => ({ ...m, lastOfNight: all[i + 1] === undefined || all[i + 1]!.startedAt - m.endedAt >= 2 * 60 * MIN }));

describe('placeLeave', () => {
  it('splits a live match in thirds, then its end', () => {
    expect(placeLeave(T0 + 10 * MIN, nights)).toEqual({ timing: 'early', finale: false });
    expect(placeLeave(T0 + 30 * MIN, nights)).toEqual({ timing: 'mid', finale: false });
    expect(placeLeave(T0 + 50 * MIN, nights)).toEqual({ timing: 'late', finale: false });
    expect(placeLeave(T0 + 58 * MIN, nights)).toEqual({ timing: 'end', finale: false });
    expect(placeLeave(T0 + 64 * MIN, nights)).toEqual({ timing: 'end', finale: false });
  });

  it("marks the night's last match and what comes after it", () => {
    expect(placeLeave(T0 + 80 * MIN, nights)).toEqual({ timing: 'early', finale: true });
    expect(placeLeave(T0 + 128 * MIN, nights)).toEqual({ timing: 'end', finale: true });
    expect(placeLeave(T0 + 180 * MIN, nights)).toEqual({ timing: 'between', finale: true });
  });

  it('puts a leave before any match between matches', () => {
    expect(placeLeave(T0 - 3 * 24 * 60 * MIN, nights)).toEqual({ timing: 'between', finale: false });
  });
});

describe('buildRetention', () => {
  const session = (steamId: string, joined: number, left: number, leftFrom: number | null = null): SessionRow => ({
    steamId,
    joinedAt: T0 + joined * MIN,
    leftAt: T0 + left * MIN,
    leftFrom: leftFrom === null ? null : T0 + leftFrom * MIN,
  });

  it('works out the day, the lengths and when people left', () => {
    const r = buildRetention({
      now: NOW,
      days: 7,
      matches: [first, second],
      sessions: [session('a', 0, 30), session('b', 0, 128), session('c', 0, 50), session('d', 0, 100, 90)],
    });
    expect(r.sessions).toBe(4);
    expect(r.daily).toHaveLength(1);
    expect(r.daily[0]).toMatchObject({ day: '2026-10-20', players: 4, sessions: 4 });
    expect(r.medianMinutes).toBe(70);
    // d's leave came after a gap in the checks, so it has a length but no place.
    expect(r.leaves.total).toBe(3);
    expect(r.leaves.timing).toEqual({ early: 0, mid: 1, late: 1, end: 1, between: 0 });
    expect(r.leaves.finale.end).toBe(1);
    expect(r.matches[1]).toMatchObject({ map: 'Narva', present: 4, leftBefore: 2 });
  });

  it('has nothing to say with no sessions', () => {
    expect(buildRetention({ now: NOW, days: 7, matches: [], sessions: [] })).toMatchObject({ sessions: 0, averageMinutes: null, daily: [] });
  });
});
