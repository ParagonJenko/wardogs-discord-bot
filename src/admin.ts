import { mapName } from './discord.ts';
import { FLAGS, griefRows, type Flag, type GriefDay } from './griefing.ts';
import { isBotBan, type BanBook, type ModAction, type ModEntry } from './moderation.ts';
import { totals, type PlayerDay } from './players.ts';
import type { Ban } from './rcon.ts';
import { DISCORD_ID, type StaffNames } from './staffnames.ts';
import type { IdOf } from './stats.ts';
import { assess, RISK, STEAM_FLAGS, STEAM_MARKS, type SteamCheck, type SteamFlag, type TradeBan } from './steam.ts';
import type { ReservedListing, VipState } from './vip.ts';
import { weaponKind, weaponName, type WeaponKind } from './weapons.ts';

// What the staff page shows: possible griefers from the kill feed, the incidents behind it, what staff did, and the bans
// on the server with their reasons. Only for signed-in staff (see adminauth.ts), so it has Steam IDs.

// The periods the page offers, in UTC days, today included.
export const ADMIN_PERIODS = [1, 7, 30] as const;
export const ADMIN_DEFAULT_DAYS = 7;
const PLAYERS_LISTED = 100;
const INCIDENTS_LISTED = 300;
const MOD_ENTRIES_LISTED = 200;

// A player as the page names them. `id` is their public page's id.
export type AdminPlayer = { steamId: string; name: string; id?: string };

export type AdminGriefRow = AdminPlayer & {
  teamKills: number;
  vehicleTeamKills: number;
  teamKilled: number;
  suicides: number;
  vehicleSuicides: number;
  mostKilledTeammate: (AdminPlayer & { kills: number }) | null;
  flags: Flag[];
  flaggedDays: number;
  // From the scoreboards over the same days, for scale: matches, kills and deaths, and minutes on the server.
  matches: number;
  kills: number;
  deaths: number;
  minutes: number;
  banned: boolean;
};

export type AdminIncident = {
  at: number;
  kind: 'team-kill' | 'vehicle-suicide';
  map: string;
  player: AdminPlayer;
  victim: AdminPlayer | null;
  faction: string | null;
  weapon: string | null;
  weaponKind: WeaponKind | null;
  distance: number | null;
  tags: string[];
};

export type AdminModEntry = {
  at: number;
  action: ModAction;
  player: AdminPlayer;
  // A Discord user ID, "bot", or "server" for a change found on the server's ban list.
  by: string;
  byName?: string;
  reason?: string;
  detail?: string;
};

export type AdminBan = {
  player: AdminPlayer;
  reason: string | null;
  bannedBy: string | null;
  // False for a ban the bot keeps until the player next joins, as the game only bans players who are in game.
  onServer: boolean;
  // When the bot made it: who, when, and when it ends (null for good).
  bot: { by: string; at: number; until: number | null; reason: string } | null;
};

// Everyone on the server's reserved list. `bot` is VIP the bot gave (earned by seeding, or added with /vip add) and
// when it ends; without it, the slot was added by hand.
export type AdminReserved = {
  players: { player: AdminPlayer; bot: { since: number; until: number } | null }[];
  maxSlots: number | null;
};

// A player whose Steam account is worth a look, with what Steam said and when, and their play over the period for scale.
export type AdminSteamRow = AdminPlayer & {
  risk: 'high' | 'medium';
  score: number;
  flags: SteamFlag[];
  vacBans: number;
  gameBans: number;
  lastBanAt: number | null;
  communityBanned: boolean;
  tradeBan: TradeBan;
  public: boolean;
  setUp: boolean;
  createdAt: number | null;
  checkedAt: number;
  inGame: boolean;
  banned: boolean;
  matches: number;
  kills: number;
  deaths: number;
  minutes: number;
  // From the kill feed over the period: their kills, and how many were headshots.
  feedKills: number;
  headshots: number;
};

// Risky Steam accounts among everyone seen in the period or in game now. `players` is how many that is, and `checked`
// how many of them the bot has checked; `high` and `medium` how many are at each risk.
export type AdminSteam = {
  flags: typeof STEAM_FLAGS;
  marks: typeof STEAM_MARKS;
  risk: typeof RISK;
  players: number;
  checked: number;
  high: number;
  medium: number;
  // Riskiest first.
  accounts: AdminSteamRow[];
};

// The Steam checks the staff page needs. `checks` covers everyone seen in the period and everyone `inGame` at the last
// check; `feed` is the kill feed's kills and headshots over the period, for the risky ones.
export type AdminSteamSources = {
  checks: Map<string, SteamCheck | null>;
  inGame: Set<string>;
  feed: Map<string, { kills: number; headshots: number }>;
};

// A staff member, by Discord user ID: the name they go by and their Discord username, when the bot knows them.
export type AdminStaff = Record<string, { name: string; username: string | null }>;

export type AdminOverview = {
  generatedAt: number;
  days: number;
  // The UTC day the bot first had the kill feed, or null if it never has: then there is no griefing data.
  feedSince: string | null;
  flags: typeof FLAGS;
  totals: { teamKills: number; vehicleTeamKills: number; suicides: number; vehicleSuicides: number; flaggedPlayers: number };
  players: AdminGriefRow[];
  // Newest first.
  incidents: AdminIncident[];
  // Newest first.
  moderation: AdminModEntry[];
  // Null when the server's ban list could not be read.
  bans: AdminBan[] | null;
  // Everyone in `moderation` and `bans` by Discord user ID that the bot has a name for.
  staff: AdminStaff;
  // Null when ServerSettings.ini could not be read.
  reserved: AdminReserved | null;
  // Null without STEAM_API_KEY.
  steam: AdminSteam | null;
};

export type AdminSources = {
  now: number;
  days: number;
  feedSince: string | null;
  // The period's griefing records and player records, oldest first.
  grief: GriefDay[];
  playerDays: PlayerDay[];
  // Every player's staff history, by Steam ID.
  modLogs: Map<string, ModEntry[]>;
  // The server's bans, or null when they could not be read.
  serverBans: Ban[] | null;
  banBook: BanBook;
  // The best name the bot has for a Steam ID, if any.
  nameOf: (steamId: string) => string | undefined;
  idOf: IdOf;
  // Staff the bot has seen or looked up, by Discord user ID.
  staffNames: StaffNames;
  // The reserved list in ServerSettings.ini, or null when it could not be read, and the VIP the bot gave.
  reserved: ReservedListing | null;
  vip: VipState;
  // Null without STEAM_API_KEY.
  steam: AdminSteamSources | null;
};

// The staff page lists at most this many risky accounts.
export const STEAM_ACCOUNTS_LISTED = 100;

// Everyone seen in the period or in game now.
export const steamPlayers = (playerDays: PlayerDay[], inGame: Iterable<string>): string[] => [
  ...new Set([...playerDays.flatMap((d) => Object.keys(d)), ...inGame]),
];

// Of `steamIds`, those whose account is worth a look or high risk, riskiest first.
export const riskySteamIds = (steamIds: string[], checks: Map<string, SteamCheck | null>, now: number): string[] =>
  steamIds
    .flatMap((steamId) => {
      const check = checks.get(steamId);
      if (check === undefined || check === null) return [];
      const { score, risk } = assess(check, now);
      return risk === 'low' ? [] : [{ steamId, score }];
    })
    .sort((a, b) => b.score - a.score)
    .map((r) => r.steamId);

const startOfDay = (at: number): number => Date.parse(`${new Date(at).toISOString().slice(0, 10)}T00:00:00Z`);

// Every Steam ID the page will name, so their public ids can be worked out first.
export const adminSteamIds = (
  grief: GriefDay[],
  modLogs: Map<string, ModEntry[]>,
  serverBans: Ban[] | null,
  banBook: BanBook,
  reserved: string[] = [],
): string[] => [
  ...new Set([
    ...grief.flatMap((d) => Object.keys(d.players)),
    ...modLogs.keys(),
    ...(serverBans ?? []).map((b) => b.steamId),
    ...Object.keys(banBook),
    ...reserved,
  ]),
];

// The Discord user IDs the page names: who did each thing in the log, and who made each of the bot's bans.
export const adminStaffIds = (overview: Pick<AdminOverview, 'moderation' | 'bans'>): string[] => [
  ...new Set([...overview.moderation.map((e) => e.by), ...(overview.bans ?? []).flatMap((b) => (b.bot === null ? [] : [b.bot.by]))]),
].filter((id) => DISCORD_ID.test(id));

// Names for those IDs: from the staff directory, or else the name the staff member had in their latest log entry.
export const staffFor = (ids: string[], staffNames: StaffNames, modLogs: Map<string, ModEntry[]>): AdminStaff => {
  const logged = new Map<string, { name: string; at: number }>();
  for (const log of modLogs.values()) {
    for (const e of log) {
      if (e.byName === undefined) continue;
      const seen = logged.get(e.by);
      if (seen === undefined || e.at > seen.at) logged.set(e.by, { name: e.byName, at: e.at });
    }
  }
  return Object.fromEntries(
    ids.flatMap((id) => {
      const known = staffNames[id];
      if (known !== undefined) return [[id, { name: known.name, username: known.username }]];
      const name = logged.get(id)?.name;
      return name === undefined ? [] : [[id, { name, username: null }]];
    }),
  );
};

export const buildAdminOverview = (s: AdminSources): AdminOverview => {
  const ref = (steamId: string, fallback?: string): AdminPlayer => {
    const id = s.idOf(steamId);
    return { steamId, name: s.nameOf(steamId) ?? fallback ?? steamId, ...(id === undefined ? {} : { id }) };
  };
  // The server's list is the truth when it could be read, with the bans waiting for the player to join; otherwise the
  // bot's own records.
  const banned = new Set(
    s.serverBans === null
      ? Object.keys(s.banBook)
      : [...s.serverBans.map((b) => b.steamId), ...Object.entries(s.banBook).flatMap(([steamId, ban]) => (ban.waiting ? [steamId] : []))],
  );
  const context = new Map(totals(s.playerDays).map((t) => [t.steamId, t]));
  const rows = griefRows(s.grief);
  const players = rows.slice(0, PLAYERS_LISTED).map((r): AdminGriefRow => {
    const t = context.get(r.steamId);
    return {
      ...ref(r.steamId, r.name),
      teamKills: r.teamKills,
      vehicleTeamKills: r.vehicleTeamKills,
      teamKilled: r.teamKilled,
      suicides: r.suicides,
      vehicleSuicides: r.vehicleSuicides,
      mostKilledTeammate:
        r.mostKilledTeammate === null ? null : { ...ref(r.mostKilledTeammate.steamId, r.mostKilledTeammate.name), kills: r.mostKilledTeammate.kills },
      flags: r.flags,
      flaggedDays: r.flaggedDays,
      matches: t?.matches ?? 0,
      kills: t?.kills ?? 0,
      deaths: t?.deaths ?? 0,
      minutes: (t?.seedingMinutes ?? 0) + (t?.liveMinutes ?? 0),
      banned: banned.has(r.steamId),
    };
  });
  const incidents = s.grief
    .flatMap((d) => d.incidents)
    .sort((a, b) => b.at - a.at)
    .slice(0, INCIDENTS_LISTED)
    .map(
      (i): AdminIncident => ({
        at: i.at,
        kind: i.kind,
        map: i.map === '' ? '' : mapName(i.map),
        player: ref(i.steamId, i.name),
        victim: i.victimSteamId === undefined ? null : ref(i.victimSteamId, i.victimName),
        faction: i.faction,
        weapon: i.cause === null ? null : weaponName(i.cause),
        weaponKind: i.cause === null ? null : weaponKind(i.cause),
        distance: i.distance === null ? null : Math.round(i.distance * 10) / 10,
        tags: i.tags,
      }),
    );
  const since = startOfDay(s.now - (s.days - 1) * 24 * 60 * 60_000);
  const moderation = [...s.modLogs]
    .flatMap(([steamId, log]) =>
      log
        .filter((e) => e.at >= since && !e.action.startsWith('vip'))
        .map((e): AdminModEntry => {
          const { action, at, by, byName, reason, detail, name } = e;
          return {
            at,
            action,
            player: ref(steamId, name),
            by,
            ...(byName === undefined ? {} : { byName }),
            ...(reason === undefined ? {} : { reason }),
            ...(detail === undefined ? {} : { detail }),
          };
        }),
    )
    .sort((a, b) => b.at - a.at)
    .slice(0, MOD_ENTRIES_LISTED);
  const bans =
    s.serverBans === null
      ? null
      : [
          ...s.serverBans.map((b): AdminBan => {
            const ours = s.banBook[b.steamId];
            const byBot = ours !== undefined && isBotBan(b.reason, ours);
            return {
              player: ref(b.steamId, ours?.name),
              reason: b.reason,
              bannedBy: b.bannedBy,
              onServer: true,
              bot: byBot ? { by: ours.by, at: ours.at, until: ours.until, reason: ours.reason } : null,
            };
          }),
          // Bans waiting for the player to join, which the server does not have yet.
          ...Object.entries(s.banBook)
            .filter(([steamId, ban]) => ban.waiting === true && !s.serverBans?.some((b) => b.steamId === steamId))
            .map(
              ([steamId, ban]): AdminBan => ({
                player: ref(steamId, ban.name),
                reason: ban.reason,
                bannedBy: null,
                onServer: false,
                bot: { by: ban.by, at: ban.at, until: ban.until, reason: ban.reason },
              }),
            ),
        ].sort((a, b) => (b.bot?.at ?? 0) - (a.bot?.at ?? 0) || a.player.name.localeCompare(b.player.name));
  const steam = ((): AdminSteam | null => {
    if (s.steam === null) return null;
    const { checks, inGame, feed } = s.steam;
    const seen = steamPlayers(s.playerDays, inGame);
    const risky = riskySteamIds(seen, checks, s.now);
    const accounts = risky.slice(0, STEAM_ACCOUNTS_LISTED).flatMap((steamId): AdminSteamRow[] => {
      const check = checks.get(steamId);
      if (check === undefined || check === null) return [];
      const { at, found: _found, alerted: _alerted, ...said } = check;
      const { flags, score, risk } = assess(check, s.now);
      const t = context.get(steamId);
      return [
        {
          ...ref(steamId, t?.name),
          risk: risk === 'high' ? 'high' : 'medium',
          score,
          flags,
          ...said,
          checkedAt: at,
          inGame: inGame.has(steamId),
          banned: banned.has(steamId),
          matches: t?.matches ?? 0,
          kills: t?.kills ?? 0,
          deaths: t?.deaths ?? 0,
          minutes: (t?.seedingMinutes ?? 0) + (t?.liveMinutes ?? 0),
          feedKills: feed.get(steamId)?.kills ?? 0,
          headshots: feed.get(steamId)?.headshots ?? 0,
        },
      ];
    });
    const high = risky.filter((steamId) => {
      const check = checks.get(steamId);
      return check !== undefined && check !== null && assess(check, s.now).risk === 'high';
    }).length;
    return {
      flags: STEAM_FLAGS,
      marks: STEAM_MARKS,
      risk: RISK,
      players: seen.length,
      checked: seen.filter((steamId) => (checks.get(steamId) ?? null) !== null).length,
      high,
      medium: risky.length - high,
      accounts,
    };
  })();
  const sum = (key: 'teamKills' | 'vehicleTeamKills' | 'suicides' | 'vehicleSuicides'): number => rows.reduce((n, r) => n + r[key], 0);
  return {
    generatedAt: s.now,
    days: s.days,
    feedSince: s.feedSince,
    flags: FLAGS,
    staff: staffFor(adminStaffIds({ moderation, bans }), s.staffNames, s.modLogs),
    reserved:
      s.reserved === null
        ? null
        : {
            players: s.reserved.ids
              .map((steamId) => {
                const grant = s.vip.granted[steamId];
                return {
                  player: ref(steamId, grant?.name),
                  bot: grant === undefined ? null : { since: grant.grantedAt, until: grant.expiresAt },
                };
              })
              .sort((a, b) => a.player.name.localeCompare(b.player.name)),
            maxSlots: s.reserved.maxSlots,
          },
    totals: {
      teamKills: sum('teamKills'),
      vehicleTeamKills: sum('vehicleTeamKills'),
      suicides: sum('suicides'),
      vehicleSuicides: sum('vehicleSuicides'),
      flaggedPlayers: rows.filter((r) => r.flags.length > 0).length,
    },
    players,
    incidents,
    moderation,
    bans,
    steam,
  };
};
