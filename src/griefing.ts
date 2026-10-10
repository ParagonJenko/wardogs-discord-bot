import { z } from 'zod';
import { factionKey } from './discord.ts';
import { dayOf } from './stats.ts';
import { isKill, weaponKind, type FeedEvent } from './weapons.ts';

// Possible griefing, from the game's kill feed, for the staff page and the moderation log channel: team kills (killing
// someone on your own side), whom each player team killed, and suicides, with those in a vehicle (crashing it, or
// blowing it up with yourself in it) apart. Kept for each UTC day ('grief:<date>'), like the other player records, and
// keyed by Steam ID, so it is private: only signed-in staff see it. Teammates killed in a helicopter crash are counted
// but never flagged: pilots crash by accident, and one crash can kill a full load. A pilot who keeps crashing is still
// flagged for vehicle suicides.

export const griefDayKey = (at: number): string => `grief:${dayOf(at)}`;

// A player's day. `victims` is the teammates they killed other than in a crash, by Steam ID, and how many times each.
export type GriefTotals = {
  name: string;
  teamKills: number;
  // Team kills with a vehicle: running a teammate over, or crashing or blowing up a vehicle with teammates in it.
  vehicleTeamKills: number;
  // Of those, the ones by a helicopter itself rather than its guns: crashing it with teammates aboard, or landing on
  // them. They count towards no flag.
  crashTeamKills: number;
  // Times a teammate killed them.
  teamKilled: number;
  suicides: number;
  vehicleSuicides: number;
  victims: Record<string, number>;
};

// One team kill or vehicle suicide, as evidence. Other suicides are only counted: they are common and say little alone.
export type Incident = {
  at: number;
  kind: 'team-kill' | 'vehicle-suicide';
  map: string;
  steamId: string;
  name: string;
  faction: string | null;
  // Team kills only.
  victimSteamId?: string;
  victimName?: string;
  cause: string | null;
  distance: number | null;
  tags: string[];
};

// Incidents oldest first.
export type GriefDay = { players: Record<string, GriefTotals>; incidents: Incident[] };

// A day keeps its latest incidents, up to this many, so its record stays small. The counts are always complete.
export const INCIDENTS_KEPT = 300;

// From when a player's day counts as worth a look. Each is a flag on the staff page. Set from the alert review (see
// review.ts) of the kill feed's first days, 4 to 6 October 2026: at 3 team kills, the same teammate twice and 2
// vehicle suicides, a full day earned 38 flags. Team kills fall away evenly from 1 to 7 a day, nobody killed the same
// teammate more than twice, and more than 1 in 4 players who appear here had a vehicle suicide.
export const FLAGS = {
  // Team kills in a day, not counting crashes.
  teamKills: 4,
  // Times they killed the same teammate in a day, not counting crashes.
  sameTeammate: 3,
  // Suicides in a vehicle in a day.
  vehicleSuicides: 4,
  // Suicides of any kind in a day.
  suicides: 10,
} as const;

export type Flag = keyof typeof FLAGS;

const count = z.number().int().nonnegative();

const GriefDaySchema = z.object({
  players: z.record(
    z.string(),
    z.object({
      name: z.string(),
      teamKills: count,
      vehicleTeamKills: count,
      // Not in days saved before it was kept apart.
      crashTeamKills: count.default(0),
      teamKilled: count,
      suicides: count,
      vehicleSuicides: count,
      victims: z.record(z.string(), count),
    }),
  ),
  incidents: z.array(
    z.object({
      at: z.number(),
      kind: z.enum(['team-kill', 'vehicle-suicide']),
      map: z.string(),
      steamId: z.string(),
      name: z.string(),
      faction: z.string().nullable(),
      victimSteamId: z.string().optional(),
      victimName: z.string().optional(),
      cause: z.string().nullable(),
      distance: z.number().nullable(),
      tags: z.array(z.string()),
    }),
  ),
});

// The in-game message to a player who just team killed. The rules note is added after it, as /warn does.
export const TEAM_KILL_WARNING = 'Team killing is against the rules. Please apologise in team chat.';

export const emptyGriefDay = (): GriefDay => ({ players: {}, incidents: [] });

// Nothing saved yet, or anything unrecognisable, is an empty day.
export const parseGriefDay = (raw: unknown): GriefDay => {
  const parsed = GriefDaySchema.safeParse(raw);
  return parsed.success ? parsed.data : emptyGriefDay();
};

export const isSuicide = (e: FeedEvent): boolean =>
  e.tags.includes('Suicide') || (e.killerSteamId !== null && e.killerSteamId === e.victimSteamId);

// A death a vehicle made: run over, blown up, or by the vehicle itself rather than a gun on it. Emplacements such as
// mortars are vehicles to the game, but not ones anyone drives, so they never count, whatever the tags say.
export const byVehicle = (e: Pick<FeedEvent, 'cause' | 'tags'>): boolean => {
  if (e.cause !== null && weaponKind(e.cause) === 'emplacement') return false;
  return e.tags.includes('VehicleExplosion') || e.tags.includes('RoadKill') || (e.cause !== null && weaponKind(e.cause) === 'vehicle');
};

// A death a helicopter itself made, rather than its guns: crashing it with people aboard, or landing on them.
const AIRCRAFT = /^Vehicle\.Variant\.Air\./i;
export const byAircraft = (e: Pick<FeedEvent, 'cause'>): boolean => e.cause !== null && AIRCRAFT.test(e.cause);

// How a vehicle killed: a helicopter itself (mostly a crash), running someone over, the vehicle blowing up with them in
// it or next to it, or the vehicle some other way. Null for a death no vehicle made, such as by a vehicle's gun.
export type VehicleDeath = 'helicopter' | 'runOver' | 'explosion' | 'other';

export const vehicleDeath = (e: Pick<FeedEvent, 'cause' | 'tags'>): VehicleDeath | null => {
  if (!byVehicle(e)) return null;
  if (byAircraft(e)) return 'helicopter';
  if (e.tags.includes('RoadKill')) return 'runOver';
  return e.tags.includes('VehicleExplosion') ? 'explosion' : 'other';
};

// Whether two players are on the same side, as the bot last saw them. Unknown sides are never the same.
export const sameSide = (a: string | null, b: string | null): boolean => a !== null && b !== null && factionKey(a) === factionKey(b);

// A player passing a flag's mark in a batch, for the moderation log channel: team kills at 4, 8, 12…, vehicle suicides
// at 4, 8, 12…, and the third time they kill the same teammate in a day. Crashes count towards none of them.
export type GriefAlert = {
  steamId: string;
  name: string;
  // All of them, crashes included.
  teamKills: number;
  crashTeamKills: number;
  vehicleSuicides: number;
  // The teammate they just killed for the third time that day.
  sameTeammate: { steamId: string; name: string; kills: number } | null;
  // The incidents in this batch by them, newest last.
  incidents: Incident[];
};

const blank = (name: string): GriefTotals => ({
  name,
  teamKills: 0,
  vehicleTeamKills: 0,
  crashTeamKills: 0,
  teamKilled: 0,
  suicides: 0,
  vehicleSuicides: 0,
  victims: {},
});

const passed = (before: number, after: number, mark: number): boolean => Math.floor(after / mark) > Math.floor(before / mark);

// The team kills that count towards the flag: not crashes.
const flaggedTeamKills = (t: GriefTotals): number => t.teamKills - t.crashTeamKills;

// Adds a batch's deaths to the day. `factionOf` is the side the bot last saw a player on, as the feed does not say.
export const recordGrief = (
  day: GriefDay,
  events: FeedEvent[],
  at: number,
  factionOf: (steamId: string) => string | null,
): { day: GriefDay; alerts: GriefAlert[]; teamKillers: { steamId: string; name: string }[] } => {
  const players: Record<string, GriefTotals> = Object.fromEntries(
    Object.entries(day.players).map(([steamId, t]) => [steamId, { ...t, victims: { ...t.victims } }]),
  );
  const before = new Map<string, GriefTotals>();
  const added: Incident[] = [];
  const player = (steamId: string, name: string): GriefTotals => {
    const known = players[steamId] ?? blank(name);
    if (!before.has(steamId)) before.set(steamId, { ...known, victims: { ...known.victims } });
    if (name !== '') known.name = name;
    players[steamId] = known;
    return known;
  };
  for (const e of events) {
    if (isSuicide(e)) {
      const p = player(e.victimSteamId, e.victimName);
      p.suicides += 1;
      if (!byVehicle(e)) continue;
      p.vehicleSuicides += 1;
      added.push({
        at,
        kind: 'vehicle-suicide',
        map: e.map,
        steamId: e.victimSteamId,
        name: p.name,
        faction: factionOf(e.victimSteamId),
        cause: e.cause,
        distance: e.distance,
        tags: e.tags,
      });
      continue;
    }
    if (!isKill(e)) continue;
    const side = factionOf(e.killerSteamId);
    if (!sameSide(side, factionOf(e.victimSteamId))) continue;
    const killer = player(e.killerSteamId, e.killerName);
    const victim = player(e.victimSteamId, e.victimName);
    killer.teamKills += 1;
    killer.vehicleTeamKills += byVehicle(e) ? 1 : 0;
    if (byAircraft(e)) killer.crashTeamKills += 1;
    else killer.victims[e.victimSteamId] = (killer.victims[e.victimSteamId] ?? 0) + 1;
    victim.teamKilled += 1;
    added.push({
      at,
      kind: 'team-kill',
      map: e.map,
      steamId: e.killerSteamId,
      name: killer.name,
      faction: side,
      victimSteamId: e.victimSteamId,
      victimName: victim.name,
      cause: e.cause,
      distance: e.distance,
      tags: e.tags,
    });
  }
  const incidents = [...day.incidents, ...added].slice(-INCIDENTS_KEPT);
  const alerts = [...before].flatMap(([steamId, old]): GriefAlert[] => {
    const now = players[steamId];
    if (now === undefined) return [];
    const teamKills = passed(flaggedTeamKills(old), flaggedTeamKills(now), FLAGS.teamKills);
    const vehicleSuicides = passed(old.vehicleSuicides, now.vehicleSuicides, FLAGS.vehicleSuicides);
    const again = Object.entries(now.victims).find(
      ([victim, kills]) => kills >= FLAGS.sameTeammate && (old.victims[victim] ?? 0) < FLAGS.sameTeammate,
    );
    if (!teamKills && !vehicleSuicides && again === undefined) return [];
    return [
      {
        steamId,
        name: now.name,
        teamKills: now.teamKills,
        crashTeamKills: now.crashTeamKills,
        vehicleSuicides: now.vehicleSuicides,
        sameTeammate: again === undefined ? null : { steamId: again[0], name: players[again[0]]?.name ?? again[0], kills: again[1] },
        incidents: added.filter((i) => i.steamId === steamId),
      },
    ];
  });
  // Who to warn: whoever team killed in this batch, once each, not for a crash (pilots crash by accident).
  const teamKillers = [
    ...new Map(
      added
        .filter((i) => i.kind === 'team-kill' && !byAircraft(i))
        .map((i) => [i.steamId, { steamId: i.steamId, name: i.name }] as const),
    ).values(),
  ];
  return { day: { players, incidents }, alerts, teamKillers };
};

// Whether a batch has anything for the griefing records, so a batch without saves a storage write.
export const hasGrief = (events: FeedEvent[], factionOf: (steamId: string) => string | null): boolean =>
  events.some((e) => isSuicide(e) || (isKill(e) && sameSide(factionOf(e.killerSteamId), factionOf(e.victimSteamId))));

// The flags a player's day earned.
export const dayFlags = (t: GriefTotals): Flag[] => [
  ...(flaggedTeamKills(t) >= FLAGS.teamKills ? (['teamKills'] as const) : []),
  ...(Object.values(t.victims).some((n) => n >= FLAGS.sameTeammate) ? (['sameTeammate'] as const) : []),
  ...(t.vehicleSuicides >= FLAGS.vehicleSuicides ? (['vehicleSuicides'] as const) : []),
  ...(t.suicides >= FLAGS.suicides ? (['suicides'] as const) : []),
];

// A player over the days the staff page shows: their totals, the teammate they killed most, and the flags their days
// earned, with how many days earned any.
export type GriefRow = Omit<GriefTotals, 'victims'> & {
  steamId: string;
  mostKilledTeammate: { steamId: string; name: string; kills: number } | null;
  flags: Flag[];
  flaggedDays: number;
};

const FLAG_ORDER: Flag[] = ['teamKills', 'sameTeammate', 'vehicleSuicides', 'suicides'];

// Everyone in the days who team killed, was team killed or killed themselves. Most flagged days first, then most team
// kills, vehicle suicides and suicides.
export const griefRows = (days: GriefDay[]): GriefRow[] => {
  const rows = new Map<string, GriefTotals & { flags: Set<Flag>; flaggedDays: number }>();
  for (const day of days) {
    for (const [steamId, t] of Object.entries(day.players)) {
      const row = rows.get(steamId) ?? { ...blank(t.name), flags: new Set<Flag>(), flaggedDays: 0 };
      row.name = t.name || row.name;
      row.teamKills += t.teamKills;
      row.vehicleTeamKills += t.vehicleTeamKills;
      row.crashTeamKills += t.crashTeamKills;
      row.teamKilled += t.teamKilled;
      row.suicides += t.suicides;
      row.vehicleSuicides += t.vehicleSuicides;
      for (const [victim, n] of Object.entries(t.victims)) row.victims[victim] = (row.victims[victim] ?? 0) + n;
      const flags = dayFlags(t);
      for (const flag of flags) row.flags.add(flag);
      if (flags.length > 0) row.flaggedDays += 1;
      rows.set(steamId, row);
    }
  }
  const nameOf = (steamId: string): string => rows.get(steamId)?.name ?? steamId;
  return [...rows]
    .map(([steamId, { victims, flags, ...t }]) => {
      const most = Object.entries(victims).reduce<[string, number] | null>((top, v) => (top === null || v[1] > top[1] ? v : top), null);
      return {
        ...t,
        steamId,
        mostKilledTeammate: most === null ? null : { steamId: most[0], name: nameOf(most[0]), kills: most[1] },
        flags: FLAG_ORDER.filter((f) => flags.has(f)),
      };
    })
    .sort(
      (a, b) =>
        b.flaggedDays - a.flaggedDays ||
        b.teamKills - a.teamKills ||
        b.vehicleSuicides - a.vehicleSuicides ||
        b.suicides - a.suicides ||
        a.name.localeCompare(b.name),
    );
};

// One player's day, for /player: their counts (all 0 when they have none), the flags it earned, the teammates they
// killed other than in a crash, most killed first, and the day's kept incidents by them or team kills on them, oldest first.
export type PlayerGrief = Omit<GriefTotals, 'name' | 'victims'> & {
  flags: Flag[];
  victims: { steamId: string; name: string; kills: number }[];
  incidents: Incident[];
};

export const playerGrief = (day: GriefDay, steamId: string): PlayerGrief => {
  const t = day.players[steamId] ?? blank('');
  return {
    teamKills: t.teamKills,
    vehicleTeamKills: t.vehicleTeamKills,
    crashTeamKills: t.crashTeamKills,
    teamKilled: t.teamKilled,
    suicides: t.suicides,
    vehicleSuicides: t.vehicleSuicides,
    flags: dayFlags(t),
    victims: Object.entries(t.victims)
      .map(([id, kills]) => ({ steamId: id, name: day.players[id]?.name || id, kills }))
      .sort((a, b) => b.kills - a.kills || a.name.localeCompare(b.name)),
    incidents: day.incidents.filter((i) => i.steamId === steamId || i.victimSteamId === steamId),
  };
};
