import { describe, expect, it } from 'vitest';
import { adminSteamIds, buildAdminOverview, type AdminSources } from '../src/admin.ts';
import { emptyGriefDay, FLAGS, recordGrief } from '../src/griefing.ts';
import type { BanRecord, ModEntry } from '../src/moderation.ts';
import type { PlayerTotals } from '../src/players.ts';
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
  const day = recordGrief(emptyGriefDay(), [death(ASH, BO), death(ASH, BO), death(ASH, BO), death(ASH, CY)], NOW - DAY, (id) => SIDES[id] ?? null).day;
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
    ...overrides,
  };
};

describe('buildAdminOverview', () => {
  it('lists possible griefers with their flags, totals for scale, and whether they are banned', () => {
    const overview = buildAdminOverview(sources({ serverBans: [{ steamId: ASH, reason: 'TK', bannedBy: null }] }));

    expect(overview).toMatchObject({ generatedAt: NOW, days: 7, feedSince: '2026-09-20', flags: FLAGS });
    expect(overview.totals).toEqual({ teamKills: 3, vehicleTeamKills: 0, suicides: 0, vehicleSuicides: 0, flaggedPlayers: 1 });
    expect(overview.players).toEqual([
      {
        steamId: ASH,
        name: 'Ash',
        id: 'a00000000001',
        teamKills: 3,
        vehicleTeamKills: 0,
        teamKilled: 0,
        suicides: 0,
        vehicleSuicides: 0,
        mostKilledTeammate: { steamId: BO, name: 'Bo', kills: 3 },
        flags: ['teamKills', 'sameTeammate'],
        flaggedDays: 1,
        matches: 3,
        kills: 50,
        deaths: 40,
        minutes: 240,
        banned: true,
      },
      expect.objectContaining({ steamId: BO, name: 'Bo', teamKilled: 3, banned: false }),
    ]);
  });

  it('shows each incident, newest first, with the map and weapon by name', () => {
    const overview = buildAdminOverview(sources());

    expect(overview.incidents).toHaveLength(3);
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

  it("lists what staff did in the period, newest first, without VIP changes", () => {
    const entry = (at: number, overrides: Partial<ModEntry> = {}): ModEntry => ({ action: 'kick', at, by: '42', reason: 'TK', ...overrides });
    const modLogs = new Map<string, ModEntry[]>([
      [ASH, [entry(NOW - 8 * DAY), entry(NOW - DAY, { byName: 'Paragon', name: 'Ash' }), entry(NOW, { action: 'vip-add' })]],
      [DEE, [entry(NOW - 2 * DAY, { action: 'ban', by: 'server', name: 'Dee', detail: 'By Admin' })]],
    ]);

    const overview = buildAdminOverview(sources({ modLogs }));

    expect(overview.moderation).toEqual([
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

  it('names everyone it can', () => {
    const grief = sources().grief;
    const modLogs = new Map<string, ModEntry[]>([[DEE, []]]);

    expect(adminSteamIds(grief, modLogs, [{ steamId: CY, reason: null, bannedBy: null }], {}).sort()).toEqual([ASH, BO, CY, DEE]);
  });
});
