import { describe, expect, it } from 'vitest';
import { adminSteamIds, buildAdminOverview, riskySteamIds, steamPlayers, type AdminSources } from '../src/admin.ts';
import { emptyGriefDay, FLAGS, recordGrief } from '../src/griefing.ts';
import type { BanRecord, ModEntry } from '../src/moderation.ts';
import type { PlayerTotals } from '../src/players.ts';
import type { DayRecords } from '../src/profiles.ts';
import type { SteamCheck } from '../src/steam.ts';
import type { FeedEvent } from '../src/weapons.ts';

const ASH = '76561198000000001';
const BO = '76561198000000002';
const CY = '76561198000000003';
const DEE = '76561198000000004';
const NOW = Date.UTC(2026, 9, 3, 20);
const DAY = 24 * 60 * 60_000;
const SIDES: Record<string, string> = { [ASH]: 'Valkyra', [BO]: 'Valkyra', [CY]: 'Kharr' };
const NAMES: Record<string, string> = { [ASH]: 'Ash', [BO]: 'Bo', [CY]: 'Cy', [DEE]: 'Dee' };

const death = (killer: string, victim: string, overrides: Partial<FeedEvent> = {}): FeedEvent => ({
  eventId: 'e',
  time: 100,
  matchId: 'm1',
  map: 'Europe',
  victimSteamId: victim,
  victimName: NAMES[victim] ?? '',
  killerSteamId: killer,
  killerName: NAMES[killer] ?? '',
  cause: 'Id.Item.AK74M',
  distance: 12.34,
  headshot: false,
  tags: [],
  ...overrides,
});

const totals = (overrides: Partial<PlayerTotals> = {}): PlayerTotals => ({
  name: 'Ash',
  seedingMinutes: 30,
  liveMinutes: 90,
  seedDays: 1,
  matches: 2,
  kills: 40,
  deaths: 20,
  ...overrides,
});

const sources = (overrides: Partial<AdminSources> = {}): AdminSources => {
  const day = recordGrief(
    emptyGriefDay(),
    [death(ASH, BO), death(ASH, BO), death(ASH, BO), death(ASH, BO), death(ASH, CY)],
    NOW - DAY,
    (id) => SIDES[id] ?? null,
  ).day;
  return {
    now: NOW,
    days: 7,
    feedSince: '2026-09-20',
    grief: [day, emptyGriefDay()],
    playerDays: [{ [ASH]: totals() }, { [ASH]: totals({ matches: 1, kills: 10 }) }],
    modLogs: new Map(),
    serverBans: [],
    banBook: {},
    nameOf: (steamId) => NAMES[steamId],
    idOf: (steamId) => (steamId === ASH ? 'a00000000001' : undefined),
    staffNames: {},
    staffProfiles: {},
    reserved: null,
    vip: { granted: {}, checkedAt: 0, revoked: {}, staffSpots: {} },
    steam: null,
    server: null,
    online: null,
    match: {},
    history: [],
    headshots: new Map(),
    joins: [],
    ...overrides,
  };
};

describe('buildAdminOverview', () => {
  it('lists possible griefers with their flags, totals for scale, and whether they are banned', () => {
    const overview = buildAdminOverview(sources({ serverBans: [{ steamId: ASH, reason: 'TK', bannedBy: null }] }));

    expect(overview).toMatchObject({ generatedAt: NOW, days: 7, feedSince: '2026-09-20', flags: FLAGS });
    expect(overview.totals).toEqual({ teamKills: 4, vehicleTeamKills: 0, crashTeamKills: 0, suicides: 0, vehicleSuicides: 0, flaggedPlayers: 1 });
    expect(overview.players).toEqual([
      {
        steamId: ASH,
        name: 'Ash',
        id: 'a00000000001',
        teamKills: 4,
        vehicleTeamKills: 0,
        crashTeamKills: 0,
        teamKilled: 0,
        suicides: 0,
        vehicleSuicides: 0,
        mostKilledTeammate: { steamId: BO, name: 'Bo', kills: 4 },
        flags: ['teamKills', 'sameTeammate'],
        flaggedDays: 1,
        matches: 3,
        kills: 50,
        deaths: 40,
        minutes: 240,
        banned: true,
      },
      expect.objectContaining({ steamId: BO, name: 'Bo', teamKilled: 4, banned: false }),
    ]);
  });

  it('lists the griefers in game first, so the limit never leaves them out', () => {
    const online = { at: NOW - 30_000, map: 'Europe', players: [{ steamId: BO, name: 'Bo', kills: 0, deaths: 0 }] };

    expect(buildAdminOverview(sources({ online })).players.map((p) => p.steamId)).toEqual([BO, ASH]);
  });

  it('shows each incident, newest first, with the map and weapon by name', () => {
    const overview = buildAdminOverview(sources());

    expect(overview.incidents).toHaveLength(4);
    expect(overview.incidents[0]).toEqual({
      at: NOW - DAY,
      kind: 'team-kill',
      map: 'Ozeti',
      player: { steamId: ASH, name: 'Ash', id: 'a00000000001' },
      victim: { steamId: BO, name: 'Bo' },
      faction: 'Valkyra',
      weapon: 'AK74',
      weaponKind: 'weapon',
      distance: 12.3,
      tags: [],
    });
  });

  it('lists what staff did in the period, newest first, VIP changes included', () => {
    const entry = (at: number, overrides: Partial<ModEntry> = {}): ModEntry => ({ action: 'kick', at, by: '42', reason: 'TK', ...overrides });
    const modLogs = new Map<string, ModEntry[]>([
      [
        ASH,
        [
          entry(NOW - 8 * DAY),
          entry(NOW - DAY, { byName: 'Paragon', name: 'Ash' }),
          entry(NOW, { action: 'vip-add', name: 'Ash', reason: 'Friend', detail: '30 days' }),
        ],
      ],
      [DEE, [entry(NOW - 2 * DAY, { action: 'ban', by: 'server', name: 'Dee', detail: 'By Admin' })]],
    ]);

    const overview = buildAdminOverview(sources({ modLogs }));

    expect(overview.moderation).toEqual([
      { at: NOW, action: 'vip-add', player: { steamId: ASH, name: 'Ash', id: 'a00000000001' }, by: '42', reason: 'Friend', detail: '30 days' },
      { at: NOW - DAY, action: 'kick', player: { steamId: ASH, name: 'Ash', id: 'a00000000001' }, by: '42', byName: 'Paragon', reason: 'TK' },
      { at: NOW - 2 * DAY, action: 'ban', player: { steamId: DEE, name: 'Dee' }, by: 'server', reason: 'TK', detail: 'By Admin' },
    ]);
  });

  it("lists the server's bans, with the bot's when and until for its own, and bans waiting for the player to join", () => {
    const bot: BanRecord = { name: 'Ash', until: NOW + DAY, reason: 'TK', serverReason: 'TK (ends …)', by: '42', at: NOW - DAY };
    const waiting: BanRecord = { name: 'Cy', until: null, reason: 'Cheating', serverReason: 'Cheating', by: '43', at: NOW - 60_000, waiting: true };

    const overview = buildAdminOverview(
      sources({
        serverBans: [
          { steamId: ASH, reason: 'TK (ends …)', bannedBy: 'RCON' },
          { steamId: DEE, reason: 'Racism', bannedBy: 'Admin' },
        ],
        banBook: { [ASH]: bot, [CY]: waiting },
      }),
    );

    expect(overview.bans).toEqual([
      { player: { steamId: CY, name: 'Cy' }, reason: 'Cheating', bannedBy: null, onServer: false, bot: { by: '43', at: NOW - 60_000, until: null, reason: 'Cheating' } },
      { player: { steamId: ASH, name: 'Ash', id: 'a00000000001' }, reason: 'TK (ends …)', bannedBy: 'RCON', onServer: true, bot: { by: '42', at: NOW - DAY, until: NOW + DAY, reason: 'TK' } },
      { player: { steamId: DEE, name: 'Dee' }, reason: 'Racism', bannedBy: 'Admin', onServer: true, bot: null },
    ]);
    expect(buildAdminOverview(sources({ serverBans: null })).bans).toBeNull();
  });

  it("trusts the server's ban list for who is banned, with bans waiting for the player to join", () => {
    const stale: BanRecord = { name: 'Ash', until: null, reason: 'TK', serverReason: 'TK', by: '42', at: NOW - DAY };
    const waiting: BanRecord = { ...stale, waiting: true };
    const banned = (overrides: Partial<AdminSources>) => buildAdminOverview(sources(overrides)).players.find((p) => p.steamId === ASH)?.banned;

    expect(banned({ serverBans: [], banBook: { [ASH]: stale } })).toBe(false);
    expect(banned({ serverBans: [], banBook: { [ASH]: waiting } })).toBe(true);
    expect(banned({ serverBans: null, banBook: { [ASH]: stale } })).toBe(true);
  });

  it('names the staff in the log and the bans: from the staff directory, else their name in their latest log entry', () => {
    const modLogs = new Map<string, ModEntry[]>([
      [ASH, [{ action: 'kick', at: NOW - 60_000, by: '340568148044414976', reason: 'TK' }]],
      [BO, [{ action: 'warn', at: NOW - 30_000, by: '100000000000000003', byName: 'Old name' }, { action: 'warn', at: NOW, by: '100000000000000003', byName: 'Moth' }]],
      [DEE, [{ action: 'ban', at: NOW, by: 'server', reason: 'Racism' }, { action: 'kick', at: NOW, by: '100000000000000009' }]],
    ]);
    const bot: BanRecord = { name: 'Cy', until: null, reason: 'Cheating', serverReason: 'Cheating', by: '100000000000000002', at: NOW };

    const overview = buildAdminOverview(
      sources({
        modLogs,
        serverBans: [{ steamId: CY, reason: 'Cheating', bannedBy: null }],
        banBook: { [CY]: bot },
        staffNames: {
          '340568148044414976': { name: 'Sarge', username: 'paragon', at: NOW },
          '100000000000000002': { name: 'Kestrel', username: 'kestrel', at: NOW },
        },
      }),
    );

    expect(overview.staff).toEqual({
      '340568148044414976': { name: 'Sarge', username: 'paragon' },
      '100000000000000003': { name: 'Moth', username: null },
      '100000000000000002': { name: 'Kestrel', username: 'kestrel' },
    });
  });

  it('lists the whitelisted players, with the VIP the bot gave and when it ends, and the staff spots', () => {
    const overview = buildAdminOverview(
      sources({
        reserved: { ids: [DEE, ASH, CY], maxSlots: 2 },
        vip: {
          granted: { [ASH]: { name: 'Ash', grantedAt: NOW - DAY, expiresAt: NOW + 6 * DAY } },
          checkedAt: 0,
          revoked: {},
          staffSpots: { [CY]: { name: 'Cy', since: NOW - 2 * DAY } },
        },
      }),
    );

    expect(overview.reserved).toEqual({
      players: [
        { player: { steamId: ASH, name: 'Ash', id: 'a00000000001' }, bot: { since: NOW - DAY, until: NOW + 6 * DAY }, staff: null },
        { player: { steamId: CY, name: 'Cy' }, bot: null, staff: { since: NOW - 2 * DAY } },
        { player: { steamId: DEE, name: 'Dee' }, bot: null, staff: null },
      ],
      maxSlots: 2,
    });
    expect(buildAdminOverview(sources()).reserved).toBeNull();
    expect(adminSteamIds([], new Map(), null, {}, [DEE])).toEqual([DEE]);
  });

  it('lists the staff who linked their Steam account, by name, and whether the bot has seen it in game', () => {
    const SARGE = '340568148044414976';
    const KESTREL = '100000000000000002';
    const overview = buildAdminOverview(
      sources({
        staffNames: { [SARGE]: { name: 'Sarge now', username: 'paragon', at: NOW } },
        staffProfiles: {
          [SARGE]: { steamId: ASH, name: 'Sarge', at: NOW - DAY },
          [KESTREL]: { steamId: DEE, name: 'Kestrel', at: NOW },
        },
        history: [{ day: '2026-10-03', players: { [ASH]: totals() } }],
      }),
    );

    expect(overview.staffProfiles).toEqual([
      { userId: KESTREL, name: 'Kestrel', linkedAt: NOW, player: { steamId: DEE, name: 'Dee' }, seen: false },
      { userId: SARGE, name: 'Sarge now', linkedAt: NOW - DAY, player: { steamId: ASH, name: 'Ash', id: 'a00000000001' }, seen: true },
    ]);
  });

  it('names everyone it can', () => {
    const grief = sources().grief;
    const modLogs = new Map<string, ModEntry[]>([[DEE, []]]);

    expect(adminSteamIds(grief, modLogs, [{ steamId: CY, reason: null, bannedBy: null }], {}).sort()).toEqual([ASH, BO, CY, DEE]);
  });
});

describe('risky Steam accounts on the staff page', () => {
  const check = (overrides: Partial<SteamCheck> = {}): SteamCheck => ({
    at: NOW - 3_600_000,
    found: true,
    vacBans: 0,
    gameBans: 0,
    lastBanAt: null,
    communityBanned: false,
    tradeBan: 'none',
    public: true,
    setUp: true,
    createdAt: NOW - 3000 * DAY,
    ...overrides,
  });
  // Ash has a recent VAC ban (high risk), Bo an old game ban (worth a look), Cy nothing risky, and Dee, in game now, a
  // brand new account that hides itself (high risk). Ash and Bo played in the period.
  const checks = new Map<string, SteamCheck | null>([
    [ASH, check({ vacBans: 1, lastBanAt: NOW - 20 * DAY, alerted: 4 })],
    [BO, check({ gameBans: 1, lastBanAt: NOW - 900 * DAY })],
    [CY, check()],
    [DEE, check({ createdAt: NOW - 2 * DAY, public: false })],
  ]);
  const steam = { checks, inGame: new Set([DEE]), feed: new Map([[ASH, { kills: 30, headshots: 21 }]]) };
  const playerDays = [{ [ASH]: totals(), [BO]: totals({ name: 'Bo' }), [CY]: totals({ name: 'Cy' }) }];

  it('lists everyone seen or in game whose account is worth a look, in game first, then riskiest, with their play for scale', () => {
    const overview = buildAdminOverview(sources({ steam, playerDays, serverBans: [{ steamId: BO, reason: 'Cheating', bannedBy: null }] }));

    expect(overview.steam).toMatchObject({ players: 4, checked: 4, high: 2, medium: 1, risk: { alert: 7, high: 4, medium: 2 } });
    expect(overview.steam?.flags.vacBan).toBe(3);
    expect(overview.steam?.accounts.map((a) => [a.name, a.risk, a.score])).toEqual([
      ['Dee', 'high', 4],
      ['Ash', 'high', 4],
      ['Bo', 'medium', 3],
    ]);
    expect(overview.steam?.accounts.find((a) => a.steamId === ASH)).toEqual({
      steamId: ASH,
      name: 'Ash',
      id: 'a00000000001',
      risk: 'high',
      score: 4,
      flags: ['vacBan', 'recentBan'],
      vacBans: 1,
      gameBans: 0,
      lastBanAt: NOW - 20 * DAY,
      communityBanned: false,
      tradeBan: 'none',
      public: true,
      setUp: true,
      createdAt: NOW - 3000 * DAY,
      checkedAt: NOW - 3_600_000,
      inGame: false,
      banned: false,
      matches: 2,
      kills: 40,
      deaths: 20,
      minutes: 120,
      feedKills: 30,
      headshots: 21,
    });
    expect(overview.steam?.accounts.find((a) => a.steamId === DEE)).toMatchObject({ inGame: true, matches: 0, feedKills: 0, flags: ['newAccount', 'hidden'] });
    expect(overview.steam?.accounts.find((a) => a.steamId === BO)?.banned).toBe(true);
  });

  it('counts players not checked yet, and is null without a Steam key', () => {
    const overview = buildAdminOverview(sources({ steam: { ...steam, checks: new Map([[ASH, null]]) }, playerDays }));

    expect(overview.steam).toMatchObject({ players: 4, checked: 0, high: 0, medium: 0, accounts: [] });
    expect(buildAdminOverview(sources()).steam).toBeNull();
  });

  it('finds the players to look up, and the risky ones among them', () => {
    expect(steamPlayers(playerDays, [DEE, ASH])).toEqual([ASH, BO, CY, DEE]);
    expect(riskySteamIds([CY, BO, DEE, ASH, '76561198000000009'], checks, NOW)).toEqual([DEE, ASH, BO]);
    // Those in game come first, however risky, so the page's limit never leaves them out.
    expect(riskySteamIds([CY, BO, DEE, ASH], checks, NOW, new Set([BO]))).toEqual([BO, DEE, ASH]);
  });
});

describe('the server list on the staff page', () => {
  const check: SteamCheck = {
    at: NOW,
    found: true,
    vacBans: 1,
    gameBans: 0,
    lastBanAt: NOW - 30 * DAY,
    communityBanned: false,
    tradeBan: 'none',
    public: true,
    setUp: true,
    createdAt: NOW - 3000 * DAY,
  };
  // Ash (Valkyra) has played before and team killed today; Dee (Kharr) is new today, on the whitelist, and banned
  // while still in game. Bo shows twice in the snapshot.
  const online = {
    at: NOW - 30_000,
    map: 'Europe',
    players: [
      { steamId: DEE, name: 'Dee', kills: 2, deaths: 0, faction: 'Kharr' },
      { steamId: ASH, name: 'Ash', kills: 1, deaths: 1, faction: 'Valkyra' },
      { steamId: BO, name: 'Bo', kills: null, deaths: null },
      { steamId: BO, name: 'Bo', kills: null, deaths: null },
    ],
  };
  const history: DayRecords[] = [
    { day: '2026-09-01', players: { [ASH]: totals() } },
    { day: '2026-10-03', players: { [ASH]: totals({ seedingMinutes: 10, liveMinutes: 50 }), [DEE]: totals({ name: 'Dee', seedingMinutes: 0, liveMinutes: 15 }) } },
  ];
  const overview = (overrides: Partial<AdminSources> = {}) =>
    buildAdminOverview(
      sources({
        online,
        history,
        match: { [ASH]: { kills: 9, deaths: 3, faction: 'Valkyra' } },
        // Ash's team kills put on today.
        grief: [emptyGriefDay(), ...sources().grief.slice(0, 1)],
        reserved: { ids: [DEE], maxSlots: 2 },
        serverBans: [{ steamId: DEE, reason: 'Cheating', bannedBy: null }],
        steam: { checks: new Map([[ASH, check]]), inGame: new Set([ASH, DEE, BO]), feed: new Map() },
        headshots: new Map([[ASH, { kills: 12, headshots: 11, expected: 3.1, chance: 0.0000002, flagged: true }]]),
        ...overrides,
      }),
    );

  it('lists everyone in game once, by team, with what is worth watching', () => {
    const list = overview().online;

    expect(list?.at).toBe(NOW - 30_000);
    expect(list?.map).toBe('Ozeti');
    expect(list?.players.map((p) => p.name)).toEqual(['Dee', 'Ash', 'Bo']);
    expect(list?.players[1]).toEqual({
      steamId: ASH,
      name: 'Ash',
      id: 'a00000000001',
      faction: 'Valkyra',
      kills: 9,
      deaths: 3,
      minutesToday: 60,
      firstSeen: '2026-09-01',
      steam: { risk: 'high', score: 4, flags: ['vacBan', 'recentBan'] },
      griefFlags: ['teamKills', 'sameTeammate'],
      teamKillsToday: 4,
      vehicleSuicidesToday: 0,
      headshotsToday: { kills: 12, headshots: 11, expected: 3.1, chance: 0.0000002, flagged: true },
      banned: false,
      reserved: false,
      checked: null,
    });
    expect(list?.players[0]).toMatchObject({
      kills: 2,
      firstSeen: '2026-10-03',
      steam: null,
      griefFlags: [],
      headshotsToday: null,
      banned: true,
      reserved: true,
    });
    expect(list?.players[2]).toMatchObject({ faction: null, kills: null, minutesToday: 0, firstSeen: null });
  });

  it('says who checked a player today, and names them', () => {
    const sarge = '340568148044414976';
    const check = { by: sarge, byName: 'Sarge', at: NOW - 60_000, reasons: ['griefing' as const, 'steam' as const], teamKills: 4, vehicleSuicides: 0 };
    const page = overview({ checked: { [ASH]: check }, staffNames: { [sarge]: { name: 'Sarge', username: 'sarge_gi', at: NOW } } });

    expect(page.online?.players.find((p) => p.steamId === ASH)?.checked).toEqual(check);
    expect(page.online?.players.find((p) => p.steamId === DEE)?.checked).toBeNull();
    expect(page.staff[sarge]).toEqual({ name: 'Sarge', username: 'sarge_gi' });
  });

  it('says nothing about the whitelist it could not read, and has no list while the server is not answering', () => {
    expect(overview({ reserved: null }).online?.players[0]?.reserved).toBeNull();
    expect(overview({ online: null }).online).toBeNull();
  });
});

describe('the join log on the staff page', () => {
  it('lists joins and leaves newest first, with how long those who left were on', () => {
    const { joins } = buildAdminOverview(
      sources({
        joins: [
          { at: NOW - 50 * 60_000, kind: 'joined', steamId: ASH, name: 'Ash' },
          { at: NOW - 10 * 60_000, kind: 'left', steamId: ASH, name: 'Ash', joinedAt: NOW - 50 * 60_000 },
          { at: NOW - 60_000, kind: 'left', steamId: BO, name: 'Bo', joinedAt: null },
        ],
      }),
    );
    expect(joins).toEqual([
      { at: NOW - 60_000, kind: 'left', player: { steamId: BO, name: 'Bo' }, from: null, minutes: null },
      { at: NOW - 10 * 60_000, kind: 'left', player: { steamId: ASH, name: 'Ash', id: 'a00000000001' }, from: null, minutes: 40 },
      { at: NOW - 50 * 60_000, kind: 'joined', player: { steamId: ASH, name: 'Ash', id: 'a00000000001' }, from: null, minutes: null },
    ]);
  });

  it('keeps the name they had then, and says since when after the bot could not read the server', () => {
    const [left] = buildAdminOverview(
      sources({ joins: [{ at: NOW, kind: 'left', steamId: CY, name: 'Cy_old', from: NOW - 30 * 60_000, joinedAt: NOW - 90 * 60_000 }] }),
    ).joins;
    expect(left).toEqual({ at: NOW, kind: 'left', player: { steamId: CY, name: 'Cy_old' }, from: NOW - 30 * 60_000, minutes: 60 });
  });

  it('names a player the server sent no name for as the bot knows them', () => {
    expect(buildAdminOverview(sources({ joins: [{ at: NOW, kind: 'joined', steamId: DEE, name: '' }] })).joins[0]?.player.name).toBe('Dee');
  });
});
