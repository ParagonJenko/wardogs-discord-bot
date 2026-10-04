import { z } from 'zod';
import type { AdminPlayer } from './admin.ts';
import { mapName } from './discord.ts';
import { sameSide } from './griefing.ts';
import type { IdOf } from './stats.ts';
import { weaponKind, weaponName, type FeedKill, type WeaponKind } from './weapons.ts';

// The staff page's kill feed, from the game's kill feed: every kill, with who killed whom, with what, from how far and
// whether it was a headshot, and who gets far more headshots than the server's players get with the same weapons. Many
// headshots, day after day, can be a sign of cheating. Keyed by Steam ID, so only signed-in staff see it.
//
// Two records. 'killFeed' (Durable Object storage, written with each batch) is the server's latest kills. The kill_days
// table, in the Durable Object's SQLite database, has a row for each player on each UTC day they killed someone: their
// kills and headshots, the same by weapon, and each kill. A batch writes one row per killer, as for their weapons, and
// rows older than KILL_DAYS_KEPT days are deleted.

export const KILL_FEED_KEY = 'killFeed';
// The feed keeps the server's latest kills, up to this many, and fewer when their names are long, so the record stays
// well under storage's limit for one value (128 KiB).
export const FEED_KEPT = 250;
export const FEED_BYTES = 80_000;
// The staff page's longest period.
export const KILL_DAYS_KEPT = 30;
// A player's day keeps their latest kills, up to this many. Their counts are always complete.
export const DAY_KILLS_KEPT = 1_000;
// The headshots list, and a player's kills, on the staff page.
export const HEADSHOT_ROWS_LISTED = 100;
export const PLAYER_KILLS_LISTED = 1_000;

// A player's day is flagged for headshots when they killed at least `kills` players, with so many headshots that
// someone with the server's usual aim, using the same weapons, would get that many less than once in `odds` days.
export const HEADSHOT_FLAG = { kills: 10, odds: 1_000 } as const;

// What the server's players get with a weapon is pulled towards what they get with every weapon by this many kills, so
// a weapon few people use, with a lucky day, does not decide.
const WEAPON_PRIOR_KILLS = 20;
// The server's players need this many kills between them before anyone's headshots are judged.
const BASELINE_KILLS = 100;

// One kill as the staff records keep it. `at` is when the bot got it, `map` as RCON names it, `cause` the game's tag.
export type StaffKill = {
  at: number;
  map: string;
  killer: string;
  killerName: string;
  victim: string;
  victimName: string;
  cause: string;
  // Metres, when the game sent a distance.
  distance: number | null;
  headshot: boolean;
  // RoadKill, Penetration and the like (see weapons.ts).
  tags: string[];
  // Killer and victim were on the same side, as the bot last saw them.
  teamKill: boolean;
};

// One of a player's kills on their day: the killer is the row's.
export type DayKill = Omit<StaffKill, 'killer' | 'killerName'>;

export type WeaponCount = { kills: number; headshots: number };

// A player's UTC day. `weapons` is by cause tag; `list` their latest kills, oldest first.
export type KillDay = {
  day: string;
  steamId: string;
  name: string;
  kills: number;
  headshots: number;
  weapons: Record<string, WeaponCount>;
  list: DayKill[];
};

// A day without its kills, for the headshots list.
export type KillDaySummary = Omit<KillDay, 'list'>;

const count = z.number().int().nonnegative();

const DayKillSchema = z.object({
  at: z.number(),
  map: z.string(),
  victim: z.string(),
  victimName: z.string(),
  cause: z.string(),
  distance: z.number().nullable(),
  headshot: z.boolean(),
  tags: z.array(z.string()),
  teamKill: z.boolean(),
});

const KillFeedSchema = z.array(DayKillSchema.extend({ killer: z.string(), killerName: z.string() }));

const WeaponsSchema = z.record(z.string(), z.object({ kills: count, headshots: count }));

// Nothing saved yet, or anything unrecognisable, is an empty feed.
export const parseKillFeed = (raw: unknown): StaffKill[] => {
  const parsed = KillFeedSchema.safeParse(raw);
  return parsed.success ? parsed.data : [];
};

// A batch's kills. `factionOf` is the side the bot last saw a player on, as the feed does not say.
export const toStaffKills = (kills: FeedKill[], at: number, factionOf: (steamId: string) => string | null): StaffKill[] =>
  kills.map((k) => ({
    at,
    map: k.map,
    killer: k.killerSteamId,
    killerName: k.killerName,
    victim: k.victimSteamId,
    victimName: k.victimName,
    cause: k.cause,
    distance: k.distance,
    headshot: k.headshot,
    tags: k.tags,
    teamKill: sameSide(factionOf(k.killerSteamId), factionOf(k.victimSteamId)),
  }));

const encoder = new TextEncoder();

// The feed with a batch's kills added: the latest FEED_KEPT, and fewer while they come to more than FEED_BYTES.
export const recordKillFeed = (feed: StaffKill[], kills: StaffKill[]): StaffKill[] => {
  const latest = [...feed, ...kills].slice(-FEED_KEPT);
  let bytes = 2;
  let first = latest.length;
  while (first > 0) {
    bytes += encoder.encode(JSON.stringify(latest[first - 1])).length + 1;
    if (bytes > FEED_BYTES) break;
    first -= 1;
  }
  return latest.slice(first);
};

// Adds a player's kills from a batch to their day (null before their first that day).
export const recordKillDay = (known: KillDay | null, steamId: string, day: string, kills: StaffKill[]): KillDay => {
  const next: KillDay =
    known === null
      ? { day, steamId, name: '', kills: 0, headshots: 0, weapons: {}, list: [] }
      : { ...known, weapons: { ...known.weapons } };
  const added: DayKill[] = [];
  for (const { killer: _killer, killerName, ...kill } of kills) {
    if (killerName !== '') next.name = killerName;
    next.kills += 1;
    next.headshots += kill.headshot ? 1 : 0;
    const weapon = next.weapons[kill.cause] ?? { kills: 0, headshots: 0 };
    next.weapons[kill.cause] = { kills: weapon.kills + 1, headshots: weapon.headshots + (kill.headshot ? 1 : 0) };
    added.push(kill);
  }
  return { ...next, list: [...next.list, ...added].slice(-DAY_KILLS_KEPT) };
};

// The Durable Object's SQLite database, as far as the kill records need it: ctx.storage.sql on Cloudflare.
export type Sql = { exec(query: string, ...bindings: (string | number | null)[]): { toArray(): Record<string, unknown>[] } };

// The table, made the first time. `list` is last, so reading the other columns never reads it.
export const createKillDays = (sql: Sql): void => {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS kill_days (
      day TEXT NOT NULL,
      steam_id TEXT NOT NULL,
      name TEXT NOT NULL,
      kills INTEGER NOT NULL,
      headshots INTEGER NOT NULL,
      weapons TEXT NOT NULL,
      list TEXT NOT NULL,
      PRIMARY KEY (day, steam_id)
    )`,
  );
  sql.exec('CREATE INDEX IF NOT EXISTS kill_days_player ON kill_days (steam_id, day)');
};

const json = (text: unknown): unknown => {
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const RowSchema = z.object({
  day: z.string(),
  steam_id: z.string(),
  name: z.string(),
  kills: count,
  headshots: count,
  weapons: z.string(),
});

// A row as a day. Anything unrecognisable is left out.
const summaryOf = (row: Record<string, unknown>): KillDaySummary | null => {
  const parsed = RowSchema.safeParse(row);
  const weapons = WeaponsSchema.safeParse(json(row['weapons']));
  if (!parsed.success || !weapons.success) return null;
  const { day, steam_id: steamId, name, kills, headshots } = parsed.data;
  return { day, steamId, name, kills, headshots, weapons: weapons.data };
};

const dayOfRow = (row: Record<string, unknown>): KillDay | null => {
  const summary = summaryOf(row);
  const list = z.array(DayKillSchema).safeParse(json(row['list']));
  return summary === null ? null : { ...summary, list: list.success ? list.data : [] };
};

// These players' rows for a day, by Steam ID. The ids go as one JSON array, as a query takes at most 100 values.
export const readKillDays = (sql: Sql, day: string, steamIds: string[]): Map<string, KillDay> =>
  new Map(
    sql
      .exec('SELECT * FROM kill_days WHERE day = ? AND steam_id IN (SELECT value FROM json_each(?))', day, JSON.stringify(steamIds))
      .toArray()
      .flatMap((row) => {
        const known = dayOfRow(row);
        return known === null ? [] : [[known.steamId, known] as const];
      }),
  );

export const writeKillDays = (sql: Sql, days: KillDay[]): void => {
  for (const d of days) {
    sql.exec(
      `INSERT INTO kill_days (day, steam_id, name, kills, headshots, weapons, list) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (day, steam_id) DO UPDATE SET
         name = excluded.name, kills = excluded.kills, headshots = excluded.headshots, weapons = excluded.weapons, list = excluded.list`,
      d.day,
      d.steamId,
      d.name,
      d.kills,
      d.headshots,
      JSON.stringify(d.weapons),
      JSON.stringify(d.list),
    );
  }
};

// Everyone's days from `from` to `to` (UTC dates), without their kills.
export const killDaySummaries = (sql: Sql, from: string, to: string): KillDaySummary[] =>
  sql
    .exec(
      'SELECT day, steam_id, name, kills, headshots, weapons FROM kill_days WHERE day >= ? AND day <= ? ORDER BY day, steam_id',
      from,
      to,
    )
    .toArray()
    .flatMap((row) => summaryOf(row) ?? []);

// A player's days from `from` on, oldest first, with their kills.
export const playerKillDays = (sql: Sql, steamId: string, from: string): KillDay[] =>
  sql
    .exec('SELECT * FROM kill_days WHERE steam_id = ? AND day >= ? ORDER BY day', steamId, from)
    .toArray()
    .flatMap((row) => dayOfRow(row) ?? []);

// Deletes the days before `oldest`.
export const pruneKillDays = (sql: Sql, oldest: string): void => {
  sql.exec('DELETE FROM kill_days WHERE day < ?', oldest);
};

// The first UTC day kept, or null before the first kill.
export const firstKillDay = (sql: Sql): string | null => {
  const day = sql.exec('SELECT MIN(day) AS day FROM kill_days').toArray()[0]?.['day'];
  return typeof day === 'string' ? day : null;
};

// Kills and headshots, over everything and by cause tag.
export type Tally = { all: WeaponCount; byCause: Map<string, WeaponCount> };

const NONE: WeaponCount = { kills: 0, headshots: 0 };

export const tally = (days: Iterable<Pick<KillDaySummary, 'weapons'>>): Tally => {
  const all = { kills: 0, headshots: 0 };
  const byCause = new Map<string, WeaponCount>();
  for (const d of days) {
    for (const [cause, w] of Object.entries(d.weapons)) {
      const known = byCause.get(cause) ?? NONE;
      byCause.set(cause, { kills: known.kills + w.kills, headshots: known.headshots + w.headshots });
      all.kills += w.kills;
      all.headshots += w.headshots;
    }
  }
  return { all, byCause };
};

const minus = (a: WeaponCount, b: WeaponCount | undefined): WeaponCount => ({
  kills: a.kills - (b?.kills ?? 0),
  headshots: a.headshots - (b?.headshots ?? 0),
});

// The chance of `headshots` or more in `kills` kills, when each is a headshot with chance `share`.
export const chanceOfAtLeast = (kills: number, headshots: number, share: number): number => {
  if (headshots <= 0) return 1;
  if (headshots > kills) return 0;
  const p = Math.min(Math.max(share, 0.001), 0.999);
  const [hit, miss] = [Math.log(p), Math.log(1 - p)];
  // ln(kills choose k), from k = 0 up.
  let ways = 0;
  let total = 0;
  for (let k = 1; k <= kills; k++) {
    ways += Math.log(kills - k + 1) - Math.log(k);
    if (k >= headshots) total += Math.exp(ways + k * hit + (kills - k) * miss);
  }
  return Math.min(1, total);
};

// How `weapons` compare with the server: `expected` is the headshots someone with the server's usual aim would get with
// the same kills by weapon, and `chance` the chance of getting as many headshots as they did, or more. `server` is
// everyone's kills, and `own` the player's own, which are left out of it. Null while the others have too few kills.
export type HeadshotOdds = { expected: number; chance: number };

export const headshotOdds = (weapons: Record<string, WeaponCount>, server: Tally, own: Tally): HeadshotOdds | null => {
  const others = minus(server.all, own.all);
  if (others.kills < BASELINE_KILLS) return null;
  const usual = others.headshots / others.kills;
  let kills = 0;
  let headshots = 0;
  let expected = 0;
  for (const [cause, w] of Object.entries(weapons)) {
    const theirs = minus(server.byCause.get(cause) ?? NONE, own.byCause.get(cause));
    kills += w.kills;
    headshots += w.headshots;
    expected += (w.kills * (theirs.headshots + WEAPON_PRIOR_KILLS * usual)) / (theirs.kills + WEAPON_PRIOR_KILLS);
  }
  if (kills === 0) return { expected: 0, chance: 1 };
  // Each weapon's own share would make the chance a little smaller still, so this never overstates how unlikely it is.
  return { expected, chance: chanceOfAtLeast(kills, headshots, expected / kills) };
};

export const flaggedDay = (kills: number, odds: HeadshotOdds | null): boolean =>
  odds !== null && kills >= HEADSHOT_FLAG.kills && odds.chance * HEADSHOT_FLAG.odds < 1;

const round1 = (n: number): number => Math.round(n * 10) / 10;

// Everyone's tallies over `days`, by Steam ID.
const tallies = (days: KillDaySummary[]): Map<string, Tally> => {
  const by = new Map<string, KillDaySummary[]>();
  for (const d of days) by.set(d.steamId, [...(by.get(d.steamId) ?? []), d]);
  return new Map([...by].map(([steamId, theirs]) => [steamId, tally(theirs)]));
};

const merged = (days: Pick<KillDaySummary, 'weapons'>[]): Record<string, WeaponCount> => Object.fromEntries(tally(days).byCause);

// A player in the headshots list, over the period.
export type HeadshotRow = {
  steamId: string;
  name: string;
  kills: number;
  headshots: number;
  // See HeadshotOdds; null while the server has too few kills to judge by.
  expected: number | null;
  chance: number | null;
  // Their days in the period with kills, and how many were flagged (HEADSHOT_FLAG).
  days: number;
  flaggedDays: number;
  // Their weapon with the most kills.
  weapon: string | null;
};

const BY_CHANCE = (a: { chance: number | null }, b: { chance: number | null }): number => (a.chance ?? 2) - (b.chance ?? 2);

// Everyone with a headshot in the period (`period`, a subset of `kept`), most flagged days first, then least likely by
// luck, then most headshots. `kept` is every day kept, which the server's usual aim is worked out from.
export const headshotRows = (period: KillDaySummary[], kept: KillDaySummary[]): HeadshotRow[] => {
  const server = tally(kept);
  const own = tallies(kept);
  const players = new Map<string, KillDaySummary[]>();
  for (const d of period) players.set(d.steamId, [...(players.get(d.steamId) ?? []), d]);
  return [...players]
    .flatMap(([steamId, days]): HeadshotRow[] => {
      const headshots = days.reduce((n, d) => n + d.headshots, 0);
      if (headshots === 0) return [];
      const mine = own.get(steamId) ?? tally([]);
      const weapons = merged(days);
      const odds = headshotOdds(weapons, server, mine);
      const named = new Map<string, number>();
      for (const [cause, w] of Object.entries(weapons)) named.set(weaponName(cause), (named.get(weaponName(cause)) ?? 0) + w.kills);
      const top = [...named].sort(([a, x], [b, y]) => y - x || a.localeCompare(b))[0];
      return [
        {
          steamId,
          name: days.findLast((d) => d.name !== '')?.name ?? steamId,
          kills: days.reduce((n, d) => n + d.kills, 0),
          headshots,
          expected: odds === null ? null : round1(odds.expected),
          chance: odds?.chance ?? null,
          days: days.length,
          flaggedDays: days.filter((d) => flaggedDay(d.kills, headshotOdds(d.weapons, server, mine))).length,
          weapon: top?.[0] ?? null,
        },
      ];
    })
    .sort((a, b) => b.flaggedDays - a.flaggedDays || BY_CHANCE(a, b) || b.headshots - a.headshots || a.name.localeCompare(b.name));
};

// What the staff page shows.

// A kill. `killer` and `victim` have no public id: the page opens their kills instead.
export type AdminKill = {
  at: number;
  map: string;
  killer: AdminPlayer;
  victim: AdminPlayer;
  weapon: string;
  weaponKind: WeaponKind;
  distance: number | null;
  headshot: boolean;
  tags: string[];
  teamKill: boolean;
};

export type AdminHeadshotRow = AdminPlayer & Omit<HeadshotRow, 'steamId' | 'name'> & { inGame: boolean };

// GET /api/admin/kills?days=: the latest kills and the headshots list over the last `days` UTC days.
export type AdminKills = {
  generatedAt: number;
  days: number;
  // The first UTC day of the kill records, or null before the first kill.
  since: string | null;
  flag: typeof HEADSHOT_FLAG;
  // Over the period: every kill, how many were headshots, how many players killed someone, and how many of those had
  // a flagged day.
  totals: { kills: number; headshots: number; players: number; flaggedPlayers: number };
  // Those in game first, as the ones staff can still act on, so the limit never leaves them out.
  players: AdminHeadshotRow[];
  // The server's latest kills, newest first, whatever the period.
  feed: AdminKill[];
};

// One weapon in a player's kills, with what someone with the server's usual aim would get with it. Tags with the same
// name are one weapon.
export type AdminWeaponRow = { name: string; kind: WeaponKind; kills: number; headshots: number; expected: number | null };

export type AdminKillDay = {
  day: string;
  kills: number;
  headshots: number;
  expected: number | null;
  chance: number | null;
  flagged: boolean;
};

// GET /api/admin/kills?days=&player=: one player's kills over the period.
export type AdminPlayerKills = {
  generatedAt: number;
  days: number;
  since: string | null;
  flag: typeof HEADSHOT_FLAG;
  player: AdminPlayer & { inGame: boolean };
  kills: number;
  headshots: number;
  expected: number | null;
  chance: number | null;
  flaggedDays: number;
  // Most kills first.
  weapons: AdminWeaponRow[];
  // Newest first.
  byDay: AdminKillDay[];
  // Their kills, newest first, up to PLAYER_KILLS_LISTED. `kept` is how many the records have in the period: fewer than
  // `kills` when a day had more than DAY_KILLS_KEPT.
  list: Omit<AdminKill, 'killer'>[];
  kept: number;
};

const killOf = (k: DayKill, ref: (steamId: string, name: string) => AdminPlayer): Omit<AdminKill, 'killer'> => ({
  at: k.at,
  map: k.map === '' ? '' : mapName(k.map),
  victim: ref(k.victim, k.victimName),
  weapon: weaponName(k.cause),
  weaponKind: weaponKind(k.cause),
  distance: k.distance === null ? null : round1(k.distance),
  headshot: k.headshot,
  tags: k.tags,
  teamKill: k.teamKill,
});

const plain = (steamId: string, name: string): AdminPlayer => ({ steamId, name: name || steamId });

export type KillSources = {
  now: number;
  days: number;
  since: string | null;
  // The first UTC day of the period.
  from: string;
  // Every day kept (KILL_DAYS_KEPT), oldest first.
  kept: KillDaySummary[];
  inGame: ReadonlySet<string>;
};

export const buildAdminKills = (s: KillSources & { feed: StaffKill[] }): AdminKills => {
  const period = s.kept.filter((d) => d.day >= s.from);
  const rows = headshotRows(period, s.kept).sort((a, b) => Number(s.inGame.has(b.steamId)) - Number(s.inGame.has(a.steamId)));
  const all = tally(period).all;
  return {
    generatedAt: s.now,
    days: s.days,
    since: s.since,
    flag: HEADSHOT_FLAG,
    totals: {
      kills: all.kills,
      headshots: all.headshots,
      players: new Set(period.map((d) => d.steamId)).size,
      flaggedPlayers: rows.filter((r) => r.flaggedDays > 0).length,
    },
    players: rows
      .slice(0, HEADSHOT_ROWS_LISTED)
      .map(({ steamId, name, ...r }) => ({ ...plain(steamId, name), ...r, inGame: s.inGame.has(steamId) })),
    feed: s.feed.toReversed().map((k) => ({ ...killOf(k, plain), killer: plain(k.killer, k.killerName) })),
  };
};

export const buildPlayerKills = (
  s: KillSources & { steamId: string; rows: KillDay[]; name: string | undefined; idOf: IdOf },
): AdminPlayerKills => {
  const rows = s.rows.filter((d) => d.day >= s.from);
  const server = tally(s.kept);
  const own = tally(s.kept.filter((d) => d.steamId === s.steamId));
  const odds = headshotOdds(merged(rows), server, own);
  const id = s.idOf(s.steamId);
  const weapons = new Map<string, AdminWeaponRow>();
  for (const [cause, w] of Object.entries(merged(rows))) {
    const name = weaponName(cause);
    const known = weapons.get(name) ?? { name, kind: weaponKind(cause), kills: 0, headshots: 0, expected: 0 };
    const usual = headshotOdds({ [cause]: w }, server, own);
    weapons.set(name, {
      ...known,
      kills: known.kills + w.kills,
      headshots: known.headshots + w.headshots,
      expected: known.expected === null || usual === null ? null : known.expected + usual.expected,
    });
  }
  const byDay = rows.toReversed().map((d): AdminKillDay => {
    const day = headshotOdds(d.weapons, server, own);
    return {
      day: d.day,
      kills: d.kills,
      headshots: d.headshots,
      expected: day === null ? null : round1(day.expected),
      chance: day?.chance ?? null,
      flagged: flaggedDay(d.kills, day),
    };
  });
  const list = rows.flatMap((d) => d.list);
  return {
    generatedAt: s.now,
    days: s.days,
    since: s.since,
    flag: HEADSHOT_FLAG,
    player: {
      ...plain(s.steamId, rows.findLast((d) => d.name !== '')?.name ?? s.name ?? ''),
      ...(id === undefined ? {} : { id }),
      inGame: s.inGame.has(s.steamId),
    },
    kills: rows.reduce((n, d) => n + d.kills, 0),
    headshots: rows.reduce((n, d) => n + d.headshots, 0),
    expected: odds === null ? null : round1(odds.expected),
    chance: odds?.chance ?? null,
    flaggedDays: byDay.filter((d) => d.flagged).length,
    weapons: [...weapons.values()]
      .map((w) => ({ ...w, expected: w.expected === null ? null : round1(w.expected) }))
      .sort((a, b) => b.kills - a.kills || a.name.localeCompare(b.name)),
    byDay,
    list: list
      .slice(-PLAYER_KILLS_LISTED)
      .toReversed()
      .map((k) => killOf(k, plain)),
    kept: list.length,
  };
};
