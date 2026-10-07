import { describe, expect, it } from 'vitest';
import {
  byAircraft,
  byVehicle,
  dayFlags,
  emptyGriefDay,
  griefDayKey,
  griefRows,
  hasGrief,
  INCIDENTS_KEPT,
  isSuicide,
  parseGriefDay,
  playerGrief,
  recordGrief,
  sameSide,
  type GriefDay,
} from '../src/griefing.ts';
import type { FeedEvent } from '../src/weapons.ts';

const ASH = '76561198000000001';
const BO = '76561198000000002';
const CY = '76561198000000003';
const DEE = '76561198000000004';
const NAMES: Record<string, string> = { [ASH]: 'Ash', [BO]: 'Bo', [CY]: 'Cy', [DEE]: 'Dee' };
// Ash, Bo and Cy are on Valkyra; Dee on Kharr.
const SIDES: Record<string, string> = { [ASH]: 'Valkyra', [BO]: 'VALKYRA', [CY]: 'Valkyra', [DEE]: 'Kharr' };
const sideOf = (steamId: string): string | null => SIDES[steamId] ?? null;
const AT = Date.UTC(2026, 9, 3, 20);

let next = 0;
const death = (killer: string | null, victim: string, overrides: Partial<FeedEvent> = {}): FeedEvent => ({
  eventId: `e${next++}`,
  time: 100,
  matchId: 'm1',
  map: 'Kavkazi',
  victimSteamId: victim,
  victimName: NAMES[victim] ?? '',
  killerSteamId: killer,
  killerName: killer === null ? '' : (NAMES[killer] ?? ''),
  cause: 'Id.Item.AK74M',
  distance: 20,
  headshot: false,
  tags: [],
  ...overrides,
});

const HUMVEE = 'Vehicle.Variant.Land.Wheeled.Humvee.Default';
const LITTLEBIRD = 'Vehicle.Variant.Air.Rotary.Littlebird.Default';

describe('telling deaths apart', () => {
  it('knows a suicide by its tag or by a player killing themselves', () => {
    expect(isSuicide(death(ASH, ASH))).toBe(true);
    expect(isSuicide(death(null, ASH, { tags: ['Suicide'], cause: null }))).toBe(true);
    expect(isSuicide(death(null, ASH, { tags: ['Falling'], cause: null }))).toBe(false);
    expect(isSuicide(death(BO, ASH))).toBe(false);
  });

  it('knows a death a vehicle made: run over, blown up, or by the vehicle itself, not a gun on it', () => {
    expect(byVehicle(death(ASH, BO, { cause: HUMVEE }))).toBe(true);
    expect(byVehicle(death(ASH, BO, { tags: ['RoadKill'] }))).toBe(true);
    expect(byVehicle(death(ASH, ASH, { tags: ['VehicleExplosion'], cause: null }))).toBe(true);
    expect(byVehicle(death(ASH, BO, { cause: 'Id.Vehicle.WeaponExtension.WHL_05.RingTurret' }))).toBe(false);
    expect(byVehicle(death(ASH, BO, { cause: 'Vehicle.Variant.Stationary.Mortar' }))).toBe(false);
    expect(byVehicle(death(ASH, ASH, { cause: 'Vehicle.Variant.Stationary.Mortar', tags: ['VehicleExplosion'] }))).toBe(false);
    // The mortar's barrel.
    expect(byVehicle(death(ASH, ASH, { cause: 'Id.Vehicle.WeaponExtension.STN_03.MainBarrel', tags: ['VehicleExplosion'] }))).toBe(false);
    expect(byVehicle(death(ASH, BO))).toBe(false);
  });

  it('knows a death a helicopter made itself, not with its guns', () => {
    expect(byAircraft(death(ASH, BO, { cause: LITTLEBIRD, tags: ['VehicleExplosion'], distance: null }))).toBe(true);
    expect(byAircraft(death(ASH, BO, { cause: 'Vehicle.Variant.Air.Rotary.Havoc.Default', tags: ['RoadKill'] }))).toBe(true);
    expect(byAircraft(death(ASH, BO, { cause: 'Id.Vehicle.WeaponExtension.ROT_03.MountedMachineGun' }))).toBe(false);
    expect(byAircraft(death(ASH, BO, { cause: HUMVEE, tags: ['VehicleExplosion'] }))).toBe(false);
    expect(byAircraft(death(ASH, ASH, { cause: null, tags: ['VehicleExplosion'] }))).toBe(false);
  });

  it('only counts players on the same side when both sides are known, however the server spells them', () => {
    expect(sameSide('Valkyra', 'VALKYRA')).toBe(true);
    expect(sameSide('Valkyra', 'Kharr')).toBe(false);
    expect(sameSide(null, null)).toBe(false);
    expect(sameSide('Valkyra', null)).toBe(false);
  });
});

describe('recordGrief', () => {
  it('counts team kills, whom they killed, and how often each player was team killed', () => {
    const { day } = recordGrief(emptyGriefDay(), [death(ASH, BO), death(ASH, BO), death(ASH, CY), death(ASH, DEE)], AT, sideOf);

    expect(day.players[ASH]).toEqual({
      name: 'Ash',
      teamKills: 3,
      vehicleTeamKills: 0,
      crashTeamKills: 0,
      teamKilled: 0,
      suicides: 0,
      vehicleSuicides: 0,
      victims: { [BO]: 2, [CY]: 1 },
    });
    expect(day.players[BO]).toMatchObject({ teamKilled: 2, teamKills: 0 });
    expect(day.players[DEE]).toBeUndefined();
    expect(day.incidents.map((i) => [i.kind, i.steamId, i.victimSteamId, i.victimName])).toEqual([
      ['team-kill', ASH, BO, 'Bo'],
      ['team-kill', ASH, BO, 'Bo'],
      ['team-kill', ASH, CY, 'Cy'],
    ]);
    expect(day.incidents[0]).toMatchObject({ at: AT, map: 'Kavkazi', faction: 'Valkyra', cause: 'Id.Item.AK74M', distance: 20 });
  });

  it('leaves out kills where either side is unknown', () => {
    const { day } = recordGrief(emptyGriefDay(), [death(ASH, BO)], AT, (steamId) => (steamId === ASH ? 'Valkyra' : null));

    expect(day).toEqual(emptyGriefDay());
  });

  it('counts every suicide, and logs the ones in a vehicle', () => {
    const { day } = recordGrief(
      emptyGriefDay(),
      [
        death(ASH, ASH, { cause: null, tags: ['Suicide'] }),
        death(ASH, ASH, { cause: HUMVEE, tags: ['VehicleExplosion'], distance: null }),
        death(null, ASH, { cause: null, tags: ['Falling'] }),
        death(ASH, CY, { cause: HUMVEE, tags: ['RoadKill'] }),
      ],
      AT,
      sideOf,
    );

    expect(day.players[ASH]).toMatchObject({ suicides: 2, vehicleSuicides: 1, teamKills: 1, vehicleTeamKills: 1 });
    expect(day.incidents.map((i) => i.kind)).toEqual(['vehicle-suicide', 'team-kill']);
    expect(day.incidents[0]).toMatchObject({ steamId: ASH, cause: HUMVEE, tags: ['VehicleExplosion'] });
    expect(day.incidents[0]?.victimSteamId).toBeUndefined();
  });

  it('adds to what the day already has, without changing it, and keeps the latest incidents', () => {
    const before = recordGrief(emptyGriefDay(), [death(ASH, BO)], AT, sideOf).day;
    const copy = structuredClone(before);
    const many = Array.from({ length: INCIDENTS_KEPT + 5 }, () => death(CY, BO));

    const { day } = recordGrief(before, many, AT + 1, sideOf);

    expect(before).toEqual(copy);
    expect(day.players[ASH]?.teamKills).toBe(1);
    expect(day.players[CY]?.teamKills).toBe(INCIDENTS_KEPT + 5);
    expect(day.incidents).toHaveLength(INCIDENTS_KEPT);
    expect(day.incidents.every((i) => i.steamId === CY)).toBe(true);
  });

  it('takes the latest name the feed gives', () => {
    const first = recordGrief(emptyGriefDay(), [death(ASH, BO)], AT, sideOf).day;

    const { day } = recordGrief(first, [death(ASH, BO, { killerName: 'Ash2' })], AT, sideOf);

    expect(day.players[ASH]?.name).toBe('Ash2');
  });

  it('alerts when a player reaches 4, 8… team kills, 4, 8… vehicle suicides, or kills the same teammate a third time', () => {
    const three = recordGrief(emptyGriefDay(), [death(ASH, BO), death(ASH, CY), death(ASH, BO)], AT, sideOf);
    expect(three.alerts).toEqual([]);

    const four = recordGrief(three.day, [death(ASH, BO)], AT, sideOf);
    expect(four.alerts).toEqual([
      expect.objectContaining({ steamId: ASH, name: 'Ash', teamKills: 4, sameTeammate: { steamId: BO, name: 'Bo', kills: 3 } }),
    ]);
    expect(four.alerts[0]?.incidents).toHaveLength(1);

    const six = recordGrief(four.day, [death(ASH, CY), death(ASH, CY)], AT, sideOf);
    expect(six.alerts).toEqual([expect.objectContaining({ steamId: ASH, teamKills: 6, sameTeammate: { steamId: CY, name: 'Cy', kills: 3 } })]);

    const other = recordGrief(six.day, [death(ASH, DEE)], AT, sideOf);
    expect(other.alerts).toEqual([]);

    const crash = (n: number) => Array.from({ length: n }, () => death(BO, BO, { cause: HUMVEE, tags: ['VehicleExplosion'] }));
    expect(recordGrief(emptyGriefDay(), crash(3), AT, sideOf).alerts).toEqual([]);
    expect(recordGrief(emptyGriefDay(), crash(4), AT, sideOf).alerts).toEqual([expect.objectContaining({ steamId: BO, vehicleSuicides: 4 })]);
  });

  it('counts teammates killed in a helicopter crash, but towards no flag', () => {
    const crash = (victim: string) => death(ASH, victim, { cause: LITTLEBIRD, tags: ['VehicleExplosion'], distance: null });

    const first = recordGrief(emptyGriefDay(), [crash(BO), crash(CY), crash(BO), crash(ASH)], AT, sideOf);

    expect(first.day.players[ASH]).toMatchObject({
      teamKills: 3,
      vehicleTeamKills: 3,
      crashTeamKills: 3,
      suicides: 1,
      vehicleSuicides: 1,
      victims: {},
    });
    expect(first.day.players[BO]?.teamKilled).toBe(2);
    expect(first.day.incidents.map((i) => [i.kind, i.victimName ?? null, i.cause])).toEqual([
      ['team-kill', 'Bo', LITTLEBIRD],
      ['team-kill', 'Cy', LITTLEBIRD],
      ['team-kill', 'Bo', LITTLEBIRD],
      ['vehicle-suicide', null, LITTLEBIRD],
    ]);
    expect(first.alerts).toEqual([]);
    expect(dayFlags(first.day.players[ASH]!)).toEqual([]);

    // Other team kills still flag from 4, crashes left out.
    const three = recordGrief(first.day, [death(ASH, BO), death(ASH, CY), death(ASH, BO)], AT, sideOf);
    expect(three.alerts).toEqual([]);
    const four = recordGrief(three.day, [death(ASH, BO)], AT, sideOf);
    expect(four.alerts).toEqual([
      expect.objectContaining({ teamKills: 7, crashTeamKills: 3, sameTeammate: { steamId: BO, name: 'Bo', kills: 3 } }),
    ]);
    expect(dayFlags(four.day.players[ASH]!)).toEqual(['teamKills', 'sameTeammate']);

    // A pilot who keeps crashing still flags for vehicle suicides: the fourth crash of the day.
    const again = recordGrief(first.day, [crash(BO), crash(ASH), crash(BO), crash(ASH), crash(BO), crash(ASH)], AT, sideOf);
    expect(again.alerts).toEqual([expect.objectContaining({ steamId: ASH, teamKills: 6, crashTeamKills: 6, vehicleSuicides: 4, sameTeammate: null })]);
  });

  it('says whether a batch has anything to record, so most batches write nothing more', () => {
    expect(hasGrief([death(ASH, DEE), death(DEE, ASH)], sideOf)).toBe(false);
    expect(hasGrief([death(ASH, DEE), death(ASH, BO)], sideOf)).toBe(true);
    expect(hasGrief([death(ASH, ASH, { tags: ['Suicide'] })], sideOf)).toBe(true);
  });
});

describe('griefing records', () => {
  it('reads what was saved, and an empty day from anything else', () => {
    const { day } = recordGrief(emptyGriefDay(), [death(ASH, BO)], AT, sideOf);
    const { crashTeamKills, ...older } = day.players[ASH]!;

    expect(griefDayKey(AT)).toBe('grief:2026-10-03');
    expect(parseGriefDay(structuredClone(day))).toEqual(day);
    // Saved before crashes were kept apart.
    expect(crashTeamKills).toBe(0);
    expect(parseGriefDay({ ...day, players: { ...day.players, [ASH]: older } })).toEqual(day);
    expect(parseGriefDay(undefined)).toEqual(emptyGriefDay());
    expect(parseGriefDay({ players: { [ASH]: { name: 'Ash' } }, incidents: [] })).toEqual(emptyGriefDay());
  });

  it("flags a player's day from 4 team kills, the same teammate 3 times, 4 vehicle suicides or 10 suicides", () => {
    const base = { name: 'Ash', teamKills: 0, vehicleTeamKills: 0, crashTeamKills: 0, teamKilled: 0, suicides: 0, vehicleSuicides: 0, victims: {} };

    expect(dayFlags(base)).toEqual([]);
    expect(dayFlags({ ...base, teamKills: 3, victims: { [BO]: 1, [CY]: 1, [DEE]: 1 } })).toEqual([]);
    expect(dayFlags({ ...base, teamKills: 4, victims: { [BO]: 2, [CY]: 2 } })).toEqual(['teamKills']);
    expect(dayFlags({ ...base, teamKills: 6, vehicleTeamKills: 3, crashTeamKills: 3, victims: { [BO]: 2, [CY]: 1 } })).toEqual([]);
    expect(dayFlags({ ...base, teamKills: 3, victims: { [BO]: 3 } })).toEqual(['sameTeammate']);
    expect(dayFlags({ ...base, suicides: 3, vehicleSuicides: 3 })).toEqual([]);
    expect(dayFlags({ ...base, suicides: 4, vehicleSuicides: 4 })).toEqual(['vehicleSuicides']);
    expect(dayFlags({ ...base, suicides: 10 })).toEqual(['suicides']);
  });

  it('adds up the days, most flagged days first, then most team kills, with the teammate each killed most', () => {
    const days: GriefDay[] = [
      recordGrief(emptyGriefDay(), [death(ASH, BO), death(ASH, BO), death(ASH, BO), death(CY, BO)], AT, sideOf).day,
      recordGrief(emptyGriefDay(), [death(ASH, CY), death(CY, BO), death(CY, ASH), death(CY, BO), death(CY, BO)], AT, sideOf).day,
      recordGrief(emptyGriefDay(), [death(DEE, DEE, { tags: ['Suicide'] })], AT, sideOf).day,
    ];

    const rows = griefRows(days);

    expect(rows.map((r) => [r.name, r.teamKills, r.flaggedDays, r.flags])).toEqual([
      ['Cy', 5, 1, ['teamKills', 'sameTeammate']],
      ['Ash', 4, 1, ['sameTeammate']],
      ['Dee', 0, 0, []],
      ['Bo', 0, 0, []],
    ]);
    expect(rows[0]?.mostKilledTeammate).toEqual({ steamId: BO, name: 'Bo', kills: 4 });
    expect(rows.find((r) => r.steamId === BO)?.teamKilled).toBe(7);
    expect(rows.find((r) => r.steamId === DEE)?.suicides).toBe(1);
  });

  it("gives one player's day for /player: counts, flags, teammates killed and the incidents by them or on them", () => {
    const day = recordGrief(
      emptyGriefDay(),
      [death(ASH, BO), death(ASH, CY), death(ASH, BO), death(ASH, BO), death(CY, ASH), death(BO, CY), death(ASH, ASH, { cause: HUMVEE })],
      AT,
      sideOf,
    ).day;

    const ash = playerGrief(day, ASH);

    expect(ash).toMatchObject({ teamKills: 4, vehicleTeamKills: 0, teamKilled: 1, suicides: 1, vehicleSuicides: 1 });
    expect(ash.flags).toEqual(['teamKills', 'sameTeammate']);
    expect(ash.victims).toEqual([
      { steamId: BO, name: 'Bo', kills: 3 },
      { steamId: CY, name: 'Cy', kills: 1 },
    ]);
    // Bo killing Cy is neither by Ash nor on Ash.
    expect(ash.incidents.map((i) => [i.kind, i.name, i.victimName])).toEqual([
      ['team-kill', 'Ash', 'Bo'],
      ['team-kill', 'Ash', 'Cy'],
      ['team-kill', 'Ash', 'Bo'],
      ['team-kill', 'Ash', 'Bo'],
      ['team-kill', 'Cy', 'Ash'],
      ['vehicle-suicide', 'Ash', undefined],
    ]);
    expect(playerGrief(day, DEE)).toEqual({
      teamKills: 0,
      vehicleTeamKills: 0,
      crashTeamKills: 0,
      teamKilled: 0,
      suicides: 0,
      vehicleSuicides: 0,
      flags: [],
      victims: [],
      incidents: [],
    });
  });
});
