import { z } from 'zod';
import { dayOf, type IdOf } from './stats.ts';

// Weapon stats from the game's kill feed. With `Url` and `Token` set under [WDServerFeed] in ServerSettings.ini, the
// game POSTs its kills to Url + /api/ingest/events, a batch of one to ten about every two seconds, with the token as a
// bearer. Each kill names the killer and the victim by Steam ID, what killed them (`cause`, a tag like Id.Item.AK74M),
// how far apart they were in centimetres, and tags such as a headshot. The bot keeps each UTC day's totals by weapon,
// and each player's, for /api/stats and the player pages. Like the other player records, the Steam IDs stay private.

// Where the game posts. It always adds this to the Url it is given.
export const FEED_PATH = '/api/ingest/events';
// The game sends at most ten kills in a batch; a body much bigger than that is not the game.
export const MAX_FEED_BYTES = 65_536;
// Each batch writes one key per killer, and storage takes at most 128 keys at once.
export const MAX_FEED_EVENTS = 100;
export const MIN_FEED_TOKEN = 16;

// One death in the feed: a player killed by another, or by something else (a suicide, a fall, the world).
export type FeedEvent = {
  eventId: string;
  // The match clock, in seconds. It starts again with each match.
  time: number;
  // The game's id for the match. It only changes when the server restarts, not with each match.
  matchId: string;
  // As RCON names it, such as Kavkazi.
  map: string;
  victimSteamId: string;
  victimName: string;
  // Null when no other player made it.
  killerSteamId: string | null;
  killerName: string;
  // What killed them, such as Id.Item.AK74M. Null for a fall.
  cause: string | null;
  // Metres, when the game sent a distance. It sends none for a vehicle blowing up.
  distance: number | null;
  headshot: boolean;
  // The other things the game says about it, in short: RoadKill, Penetration, Ricochet, WeaponMelee, VehicleExplosion,
  // Falling, Suicide.
  tags: string[];
};

// One player killing another, with something. Suicides, falls and deaths with no player to blame are not kills.
export type FeedKill = FeedEvent & { killerSteamId: string; cause: string };

export const isKill = (e: FeedEvent): e is FeedKill =>
  e.killerSteamId !== null && e.killerSteamId !== e.victimSteamId && e.cause !== null && !e.tags.includes('Suicide');

// Every death in a batch, in the order the game sent them, the kills among them, and how many of its events were
// something else.
export type FeedBatch = { events: FeedEvent[]; kills: FeedKill[]; skipped: number };

const STEAM_ID = /^\d{17}$/;
const TAG_PREFIXES = ['Meta.Progression.Context.Player.KillContext.', 'Meta.PlayerKillFlag.Player.'];
// The tags kept: the rest (Local.Kill and Local.Death, on every event) say nothing.
const TAGS = ['Headshot', 'RoadKill', 'Penetration', 'Ricochet', 'WeaponMelee', 'VehicleExplosion', 'Falling', 'Suicide'];

const EventSchema = z.object({
  eventId: z.string().min(1).max(200),
  type: z.literal('killed'),
  eventTime: z.number().nullish(),
  matchId: z.string().max(200).nullish(),
  mapName: z.string().max(200).nullish(),
  killerSteamId: z.string().regex(STEAM_ID).nullish(),
  killerName: z.string().nullish(),
  victimSteamId: z.string().regex(STEAM_ID),
  victimName: z.string().nullish(),
  cause: z.string().min(1).max(200).nullish(),
  distance: z.number().nonnegative().nullish(),
  contextTags: z.array(z.string()).nullish(),
});

const shortTag = (tag: string): string => TAG_PREFIXES.reduce((t, prefix) => (t.startsWith(prefix) ? t.slice(prefix.length) : t), tag);

// A batch's deaths. Null when the body is not a batch at all.
export const parseFeed = (body: unknown): FeedBatch | null => {
  const batch = z.object({ events: z.array(z.unknown()).max(MAX_FEED_EVENTS) }).safeParse(body);
  if (!batch.success) return null;
  const events: FeedEvent[] = [];
  for (const raw of batch.data.events) {
    const parsed = EventSchema.safeParse(raw);
    if (!parsed.success) continue;
    const e = parsed.data;
    const tags = [...new Set((e.contextTags ?? []).map(shortTag))].filter((t) => TAGS.includes(t));
    events.push({
      eventId: e.eventId,
      time: e.eventTime ?? 0,
      matchId: e.matchId ?? '',
      map: e.mapName ?? '',
      victimSteamId: e.victimSteamId,
      victimName: (e.victimName ?? '').slice(0, 100),
      killerSteamId: e.killerSteamId ?? null,
      killerName: (e.killerName ?? '').slice(0, 100),
      cause: e.cause ?? null,
      // Unreal units are centimetres.
      distance: e.distance == null ? null : Math.round(e.distance) / 100,
      headshot: tags.includes('Headshot'),
      tags: tags.filter((t) => t !== 'Headshot'),
    });
  }
  return { events, kills: events.filter(isKill), skipped: batch.data.events.length - events.length };
};

const sha256 = async (text: string): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));

// Whether an Authorization header carries the token. Digests are compared, not the strings, and every byte of them,
// so the time it takes says nothing about how much of a guess was right.
export const feedAuthorized = async (header: string | null, token: string): Promise<boolean> => {
  const given = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '')?.[1];
  if (given === undefined) return false;
  const [a, b] = await Promise.all([sha256(given), sha256(token)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return difference === 0;
};

// What sort of thing killed: a hand-held weapon (guns, launchers, grenades, tools), something placed and left to go off
// (mines, charges, a supply pallet), a vehicle's gun (an emplacement's too: AA, mortars), a vehicle itself (run over,
// or blown up), or something built, such as barbed wire. The game blames placed and built things on whoever put them
// there, from wherever they are now.
export type WeaponKind = 'weapon' | 'placed' | 'vehicle-weapon' | 'vehicle' | 'buildable';

const PLACED = /^Id\.Item\.(ATMine|Claymore|C4Explosive|IED\.|VehicleSupplyCrate\.)/i;

export const weaponKind = (cause: string): WeaponKind => {
  if (/^Id\.Vehicle\.WeaponExtension\./i.test(cause)) return 'vehicle-weapon';
  if (/^Vehicle\./i.test(cause)) return 'vehicle';
  if (/^Id\.Buildable\./i.test(cause)) return 'buildable';
  if (PLACED.test(cause)) return 'placed';
  return 'weapon';
};

const KIND_ORDER: WeaponKind[] = ['weapon', 'placed', 'vehicle-weapon', 'vehicle', 'buildable'];

// Tags of different kinds can share a name: the Talon 9K-SAM is both a stationary vehicle and that vehicle's gun. Merged,
// they take the kind earlier in KIND_ORDER, so the kind never depends on which tag was counted first.
const mergedKind = (a: WeaponKind, b: WeaponKind): WeaponKind => (KIND_ORDER.indexOf(a) <= KIND_ORDER.indexOf(b) ? a : b);

// Names for the tags the game is known to send, as the game's weapon and vehicle lists name them. From Warcon
// (https://github.com/warcon-app/warcon, src/lib/causes.ts, MIT licence). The game sends no names of its own, so a tag
// not listed here is named from its last parts. Tags are matched in any case: the game writes `ID.Item.` for some.
const NAMES: Record<string, string> = {
  'Id.Item.A91': 'A-91',
  'Id.Item.KH2002': 'KH-2002',
  'Id.Item.TAR21': 'T-21',
  'Id.Item.AK74M': 'AK74',
  'Id.Item.WEPN_029': 'Galil',
  'Id.Item.M4': 'M4',
  'Id.Item.MP9': 'AMP-9',
  'Id.Item.Vector': 'Super-45',
  'Id.Item.MP43': 'MP43',
  'Id.Item.M500': 'M500',
  'Id.Item.M249': 'M249 SAW',
  'Id.Item.LMG_02': 'PKM',
  'Id.Item.SKS': 'SKS',
  'Id.Item.SVDM': 'SVD',
  'Id.Item.RFB': 'BMR-308',
  'Id.Item.Mosin': 'Mosin Nagant',
  'Id.Item.SV98': 'SV98',
  'Id.Item.MK22': 'MK22',
  'Id.Item.CombatBow': 'Compound bow',
  'Id.Item.Glock17': 'GGX 17',
  'Id.Item.Judge': 'Judge',
  'Id.Item.RPG7': 'RPG-7',
  'Id.Item.CGM4': 'MAAWS',
  'Id.Item.MMGL': 'MGL-40',
  'Id.Item.M67Grenade': 'M67 frag grenade',
  'Id.Item.C4Explosive': 'C4 charge',
  'Id.Item.IED.Explosive': 'IED',
  'Id.Item.ATMine': 'AT mine',
  'Id.Item.Claymore': 'Claymore',
  'Id.Item.Crowbar': 'Halligan bar',
  'Id.Item.Fists': 'Fists',
  'Id.Item.Defibrillator.Standard': 'Defibrillator',
  'ID.Item.BuildTool.Hammer.Large': 'Large hammer',
  'ID.Item.BuildTool.Hammer.Medium': 'Medium hammer',
  'ID.Item.BuildTool.Hammer.Small': 'Small hammer',
  'ID.Item.RepairTool.Drill.Light': 'Light drill',
  'ID.Item.RepairTool.Drill.Heavy': 'Heavy drill',
  'ID.Item.SmokeGrenade.White': 'White smoke grenade',
  'Id.Item.VehicleSupplyCrate.Pallet.MunitionsSupply': 'Ammo supply pallet',
  'Id.Buildable.BremmerWall': 'Bremer wall',
  'Id.Buildable.BarbedWire': 'Barbed wire',
  'Id.Buildable.HBlock': 'H-block',
  'Id.Buildable.TallHBlock': 'Tall H-block',
  'Vehicle.Variant.Air.Rotary.Littlebird.Default': 'MH-6',
  'Vehicle.Variant.Air.Rotary.Littlebird.MountedMachineGuns': 'AH-6M',
  'Vehicle.Variant.Air.Rotary.Littlebird.RocketPods': 'AH-6R',
  'Vehicle.Variant.Air.Rotary.Havoc.Default': 'Havoc',
  'Vehicle.Variant.Air.Rotary.ROT_04.Default': 'Z20 Lakota',
  'Vehicle.Variant.Air.Rotary.ROT_04.MountedMachineGuns': 'Z20 Lakota (miniguns)',
  'Vehicle.Variant.Land.Tracked.TNK_01.AntiAir': 'Flakpanzer Gepard',
  'Vehicle.Variant.Land.Tracked.TNK_01.Heavy': 'L2A6',
  'Vehicle.Variant.Land.Tracked.TNK_01.Artillery': 'SPH-2',
  'Vehicle.Variant.Land.Tracked.SpawnVehicle.Lonestar': 'M113 APC',
  'Vehicle.Variant.Land.Tracked.SpawnVehicle.Valkyra': 'M113 APC',
  'Vehicle.Variant.Land.Tracked.SpawnVehicle.Manticore': 'M113 APC',
  'Vehicle.Variant.Land.Wheeled.Humvee.Default': 'Humvee',
  'Vehicle.Variant.Land.Wheeled.Humvee.MachineGun': 'Humvee (M249)',
  'Vehicle.Variant.Land.Wheeled.Humvee.Minigun': 'Humvee (minigun)',
  'Vehicle.Variant.Land.Wheeled.Kodiak.Default': 'Kodiak',
  'Vehicle.Variant.Land.Wheeled.Kodiak.MachineGun': 'Kodiak (M249)',
  'Vehicle.Variant.Land.Wheeled.Kodiak.Pickup': 'Kodiak (pickup)',
  'Vehicle.Variant.Land.Wheeled.Ural.Default': 'Ural',
  'Vehicle.Variant.Land.Wheeled.Ural.Battle': 'Ural Defender',
  'Vehicle.Variant.Land.Wheeled.Ural.Attack': 'Ural Defender (M249)',
  'Vehicle.Variant.Land.Wheeled.Bobcat.Default': 'Bobcat',
  'Vehicle.Variant.Land.Wheeled.DuneBuggy.Default': 'Dune buggy',
  'Vehicle.Variant.Stationary.Phalanx': 'Vanguard CIWS',
  'Vehicle.Variant.Stationary.Mortar': 'L81 mortar',
  'Vehicle.Variant.Stationary.MistralAA': 'Talon 9K-SAM',
  'Vehicle.Variant.Stationary.Loudspeaker': 'Loudspeaker',
  'Id.Vehicle.WeaponExtension.ROT_02.30mmCannon': 'Havoc 2A42 autocannon',
  'Id.Vehicle.WeaponExtension.ROT_02.122mm': 'Havoc B-13 rockets',
  'Id.Vehicle.WeaponExtension.ROT_03.MountedMachineGun': 'AH-6M miniguns',
  'Id.Vehicle.WeaponExtension.ROT_03.RocketPods': 'AH-6R rockets',
  'Id.Vehicle.WeaponExtension.ROT_04.MountedMachineGun': 'Z20 Lakota miniguns',
  'Id.Vehicle.WeaponExtension.TNK_01.Artillery': 'SPH-2 artillery',
  'Id.Vehicle.WeaponExtension.TNK_01.Heavy': 'L2A6 cannon',
  'Id.Vehicle.WeaponExtension.TNK_01.MachineGun': 'L2A6 machine gun',
  'Id.Vehicle.WeaponExtension.TNK_01.MountedMachineGun': 'L2A6 mounted MG',
  'Id.Vehicle.WeaponExtension.WHL_02.SUV.RingTurret': 'Kodiak M249',
  'Id.Vehicle.WeaponExtension.WHL_05.RingTurret': 'Humvee M249',
  'Id.Vehicle.WeaponExtension.WHL_05.RingMinigun': 'Humvee minigun',
  'Id.Vehicle.WeaponExtension.WHL_07.MachineGun': 'Ural Defender M249',
  'Id.Vehicle.WeaponExtension.STN_01.MistralAA': 'Talon 9K-SAM',
};

const BY_TAG = new Map(Object.entries(NAMES).map(([cause, name]) => [cause.toLowerCase(), name]));

// `WEPN_035` → `WEPN 035`, `MountedMachineGuns` → `Mounted machine guns`. A code name keeps its capitals.
const words = (part: string): string =>
  part
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .map((w, i) => {
      if (/^[A-Z0-9]+$/.test(w) && /[A-Z]{2}/.test(w)) return w;
      const lower = w.toLowerCase();
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(' ');

export const weaponName = (cause: string): string => {
  const known = BY_TAG.get(cause.toLowerCase());
  if (known !== undefined) return known;
  const parts = cause.split('.').filter(Boolean);
  switch (weaponKind(cause)) {
    case 'vehicle': {
      // Vehicle.Variant.Air.Rotary.Littlebird.Default: the model, and the variant unless it is Default.
      const [model, variant] = parts.slice(4);
      if (model === undefined) return words(parts.at(-1) ?? cause);
      return variant !== undefined && variant !== 'Default' ? `${words(model)} (${words(variant).toLowerCase()})` : words(model);
    }
    case 'vehicle-weapon':
      // Id.Vehicle.WeaponExtension.STN_03.MainBarrel: the mount and the gun.
      return parts.slice(3).map(words).join(' ') || words(cause);
    case 'buildable':
      return words(parts.at(-1) ?? cause);
    default:
      // Id.Item.Mosin, Id.Item.Defibrillator.Standard
      return parts.slice(2).map(words).join(' ') || words(cause);
  }
};

// The longest kill with a weapon in a day, and who made it.
export type LongestKill = { distance: number; steamId: string; name: string };

// One weapon's kills in a UTC day, by everyone. `distance` adds up the metres of the `ranged` kills, the ones the game
// sent a distance for, for the average.
export type WeaponTotals = { kills: number; headshots: number; ranged: number; distance: number; longest: LongestKill | null };

// By the cause tag the game sends.
export type WeaponDay = Record<string, WeaponTotals>;

// One player's kills with one weapon in a UTC day. `longest` is in metres, null when the game sent no distance.
export type WeaponUse = { kills: number; headshots: number; longest: number | null };

// One player's weapons, by UTC date and then cause tag. Days older than the player pages cover are dropped as it is
// written, so it never grows past 90 days.
export type PlayerWeapons = Record<string, Record<string, WeaponUse>>;

export const weaponDayKey = (at: number): string => `weapons:${dayOf(at)}`;

export const playerWeaponsKey = (steamId: string): string => `playerWeapons:${steamId}`;

const count = z.number().int().nonnegative();

const WeaponDaySchema = z.record(
  z.string(),
  z.object({
    kills: count,
    headshots: count,
    ranged: count,
    distance: z.number(),
    longest: z.object({ distance: z.number(), steamId: z.string(), name: z.string() }).nullable(),
  }),
);

const PlayerWeaponsSchema = z.record(
  z.string(),
  z.record(z.string(), z.object({ kills: count, headshots: count, longest: z.number().nullable() })),
);

// Nothing saved yet, or anything unrecognisable, is an empty record.
export const parseWeaponDay = (raw: unknown): WeaponDay => {
  const parsed = WeaponDaySchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
};

export const parsePlayerWeapons = (raw: unknown): PlayerWeapons => {
  const parsed = PlayerWeaponsSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
};

const further = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));

export const recordWeaponDay = (day: WeaponDay, kills: FeedKill[]): WeaponDay => {
  const next = { ...day };
  for (const k of kills) {
    const known = next[k.cause] ?? { kills: 0, headshots: 0, ranged: 0, distance: 0, longest: null };
    const longer = k.distance !== null && (known.longest === null || k.distance > known.longest.distance);
    next[k.cause] = {
      kills: known.kills + 1,
      headshots: known.headshots + (k.headshot ? 1 : 0),
      ranged: known.ranged + (k.distance === null ? 0 : 1),
      distance: known.distance + (k.distance ?? 0),
      longest: longer && k.distance !== null ? { distance: k.distance, steamId: k.killerSteamId, name: k.killerName } : known.longest,
    };
  }
  return next;
};

// Adds one player's kills to `day`, and drops their days before `oldest`.
export const recordPlayerWeapons = (record: PlayerWeapons, kills: FeedKill[], day: string, oldest: string): PlayerWeapons => {
  const kept = Object.fromEntries(Object.entries(record).filter(([d]) => d >= oldest));
  const today = { ...kept[day] };
  for (const k of kills) {
    const known = today[k.cause] ?? { kills: 0, headshots: 0, longest: null };
    today[k.cause] = {
      kills: known.kills + 1,
      headshots: known.headshots + (k.headshot ? 1 : 0),
      longest: further(known.longest, k.distance),
    };
  }
  return { ...kept, [day]: today };
};

// Distances go out to a tenth of a metre.
const metres = (value: number): number => Math.round(value * 10) / 10;

// A weapon over the board's days. Tags with the same name, such as each side's M113, are one weapon.
export type WeaponRow = {
  name: string;
  kind: WeaponKind;
  kills: number;
  headshots: number;
  // Metres, over the kills the game sent a distance for; null when it sent none.
  averageDistance: number | null;
  longest: { distance: number; name: string; id?: string } | null;
};

export type WeaponBoard = {
  days: number;
  // The first UTC day the bot had the kill feed. Kills before then have no weapon.
  since: string;
  // Every kill in the feed over the days, of which `headshots` were headshots.
  kills: number;
  headshots: number;
  // Most kills first.
  top: WeaponRow[];
  // The longest kill of all with a hand-held weapon, and what with.
  longest: { distance: number; weapon: string; name: string; id?: string } | null;
};

// Everyone a board can name, so their public ids can be worked out first.
export const weaponHolders = (days: WeaponDay[]): string[] => [
  ...new Set(days.flatMap((d) => Object.values(d).flatMap((w) => (w.longest === null ? [] : [w.longest.steamId])))),
];

const holder = (longest: LongestKill, idOf: IdOf): { distance: number; name: string; id?: string } => {
  const id = idOf(longest.steamId);
  return { distance: metres(longest.distance), name: longest.name, ...(id === undefined ? {} : { id }) };
};

// The days' weapons, the top `count` by kills. `days` holds just the days the board covers.
export const weaponBoard = (days: WeaponDay[], period: number, since: string, count: number, idOf: IdOf): WeaponBoard => {
  const weapons = new Map<string, WeaponTotals & { kind: WeaponKind }>();
  for (const day of days) {
    for (const [cause, t] of Object.entries(day)) {
      const name = weaponName(cause);
      const known = weapons.get(name) ?? { kind: weaponKind(cause), kills: 0, headshots: 0, ranged: 0, distance: 0, longest: null };
      const longer = t.longest !== null && (known.longest === null || t.longest.distance > known.longest.distance);
      weapons.set(name, {
        kind: mergedKind(known.kind, weaponKind(cause)),
        kills: known.kills + t.kills,
        headshots: known.headshots + t.headshots,
        ranged: known.ranged + t.ranged,
        distance: known.distance + t.distance,
        longest: longer ? t.longest : known.longest,
      });
    }
  }
  const all = [...weapons].sort(([a, x], [b, y]) => y.kills - x.kills || a.localeCompare(b));
  // Only a hand-held weapon's kill can be the longest of all: how far a mine was from whoever laid it, or an emplacement
  // from its target, says nothing about their aim.
  const furthest = all.reduce<[string, LongestKill] | null>((best, [name, w]) => {
    if (w.kind !== 'weapon' || w.longest === null || (best !== null && w.longest.distance <= best[1].distance)) return best;
    return [name, w.longest];
  }, null);
  return {
    days: period,
    since,
    kills: all.reduce((sum, [, w]) => sum + w.kills, 0),
    headshots: all.reduce((sum, [, w]) => sum + w.headshots, 0),
    top: all.slice(0, count).map(([name, w]) => ({
      name,
      kind: w.kind,
      kills: w.kills,
      headshots: w.headshots,
      averageDistance: w.ranged === 0 ? null : metres(w.distance / w.ranged),
      longest: w.longest === null ? null : holder(w.longest, idOf),
    })),
    longest: furthest === null ? null : { weapon: furthest[0], ...holder(furthest[1], idOf) },
  };
};

// One UTC day's kills with one weapon, for a player page, which adds up the days of the period it shows.
export type PlayerWeaponDay = { day: string; name: string; kind: WeaponKind; kills: number; headshots: number; longest: number | null };

// A player's weapons on a player page. `since` is as on the weapon board.
export type PlayerWeaponsPage = { since: string; used: PlayerWeaponDay[] };

// Their days from `oldest` on, oldest first, and each day's weapons with the most kills first.
export const playerWeaponDays = (record: PlayerWeapons, oldest: string): PlayerWeaponDay[] =>
  Object.entries(record)
    .filter(([day]) => day >= oldest)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([day, weapons]) => {
      const named = new Map<string, PlayerWeaponDay>();
      for (const [cause, w] of Object.entries(weapons)) {
        const name = weaponName(cause);
        const known = named.get(name) ?? { day, name, kind: weaponKind(cause), kills: 0, headshots: 0, longest: null };
        named.set(name, {
          ...known,
          kind: mergedKind(known.kind, weaponKind(cause)),
          kills: known.kills + w.kills,
          headshots: known.headshots + w.headshots,
          longest: further(known.longest, w.longest),
        });
      }
      return [...named.values()]
        .map((w) => ({ ...w, longest: w.longest === null ? null : metres(w.longest) }))
        .sort((a, b) => b.kills - a.kills || a.name.localeCompare(b.name));
    });

// A player's kills in the feed from `oldest` on, and how many were headshots, for the staff page.
export const feedKillsSince = (record: PlayerWeapons, oldest: string): { kills: number; headshots: number } =>
  Object.entries(record)
    .filter(([day]) => day >= oldest)
    .flatMap(([, weapons]) => Object.values(weapons))
    .reduce((sum, w) => ({ kills: sum.kills + w.kills, headshots: sum.headshots + w.headshots }), { kills: 0, headshots: 0 });
