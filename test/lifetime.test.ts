import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { Sql } from '../src/killfeed.ts';
import { createLifetime, exportTable, readPublicLifetime, firstStayDay, rebuildPlayers, readLifetime, toCsv, writeDay, writePlayerDays, type DayInput } from '../src/lifetime.ts';
import { createSessions } from '../src/joinlog.ts';

const database = (): Sql => {
  const db = new DatabaseSync(':memory:');
  return {
    exec: (query, ...bindings) => {
      const rows = db.prepare(query).all(...(bindings as SQLInputValue[])) as Record<string, unknown>[];
      return { toArray: () => rows };
    },
  };
};

const MIN = 60_000;
const day = (n: number): string => new Date(Date.UTC(2026, 9, n)).toISOString().slice(0, 10);
const at = (n: number, hour = 19): number => Date.UTC(2026, 9, n, hour);

// Who played on which days (October 2026): a on 1, 2, 3, 8; b on 1, 2; c on 2, 3; d on 3.
const PLAYED: Record<number, string[]> = { 1: ['a', 'b'], 2: ['a', 'b', 'c'], 3: ['a', 'c', 'd'], 8: ['a'] };

const stored = (): Sql => {
  const sql = database();
  createLifetime(sql);
  for (const [d, ids] of Object.entries(PLAYED)) writePlayerDays(sql, day(Number(d)), Object.fromEntries(ids.map((id) => [id, { minutes: 60, matches: 2 }])));
  rebuildPlayers(sql);
  return sql;
};

const empty = (d: number): DayInput => ({ day: day(d), stays: null, matches: [], discord: { clicks: null, accounts: null, linked: null } });

describe('the long-term records', () => {
  it('counts unique, new and returning players for a day', () => {
    const sql = stored();
    for (const d of [1, 2, 3]) writeDay(sql, empty(d));
    const lifetime = readLifetime(sql, day(10));
    const by = (d: number) => lifetime.daily.find((r) => r['day'] === day(d));
    // The first day's players could have played before it, so are not counted as new.
    expect(by(1)).toMatchObject({ unique_players: 2, new_players: null, player_minutes: 120 });
    expect(by(2)).toMatchObject({ unique_players: 3, new_players: 1, returning_players: 2 });
    expect(by(3)).toMatchObject({ unique_players: 3, new_players: 1, returning_players: 2 });
    expect(lifetime.summary).toMatchObject({ unique_players: 4, matches: 0 });
    expect(lifetime.since).toBe(day(1));
  });

  it('leaves out someone credited a match but never on the server that day', () => {
    const sql = database();
    createLifetime(sql);
    writePlayerDays(sql, day(1), { a: { minutes: 30, matches: 1 } });
    writePlayerDays(sql, day(2), { a: { minutes: 0, matches: 1 } });
    rebuildPlayers(sql);
    writeDay(sql, empty(2));
    expect(readLifetime(sql, day(5)).daily[0]).toMatchObject({ unique_players: 0 });
  });

  it('works out weeks and months, with regulars and stickiness', () => {
    const sql = stored();
    for (const d of [1, 2, 3, 8]) writeDay(sql, empty(d));
    const lifetime = readLifetime(sql, day(15));
    // 1 October 2026 is a Thursday: the week of Monday 28 September has days 1 to 4, then the week of the 5th has the 8th.
    expect(lifetime.weekly.map((w) => [w.period, w.unique_players])).toEqual([['2026-09-28', 4], ['2026-10-05', 1]]);
    expect(lifetime.weekly[0]).toMatchObject({ regulars: 1, new_players: 2 });
    expect(lifetime.monthly).toHaveLength(1);
    expect(lifetime.monthly[0]).toMatchObject({ period: '2026-10', unique_players: 4, regulars: 0, new_players: 2 });
    // The average of 2, 3, 3 and 1 players a day, of 4 in the month.
    expect(lifetime.monthly[0]?.stickiness).toBe(0.563);
  });

  it('works out how many came back, once the days are over', () => {
    const sql = stored();
    const lifetime = readLifetime(sql, day(10));
    const [cohort] = lifetime.cohorts;
    // c and d first played on the 2nd and 3rd; b is not new (the 1st is the first day). c came back the next day.
    expect(cohort?.new_players).toBe(2);
    expect(cohort?.windows.find((w) => w.days === 1)).toEqual({ days: 1, eligible: 2, returned: 1 });
    // c's seven days end on the 9th, so are over by the 10th; d's end on the 10th, so are not.
    expect(cohort?.windows.find((w) => w.days === 7)).toEqual({ days: 7, eligible: 1, returned: 1 });
    expect(cohort?.windows.find((w) => w.days === 30)).toEqual({ days: 30, eligible: 0, returned: 0 });
  });

  it('counts regulars and lapsed regulars in the last 30 days', () => {
    const sql = stored();
    const soon = readLifetime(sql, day(10)).summary;
    expect(soon).toMatchObject({ active_last_30: 4, regulars: 0 });
    // Long after, only a (who played on 4 days, none of them lately) has lapsed, and not enough days to be a regular.
    const later = readLifetime(sql, '2026-12-25').summary;
    expect(later).toMatchObject({ active_last_30: 0, lapsed_regulars: 0 });
  });

  it('writes matches, and keeps a value it had when it is written again without it', () => {
    const sql = database();
    createLifetime(sql);
    createSessions(sql);
    const match = { startedAt: at(1, 18), map: 'Narva', liveAt: at(1, 19), endedAt: at(1, 20), peakPlayers: 70, scores: [100, 40] };
    const stays = {
      sessions: 3,
      averageMinutes: 50,
      medianMinutes: 45,
      bounce: { newPlayers: { sessions: 1, short: 1 }, others: { sessions: 2, short: 0 } },
      leaves: { timing: { early: 1, mid: 0, late: 0, end: 2, between: 0 }, finale: { end: 2 } },
      excluded: 0,
      detail: {
        matches: [{ map: 'Narva', startedAt: match.startedAt, liveAt: match.liveAt, endedAt: match.endedAt, lastOfNight: true, present: 3, leftBefore: 1 }],
        seeding: [{ map: 'Narva', startedAt: match.startedAt, liveAt: match.liveAt, seedingMinutes: 60, seeders: 4, reachedLive: 3 }],
      },
      heat: { leaves: Array.from({ length: 168 }, (_, i) => (i === 3 ? 2 : 0)), minutes: Array.from({ length: 168 }, () => 1) },
    };
    writeDay(sql, { ...empty(1), stays, matches: [match] });
    // Again once the stays are gone: what was kept stays.
    writeDay(sql, { ...empty(1), matches: [match] });
    const lifetime = readLifetime(sql, day(5));
    expect(lifetime.daily[0]).toMatchObject({ stays: 3, median_stay_minutes: 45, leaves_end: 2, leaves_finale: 2, seeded_matches: 1, seeders: 4, seeders_at_go_live: 3, matches: 1, peak_players: 70, short_stays_new: 1 });
    expect(lifetime.maps).toEqual([{ map: 'Narva', matches: 1, average_peak: 70, average_minutes: 60, players_at_start: 3, left_early: 1, one_sided: 1, with_scores: 1 }]);
    expect(lifetime.heat).toMatchObject({ days: 1 });
    expect(lifetime.heat.leaves[3]).toBe(2);
    expect(firstStayDay(sql)).toBeNull();
  });

  it('gives each table as CSV, safe to open in a spreadsheet', () => {
    const sql = stored();
    writeDay(sql, empty(1));
    const csv = toCsv(exportTable(sql, day(5), 'daily')).split('\r\n');
    expect(csv[0]?.startsWith('day,unique_players,new_players')).toBe(true);
    expect(csv[1]?.startsWith('2026-10-01,2,,')).toBe(true);
    expect(toCsv({ columns: ['map'], rows: [['=cmd'], ['a,"b"']] })).toBe('map\r\n\'=cmd\r\n"a,""b"""\r\n');
    expect(exportTable(sql, day(5), 'cohorts').columns.slice(0, 3)).toEqual(['week', 'new_players', 'eligible_1d']);
  });
});

describe('what the public sees', () => {
  it('has the headline figures, records, weeks, months and maps, and nothing about who left or came back', () => {
    const sql = stored();
    const match = { startedAt: at(2, 18), map: 'Narva', liveAt: at(2, 19), endedAt: at(2, 20), peakPlayers: 60, scores: [100, 40] };
    for (const d of [1, 2, 3, 8]) writeDay(sql, { ...empty(d), matches: d === 2 ? [match] : [] });
    const pub = readPublicLifetime(sql, day(15));
    expect(pub.totals).toMatchObject({ players: 4, player_hours: 9, matches: 1, days: 4 });
    expect(pub.records.most_players).toEqual({ day: day(2), players: 3 });
    expect(pub.records.biggest_match).toEqual({ day: day(2), players: 60 });
    expect(pub.weeks.map((w) => [w.week, w.players])).toEqual([['2026-09-28', 4], ['2026-10-05', 1]]);
    expect(pub.months).toEqual([{ month: '2026-10', players: 4, new_players: 2, hours: 9, matches: 1 }]);
    expect(pub.maps).toEqual([{ map: 'Narva', matches: 1 }]);
    // Seven days of stays are needed before it says when the server is busiest.
    expect(pub.busy).toBeNull();
    expect(Object.keys(pub)).not.toContain('cohorts');
    expect(JSON.stringify(pub)).not.toMatch(/lapsed|left_early|bounce|seed|invite|steam/i);
  });

  it('averages the players on in each hour of the week', () => {
    const sql = database();
    createLifetime(sql);
    createSessions(sql);
    // Fourteen days of stays, each with 60 minutes on in the hour of Monday 19:00.
    const minutes = Array.from({ length: 168 }, (_, i) => (i === 19 ? 60 : 0));
    for (let d = 1; d <= 14; d += 1) {
      writeDay(sql, { ...empty(d), stays: { sessions: 1, averageMinutes: 60, medianMinutes: 60, bounce: null, leaves: { timing: { early: 0, mid: 0, late: 0, end: 0, between: 0 }, finale: {} }, excluded: 0, detail: { matches: [], seeding: [] }, heat: { leaves: Array.from({ length: 168 }, () => 0), minutes } } });
    }
    const busy = readPublicLifetime(sql, day(20)).busy;
    // 14 days of 60 minutes is 840 minutes: over two Mondays, 7 players on at a time.
    expect(busy?.days).toBe(14);
    expect(busy?.players[19]).toBe(7);
    expect(busy?.players[20]).toBe(0);
  });
});
