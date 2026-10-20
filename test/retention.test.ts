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
    // Narva: a and c left before its last minutes; d was last seen at 90, after it ended, so stayed.
    expect(r.matches[1]).toMatchObject({ map: 'Narva', present: 4, leftBefore: 2 });
    // Mutaha (70 to 130): d was gone by minute 100, so left early even though when is not known.
    expect(r.matches[0]).toMatchObject({ map: 'Mutaha', leftBefore: 1 });
  });

  it('counts those still in game as having stayed, and gap leaves only when the gap settles it', () => {
    const r = buildRetention({
      now: NOW,
      days: 7,
      matches: [first],
      sessions: [session('a', 0, 20), session('b', 0, 59, 40), session('c', 0, 10, 5)],
      ongoing: [{ steamId: 'd', since: T0 }, { steamId: 'e', since: null }],
    });
    // a left early, c's gap was early too, b's gap straddles the cutoff so it is left out, d stayed, e's join is unknown.
    expect(r.matches[0]).toMatchObject({ present: 3, leftBefore: 2 });
  });

  it('reaches sessions back before the period and leaves out the match on now', () => {
    const live = T0 + 130 * MIN;
    const r = buildRetention({
      now: NOW,
      days: 1,
      matches: [first],
      sessions: [session('a', 0, 140)],
      live: { startedAt: live, liveAt: live },
    });
    // Narva is not the night's last while the next match is on, and a leave in the match on now is not placed yet.
    expect(r.matches[0]).toMatchObject({ lastOfNight: false });
    expect(r.leaves.total).toBe(0);
  });

  it('has nothing to say with no sessions', () => {
    expect(buildRetention({ now: NOW, days: 7, matches: [], sessions: [] })).toMatchObject({ sessions: 0, averageMinutes: null, daily: [] });
  });
});

describe('what else the Play time tab works out', () => {
  const stay = (steamId: string, joined: number, left: number, extra: Partial<SessionRow> = {}): SessionRow => ({
    steamId,
    joinedAt: T0 + joined * MIN,
    leftAt: T0 + left * MIN,
    leftFrom: null,
    ...extra,
  });
  const scored = (m: MatchTimes, scores: number[]): MatchTimes => ({ ...m, scores });

  it('counts early leavers by map and by how one-sided the match was', () => {
    const r = buildRetention({
      now: NOW,
      days: 7,
      matches: [scored(first, [100, 90]), scored(second, [100, 20])],
      sessions: [stay('a', 0, 20), stay('b', 0, 128), stay('c', 70, 90), stay('d', 70, 128)],
    });
    expect(r.byMap.map((m) => [m.map, m.present, m.leftBefore])).toEqual([
      ['Mutaha', 3, 1],
      ['Narva', 2, 1],
    ]);
    expect(r.byBalance.find((b) => b.label.startsWith('Close'))).toMatchObject({ matches: 1, present: 2, leftBefore: 1 });
    expect(r.byBalance.find((b) => b.label.startsWith('One-sided'))).toMatchObject({ matches: 1 });
  });

  it('leaves out players staff kicked or banned', () => {
    const sessions = [stay('a', 0, 20), stay('b', 0, 30)];
    const r = buildRetention({ now: NOW, days: 7, matches: [first], sessions, removed: [{ steamId: 'a', at: T0 + 20 * MIN - 5_000 }] });
    expect(r.excluded).toBe(1);
    expect(r.sessions).toBe(1);
    expect(r.matches[0]).toMatchObject({ present: 1, leftBefore: 1 });
  });

  it('works out stays by when people joined', () => {
    const r = buildRetention({
      now: NOW,
      days: 7,
      matches: [{ ...first, startedAt: T0 - 10 * MIN }, second],
      sessions: [stay('a', -5, 20), stay('b', 5, 65), stay('c', 80, 150), stay('d', 90, 100, { joinedFrom: T0 + 85 * MIN })],
    });
    const by = (t: string) => r.joins.find((j) => j.timing === t);
    expect(by('seeding')).toMatchObject({ sessions: 1, medianMinutes: 25, stayedShare: 0 });
    expect(by('early')).toMatchObject({ sessions: 2 });
    // d's join came after a gap, so it is not placed.
    expect(r.joins.reduce((n, j) => n + j.sessions, 0)).toBe(3);
  });

  it('follows the seeding funnel', () => {
    const seeded = { map: 'Narva', startedAt: T0 - 20 * MIN, liveAt: T0, endedAt: T0 + 60 * MIN };
    const r = buildRetention({
      now: NOW,
      days: 7,
      matches: [seeded],
      sessions: [stay('a', -15, -5), stay('b', -15, 40), stay('c', 10, 40)],
      ongoing: [{ steamId: 'd', since: T0 - 10 * MIN }],
    });
    // a left while seeding; b and d were there when it went live; c joined after.
    expect(r.seeding).toMatchObject({ matches: 1, averageMinutes: 20, seeders: 3, reachedLive: 2 });
  });

  it('counts short stays by new players and everyone else', () => {
    const r = buildRetention({
      now: NOW,
      days: 7,
      matches: [first],
      sessions: [stay('a', 0, 5), stay('b', 0, 40), stay('c', 0, 3)],
      newOn: new Map([['a', '2026-10-20'], ['b', '2026-10-20']]),
    });
    expect(r.bounce).toEqual({ newPlayers: { sessions: 2, short: 1 }, others: { sessions: 1, short: 1 } });
    expect(buildRetention({ now: NOW, days: 7, matches: [], sessions: [] }).bounce).toBeNull();
  });

  it('spreads time on the server across the hours of the week', () => {
    // 19:30 to 20:30 on Tuesday 20 October 2026.
    const r = buildRetention({ now: NOW, days: 7, matches: [], sessions: [stay('a', 30, 90)] });
    const tuesday19 = 24 + 19;
    expect(r.heat.minutes[tuesday19]).toBe(30);
    expect(r.heat.minutes[tuesday19 + 1]).toBe(30);
    expect(r.heat.leaves[tuesday19 + 1]).toBe(1);
  });
});

describe('review fixes', () => {
  const stay = (steamId: string, joined: number, left: number, extra: Partial<SessionRow> = {}): SessionRow => ({
    steamId,
    joinedAt: T0 + joined * MIN,
    leftAt: T0 + left * MIN,
    leftFrom: null,
    ...extra,
  });

  it('counts a player who reconnected while seeding once, and not one with no known join', () => {
    const seeded = { map: 'Narva', startedAt: T0 - 20 * MIN, liveAt: T0, endedAt: T0 + 60 * MIN };
    const r = buildRetention({
      now: NOW,
      days: 7,
      matches: [seeded],
      sessions: [stay('a', -18, -15), stay('a', -10, 30), stay('b', -18, 30, { joinedAt: null })],
    });
    expect(r.seeding).toMatchObject({ seeders: 1, reachedLive: 1 });
  });

  it('places a join in the seeding of the match on now', () => {
    const r = buildRetention({
      now: NOW,
      days: 7,
      matches: [first],
      sessions: [stay('a', 125, 135)],
      live: { startedAt: T0 + 120 * MIN, liveAt: null },
    });
    expect(r.joins.find((j) => j.timing === 'seeding')?.sessions).toBe(1);
  });

  it("counts only the period's hours in the heatmap", () => {
    // Joined 23:30 the day before, left 00:30: only the half hour in the period is counted.
    const midnight = Date.UTC(2026, 9, 20);
    const r = buildRetention({
      now: NOW,
      days: 1,
      matches: [],
      sessions: [{ steamId: 'a', joinedAt: midnight - 30 * MIN, leftAt: midnight + 30 * MIN, leftFrom: null }],
    });
    expect(r.heat.minutes.reduce((a, b) => a + b, 0)).toBe(30);
  });

  it('leaves out stays that ended while a ban held, and those a kick just before midnight ended', () => {
    const midnight = Date.UTC(2026, 9, 20);
    const r = buildRetention({
      now: NOW,
      days: 1,
      matches: [],
      sessions: [
        { steamId: 'a', joinedAt: midnight - 5 * MIN, leftAt: midnight + MIN, leftFrom: null },
        { steamId: 'b', joinedAt: T0, leftAt: T0 + 5 * MIN, leftFrom: null },
        { steamId: 'c', joinedAt: T0, leftAt: T0 + 5 * MIN, leftFrom: null },
      ],
      removed: [{ steamId: 'a', at: midnight - MIN }, { steamId: 'b', at: T0 - 60 * MIN, until: null }, { steamId: 'c', at: T0 - 60 * MIN, until: T0 - 30 * MIN }],
    });
    expect(r.excluded).toBe(2);
    expect(r.sessions).toBe(1);
  });
});

describe('a day that is over', () => {
  it('counts only the stays that ended in it, and the matches in it', () => {
    const midnight = Date.UTC(2026, 9, 20);
    const nextDay = midnight + 24 * 60 * MIN;
    const sessions: SessionRow[] = [
      { steamId: 'a', joinedAt: midnight - 60 * MIN, leftAt: midnight + 30 * MIN, leftFrom: null },
      { steamId: 'b', joinedAt: nextDay - 10 * MIN, leftAt: nextDay + 20 * MIN, leftFrom: null },
    ];
    const r = buildRetention({ now: nextDay - 1, days: 1, until: nextDay, matches: [first], sessions });
    expect(r.sessions).toBe(1);
    expect(r.daily.map((d) => d.day)).toEqual(['2026-10-20']);
    // a's hour before midnight is the day before's to show, so only its half hour after is counted; b ended the next day.
    expect(r.heat.minutes.reduce((a, b) => a + b, 0)).toBe(30);
    // For the long-term records, a is kept whole, as the day before did not count it.
    const whole = buildRetention({ now: nextDay - 1, days: 1, until: nextDay, matches: [first], sessions, clampHeat: false });
    expect(whole.heat.minutes.reduce((a, b) => a + b, 0)).toBe(90);
    expect(r.detail.matches).toHaveLength(1);
  });
});
