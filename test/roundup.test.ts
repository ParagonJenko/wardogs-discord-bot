import { describe, expect, it } from 'vitest';
import type { KillDaySummary } from '../src/killfeed.ts';
import type { MatchPlayer, MatchRecord, PlayerDay, PlayerTotals } from '../src/players.ts';
import {
  buildRoundup,
  currentPeriod,
  dueRoundups,
  lastPeriod,
  markPosted,
  parseRoundupsPosted,
  periodDays,
  periodFor,
  type FeedSources,
  type Period,
} from '../src/roundup.ts';
import type { WeaponDay } from '../src/weapons.ts';

const HOUR = 60 * 60_000;
const at = (date: string, hour = 0): number => Date.parse(`${date}T00:00:00Z`) + hour * HOUR;

// Monday 28 Sep to Sunday 4 Oct 2026.
const WEEK: Period = { kind: 'week', start: at('2026-09-28'), end: at('2026-10-05'), partial: false };

const totals = (name: string, values: Partial<PlayerTotals> = {}): PlayerTotals => ({
  name,
  seedingMinutes: 0,
  liveMinutes: 0,
  seedDays: 0,
  matches: 0,
  kills: 0,
  deaths: 0,
  ...values,
});

const p = (steamId: string, name: string, kills: number, deaths: number, faction?: string): MatchPlayer => ({
  steamId,
  name,
  kills,
  deaths,
  ...(faction ? { faction } : {}),
});

const match = (endedAt: number, map: string, scores: [string, number][], players: MatchPlayer[], peak = 40): MatchRecord => ({
  map,
  startedAt: endedAt - HOUR,
  liveAt: endedAt - 50 * 60_000,
  endedAt,
  durationMs: 50 * 60_000,
  peakPlayers: peak,
  factionScores: scores.map(([name, score]) => ({ name, score, ...(name === 'Valkyra' ? { colorHex: '#3366ff' } : {}) })),
  players,
});

const ids: Record<string, string> = { a: 'aaaaaaaaaaaa', b: 'bbbbbbbbbbbb', c: 'cccccccccccc', d: 'dddddddddddd' };
const idOf = (steamId: string) => ids[steamId];

const day = (date: string, players: PlayerDay) => ({ day: date, players });

describe('periods', () => {
  it('finds the last full week, Monday to Sunday UTC, and the last calendar month', () => {
    const saturday = at('2026-10-03', 15);
    expect(lastPeriod('week', saturday)).toEqual({ kind: 'week', start: at('2026-09-21'), end: at('2026-09-28'), partial: false });
    expect(lastPeriod('week', at('2026-10-05'))).toEqual(WEEK);
    expect(lastPeriod('month', saturday)).toEqual({ kind: 'month', start: at('2026-09-01'), end: at('2026-10-01'), partial: false });
    expect(lastPeriod('month', at('2026-01-01', 17))).toEqual({
      kind: 'month',
      start: at('2025-12-01'),
      end: at('2026-01-01'),
      partial: false,
    });
  });

  it('finds the week and month going on now, up to now', () => {
    const now = at('2026-10-03', 15);
    expect(currentPeriod('week', now)).toEqual({ kind: 'week', start: at('2026-09-28'), end: now, partial: true });
    expect(currentPeriod('month', now)).toEqual({ kind: 'month', start: at('2026-10-01'), end: now, partial: true });
    expect(periodFor('this-week', now)).toEqual(currentPeriod('week', now));
    expect(periodFor('this-month', now)).toEqual(currentPeriod('month', now));
    expect(periodFor('week', now)).toEqual(lastPeriod('week', now));
    expect(periodFor('month', now)).toEqual(lastPeriod('month', now));
  });

  it('lists the UTC days a period covers, across a year end and up to today for one going on', () => {
    expect(periodDays(WEEK)).toEqual(['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
    expect(periodDays(lastPeriod('week', at('2026-01-05')))).toEqual([
      '2025-12-29',
      '2025-12-30',
      '2025-12-31',
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      '2026-01-04',
    ]);
    expect(periodDays(lastPeriod('month', at('2026-03-01')))).toHaveLength(28);
    expect(periodDays(currentPeriod('week', at('2026-09-30', 9)))).toEqual(['2026-09-28', '2026-09-29', '2026-09-30']);
  });
});

describe('dueRoundups', () => {
  const monday = '2026-10-05';

  it('is due from the hour on the first day of the next week, until that day ends', () => {
    expect(dueRoundups({}, at(monday, 16.99), 17)).toEqual([]);
    expect(dueRoundups({}, at(monday, 17), 17)).toEqual([WEEK]);
    expect(dueRoundups({}, at(monday, 23.99), 17)).toEqual([WEEK]);
    expect(dueRoundups({}, at('2026-10-06', 0), 17)).toEqual([]);
    expect(dueRoundups({}, at(monday, 0), 0)).toEqual([WEEK]);
  });

  it('is not due once posted', () => {
    const posted = markPosted({}, WEEK);
    expect(posted).toEqual({ week: '2026-09-28' });
    expect(dueRoundups(posted, at(monday, 18), 17)).toEqual([]);
  });

  it('posts both on the 1st of a month that is a Monday', () => {
    const due = dueRoundups({ week: '2026-05-18', month: '2026-04-01' }, at('2026-06-01', 17), 17);
    expect(due.map((period) => [period.kind, period.start])).toEqual([
      ['week', at('2026-05-25')],
      ['month', at('2026-05-01')],
    ]);
  });

  it('reads what was saved, or nothing', () => {
    expect(parseRoundupsPosted({ week: '2026-09-28', month: '2026-09-01' })).toEqual({ week: '2026-09-28', month: '2026-09-01' });
    expect(parseRoundupsPosted(undefined)).toEqual({});
    expect(parseRoundupsPosted('junk')).toEqual({});
  });
});

describe('buildRoundup', () => {
  // Valkyra wins 3 of 4, Lonestar 1 of 4. Manticore only played 1, so it cannot be the best team.
  const matches: MatchRecord[] = [
    match(at('2026-09-28', 20), 'Ozeti', [['Valkyra', 100], ['Lonestar', 23]], [
      p('a', 'Ash', 20, 2, 'Valkyra'),
      p('b', 'Bo', 5, 9, 'Lonestar'),
      p('c', 'Cy', 8, 4, 'Valkyra'),
    ]),
    match(at('2026-09-29', 20), 'Bakurani', [['Lonestar', 100], ['Valkyra', 98]], [
      p('a', 'Ash', 6, 6, 'Valkyra'),
      p('b', 'Bo', 12, 3, 'Lonestar'),
    ], 90),
    match(at('2026-10-01', 20), 'Ozeti', [['Valkyra', 100], ['Lonestar', 60]], [
      p('a', 'Ash2', 9, 3, 'Valkyra'),
      p('b', 'Bo', 9, 3, 'Lonestar'),
    ]),
    match(at('2026-10-04', 23), 'Zestafona', [['Valkyra', 100], ['Lonestar', 80], ['Manticore', 10]], [
      p('a', 'Ash2', 3, 1, 'Valkyra'),
      p('c', 'Cy', 30, 5, 'Manticore'),
    ]),
    // Before the week and after it: not counted.
    match(at('2026-09-27', 23), 'Ozeti', [['Lonestar', 100], ['Valkyra', 0]], [p('b', 'Bo', 99, 0, 'Lonestar')]),
    match(at('2026-10-05', 0), 'Ozeti', [['Lonestar', 100], ['Valkyra', 0]], [p('b', 'Bo', 99, 0, 'Lonestar')]),
  ];

  const days = [
    day('2026-09-27', { b: totals('Bo', { kills: 99, matches: 1, liveMinutes: 60 }) }),
    day('2026-09-28', {
      a: totals('Ash', { kills: 20, deaths: 2, matches: 1, liveMinutes: 50 }),
      b: totals('Bo', { kills: 5, deaths: 9, matches: 1, liveMinutes: 50, seedingMinutes: 30, seedDays: 1 }),
      c: totals('Cy', { kills: 8, deaths: 4, matches: 1, liveMinutes: 50 }),
    }),
    day('2026-09-29', {
      a: totals('Ash', { kills: 6, deaths: 6, matches: 1, liveMinutes: 50, seedingMinutes: 20, seedDays: 1 }),
      b: totals('Bo', { kills: 12, deaths: 3, matches: 1, liveMinutes: 50 }),
    }),
    day('2026-09-30', {}),
    day('2026-10-01', {
      a: totals('Ash2', { kills: 9, deaths: 3, matches: 1, liveMinutes: 50 }),
      b: totals('Bo', { kills: 9, deaths: 3, matches: 1, liveMinutes: 50, seedingMinutes: 15, seedDays: 1 }),
      d: totals('Di', { seedingMinutes: 5 }),
    }),
    day('2026-10-04', {
      a: totals('Ash2', { kills: 3, deaths: 1, matches: 1, liveMinutes: 50 }),
      c: totals('Cy', { kills: 30, deaths: 5, matches: 1, liveMinutes: 50 }),
    }),
    day('2026-10-05', { b: totals('Bo', { kills: 99, matches: 1, liveMinutes: 60 }) }),
  ];

  const roundup = buildRoundup({ period: WEEK, days, matches, idOf });

  it('sums up the week: matches, time played, players, peak and the busiest day', () => {
    expect(roundup).toMatchObject({
      kind: 'week',
      start: WEEK.start,
      end: WEEK.end,
      partial: false,
      matches: 4,
      playedMs: 4 * 50 * 60_000,
      players: 4,
      peakPlayers: 90,
      busiestDay: { day: '2026-09-28', players: 3 },
    });
  });

  it('ranks the teams by win rate among those with 3+ matches, and names the best', () => {
    expect(roundup?.teams).toEqual([
      { name: 'Valkyra', colorHex: '#3366ff', matches: 4, wins: 3, losses: 1, draws: 0 },
      { name: 'Lonestar', matches: 4, wins: 1, losses: 3, draws: 0 },
      { name: 'Manticore', matches: 1, wins: 0, losses: 1, draws: 0 },
    ]);
    expect(roundup?.bestTeam?.name).toBe('Valkyra');
  });

  it('names no best team when the top two are level, or none played enough', () => {
    const level = [
      match(at('2026-09-28', 20), 'Ozeti', [['Valkyra', 100], ['Lonestar', 50]], []),
      match(at('2026-09-29', 20), 'Ozeti', [['Lonestar', 100], ['Valkyra', 50]], []),
      match(at('2026-09-30', 20), 'Ozeti', [['Valkyra', 100], ['Lonestar', 50]], []),
      match(at('2026-10-01', 20), 'Ozeti', [['Lonestar', 100], ['Valkyra', 50]], []),
    ];
    expect(buildRoundup({ period: WEEK, days, matches: level, idOf })?.bestTeam).toBeNull();
    expect(buildRoundup({ period: WEEK, days, matches: level.slice(0, 2), idOf })?.bestTeam).toBeNull();
  });

  it('counts a draw for each side level at the top, and a loss for the rest', () => {
    const drawn = [match(at('2026-09-28', 20), 'Ozeti', [['Valkyra', 80], ['Lonestar', 80], ['Manticore', 10]], [])];
    expect(buildRoundup({ period: WEEK, days, matches: drawn, idOf })?.teams).toEqual([
      { name: 'Lonestar', matches: 1, wins: 0, losses: 0, draws: 1 },
      { name: 'Valkyra', colorHex: '#3366ff', matches: 1, wins: 0, losses: 0, draws: 1 },
      { name: 'Manticore', matches: 1, wins: 0, losses: 1, draws: 0 },
    ]);
  });

  it('gives the top 3 on each board, by public id, with their latest name', () => {
    // Level on kills, fewer deaths first.
    expect(roundup?.kills).toEqual([
      { name: 'Cy', id: 'cccccccccccc', kills: 38 },
      { name: 'Ash2', id: 'aaaaaaaaaaaa', kills: 38 },
      { name: 'Bo', id: 'bbbbbbbbbbbb', kills: 26 },
    ]);
    expect(roundup?.kd.map((p) => [p.name, p.kd])).toEqual([
      ['Ash2', 38 / 12],
      ['Bo', 26 / 15],
    ]);
    expect(roundup?.playtime.map((p) => [p.name, p.minutes])).toEqual([
      ['Ash2', 220],
      ['Bo', 195],
      ['Cy', 100],
    ]);
    expect(roundup?.seeding).toEqual([
      { name: 'Bo', id: 'bbbbbbbbbbbb', seedDays: 2, minutes: 45 },
      { name: 'Ash2', id: 'aaaaaaaaaaaa', seedDays: 1, minutes: 20 },
      { name: 'Di', id: 'dddddddddddd', seedDays: 0, minutes: 5 },
    ]);
    expect(JSON.stringify(roundup)).not.toMatch(/steamId/);
  });

  it('counts wins on the winning side, MVPs (players level at the top share it) and each best match', () => {
    expect(roundup?.wins).toEqual([
      { name: 'Ash2', id: 'aaaaaaaaaaaa', wins: 3, played: 4 },
      { name: 'Cy', id: 'cccccccccccc', wins: 1, played: 2 },
      { name: 'Bo', id: 'bbbbbbbbbbbb', wins: 1, played: 3 },
    ]);
    expect(roundup?.mvps).toEqual([
      { name: 'Ash2', id: 'aaaaaaaaaaaa', mvps: 2 },
      { name: 'Bo', id: 'bbbbbbbbbbbb', mvps: 2 },
      { name: 'Cy', id: 'cccccccccccc', mvps: 1 },
    ]);
    expect(roundup?.bestMatch).toEqual([
      { name: 'Cy', id: 'cccccccccccc', kills: 30, deaths: 5, map: 'Zestafona' },
      { name: 'Ash2', id: 'aaaaaaaaaaaa', kills: 20, deaths: 2, map: 'Ozeti' },
      { name: 'Bo', id: 'bbbbbbbbbbbb', kills: 12, deaths: 3, map: 'Bakurani' },
    ]);
  });

  it('picks the biggest win, the closest finish and the most played map', () => {
    expect(roundup?.biggestWin).toEqual({
      map: 'Ozeti',
      endedAt: at('2026-09-28', 20),
      factionScores: [
        { name: 'Valkyra', score: 100, colorHex: '#3366ff' },
        { name: 'Lonestar', score: 23 },
      ],
    });
    expect(roundup?.closestMatch).toMatchObject({ map: 'Bakurani' });
    expect(roundup?.topMap).toEqual({ map: 'Ozeti', matches: 2 });
  });

  it('leaves out a closest finish that is the biggest win, and a most played map that is level', () => {
    const one = buildRoundup({ period: WEEK, days, matches: matches.slice(0, 1), idOf });
    expect(one?.biggestWin).toMatchObject({ map: 'Ozeti' });
    expect(one?.closestMatch).toBeNull();
    expect(buildRoundup({ period: WEEK, days, matches: matches.slice(1, 3), idOf })?.topMap).toBeNull();
  });

  it('works without matches, and is null when nobody played', () => {
    const quiet = buildRoundup({ period: WEEK, days, matches: [], idOf });
    expect(quiet).toMatchObject({ matches: 0, playedMs: 0, peakPlayers: null, teams: [], bestTeam: null, biggestWin: null, topMap: null });
    expect(quiet?.seeding).toHaveLength(3);
    expect(buildRoundup({ period: WEEK, days: [days[0]!, day('2026-09-30', {})], matches, idOf })).toBeNull();
  });

  it('counts a week still going up to now', () => {
    const now = at('2026-09-29', 21);
    const soFar = buildRoundup({ period: currentPeriod('week', now), days, matches, idOf });
    expect(soFar).toMatchObject({ partial: true, matches: 2, players: 3 });
    // Level on days, and Bo played longer.
    expect(soFar?.regular).toEqual({ name: 'Bo', id: 'bbbbbbbbbbbb', days: 2, of: 2 });
  });

  it('names who was on the most days, more time played first when level', () => {
    expect(roundup?.regular).toEqual({ name: 'Ash2', id: 'aaaaaaaaaaaa', days: 4, of: 7 });
  });

  it('names the rookie who played the most, once the records go back 4 weeks before the period', () => {
    expect(roundup?.rookie).toBeNull();
    // Ash played a month before; Bo the day before the week.
    const longer = [day('2026-08-31', { a: totals('Ash', { liveMinutes: 10 }) }), ...days];
    expect(buildRoundup({ period: WEEK, days: longer, matches, idOf })?.rookie).toEqual({ name: 'Cy', id: 'cccccccccccc', minutes: 100 });
    const shorter = [day('2026-09-01', { a: totals('Ash', { liveMinutes: 10 }) }), ...days];
    expect(buildRoundup({ period: WEEK, days: shorter, matches, idOf })?.rookie).toBeNull();
  });

  describe('awards from the kill feed', () => {
    const kills = (steamId: string, name: string, date: string, headshots: number, weapons: KillDaySummary['weapons']): KillDaySummary => ({
      day: date,
      steamId,
      name,
      kills: Object.values(weapons).reduce((n, w) => n + w.kills, 0),
      headshots,
      weapons,
    });
    const longest = (distance: number, steamId: string, name: string): WeaponDay[string] => ({
      kills: 1,
      headshots: 0,
      ranged: 1,
      distance,
      longest: { distance, steamId, name },
    });
    const feed: FeedSources = {
      since: '2026-09-01',
      kills: [
        kills('a', 'Ash', '2026-09-28', 4, {
          'Id.Item.AK74M': { kills: 10, headshots: 4 },
          // A team kill with the mortar does not count.
          'Vehicle.Variant.Stationary.Mortar': { kills: 3, headshots: 0, teamKills: 1 },
          'Id.Vehicle.WeaponExtension.STN_03.MainBarrel': { kills: 2, headshots: 0 },
          'Id.Item.Fists': { kills: 1, headshots: 0 },
        }),
        kills('b', 'Bo', '2026-09-29', 6, {
          'Id.Item.M249': { kills: 6, headshots: 1 },
          'Id.Item.SV98': { kills: 4, headshots: 4 },
          'Id.Item.Glock17': { kills: 2, headshots: 1 },
          'Vehicle.Variant.Land.Wheeled.Humvee.Default': { kills: 2, headshots: 0 },
        }),
        kills('e', 'Eve', '2026-09-30', 0, { 'Id.Item.RPG7': { kills: 2, headshots: 0 } }),
        kills('c', 'Cy', '2026-10-04', 0, {
          'Vehicle.Variant.Stationary.Mortar': { kills: 5, headshots: 0 },
          'Id.Item.AK74M': { kills: 1, headshots: 0 },
          'Id.Vehicle.WeaponExtension.TNK_01.Heavy': { kills: 3, headshots: 0 },
        }),
        // After the week.
        kills('c', 'Cy', '2026-10-05', 99, { 'Id.Item.AK74M': { kills: 99, headshots: 99 } }),
      ],
      weapons: [
        { day: '2026-09-29', weapons: { 'Id.Item.SV98': longest(512.4, 'b', 'Bo') } },
        // Not a shot.
        { day: '2026-10-04', weapons: { 'Vehicle.Variant.Stationary.Mortar': longest(900, 'c', 'Cy') } },
        { day: '2026-10-05', weapons: { 'Id.Item.SV98': longest(2000, 'c', 'Cy') } },
      ],
    };
    const awarded = buildRoundup({ period: WEEK, days, matches, idOf, feed })?.awards;

    it('ranks each role by its kills, team kills left out, with their latest names', () => {
      expect(Object.fromEntries((awarded?.roles ?? []).map(({ role, top }) => [role, top.map((p) => [p.name, p.kills])]))).toEqual({
        assault: [
          ['Ash2', 10],
          ['Cy', 1],
        ],
        // The mortar and its barrel together.
        support: [
          ['Cy', 5],
          ['Ash2', 4],
        ],
        'machine-gun': [['Bo', 6]],
        marksman: [['Bo', 4]],
        demolition: [['Eve', 2]],
        'vehicle-gun': [['Cy', 3]],
      });
      expect(awarded?.roles[0]?.top[0]).toEqual({ name: 'Ash2', id: 'aaaaaaaaaaaa', kills: 10 });
      expect(JSON.stringify(awarded)).not.toMatch(/steamId/);
    });

    it('gives each award to one player', () => {
      expect(awarded).toMatchObject({
        from: '2026-09-28',
        headshots: { name: 'Bo', id: 'bbbbbbbbbbbb', headshots: 6 },
        longest: { name: 'Bo', id: 'bbbbbbbbbbbb', distance: 512.4, weapon: 'SV98' },
        variety: { name: 'Bo', weapons: 4 },
        roadKills: { name: 'Bo', kills: 2 },
        melee: { name: 'Ash2', kills: 1 },
        sidearm: { name: 'Bo', kills: 2 },
      });
    });

    it('counts from the first day the kill feed has, when that is during the period', () => {
      const later = buildRoundup({ period: WEEK, days, matches, idOf, feed: { ...feed, since: '2026-09-30' } })?.awards;
      expect(later?.from).toBe('2026-09-30');
      expect(later?.roles[0]?.top).toEqual([{ name: 'Cy', id: 'cccccccccccc', kills: 1 }]);
      expect(later?.longest).toBeNull();
      expect(later?.melee).toBeNull();
    });

    it('has none without the kill feed, or with only team kills', () => {
      expect(roundup?.awards).toBeNull();
      const teamKills = [kills('a', 'Ash', '2026-09-28', 0, { 'Id.Item.AK74M': { kills: 2, headshots: 0, teamKills: 2 } })];
      expect(buildRoundup({ period: WEEK, days, matches, idOf, feed: { ...feed, kills: teamKills, weapons: [] } })?.awards).toBeNull();
    });
  });
});
