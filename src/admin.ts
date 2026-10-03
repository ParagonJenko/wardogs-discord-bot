import { mapName } from './discord.ts';
import { FLAGS, griefRows, type Flag, type GriefDay } from './griefing.ts';
import { isBotBan, type BanBook, type ModAction, type ModEntry } from './moderation.ts';
import { totals, type PlayerDay } from './players.ts';
import type { Ban } from './rcon.ts';
import type { IdOf } from './stats.ts';
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
};

const startOfDay = (at: number): number => Date.parse(`${new Date(at).toISOString().slice(0, 10)}T00:00:00Z`);

// Every Steam ID the page will name, so their public ids can be worked out first.
export const adminSteamIds = (grief: GriefDay[], modLogs: Map<string, ModEntry[]>, serverBans: Ban[] | null, banBook: BanBook): string[] => [
  ...new Set([
    ...grief.flatMap((d) => Object.keys(d.players)),
    ...modLogs.keys(),
    ...(serverBans ?? []).map((b) => b.steamId),
    ...Object.keys(banBook),
  ]),
];

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
  const sum = (key: 'teamKills' | 'vehicleTeamKills' | 'suicides' | 'vehicleSuicides'): number => rows.reduce((n, r) => n + r[key], 0);
  return {
    generatedAt: s.now,
    days: s.days,
    feedSince: s.feedSince,
    flags: FLAGS,
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
  };
};
