import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  adminFeed,
  buildAdminKills,
  buildPlayerKills,
  chanceOfAtLeast,
  createKillDays,
  DAY_KILLS_KEPT,
  FEED_BYTES,
  FEED_KEPT,
  firstKillDay,
  flaggedDay,
  headshotOdds,
  headshotRows,
  headshotsOn,
  killDaySummaries,
  parseKillFeed,
  playerKillDays,
  pruneKillDays,
  readKillDays,
  recordKillDay,
  recordKillFeed,
  socketSession,
  STAFF_SOCKET_PROTOCOL,
  tally,
  toStaffKills,
  writeKillDays,
  type KillDay,
  type KillDaySummary,
  type Sql,
  type StaffKill,
} from '../src/killfeed.ts';
import type { FeedKill } from '../src/weapons.ts';

const ASH = '76561198000000001';
const BO = '76561198000000002';
const CY = '76561198000000003';
const DEE = '76561198000000004';
const NAMES: Record<string, string> = { [ASH]: 'Ash', [BO]: 'Bo', [CY]: 'Cy', [DEE]: 'Dee' };
const SIDES: Record<string, string> = { [ASH]: 'Valkyra', [BO]: 'Valkyra', [CY]: 'Kharr' };
const NOW = Date.UTC(2026, 9, 4, 20);
const AK = 'Id.Item.AK74M';
const SVD = 'Id.Item.SVDM';

// The Durable Object's database, as Node's SQLite. Like Cloudflare's, a statement runs as soon as it is given.
const database = (): Sql => {
  const db = new DatabaseSync(':memory:');
  return {
    exec: (query, ...bindings) => {
      const rows = db.prepare(query).all(...(bindings as SQLInputValue[])) as Record<string, unknown>[];
      return { toArray: () => rows };
    },
  };
};

const feedKill = (killer: string, victim: string, overrides: Partial<FeedKill> = {}): FeedKill => ({
  eventId: 'e',
  time: 100,
  matchId: 'm1',
  map: 'Kavkazi',
  victimSteamId: victim,
  victimName: NAMES[victim] ?? '',
  killerSteamId: killer,
  killerName: NAMES[killer] ?? '',
  cause: AK,
  distance: 42.36,
  headshot: false,
  tags: [],
  ...overrides,
});

const kill = (killer: string, victim: string, overrides: Partial<StaffKill> = {}): StaffKill => ({
  at: NOW,
  map: 'Kavkazi',
  killer,
  killerName: NAMES[killer] ?? '',
  victim,
  victimName: NAMES[victim] ?? '',
  cause: AK,
  distance: 42.36,
  headshot: false,
  tags: [],
  teamKill: false,
  ...overrides,
});

// A player's day with `kills` kills with `cause`, `headshots` of them headshots.
const summary = (steamId: string, day: string, weapons: Record<string, [number, number]>): KillDaySummary => {
  const counts = Object.entries(weapons).map(([cause, [kills, headshots]]) => [cause, { kills, headshots }] as const);
  return {
    day,
    steamId,
    name: NAMES[steamId] ?? '',
    kills: counts.reduce((n, [, w]) => n + w.kills, 0),
    headshots: counts.reduce((n, [, w]) => n + w.headshots, 0),
    weapons: Object.fromEntries(counts),
  };
};

describe('toStaffKills', () => {
  it('keeps who killed whom, with what, and whether they were on the same side', () => {
    const kills = toStaffKills(
      [feedKill(ASH, CY, { headshot: true, tags: ['Penetration'] }), feedKill(ASH, BO), feedKill(DEE, ASH)],
      NOW,
      (steamId) => SIDES[steamId] ?? null,
    );
    expect(kills[0]).toEqual({
      at: NOW,
      map: 'Kavkazi',
      killer: ASH,
      killerName: 'Ash',
      victim: CY,
      victimName: 'Cy',
      cause: AK,
      distance: 42.36,
      headshot: true,
      tags: ['Penetration'],
      teamKill: false,
    });
    expect(kills.map((k) => k.teamKill)).toEqual([false, true, false]);
  });
});

describe('recordKillFeed', () => {
  it('keeps the latest kills, oldest first', () => {
    const feed = recordKillFeed(
      [],
      Array.from({ length: FEED_KEPT + 5 }, (_, i) => kill(ASH, CY, { at: i })),
    );
    expect(feed).toHaveLength(FEED_KEPT);
    expect(feed[0]?.at).toBe(5);
    expect(recordKillFeed(feed, [kill(BO, CY, { at: 999 })]).at(-1)).toMatchObject({ at: 999, killer: BO });
  });

  it('keeps fewer when long names would make it too big to store', () => {
    const long = 'Ж'.repeat(100);
    const feed = recordKillFeed(
      [],
      Array.from({ length: FEED_KEPT }, (_, i) => kill(ASH, CY, { at: i, killerName: long, victimName: long })),
    );
    expect(new TextEncoder().encode(JSON.stringify(feed)).length).toBeLessThanOrEqual(FEED_BYTES);
    expect(feed.length).toBeGreaterThan(100);
    expect(feed.at(-1)?.at).toBe(FEED_KEPT - 1);
  });

  it('reads back what it wrote, and nothing from anything else', () => {
    const feed = [kill(ASH, CY, { headshot: true })];
    expect(parseKillFeed(JSON.parse(JSON.stringify(feed)))).toEqual(feed);
    expect(parseKillFeed(undefined)).toEqual([]);
    expect(parseKillFeed([{ at: 'soon' }])).toEqual([]);
  });
});

describe('recordKillDay', () => {
  it('adds up kills and headshots, by weapon too, and keeps each kill without the killer', () => {
    const first = recordKillDay(null, ASH, '2026-10-04', [
      kill(ASH, CY, { headshot: true }),
      kill(ASH, BO, { cause: SVD, teamKill: true }),
    ]);
    const day = recordKillDay(first, ASH, '2026-10-04', [kill(ASH, CY, { headshot: true, at: NOW + 1 })]);
    expect(day).toMatchObject({
      day: '2026-10-04',
      steamId: ASH,
      name: 'Ash',
      kills: 3,
      headshots: 2,
      // The team kill is counted apart too, and is not the SVD's longest.
      weapons: { [AK]: { kills: 2, headshots: 2, longest: 42.36 }, [SVD]: { kills: 1, headshots: 0, teamKills: 1 } },
    });
    expect(day.list).toHaveLength(3);
    expect(day.list[1]).toEqual({
      at: NOW,
      map: 'Kavkazi',
      victim: BO,
      victimName: 'Bo',
      cause: SVD,
      distance: 42.36,
      headshot: false,
      tags: [],
      teamKill: true,
    });
    expect(first.kills).toBe(2);
  });

  it('keeps their latest kills, and counts them all', () => {
    const kills = Array.from({ length: DAY_KILLS_KEPT + 3 }, (_, i) => kill(ASH, CY, { at: i }));
    const day = recordKillDay(null, ASH, '2026-10-04', kills);
    expect(day.kills).toBe(DAY_KILLS_KEPT + 3);
    expect(day.list).toHaveLength(DAY_KILLS_KEPT);
    expect(day.list[0]?.at).toBe(3);
  });

  it('keeps the name it has when the game sends none', () => {
    const first = recordKillDay(null, ASH, '2026-10-04', [kill(ASH, CY)]);
    expect(recordKillDay(first, ASH, '2026-10-04', [kill(ASH, CY, { killerName: '' })]).name).toBe('Ash');
  });
});

describe('the kill_days table', () => {
  it('saves and reads back players’ days, changing a day in place', () => {
    const sql = database();
    createKillDays(sql);
    createKillDays(sql);
    const ash = recordKillDay(null, ASH, '2026-10-04', [kill(ASH, CY, { headshot: true })]);
    const bo = recordKillDay(null, BO, '2026-10-04', [kill(BO, CY)]);
    writeKillDays(sql, [ash, bo, recordKillDay(null, ASH, '2026-10-03', [kill(ASH, BO)])]);
    expect(readKillDays(sql, '2026-10-04', [ASH, CY])).toEqual(new Map([[ASH, ash]]));
    const more = recordKillDay(ash, ASH, '2026-10-04', [kill(ASH, BO, { headshot: true })]);
    writeKillDays(sql, [more]);
    expect(readKillDays(sql, '2026-10-04', [ASH]).get(ASH)).toEqual(more);
    expect(killDaySummaries(sql, '2026-10-04', '2026-10-04')).toEqual([
      { day: '2026-10-04', steamId: ASH, name: 'Ash', kills: 2, headshots: 2, weapons: { [AK]: { kills: 2, headshots: 2, longest: 42.36 } } },
      { day: '2026-10-04', steamId: BO, name: 'Bo', kills: 1, headshots: 0, weapons: { [AK]: { kills: 1, headshots: 0, longest: 42.36 } } },
    ]);
    expect(playerKillDays(sql, ASH, '2026-10-01').map((d) => [d.day, d.kills, d.list.length])).toEqual([
      ['2026-10-03', 1, 1],
      ['2026-10-04', 2, 2],
    ]);
    expect(firstKillDay(sql)).toBe('2026-10-03');
    // Older days keep their counts but not their kills, and the oldest go.
    pruneKillDays(sql, '2026-10-03', '2026-10-04');
    expect(playerKillDays(sql, ASH, '2026-10-01').map((d) => [d.day, d.kills, d.list.length])).toEqual([
      ['2026-10-03', 1, 0],
      ['2026-10-04', 2, 2],
    ]);
    pruneKillDays(sql, '2026-10-04', '2026-10-04');
    expect(firstKillDay(sql)).toBe('2026-10-04');
    expect(playerKillDays(sql, ASH, '2026-10-01').map((d) => d.day)).toEqual(['2026-10-04']);
  });

  it('keeps the team kills and their headshots by weapon, and the longest of the other kills', () => {
    const sql = database();
    createKillDays(sql);
    const day = recordKillDay(null, ASH, '2026-10-04', [
      kill(ASH, BO, { cause: SVD, teamKill: true, headshot: true, distance: 900 }),
      kill(ASH, CY, { cause: SVD, distance: 310.5 }),
      kill(ASH, CY, { cause: SVD, distance: null }),
    ]);
    writeKillDays(sql, [day]);
    expect(killDaySummaries(sql, '2026-10-04', '2026-10-04')[0]?.weapons).toEqual({
      [SVD]: { kills: 3, headshots: 1, teamKills: 1, teamHeadshots: 1, longest: 310.5 },
    });
  });

  it('has no first day before the first kill', () => {
    const sql = database();
    createKillDays(sql);
    expect(firstKillDay(sql)).toBeNull();
    expect(readKillDays(sql, '2026-10-04', [ASH]).size).toBe(0);
  });
});

describe('chanceOfAtLeast', () => {
  it('is the chance of that many headshots or more by luck', () => {
    expect(chanceOfAtLeast(10, 10, 0.5)).toBeCloseTo(1 / 1024, 10);
    expect(chanceOfAtLeast(20, 10, 0.25)).toBeCloseTo(0.01386, 4);
    expect(chanceOfAtLeast(20, 0, 0.25)).toBe(1);
    expect(chanceOfAtLeast(20, 21, 0.25)).toBe(0);
    expect(chanceOfAtLeast(3000, 2000, 0.3)).toBeLessThan(1e-200);
  });
});

describe('headshotOdds', () => {
  // The server: 1,000 AK kills with 25% headshots, 200 SVD kills with 60%.
  const server = tally([{ weapons: { [AK]: { kills: 1000, headshots: 250 }, [SVD]: { kills: 200, headshots: 120 } } }]);
  const none = tally([]);

  it('expects what the server’s players get with each weapon', () => {
    const ak = headshotOdds({ [AK]: { kills: 40, headshots: 10 } }, server, none);
    expect(ak?.expected).toBeCloseTo(40 * ((250 + 20 * (370 / 1200)) / 1020), 6);
    expect(ak?.chance).toBeGreaterThan(0.4);
    // A sniper's share of headshots is ordinary with a sniper rifle.
    const svd = headshotOdds({ [SVD]: { kills: 40, headshots: 26 } }, server, none);
    expect(svd?.chance).toBeGreaterThan(0.05);
    // The same with an AK is not.
    expect(headshotOdds({ [AK]: { kills: 40, headshots: 26 } }, server, none)?.chance).toBeLessThan(1e-6);
  });

  it('leaves the player’s own kills out of the server’s', () => {
    const own = tally([{ weapons: { [AK]: { kills: 500, headshots: 250 } } }]);
    const withThem = tally([{ weapons: { [AK]: { kills: 1500, headshots: 500 } } }]);
    expect(headshotOdds({ [AK]: { kills: 500, headshots: 250 } }, withThem, own)?.expected).toBeCloseTo(500 * 0.25, 6);
  });

  it('pulls a weapon few use towards the server’s share', () => {
    const rare = 'Id.Item.CombatBow';
    const withBow = tally([{ weapons: { [AK]: { kills: 1000, headshots: 250 }, [rare]: { kills: 2, headshots: 2 } } }]);
    const odds = headshotOdds({ [rare]: { kills: 1, headshots: 1 } }, withBow, none);
    expect(odds?.expected).toBeCloseTo((2 + 20 * (252 / 1002)) / 22, 6);
  });

  it('says nothing until the server has enough kills', () => {
    const quiet = tally([{ weapons: { [AK]: { kills: 99, headshots: 20 } } }]);
    expect(headshotOdds({ [AK]: { kills: 30, headshots: 30 } }, quiet, none)).toBeNull();
  });

  it('flags a day with enough kills and less than one chance in a thousand', () => {
    expect(flaggedDay(10, { expected: 2, chance: 0.0009 })).toBe(true);
    expect(flaggedDay(9, { expected: 2, chance: 0.0000001 })).toBe(false);
    expect(flaggedDay(30, { expected: 2, chance: 0.0011 })).toBe(false);
    expect(flaggedDay(30, null)).toBe(false);
  });
});

// Everyone else: 40 players a day with 25 AK kills each, a quarter of them headshots.
const crowd = (day: string): KillDaySummary[] =>
  Array.from({ length: 40 }, (_, i) => summary(`7656119900000${String(i).padStart(4, '0')}`, day, { [AK]: [25, 6] }));

describe('headshotRows', () => {
  it('lists players with headshots, most flagged days first, then least likely by luck', () => {
    const kept = [
      ...crowd('2026-10-03'),
      ...crowd('2026-10-04'),
      summary(ASH, '2026-10-03', { [AK]: [20, 15] }),
      summary(ASH, '2026-10-04', { [AK]: [12, 9], [SVD]: [3, 2] }),
      summary(BO, '2026-10-04', { [AK]: [8, 6] }),
      summary(CY, '2026-10-04', { [AK]: [20, 0] }),
    ];
    const rows = headshotRows(
      kept.filter((d) => d.day === '2026-10-04' || d.steamId === ASH),
      kept,
    );
    expect(rows[0]).toMatchObject({ steamId: ASH, name: 'Ash', kills: 35, headshots: 26, days: 2, flaggedDays: 2, weapon: 'AK74' });
    expect(rows[0]?.chance).toBeLessThan(1e-6);
    expect(rows[0]?.expected).toBeGreaterThan(8);
    expect(rows[1]).toMatchObject({ steamId: BO, flaggedDays: 0 });
    expect(rows.some((r) => r.steamId === CY)).toBe(false);
    expect(rows).toHaveLength(42);
  });
});

describe('buildAdminKills', () => {
  it('has the latest kills newest first, and the headshots list with those in game first', () => {
    const kept = [...crowd('2026-10-04'), summary(ASH, '2026-10-04', { [AK]: [20, 15] }), summary(BO, '2026-10-02', { [AK]: [10, 3] })];
    const page = buildAdminKills({
      now: NOW,
      days: 1,
      since: '2026-10-02',
      from: '2026-10-04',
      kept,
      inGame: new Set([`76561199000000007`]),
      feed: [
        kill(ASH, CY, { at: 1, map: 'Kavkazi', headshot: true }),
        kill(BO, CY, { at: 2, map: '', cause: SVD, distance: 312.349, killerName: '' }),
      ],
    });
    expect(page).toMatchObject({ generatedAt: NOW, days: 1, since: '2026-10-02', flag: { kills: 10, odds: 1000 } });
    expect(page.totals).toEqual({ kills: 1020, headshots: 255, players: 41, flaggedPlayers: 1 });
    expect(page.players[0]).toMatchObject({ steamId: '76561199000000007', inGame: true });
    expect(page.players[1]).toMatchObject({ steamId: ASH, name: 'Ash', flaggedDays: 1, inGame: false });
    expect(page.players.some((p) => p.steamId === BO)).toBe(false);
    expect(page.feed).toEqual([
      {
        at: 2,
        map: '',
        killer: { steamId: BO, name: BO },
        victim: { steamId: CY, name: 'Cy' },
        weapon: 'SVD',
        weaponKind: 'weapon',
        distance: 312.3,
        headshot: false,
        tags: [],
        teamKill: false,
      },
      expect.objectContaining({ at: 1, map: 'Bakurani', killer: { steamId: ASH, name: 'Ash' }, headshot: true }),
    ]);
  });
});

describe('buildPlayerKills', () => {
  it('has their kills by weapon and by day, and each kill newest first', () => {
    const yesterday = recordKillDay(null, ASH, '2026-10-03', [kill(ASH, CY, { at: 1, headshot: true })]);
    const today = recordKillDay(null, ASH, '2026-10-04', [
      kill(ASH, CY, { at: 2, headshot: true }),
      kill(ASH, BO, {
        at: 3,
        cause: 'Vehicle.Variant.Land.Tracked.SpawnVehicle.Lonestar',
        distance: null,
        tags: ['RoadKill'],
        teamKill: true,
      }),
      kill(ASH, CY, { at: 4, cause: 'Vehicle.Variant.Land.Tracked.SpawnVehicle.Valkyra', distance: null }),
    ]);
    const { list: _list, ...todaySummary } = today;
    const { list: _old, ...yesterdaySummary } = yesterday;
    const page = buildPlayerKills({
      now: NOW,
      days: 7,
      since: '2026-10-03',
      from: '2026-09-28',
      kept: [...crowd('2026-10-04'), yesterdaySummary, todaySummary],
      inGame: new Set([ASH]),
      steamId: ASH,
      rows: [yesterday, today],
      name: undefined,
      idOf: (steamId) => (steamId === ASH ? 'a00000000001' : undefined),
    });
    expect(page).toMatchObject({
      player: { steamId: ASH, name: 'Ash', id: 'a00000000001', inGame: true },
      kills: 4,
      headshots: 2,
      flaggedDays: 0,
      kept: 4,
    });
    expect(page.weapons.map((w) => [w.name, w.kind, w.kills, w.headshots])).toEqual([
      ['AK74', 'weapon', 2, 2],
      ['M113 APC', 'vehicle', 2, 0],
    ]);
    expect(page.weapons[0]?.expected).toBeCloseTo(0.5, 1);
    expect(page.byDay.map((d) => [d.day, d.kills, d.headshots, d.flagged])).toEqual([
      ['2026-10-04', 3, 1, false],
      ['2026-10-03', 1, 1, false],
    ]);
    expect(page.list.map((k) => k.at)).toEqual([4, 3, 2, 1]);
    expect(page.list[1]).toEqual({
      at: 3,
      map: 'Bakurani',
      victim: { steamId: BO, name: 'Bo' },
      weapon: 'M113 APC',
      weaponKind: 'vehicle',
      distance: null,
      headshot: false,
      tags: ['RoadKill'],
      teamKill: true,
    });
  });

  it('has nothing for a player without kills in the period', () => {
    const page = buildPlayerKills({
      now: NOW,
      days: 1,
      since: null,
      from: '2026-10-04',
      kept: [],
      inGame: new Set(),
      steamId: DEE,
      rows: [],
      name: 'Dee',
      idOf: () => undefined,
    });
    expect(page).toMatchObject({
      player: { steamId: DEE, name: 'Dee', inGame: false },
      kills: 0,
      headshots: 0,
      expected: null,
      chance: null,
      weapons: [],
      byDay: [],
      list: [],
    });
  });
});

describe('the live kill feed', () => {
  it('sends a batch newest first, as the feed shows it', () => {
    const feed = adminFeed([kill(ASH, CY, { at: 1, headshot: true }), kill(BO, CY, { at: 2 })]);
    expect(feed.map((k) => [k.at, k.killer.name, k.victim.name, k.weapon, k.headshot])).toEqual([
      [2, 'Bo', 'Cy', 'AK74', false],
      [1, 'Ash', 'Cy', 'AK74', true],
    ]);
  });

  it('reads the session the staff page sends as the socket’s second subprotocol', () => {
    expect(socketSession(`${STAFF_SOCKET_PROTOCOL}, abc.def`)).toBe('abc.def');
    expect(socketSession(`${STAFF_SOCKET_PROTOCOL},abc.def`)).toBe('abc.def');
    expect(socketSession(STAFF_SOCKET_PROTOCOL)).toBeNull();
    expect(socketSession('chat, abc.def')).toBeNull();
    expect(socketSession(null)).toBeNull();
  });
});

describe('headshotsOn', () => {
  it('judges today’s headshots of the players asked about who killed someone today', () => {
    const kept = [
      ...crowd('2026-10-03'),
      ...crowd('2026-10-04'),
      summary(ASH, '2026-10-04', { [AK]: [12, 10] }),
      summary(BO, '2026-10-04', { [AK]: [8, 2] }),
      summary(CY, '2026-10-03', { [AK]: [20, 5] }),
    ];
    const today = headshotsOn(kept, '2026-10-04', [ASH, BO, CY, DEE]);
    expect([...today.keys()]).toEqual([ASH, BO]);
    expect(today.get(ASH)).toMatchObject({ kills: 12, headshots: 10, flagged: true });
    expect(today.get(ASH)?.expected).toBeCloseTo(3, 0);
    expect(today.get(BO)).toMatchObject({ kills: 8, headshots: 2, flagged: false });
    expect(today.get(BO)?.chance).toBeGreaterThan(0.3);
  });
});
