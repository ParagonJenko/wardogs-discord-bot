import { describe, expect, it } from 'vitest';
import {
  feedKillsSince,
  feedAuthorized,
  MAX_FEED_EVENTS,
  parseFeed,
  parsePlayerWeapons,
  parseWeaponDay,
  playerWeaponDays,
  playerWeaponsKey,
  recordPlayerWeapons,
  recordWeaponDay,
  weaponBoard,
  weaponDayKey,
  weaponHolders,
  weaponKind,
  weaponName,
  weaponRole,
  type FeedKill,
} from '../src/weapons.ts';

const ASH = '76561198000000001';
const BO = '76561198000000002';
const CY = '76561198000000003';
const HEADSHOT = 'Meta.Progression.Context.Player.KillContext.Headshot';

// A kill as the game sends it, captured from a live server.
const event = (overrides: Record<string, unknown> = {}) => ({
  eventId: 'e1',
  type: 'killed',
  eventTime: 3317.77,
  matchId: 'm1',
  mapName: 'Kavkazi',
  killerName: 'Ash',
  killerId: 'k1',
  killerSteamId: ASH,
  victimName: 'Bo',
  victimId: 'v1',
  victimSteamId: BO,
  cause: 'Id.Item.AK74M',
  distance: 704.87,
  contextTags: [HEADSHOT, 'Meta.PlayerKillFlag.Player.Local.Kill', 'Meta.PlayerKillFlag.Player.Local.Death'],
  ...overrides,
});

const kill = (overrides: Partial<FeedKill> = {}): FeedKill => ({
  eventId: 'e1',
  time: 100,
  matchId: 'm1',
  map: 'Kavkazi',
  victimSteamId: CY,
  victimName: 'Cy',
  killerSteamId: ASH,
  killerName: 'Ash',
  cause: 'Id.Item.AK74M',
  distance: 50,
  headshot: false,
  tags: [],
  ...overrides,
});

describe('parseFeed', () => {
  it('reads each death: who, by whom, with what, how far in metres, whether it was a headshot, and the match clock', () => {
    const kill = {
      eventId: 'e1',
      time: 3317.77,
      matchId: 'm1',
      map: 'Kavkazi',
      victimSteamId: BO,
      victimName: 'Bo',
      killerSteamId: ASH,
      killerName: 'Ash',
      cause: 'Id.Item.AK74M',
      distance: 7.05,
      headshot: true,
      tags: [],
    };

    expect(parseFeed({ serverId: 's1', serverName: 'UK #1', events: [event()] })).toEqual({ events: [kill], kills: [kill], skipped: 0 });
  });

  it('keeps suicides, falls and deaths with nobody to blame as deaths, not kills', () => {
    const batch = parseFeed({
      events: [
        event({ eventId: 'suicide', killerSteamId: BO }),
        event({ eventId: 'tagged', contextTags: ['Meta.PlayerKillFlag.Player.Suicide'] }),
        event({ eventId: 'fall', cause: undefined, killerSteamId: undefined, contextTags: ['Meta.Progression.Context.Player.KillContext.Falling'] }),
        event({ eventId: 'world', killerSteamId: undefined, killerName: undefined }),
        event({ eventId: 'kept', contextTags: ['Meta.Progression.Context.Player.KillContext.RoadKill'] }),
      ],
    });

    expect(batch?.events.map((e) => e.eventId)).toEqual(['suicide', 'tagged', 'fall', 'world', 'kept']);
    expect(batch?.kills.map((k) => k.eventId)).toEqual(['kept']);
    expect(batch?.events[1]?.tags).toEqual(['Suicide']);
    expect(batch?.events[2]).toMatchObject({ killerSteamId: null, cause: null, tags: ['Falling'] });
    expect(batch?.kills[0]).toMatchObject({ headshot: false, tags: ['RoadKill'] });
    expect(batch?.skipped).toBe(0);
  });

  it('skips other events and anything malformed', () => {
    const batch = parseFeed({
      events: [event({ eventId: 'other', type: 'spawned' }), event({ eventId: 'odd', distance: 'far' }), 'nonsense', event({ eventId: 'kept' })],
    });

    expect(batch?.events.map((e) => e.eventId)).toEqual(['kept']);
    expect(batch?.skipped).toBe(3);
  });

  it('keeps a kill without a distance, as when a vehicle blows up', () => {
    expect(parseFeed({ events: [event({ distance: undefined })] })?.kills[0]?.distance).toBeNull();
  });

  it('refuses a body that is not a batch, or a batch far bigger than the game sends', () => {
    expect(parseFeed(null)).toBeNull();
    expect(parseFeed({ events: 'many' })).toBeNull();
    expect(parseFeed({ events: Array.from({ length: MAX_FEED_EVENTS + 1 }, () => event()) })).toBeNull();
  });
});

describe('feedAuthorized', () => {
  const token = 'a-long-random-feed-token';

  it('takes the token as a bearer', async () => {
    expect(await feedAuthorized(`Bearer ${token}`, token)).toBe(true);
    expect(await feedAuthorized(`bearer ${token} `, token)).toBe(true);
  });

  it('refuses anything else', async () => {
    expect(await feedAuthorized(null, token)).toBe(false);
    expect(await feedAuthorized(token, token)).toBe(false);
    expect(await feedAuthorized(`Bearer ${token}x`, token)).toBe(false);
    expect(await feedAuthorized('Bearer ', token)).toBe(false);
  });
});

describe('weaponName and weaponKind', () => {
  it('names the weapons the game is known to send, in any case', () => {
    expect(weaponName('Id.Item.AK74M')).toBe('AK74');
    expect(weaponName('id.item.svdm')).toBe('SVD');
    expect(weaponName('ID.Item.BuildTool.Hammer.Large')).toBe('Large hammer');
    expect(weaponName('Id.Item.SR_04')).toBe('AMR 50');
  });

  it('names anything else from its tag', () => {
    expect(weaponName('Id.Item.WEPN_035')).toBe('WEPN 035');
    expect(weaponName('Id.Item.Defibrillator.Heavy')).toBe('Defibrillator Heavy');
    expect(weaponName('Vehicle.Variant.Land.Wheeled.Hilux.MountedMachineGun')).toBe('Hilux (mounted machine gun)');
    expect(weaponName('Vehicle.Variant.Land.Wheeled.Hilux.Default')).toBe('Hilux');
    expect(weaponName('Id.Vehicle.WeaponExtension.STN_05.MainBarrel')).toBe('STN 05 Main barrel');
    expect(weaponName('Vehicle.Variant.Stationary.STN_05')).toBe('STN 05');
    expect(weaponName('Id.Buildable.SandbagWall')).toBe('Sandbag wall');
  });

  it('names the mortar and its barrel alike', () => {
    expect(weaponName('Vehicle.Variant.Stationary.Mortar')).toBe('L81 mortar');
    expect(weaponName('Id.Vehicle.WeaponExtension.STN_03.MainBarrel')).toBe('L81 mortar');
  });

  it('tells hand-held weapons from things placed, vehicles, their guns, emplacements and things built', () => {
    expect(weaponKind('Id.Item.M4')).toBe('weapon');
    expect(weaponKind('Id.Item.RPG7')).toBe('weapon');
    expect(weaponKind('Id.Item.M67Grenade')).toBe('weapon');
    expect(weaponKind('Id.Item.ATMine')).toBe('placed');
    expect(weaponKind('Id.Item.Claymore')).toBe('placed');
    expect(weaponKind('Id.Item.C4Explosive')).toBe('placed');
    expect(weaponKind('Id.Item.IED.Explosive')).toBe('placed');
    expect(weaponKind('Id.Item.VehicleSupplyCrate.Pallet.MunitionsSupply')).toBe('placed');
    expect(weaponKind('Id.Vehicle.WeaponExtension.WHL_05.RingMinigun')).toBe('vehicle-weapon');
    expect(weaponKind('Vehicle.Variant.Land.Wheeled.Humvee.Default')).toBe('vehicle');
    expect(weaponKind('Id.Buildable.BarbedWire')).toBe('buildable');
    // Mortars and the other fixed weapons are vehicles to the game, but nobody drives them.
    expect(weaponKind('Vehicle.Variant.Stationary.Mortar')).toBe('emplacement');
    expect(weaponKind('Id.Vehicle.WeaponExtension.STN_03.MainBarrel')).toBe('emplacement');
    expect(weaponKind('id.vehicle.weaponextension.stn_01.mistralaa')).toBe('emplacement');
  });
});

describe('weaponRole', () => {
  it('sorts the weapons the game is known to send by what they are for', () => {
    expect(['Id.Item.AK74M', 'Id.Item.Vector', 'Id.Item.M500'].map(weaponRole)).toEqual(['assault', 'assault', 'assault']);
    expect(weaponRole('Id.Item.LMG_02')).toBe('machine-gun');
    expect(['Id.Item.SV98', 'Id.Item.SR_04', 'Id.Item.SKS', 'Id.Item.CombatBow'].map(weaponRole)).toEqual([
      'marksman',
      'marksman',
      'marksman',
      'marksman',
    ]);
    expect(weaponRole('Id.Item.Glock17')).toBe('sidearm');
    expect(['Id.Item.RPG7', 'Id.Item.M67Grenade', 'Id.Item.IED.Explosive'].map(weaponRole)).toEqual(['demolition', 'demolition', 'demolition']);
    expect(['Id.Item.Fists', 'ID.Item.BuildTool.Hammer.Large', 'Id.Item.Defibrillator.Heavy'].map(weaponRole)).toEqual([
      'melee',
      'melee',
      'melee',
    ]);
  });

  it('counts mortars, artillery and emplacements as support, and other vehicle guns apart', () => {
    expect(
      [
        'Vehicle.Variant.Stationary.Mortar',
        'Id.Vehicle.WeaponExtension.STN_03.MainBarrel',
        'Id.Vehicle.WeaponExtension.TNK_01.Artillery',
        'Id.Vehicle.WeaponExtension.STN_01.MistralAA',
      ].map(weaponRole),
    ).toEqual(['support', 'support', 'support', 'support']);
    expect(weaponRole('Id.Vehicle.WeaponExtension.TNK_01.Heavy')).toBe('vehicle-gun');
    // The SPH-2 running someone over.
    expect(weaponRole('Vehicle.Variant.Land.Tracked.TNK_01.Artillery')).toBe('vehicle');
    expect(weaponRole('Id.Buildable.BarbedWire')).toBe('buildable');
  });

  it('leaves out what it does not know', () => {
    expect(weaponRole('Id.Item.WEPN_035')).toBe('other');
    expect(weaponRole('ID.Item.SmokeGrenade.White')).toBe('other');
  });
});

describe('recordWeaponDay', () => {
  it('adds up each weapon’s kills, headshots and distances, and keeps its longest kill', () => {
    const day = recordWeaponDay(parseWeaponDay(undefined), [
      kill({ distance: 40, headshot: true }),
      kill({ killerSteamId: BO, killerName: 'Bo', distance: 120 }),
      kill({ distance: null }),
      kill({ cause: 'Id.Item.SVDM', distance: 650.5, headshot: true }),
    ]);

    expect(day).toEqual({
      'Id.Item.AK74M': { kills: 3, headshots: 1, ranged: 2, distance: 160, longest: { distance: 120, steamId: BO, name: 'Bo' } },
      'Id.Item.SVDM': { kills: 1, headshots: 1, ranged: 1, distance: 650.5, longest: { distance: 650.5, steamId: ASH, name: 'Ash' } },
    });
    expect(recordWeaponDay(day, [kill({ distance: 90 })])['Id.Item.AK74M']).toMatchObject({ kills: 4, longest: { steamId: BO } });
  });

  it('reads back what it stored, and starts again from anything unrecognisable', () => {
    const day = recordWeaponDay({}, [kill()]);

    expect(parseWeaponDay(JSON.parse(JSON.stringify(day)))).toEqual(day);
    expect(parseWeaponDay({ 'Id.Item.M4': { kills: 'lots' } })).toEqual({});
  });

  it('keys days by UTC date', () => {
    expect(weaponDayKey(Date.UTC(2026, 9, 3, 23, 59))).toBe('weapons:2026-10-03');
    expect(playerWeaponsKey(ASH)).toBe(`playerWeapons:${ASH}`);
  });
});

describe('recordPlayerWeapons', () => {
  it('adds a player’s kills to the day by weapon, and drops days older than the pages cover', () => {
    const before = { '2026-07-01': { 'Id.Item.M4': { kills: 9, headshots: 1, longest: 80 } }, '2026-10-02': { 'Id.Item.M4': { kills: 2, headshots: 0, longest: null } } };
    const after = recordPlayerWeapons(
      before,
      [kill({ headshot: true, distance: 30 }), kill({ distance: 75 }), kill({ cause: 'Id.Item.M4', distance: null })],
      '2026-10-03',
      '2026-07-06',
    );

    expect(after).toEqual({
      '2026-10-02': { 'Id.Item.M4': { kills: 2, headshots: 0, longest: null } },
      '2026-10-03': {
        'Id.Item.AK74M': { kills: 2, headshots: 1, longest: 75 },
        'Id.Item.M4': { kills: 1, headshots: 0, longest: null },
      },
    });
    expect(parsePlayerWeapons(JSON.parse(JSON.stringify(after)))).toEqual(after);
    expect(parsePlayerWeapons('nonsense')).toEqual({});
  });
});

describe('weaponBoard', () => {
  const ids: Record<string, string> = { [ASH]: 'a1a1a1a1a1a1', [BO]: 'b2b2b2b2b2b2' };
  const days = [
    recordWeaponDay({}, [
      kill({ distance: 40, headshot: true }),
      kill({ cause: 'Vehicle.Variant.Land.Tracked.SpawnVehicle.Lonestar', distance: null }),
      kill({ cause: 'Id.Item.SVDM', killerSteamId: BO, killerName: 'Bo', distance: 650 }),
    ]),
    {},
    recordWeaponDay({}, [
      kill({ distance: 60 }),
      kill({ killerSteamId: CY, killerName: 'Cy', distance: 210 }),
      kill({ cause: 'Vehicle.Variant.Land.Tracked.SpawnVehicle.Valkyra', distance: null }),
    ]),
  ];

  it('lists the weapons with the most kills, their headshots, average distance and longest kill', () => {
    const board = weaponBoard(days, 30, '2026-09-20', 2, (steamId) => ids[steamId]);

    expect(board).toEqual({
      days: 30,
      since: '2026-09-20',
      kills: 6,
      headshots: 1,
      top: [
        {
          name: 'AK74',
          kind: 'weapon',
          kills: 3,
          headshots: 1,
          averageDistance: 103.3,
          // Cy has no public id yet, so the name goes out alone.
          longest: { distance: 210, name: 'Cy' },
        },
        // Each side's M113 is the same vehicle.
        { name: 'M113 APC', kind: 'vehicle', kills: 2, headshots: 0, averageDistance: null, longest: null },
      ],
      longest: { weapon: 'SVD', distance: 650, name: 'Bo', id: 'b2b2b2b2b2b2' },
    });
    expect(JSON.stringify(board)).not.toMatch(/7656119|steamId/);
  });

  it('takes the longest kill of all from hand-held weapons only', () => {
    const board = weaponBoard(
      [
        ...days,
        recordWeaponDay({}, [
          kill({ cause: 'Id.Item.ATMine', killerSteamId: CY, killerName: 'Cy', distance: 851.1 }),
          kill({ cause: 'Id.Vehicle.WeaponExtension.STN_03.MainBarrel', killerSteamId: CY, killerName: 'Cy', distance: 706.8 }),
          kill({ cause: 'Vehicle.Variant.Stationary.MistralAA', killerSteamId: CY, killerName: 'Cy', distance: 900 }),
          kill({ cause: 'Id.Buildable.BarbedWire', killerSteamId: CY, killerName: 'Cy', distance: 1200 }),
        ]),
      ],
      30,
      '2026-09-20',
      10,
      (steamId) => ids[steamId],
    );

    expect(board.longest).toEqual({ weapon: 'SVD', distance: 650, name: 'Bo', id: 'b2b2b2b2b2b2' });
    // Each still has its own longest kill.
    expect(board.top.find((w) => w.name === 'AT mine')).toMatchObject({ kind: 'placed', longest: { distance: 851.1, name: 'Cy' } });
  });

  it('has no longest kill of all without a hand-held weapon’s', () => {
    const board = weaponBoard([recordWeaponDay({}, [kill({ cause: 'Id.Item.Claymore', distance: 30 })])], 30, '2026-09-20', 10, () => undefined);

    expect(board.longest).toBeNull();
  });

  it('gives tags of different kinds with the same name one kind, whichever came first', () => {
    const top = (causes: string[]) =>
      weaponBoard([recordWeaponDay({}, causes.map((cause) => kill({ cause })))], 30, '2026-09-20', 10, () => undefined).top;
    // The mortar and its barrel are one weapon.
    const mortar = ['Vehicle.Variant.Stationary.Mortar', 'Id.Vehicle.WeaponExtension.STN_03.MainBarrel'];
    expect([top(mortar), top([...mortar].reverse())]).toEqual([
      [expect.objectContaining({ name: 'L81 mortar', kind: 'emplacement', kills: 2 })],
      [expect.objectContaining({ name: 'L81 mortar', kind: 'emplacement', kills: 2 })],
    ]);
    const hilux = ['Id.Item.Hilux', 'Vehicle.Variant.Land.Wheeled.Hilux.Default'];
    expect([top(hilux), top([...hilux].reverse())]).toEqual([
      [expect.objectContaining({ name: 'Hilux', kind: 'weapon', kills: 2 })],
      [expect.objectContaining({ name: 'Hilux', kind: 'weapon', kills: 2 })],
    ]);
    expect(
      playerWeaponDays(
        {
          '2026-10-03': {
            'Vehicle.Variant.Stationary.MistralAA': { kills: 1, headshots: 0, longest: null },
            'Id.Vehicle.WeaponExtension.STN_01.MistralAA': { kills: 1, headshots: 0, longest: null },
          },
        },
        '2026-10-01',
      ),
    ).toEqual([{ day: '2026-10-03', name: 'Talon 9K-SAM', kind: 'emplacement', kills: 2, headshots: 0, longest: null }]);
  });

  it('is empty when nobody was killed in those days', () => {
    expect(weaponBoard([{}, {}], 30, '2026-09-20', 10, () => undefined)).toEqual({
      days: 30,
      since: '2026-09-20',
      kills: 0,
      headshots: 0,
      top: [],
      longest: null,
    });
  });

  it('names everyone holding a longest kill, so their ids can be worked out first', () => {
    expect(weaponHolders(days).sort()).toEqual([ASH, BO, CY]);
  });
});

describe('playerWeaponDays', () => {
  it('lists each day’s weapons from the oldest day asked for, most kills first, with tags of the same name together', () => {
    const record = {
      '2026-07-01': { 'Id.Item.M4': { kills: 9, headshots: 1, longest: 80 } },
      '2026-10-03': {
        'Id.Item.M4': { kills: 1, headshots: 0, longest: null },
        'Vehicle.Variant.Land.Tracked.SpawnVehicle.Lonestar': { kills: 1, headshots: 0, longest: null },
        'Vehicle.Variant.Land.Tracked.SpawnVehicle.Valkyra': { kills: 2, headshots: 0, longest: 3.04 },
      },
      '2026-10-01': { 'Id.Item.SVDM': { kills: 2, headshots: 2, longest: 512.345 } },
    };

    expect(playerWeaponDays(record, '2026-07-06')).toEqual([
      { day: '2026-10-01', name: 'SVD', kind: 'weapon', kills: 2, headshots: 2, longest: 512.3 },
      { day: '2026-10-03', name: 'M113 APC', kind: 'vehicle', kills: 3, headshots: 0, longest: 3 },
      { day: '2026-10-03', name: 'M4', kind: 'weapon', kills: 1, headshots: 0, longest: null },
    ]);
  });
});

describe('feedKillsSince', () => {
  it('adds up a player\'s kills and headshots from a day on', () => {
    const record = {
      '2026-09-01': { 'Id.Item.AK74M': { kills: 9, headshots: 9, longest: 50 } },
      '2026-10-01': { 'Id.Item.AK74M': { kills: 4, headshots: 1, longest: 20 }, 'Id.Item.M4A1': { kills: 2, headshots: 2, longest: null } },
      '2026-10-03': { 'Id.Item.AK74M': { kills: 3, headshots: 0, longest: 12 } },
    };

    expect(feedKillsSince(record, '2026-10-01')).toEqual({ kills: 9, headshots: 3 });
    expect(feedKillsSince({}, '2026-10-01')).toEqual({ kills: 0, headshots: 0 });
  });
});
