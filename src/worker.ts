import { connect } from 'cloudflare:sockets';
import { z } from 'zod';
import { DurableObject } from 'cloudflare:workers';
import { withSeedCall } from './alerts.ts';
import { loadConfig } from './config.ts';
import { runCommand, suggestOptions } from './commands.ts';
import { nextMap, parseBoardRef, parseStagedMap, showBoard, type StagedMap } from './board.ts';
import {
  ADMIN_DEFAULT_DAYS,
  ADMIN_PERIODS,
  adminStaffIds,
  adminSteamIds,
  buildAdminOverview,
  riskySteamIds,
  staffFor,
  STEAM_ACCOUNTS_LISTED,
  steamPlayers,
  type AdminOverview,
  type AdminSteamSources,
} from './admin.ts';
import {
  adminAuthConfig,
  ADMIN_PAGE,
  CALLBACK_PATH,
  checkState,
  CLEAR_LOGIN_COOKIE,
  createSession,
  finishLogin,
  notSetUpText,
  siteOriginOf,
  readSession,
  returnAddress,
  startLogin,
} from './adminauth.ts';
import {
  buildGriefAlert,
  buildLiveStatus,
  buildModLogMessage,
  buildRoundupMessage,
  buildSteamAlerts,
  buildVipMessage,
  mapName,
  postWebhook,
} from './discord.ts';
import { griefDayKey, hasGrief, parseGriefDay, recordGrief, type GriefAlert } from './griefing.ts';
import {
  ADMIN_COMMAND_DEFINITIONS,
  checkOptions,
  editOriginalReply,
  failureText,
  handleInteraction,
  isAdminCommand,
  isCommandName,
  isOptionOf,
  type CommandReply,
  type CommandRequest,
  type Choice,
} from './interactions.ts';
import { fetchInviteCounts } from './invite.ts';
import type { Config } from './config.ts';
import type { DiscordMessage, SeederRow } from './discord.ts';
import {
  appendMod,
  BAN_LENGTHS,
  banChanges,
  banReason,
  expiredBans,
  isBotBan,
  modLogKey,
  parseBanBook,
  parseServerBans,
  joinWork,
  parseModLog,
  type BanRecord,
  type ModEntry,
  type ServerBan,
  type ServerBans,
} from './moderation.ts';
import {
  dayOfKey,
  leaderboard,
  matchRecord,
  matchRecordKey,
  parseMatchRecord,
  parsePlayerDay,
  playerDayKey,
  rankSeeders,
  recentDayKeys,
  totals,
  recordActivity,
  recordMatchPlayers,
  recordSeed,
  unrecordMatchPlayers,
  withoutStaffSeeding,
  type MatchRecord,
  type PlayerDay,
  type PlayerTotals,
  type RankedPlayer,
  type SeedCredit,
} from './players.ts';
import type { Lines } from './lines.ts';
import {
  buildLinesPage,
  editLines,
  LINES_KEY,
  linesContext,
  parseSavedLines,
  readLinesAction,
  resolveLines,
  type LinesAction,
  type LinesActionResult,
  type LinesPage,
  type SavedLines,
} from './linespage.ts';
import { createJoinCheck, createPoller, JOIN_CHECK_MS, parseState, type StateStore } from './poller.ts';
import {
  buildProfile,
  directory,
  importIdKey,
  isIdKey,
  newIdKey,
  parseOnline,
  PLAYER_ID,
  publicId,
  type DayRecords,
  type OnlineNow,
  type OnlineSnapshot,
  type PlayerDirectory,
  type PlayerProfile,
} from './profiles.ts';
import {
  addBan,
  fetchBans,
  fetchConfig,
  fetchExperiences,
  fetchLightings,
  fetchMapExperiences,
  fetchMaps,
  fetchPlayers,
  fetchRotation,
  fetchSnapshot,
  fetchStatus,
  fetchZones,
  isNotInGame,
  kickPlayer,
  putConfig,
  RconError,
  removeBan,
  sendBroadcast,
  validateConfig,
  type HttpClient,
  type ServerConfig,
  type Snapshot,
} from './rcon.ts';
import {
  buildRoundup,
  dueRoundups,
  markPosted,
  parseRoundupsPosted,
  periodDays,
  periodFor,
  type FeedSources,
  type Period,
  type Roundup,
  type RoundupChoice,
} from './roundup.ts';
import { socketHttp } from './socket-http.ts';
import {
  alertDue,
  assess,
  checksDue,
  fetchSteamChecks,
  parseSteamCheck,
  RECHECK_MS,
  RISK_LABELS,
  steamFacts,
  steamKey,
  STEAM_RETRY_MS,
  type SteamAlert,
  type SteamCheck,
  type SteamLookup,
} from './steam.ts';
import {
  fetchDiscordUser,
  LOOKUP_FAILURES_KEY,
  lookupsDue,
  noteStaffName,
  parseLookupFailures,
  parseStaffNames,
  STAFF_NAMES_KEY,
  withFailures,
  type StaffNames,
} from './staffnames.ts';
import {
  linkSteam,
  parseStaffProfiles,
  readProfileAction,
  STAFF_PROFILES_KEY,
  staffBySteam,
  staffSteamIds,
  unlinkSteam,
  type ProfileAction,
} from './staffprofiles.ts';
import {
  banKickReason,
  PROFILE_DAYS,
  type BanRequest,
  type BanResult,
  type Named,
  type PlayerRecord,
  type StaffRecords,
  type VipAddResult,
  type VipRemoveResult,
} from './staff.ts';
import {
  DEFAULT_ROTATION,
  editRotations as editRotationBook,
  findRotation,
  hasDefault,
  parseRotationBook,
  planToday,
  putRotation,
  rotationDay,
  rotationEntries,
  rotationSlot,
  rotationToday,
  seedDefault,
  serverEntries,
  type RotationBook,
  type RotationEdit,
  type RotationEditResult,
  type RotationServer,
} from './rotations.ts';
import {
  actionEdit,
  buildCatalog,
  buildRotationsPage,
  readRotationAction,
  type RotationAction,
  type RotationCatalog,
  type RotationsActionResult,
  type RotationsPage,
} from './rotationspage.ts';
import {
  dayOf,
  discordDue,
  namedSteamIds,
  parseStats,
  publicCurrentMatch,
  publicStats,
  recordDiscord,
  recordMatch,
  recordObservation,
  removeRecentMatch,
  type Observation,
  type PublicStats,
  type RecentMatch,
  type SiteStats,
  type Thresholds,
} from './stats.ts';
import { teamBoard } from './teams.ts';
import { matchMap, settleWin, summarise, type MatchState } from './tracking.ts';
import {
  addVip,
  parseVipState,
  removeVip,
  reservedListing,
  seederVip,
  staffSpotsDue,
  syncVip,
  vipDue,
  type ReservedListing,
  type VipState,
} from './vip.ts';
import {
  FEED_PATH,
  feedAuthorized,
  feedKillsSince,
  isKill,
  MAX_FEED_BYTES,
  MIN_FEED_TOKEN,
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
  weaponName,
  type FeedEvent,
  type WeaponDay,
} from './weapons.ts';
import { isCurrent, liveStats, liveSteamIds, parseLiveMatch, recordLive, type LiveSnapshot } from './live.ts';
import {
  adminFeed,
  buildAdminKills,
  buildPlayerKills,
  createKillDays,
  firstKillDay,
  headshotsOn,
  KILL_DAYS_KEPT,
  KILL_DAYS_STORED,
  KILL_FEED_KEY,
  killDaySummaries,
  parseKillFeed,
  playerKillDays,
  pruneKillDays,
  readKillDays,
  recordKillDay,
  recordKillFeed,
  socketSession,
  STAFF_SOCKET_PROTOCOL,
  toStaffKills,
  writeKillDays,
  type AdminKills,
  type AdminPlayerKills,
  type HeadshotDay,
  type KillDaySummary,
  type Sql,
  type StaffKill,
  type StaffLiveMessage,
} from './killfeed.ts';

type Env = {
  WATCHER: DurableObjectNamespace<Watcher>;
  [key: string]: unknown;
};

const stringVars = (env: Env): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );

const SEEDERS_LISTED = 25;
// Recent matches are the last 10, so their records are among the newest few.
const MATCH_RECORDS_SEARCHED = 50;
// Durable Object storage writes at most 128 keys at once.
const RECORDS_PER_WRITE = 128;
const LEADERBOARD_DAYS = 30;
const LEADERBOARD_SIZE = 10;
// The weapons in /api/stats: the top this many over the leaderboard's days.
const WEAPONS_LISTED = 10;
// Kill feed events already counted, remembered so a batch the game sends again is not counted twice.
const KILLS_REMEMBERED = 5_000;
// Live pages open at once, at most. Each is one WebSocket to the Durable Object.
const LIVE_VIEWERS = 500;
// The staff page's live kill feed: its sockets are tagged apart from the live page's, and fewer may be open.
const LIVE_TAG = 'live';
const STAFF_TAG = 'staff';
const STAFF_VIEWERS = 50;
// The Worker hands the Durable Object a signed-in staff page's socket at this address, which nothing outside reaches.
const STAFF_SOCKET_PATH = '/staff-socket';
const DAY_MS = 24 * 60 * 60_000;
// How far back staff can pick players who are not online.
const KNOWN_PLAYER_DAYS = 30;
// Suggestions must reach Discord within 3 seconds.
const SUGGEST_TIMEOUT_MS = 2_000;

// What maps can be played with is read again after this long.
const CATALOG_MS = 10 * 60_000;

// A server that stopped answering this recently is most likely slow, not down, so the live status is left as it was.
const OFFLINE_AFTER_MS = 3 * 60_000;

const withoutId = ({ steamId: _id, ...rest }: RankedPlayer): PlayerTotals => rest;

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// Runs work one at a time, in the order it was asked for. A failure does not hold up what comes after it.
const oneAtATime = () => {
  let queue: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work);
    queue = run.catch(() => undefined);
    return run;
  };
};

// A single Durable Object holds the bot's state, so it survives between cron runs and is never read stale.
// Storage keys: 'state' (alerts and the match in progress), 'stats' (public, for /api/stats), the private player
// records: 'players:<UTC date>' (each player's totals that day) and 'match:<start time>' (each finished match),
// 'vip' (who the bot put on the reserved list, and until when), 'mod:<Steam ID>' (what staff did to that player through
// the bot), 'bans' (the bans the bot made, and when the timed ones end), 'board' (which Discord message is the live
// status), 'nextMap' (the map staff set to play next), 'playerIdKey' (the key for players' public ids), 'online' (who
// was in game at the last check that reached the server), 'seedCall' (when staff last sent /seednow), 'winsSettled'
// (set once the matches saved before settleWin have been put right), 'roundups' (the first day of the last week and
// month whose roundup went out), and from the game's kill feed: 'weapons:<UTC date>' (every kill that day by weapon),
// 'playerWeapons:<Steam ID>' (that player's kills by weapon for each of their last 90 days), 'killFeedSince' (the
// UTC date of the first kill the feed sent), 'live' (the match going on now, for the live page) and 'grief:<UTC date>'
// (team kills and suicides that day, for the staff page), 'serverBans' (the server's ban list at the last check, to
// notice bans made or lifted outside the bot), 'staffNames' (staff's names on Discord, by user ID, for the staff page),
// 'staffLookupsFailed' (when asking Discord about each of those last failed), 'staffProfiles' (the Steam account each
// staff member linked, by Discord user ID, so staff never count as seeders), 'steam:<Steam ID>' (what Steam said about
// that player's account, for risky accounts), 'rotations' (the saved map rotations, the week's plan and the rotation
// put on the server today), 'lines' (the in-game lines staff put in place of the bot's own, by list) and 'killFeed' (the
// server's latest kills, for the staff page). Each player's kills by
// day, for the staff page and the roundups' awards, are in the SQLite database's kill_days table (see killfeed.ts).
export class Watcher extends DurableObject<Env> {
  // Live pages keep their WebSocket open with a ping now and then, answered without waking the object.
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  // Bans, the reserved list and the map rotation all live in the server's settings file. Changes to them run one at a
  // time, so one never overwrites another, or the VIP state or the saved rotations, with what it read before the other
  // finished. Staff Steam accounts change in turn too, as the VIP updates read them.
  private serial = oneAtATime();
  // The alerts and /seednow run one at a time, so a check never sends the seeding alert while a seeding call is going out.
  private alerting = oneAtATime();
  // A roundup is posted by one check at a time, so two checks close together cannot both post it.
  private roundingUp = oneAtATime();
  // Steam checks, their alerts and /player's lookups run one at a time, so two checks close together cannot both post the
  // same account, and an older answer from Steam is never saved over a newer one.
  private steamChecking = oneAtATime();

  // The player records the website's pages read. Past days and finished matches only change through /removematch,
  // which clears them, so they are kept in memory and each read only fetches the last two days and any new matches.
  // The day before is fetched too, as a check that started before midnight may still be writing to it.
  private dayCache = new Map<string, PlayerDay>();
  private matchCache = new Map<string, MatchRecord>();
  // Steam ID → public id.
  private ids = new Map<string, string>();
  private idKey: Promise<CryptoKey> | null = null;
  // Saves reading 'winsSettled' on every check once it is set.
  private winsSettled = false;
  // Kill feed event ids already counted, oldest first.
  private killsSeen = new Set<string>();
  // Past days' weapons, like dayCache: only today's and yesterday's are read each time.
  private weaponDayCache = new Map<string, WeaponDay>();
  // Steam checks once read, by Steam ID; null for a player with none. Every write goes through saveSteam, so it is never
  // stale.
  private steamChecks = new Map<string, SteamCheck | null>();
  // After Steam fails or refuses, the checks wait until then.
  private steamRetryAt = 0;
  // What maps can be played with, for the staff page's rotations; it only changes with a game update.
  private rotationCatalog: { at: number; catalog: RotationCatalog } | null = null;
  // Staff's in-game lines, once read: every check that can send an in-game message needs them. Every write goes through
  // linesAction, so it is never stale.
  private savedLines: SavedLines | null = null;
  // Past days of the staff page's kills, like dayCache: only today's and yesterday's are read each time.
  private killDayCache = new Map<string, KillDaySummary[]>();
  // Whether the kill_days table is known to be there, and the UTC day its old rows were last deleted.
  private killTable = false;
  private killsPrunedOn: string | null = null;

  private rcon(): { config: Config; http: HttpClient } {
    return { config: loadConfig(stringVars(this.env)), http: socketHttp(connect) };
  }

  // ServerSettings.ini, which holds the reserved list and the map rotation.
  private settingsFile({ config, http }: { config: Config; http: HttpClient }) {
    return {
      fetchConfig: () => fetchConfig(config.rconUrl, config.rconPassword, http),
      validate: (text: string) => validateConfig(config.rconUrl, config.rconPassword, text, http),
      put: (serverConfig: ServerConfig) => putConfig(config.rconUrl, config.rconPassword, serverConfig, http),
    };
  }

  // The Steam accounts staff linked (see staffprofiles.ts). Their time counts as playing, never seeding.
  private async staffSteam(): Promise<Set<string>> {
    return staffSteamIds(parseStaffProfiles(await this.ctx.storage.get(STAFF_PROFILES_KEY)));
  }

  // Adds to a player's log, and changes their ban (null lifts it), the VIP state or the bot's copy of the server's ban
  // list (`serverBan`: the ban the bot just put on the server, or null for one it lifted) in the same write. The bot's
  // own bans go on that copy as it makes them, so the next check does not take them for bans made outside the bot.
  // Every entry then goes to the moderation log channel.
  private async record(
    steamId: string,
    entry: ModEntry | null,
    change: { ban?: BanRecord | null; vip?: VipState; serverBan?: ServerBan | null } = {},
  ): Promise<void> {
    const key = modLogKey(steamId);
    const stored = await this.ctx.storage.get([key, 'bans', 'serverBans']);
    const { [steamId]: _old, ...others } = parseBanBook(stored.get('bans'));
    // Before the first check has read the server's list there is no copy to change.
    const serverBans = change.serverBan === undefined ? null : parseServerBans(stored.get('serverBans'));
    const { [steamId]: _was, ...otherServerBans } = serverBans ?? {};
    await this.ctx.storage.put({
      ...(entry === null ? {} : { [key]: appendMod(parseModLog(stored.get(key)), entry) }),
      ...(change.ban === undefined ? {} : { bans: change.ban === null ? others : { ...others, [steamId]: change.ban } }),
      ...(change.vip === undefined ? {} : { vip: change.vip }),
      ...(serverBans === null || change.serverBan === undefined
        ? {}
        : { serverBans: change.serverBan === null ? otherServerBans : { ...otherServerBans, [steamId]: change.serverBan } }),
    });
    if (entry !== null) this.postModLog(steamId, entry);
  }

  // Where the moderation log goes. A configuration problem only stops the posts: what they report is saved already.
  private posting(): Pick<Config, 'modLogWebhookUrl' | 'griefAlerts' | 'steamAlerts' | 'siteUrl'> {
    try {
      return loadConfig(stringVars(this.env));
    } catch (error) {
      console.error(`Moderation log: ${errorText(error)}`);
      return { modLogWebhookUrl: undefined, griefAlerts: false, steamAlerts: false, siteUrl: undefined };
    }
  }

  // Posted in the background, so a slow Discord never holds up a ban or the VIP update queued behind it. A post that
  // fails is logged, not retried: the staff history has the entry either way.
  private postModLog(steamId: string, entry: ModEntry): void {
    const { modLogWebhookUrl, siteUrl } = this.posting();
    if (modLogWebhookUrl === undefined) return;
    this.ctx.waitUntil(
      postWebhook(modLogWebhookUrl, buildModLogMessage(steamId, entry, siteUrl)).catch((error: unknown) =>
        console.error(`Moderation log post failed (${entry.action} ${steamId}): ${errorText(error)}`),
      ),
    );
  }

  // Possible griefing, to the moderation log channel, when GRIEF_ALERTS is on, with the player's Steam account when it is
  // risky. Steam is not asked: the saved check is used, as the bot checks everyone in game. In the background, so a slow
  // read or Discord never holds up the kill feed.
  private postGriefAlerts(alerts: GriefAlert[]): void {
    const { modLogWebhookUrl, griefAlerts, siteUrl } = this.posting();
    for (const alert of alerts) {
      console.info(
        `Possible griefing: ${JSON.stringify(alert.name)} (${alert.steamId}) has ${alert.teamKills} team kills and ` +
          `${alert.vehicleSuicides} vehicle suicides today`,
      );
    }
    if (modLogWebhookUrl === undefined || !griefAlerts) return;
    this.ctx.waitUntil(
      (async () => {
        const steam = await this.savedSteam(alerts.map((a) => a.steamId));
        await Promise.all(
          alerts.map((alert) =>
            postWebhook(modLogWebhookUrl, buildGriefAlert(alert, weaponName, siteUrl, steam.get(alert.steamId) ?? null)).catch((error: unknown) =>
              console.error(`Griefing alert failed (${alert.steamId}): ${errorText(error)}`),
            ),
          ),
        );
      })(),
    );
  }

  private stateStore(): StateStore {
    const storage = this.ctx.storage;
    return {
      // A /seednow call is kept apart from 'state', so a check that saves 'state' never overwrites it.
      load: async () => {
        const stored = await storage.get(['state', 'seedCall']);
        const state = parseState(stored.get('state'));
        const calledAt = stored.get('seedCall');
        return state && typeof calledAt === 'number' ? { ...state, alerts: withSeedCall(state.alerts, calledAt) } : state;
      },
      save: (state) => storage.put('state', state),
    };
  }

  // While the server seeds, an alarm reads who is in game every few seconds between the checks, so the seeding message
  // goes out 30 seconds after someone joins. The check starts them when it finds the server seeding, and they stop
  // themselves once a check finds it is not.
  private async startJoinChecks(config: Config): Promise<void> {
    if (config.seedingMessages === null) return;
    try {
      const storage = this.ctx.storage;
      if (parseState(await storage.get('state'))?.alerts.phase !== 'seeding') return;
      if ((await storage.getAlarm()) === null) await storage.setAlarm(Date.now() + JOIN_CHECK_MS);
    } catch (error) {
      console.error(`Starting join checks failed: ${errorText(error)}`);
    }
  }

  // One quick join check. It runs with the alerts, so it never saves the state while a check is part-way through.
  async alarm(): Promise<void> {
    const { config, http } = this.rcon();
    const joinCheck = createJoinCheck({
      config,
      fetchPlayers: () => fetchPlayers(config.rconUrl, config.rconPassword, http),
      broadcast: (message) => sendBroadcast(config.rconUrl, config.rconPassword, message, http),
      now: Date.now,
      log: console,
      store: this.stateStore(),
      lines: () => this.lines(),
    });
    if (await this.alerting(joinCheck)) await this.ctx.storage.setAlarm(Date.now() + JOIN_CHECK_MS);
  }

  private async updateStats(change: (stats: SiteStats) => SiteStats): Promise<void> {
    const storage = this.ctx.storage;
    await storage.put('stats', change(parseStats(await storage.get('stats'))));
  }

  // One write for the site's stats, who is online and today's player totals.
  private async recordCheck(observation: Observation, minutes: number, thresholds: Pick<Thresholds, 'live' | 'busy'>): Promise<void> {
    const dayKey = playerDayKey(observation.at);
    const stored = await this.ctx.storage.get(['stats', dayKey]);
    const stats = recordObservation(parseStats(stored.get('stats')), observation, minutes, thresholds);
    const online: OnlineSnapshot = { at: observation.at, map: observation.status.map, players: observation.players };
    if (observation.phase === 'empty' || observation.players.length === 0) {
      await this.ctx.storage.put({ stats, online });
      return;
    }
    const kind = observation.seeding ? 'seeding' : 'live';
    const day = recordActivity(parsePlayerDay(stored.get(dayKey)), observation.players, kind, minutes);
    await this.ctx.storage.put({ stats, online, [dayKey]: day });
  }

  private async recordSeed(seeders: SeedCredit[], at: number, minMinutes: number): Promise<void> {
    const dayKey = playerDayKey(at);
    await this.ctx.storage.put(dayKey, recordSeed(parsePlayerDay(await this.ctx.storage.get(dayKey)), seeders, minMinutes));
  }

  // The match, the recent matches list and the players' totals are written together, and only once per match.
  private async recordMatchEnd(match: MatchState, at: number): Promise<void> {
    const key = matchRecordKey(match.startedAt);
    const dayKey = playerDayKey(at);
    const stored = await this.ctx.storage.get([key, 'stats', dayKey]);
    if (stored.has(key)) return;
    await this.ctx.storage.put({
      [key]: matchRecord(match, at),
      stats: recordMatch(parseStats(stored.get('stats')), summarise(match), at),
      [dayKey]: recordMatchPlayers(parsePlayerDay(stored.get(dayKey)), match),
    });
  }

  // Matches saved before the bot settled a win the last check saw one point short (see settleWin) are put right once:
  // their records, for the player pages, and the recent matches. Only storage is awaited, so nothing else runs between
  // the reads and the writes. A failure is tried again on the next check.
  private async settleSavedWins(scoreToWin: number): Promise<void> {
    if (this.winsSettled) return;
    const storage = this.ctx.storage;
    try {
      if ((await storage.get('winsSettled')) !== undefined) {
        this.winsSettled = true;
        return;
      }
      let records = 0;
      let after: string | undefined;
      for (;;) {
        const page = await storage.list({
          prefix: 'match:',
          limit: RECORDS_PER_WRITE,
          ...(after === undefined ? {} : { startAfter: after }),
        });
        const settled = [...page].flatMap(([key, value]) => {
          const record = parseMatchRecord(value);
          if (record === null) return [];
          const factionScores = settleWin(record.factionScores, scoreToWin);
          return factionScores === record.factionScores ? [] : [[key, { ...record, factionScores }] as const];
        });
        if (settled.length > 0) await storage.put(Object.fromEntries(settled));
        records += settled.length;
        after = [...page.keys()].at(-1);
        if (page.size < RECORDS_PER_WRITE) break;
      }
      const stats = parseStats(await storage.get('stats'));
      const matches = stats.matches.map((m) => {
        const factionScores = settleWin(m.factionScores, scoreToWin);
        return factionScores === m.factionScores ? m : { ...m, factionScores };
      });
      const recent = matches.filter((m, i) => m !== stats.matches[i]).length;
      await storage.put({ ...(recent > 0 ? { stats: { ...stats, matches } } : {}), winsSettled: true });
      this.matchCache.clear();
      this.winsSettled = true;
      console.info(`Settled wins saved one point short: ${records} match records, ${recent} recent matches`);
    } catch (error) {
      console.error(`Settling saved wins failed: ${errorText(error)}`);
    }
  }

  async check(): Promise<void> {
    // The cron fires every minute whatever POLL_INTERVAL_SECONDS says, and seeding minutes are counted per check.
    const config = { ...loadConfig(stringVars(this.env)), pollIntervalMs: 60_000 };
    await this.settleSavedWins(config.scoreToWin);
    const storage = this.ctx.storage;
    const minutesPerCheck = config.pollIntervalMs / 60_000;
    // What this check read from the server, for the live status.
    const seen: { snapshot: Snapshot | null } = { snapshot: null };
    const poll = createPoller({
      config,
      fetchSnapshot: async () => (seen.snapshot = await fetchSnapshot(config.rconUrl, config.rconPassword, socketHttp(connect))),
      send: (message) => postWebhook(config.webhookUrl, message),
      broadcast: (message) => sendBroadcast(config.rconUrl, config.rconPassword, message, socketHttp(connect)),
      now: Date.now,
      log: console,
      store: this.stateStore(),
      lines: () => this.lines(),
      staff: () => this.staffSteam(),
      stats: {
        check: (observation) =>
          this.recordCheck(observation, minutesPerCheck, { live: config.rules.live, busy: config.busyThreshold }),
        seeded: (seeders, at) => this.recordSeed(seeders, at, config.seedMinutes),
        matchEnded: (match, at) => this.recordMatchEnd(match, at),
      },
    });
    await this.alerting(poll);
    await this.startJoinChecks(config);
    await this.updateBoard(config, seen.snapshot);
    await this.serial(() => this.expireBans(config));
    await this.serial(() => this.applyWaitingBans(config, seen.snapshot));
    await this.serial(() => this.watchBans(config, seen.snapshot));
    await this.serial(() => this.updateVip(config));
    await this.serial(() => this.updateRotation(config, seen.snapshot));
    await this.steamChecking(() => this.checkSteam(seen.snapshot));

    const { inviteCode } = config;
    if (inviteCode && discordDue(parseStats(await storage.get('stats')), Date.now())) {
      try {
        const counts = await fetchInviteCounts(inviteCode, Date.now());
        await this.updateStats((stats) => recordDiscord(stats, counts));
      } catch (error) {
        console.error(`Discord member count failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await this.roundingUp(() => this.postRoundups(config));
    // Live pages get the new score, players and map.
    await this.broadcastLive();
  }

  // The roundup of the week or month just ended, once, from ROUNDUP_HOUR (UTC) on the first day of the next one. A post
  // that fails is tried again at the next check, until the end of that day.
  private async postRoundups(config: Config): Promise<void> {
    const rule = config.roundups;
    const now = Date.now();
    // Outside the hours a roundup can be due, storage is not read at all.
    if (rule === null || dueRoundups({}, now, rule.hour).length === 0) return;
    const storage = this.ctx.storage;
    try {
      let posted = parseRoundupsPosted(await storage.get('roundups'));
      for (const period of dueRoundups(posted, now, rule.hour)) {
        const label = `${period.kind === 'week' ? 'weekly' : 'monthly'} roundup from ${dayOf(period.start)}`;
        try {
          const roundup = await this.roundupFor(period, now);
          if (roundup !== null) await postWebhook(rule.webhookUrl, buildRoundupMessage(roundup, config.siteUrl));
          posted = markPosted(posted, period);
          await storage.put('roundups', posted);
          console.info(roundup === null ? `No ${label}: nobody played` : `Posted the ${label}`);
        } catch (error) {
          console.error(`The ${label} failed, trying again next check: ${errorText(error)}`);
        }
      }
    } catch (error) {
      console.error(`Roundups failed: ${errorText(error)}`);
    }
  }

  // From the same records as the player pages, and the kill feed's for the awards. Null when nobody played in the
  // period.
  private async roundupFor(period: Period, now: number): Promise<Roundup | null> {
    const covered = periodDays(period);
    const [days, matches] = await Promise.all([this.recentDays(now), this.matchRecords(now)]);
    const feed = this.roundupFeed(covered);
    const ids = await this.idsFor([
      ...days.flatMap((d) => (covered.includes(d.day) ? Object.keys(d.players) : [])),
      ...(feed?.kills.map((d) => d.steamId) ?? []),
    ]);
    return buildRoundup({ period, days, matches, idOf: (steamId) => ids.get(steamId), ...(feed === null ? {} : { feed }) });
  }

  // The kill feed's records over a period's days. Null before the first kill, or if the database cannot be read, so
  // the roundup goes out without its awards.
  private roundupFeed(covered: string[]): FeedSources | null {
    try {
      const sql = this.killSql();
      const since = firstKillDay(sql);
      if (since === null) return null;
      return { since, kills: killDaySummaries(sql, covered[0] ?? '', covered[covered.length - 1] ?? '') };
    } catch (error) {
      console.error(`Roundup awards failed: ${errorText(error)}`);
      return null;
    }
  }

  // For /roundup.
  async roundup(choice: RoundupChoice): Promise<Roundup | null> {
    const now = Date.now();
    return this.roundupFor(periodFor(choice, now), now);
  }

  // Brings the live status message up to date, after the check has saved the match and stats it shows. A failure
  // is logged and tried again next check; it never stops the bans and VIP updates after it.
  private async updateBoard(config: Config, snapshot: Snapshot | null): Promise<void> {
    const webhookUrl = config.statusWebhookUrl;
    if (webhookUrl === undefined) return;
    const storage = this.ctx.storage;
    const now = Date.now();
    try {
      const stored = await storage.get(['board', 'state', 'stats', 'nextMap']);
      const server = parseStats(stored.get('stats')).server;
      if (snapshot === null && server !== null && now - server.seenAt < OFFLINE_AFTER_MS) return;
      const match = parseState(stored.get('state'))?.match ?? null;
      const next =
        snapshot === null
          ? null
          : nextMap(
              snapshot.status.map,
              parseStagedMap(stored.get('nextMap')),
              // Without the rotation, the live status just leaves the next map out.
              await fetchRotation(config.rconUrl, config.rconPassword, socketHttp(connect)).catch(() => null),
              now,
            );
      const message = buildLiveStatus(
        { snapshot, lastSeen: server === null ? null : { name: server.name, at: server.seenAt }, match, nextMap: next, now },
        config.rules,
        config.siteUrl,
      );
      const ref = parseBoardRef(stored.get('board'));
      const shown = await showBoard(webhookUrl, message, ref);
      if (shown.messageId !== ref?.messageId) {
        await storage.put('board', shown);
        console.info(`Posted the live status (message ${shown.messageId})`);
      }
    } catch (error) {
      console.error(`Live status update failed: ${errorText(error)}`);
    }
  }

  // As each day starts, puts that day's planned rotation on the server, and tries again each check until the server has
  // it. Waits while the server is not answering. A failure is logged; it never stops what comes after it.
  private async updateRotation(config: Config, snapshot: Snapshot | null): Promise<void> {
    if (snapshot === null) return;
    const now = Date.now();
    const today = rotationDay(now, config.rotationHour);
    try {
      const saved = await this.ensureDefault(config);
      const book = planToday(saved, today, now);
      if (book !== saved) await this.ctx.storage.put('rotations', book);
      if (rotationToday(book, today)?.pending) await this.sendRotation(book, config);
    } catch (error) {
      console.error(`Map rotation update failed: ${errorText(error)}`);
    }
  }

  // Puts the rotation `applied` names on the server, and notes when the server has it. One that is no longer saved, or
  // has no maps, is dropped: the server keeps the maps it has.
  private async sendRotation(book: RotationBook, config: Config): Promise<{ book: RotationBook; server: RotationServer | null }> {
    const { applied } = book;
    if (applied === null) return { book, server: null };
    const rotation = findRotation(book, applied.name);
    const done = { ...book, applied: { ...applied, pending: false } };
    if (rotation === null || rotation.entries.length === 0) {
      await this.ctx.storage.put('rotations', done);
      return { book: done, server: null };
    }
    const who = applied.by === 'schedule' ? 'the schedule' : `Discord user ${applied.by}`;
    try {
      const { rconUrl, rconPassword } = config;
      const http = socketHttp(connect);
      const changed = await putRotation(
        {
          ...this.settingsFile({ config, http }),
          slot: async () =>
            rotationSlot(await fetchRotation(rconUrl, rconPassword, http), await fetchStatus(rconUrl, rconPassword, http)),
        },
        rotation.entries,
      );
      await this.ctx.storage.put('rotations', done);
      console.info(
        changed
          ? `Map rotation: put ${JSON.stringify(rotation.name)} (${rotation.entries.length} maps) on the server for ${applied.day}, chosen by ${who}, starting with ${rotation.entries[0]?.map} at the next map change`
          : `Map rotation: the server already has ${JSON.stringify(rotation.name)}`,
      );
      return { book: done, server: { outcome: changed ? 'updated' : 'unchanged' } };
    } catch (error) {
      console.error(`Map rotation: couldn't put ${JSON.stringify(rotation.name)} on the server, trying again next check: ${errorText(error)}`);
      return { book, server: { outcome: 'failed', reason: errorText(error) } };
    }
  }

  // The saved rotations, starting Default as the server's rotation the first time (see seedDefault). Run in `serial`.
  private async ensureDefault(config: Config): Promise<RotationBook> {
    const saved = parseRotationBook(await this.ctx.storage.get('rotations'));
    if (hasDefault(saved)) return saved;
    // A Default staff made before, with maps, only needs its name put right.
    const named = seedDefault(saved, []);
    if (hasDefault(named)) {
      await this.ctx.storage.put('rotations', named);
      return named;
    }
    const http = socketHttp(connect);
    // The settings file as it is, or what the server reports when the file has no rotation of its own.
    const inFile = serverEntries((await fetchConfig(config.rconUrl, config.rconPassword, http)).text);
    const entries = inFile.length > 0 ? inFile : rotationEntries(await fetchRotation(config.rconUrl, config.rconPassword, http));
    const book = seedDefault(named, entries);
    if (book === saved) return saved;
    await this.ctx.storage.put('rotations', book);
    console.info(`Map rotation: saved the server's rotation as ${DEFAULT_ROTATION} (${entries.length} maps)`);
    return book;
  }

  // The saved rotations, for /rotations.
  async rotationBook(): Promise<RotationBook> {
    return parseRotationBook(await this.ctx.storage.get('rotations'));
  }

  // What maps can be played with, read from the server at most every CATALOG_MS.
  private async catalog(config: Config): Promise<RotationCatalog | null> {
    const now = Date.now();
    if (this.rotationCatalog !== null && now - this.rotationCatalog.at < CATALOG_MS) return this.rotationCatalog.catalog;
    const http = socketHttp(connect);
    const { rconUrl, rconPassword } = config;
    const optional = <T>(work: Promise<T>): Promise<T | null> => work.catch(() => null);
    const [maps, experiences, lightings] = await Promise.all([
      fetchMaps(rconUrl, rconPassword, http),
      optional(fetchExperiences(rconUrl, rconPassword, http)),
      optional(fetchLightings(rconUrl, rconPassword, http)),
    ]);
    const perMap = new Map(
      await Promise.all(
        maps.map(async (map) => {
          const [own, zones] = await Promise.all([
            optional(fetchMapExperiences(rconUrl, rconPassword, map.id, http)),
            optional(fetchZones(rconUrl, rconPassword, map.id, http)),
          ]);
          return [map.id, { experiences: own, zones }] as const;
        }),
      ),
    );
    const catalog = buildCatalog({ maps, experiences, lightings, perMap });
    // Only a full answer is kept, so a slow server is asked again next time.
    if (experiences !== null && lightings !== null && [...perMap.values()].every((m) => m.experiences !== null && m.zones !== null)) {
      this.rotationCatalog = { at: now, catalog };
    }
    return catalog;
  }

  // The staff page's Rotations tab. Without the server, the saved rotations and the week still show.
  async rotationsPage(): Promise<RotationsPage> {
    const config = loadConfig(stringVars(this.env));
    const book = await this.serial(() => this.ensureDefault(config)).catch(async (error: unknown) => {
      console.error(`Map rotation: Default could not be set up: ${errorText(error)}`);
      return parseRotationBook(await this.ctx.storage.get('rotations'));
    });
    const [server, catalog] = await Promise.all([
      fetchRotation(config.rconUrl, config.rconPassword, socketHttp(connect)).catch(() => null),
      this.catalog(config).catch((error: unknown) => {
        console.error(`Staff page: the maps could not be read: ${errorText(error)}`);
        return null;
      }),
    ]);
    return buildRotationsPage({ book, today: rotationDay(Date.now(), config.rotationHour), hour: config.rotationHour, server, catalog });
  }

  // A change from the staff page's Rotations tab, and the tab as it is after it.
  async rotationsAction(action: RotationAction, by: string, byName: string): Promise<RotationsActionResult> {
    const result = await this.editRotations(actionEdit(action), by, byName);
    if ('problem' in result) return { problem: result.problem };
    return { ...(await this.rotationsPage()), ...(result.server === undefined ? {} : { outcome: result.server }) };
  }

  // Changes the saved rotations as staff asked, and when that changes what should be on the server today, puts it there.
  async editRotations(edit: RotationEdit, by: string, byName?: string): Promise<RotationEditResult> {
    return this.serial(async () => {
      const config = loadConfig(stringVars(this.env));
      const now = Date.now();
      const saved = parseRotationBook(await this.ctx.storage.get('rotations'));
      const named = byName === undefined ? {} : { byName };
      const edited = editRotationBook(saved, edit, { today: rotationDay(now, config.rotationHour), now, by, ...named });
      if ('problem' in edited) return edited;
      await this.ctx.storage.put('rotations', edited.book);
      // Only when this edit chose it, so a reply never reports on a rotation staff did not touch.
      if (edited.book.applied === saved.applied || !edited.book.applied?.pending) return edited;
      const { book, server } = await this.sendRotation(edited.book, config);
      return { ...edited, book, ...(server === null ? {} : { server }) };
    });
  }

  private async lineBook(): Promise<SavedLines> {
    this.savedLines ??= parseSavedLines(await this.ctx.storage.get(LINES_KEY));
    return this.savedLines;
  }

  // The lines the bot says in game: staff's, or its own (see linespage.ts).
  async lines(): Promise<Lines> {
    return resolveLines(await this.lineBook());
  }

  // The staff page's Lines tab.
  async linesPage(): Promise<LinesPage> {
    return buildLinesPage(await this.lineBook(), linesContext(loadConfig(stringVars(this.env))));
  }

  // A change from the Lines tab, and the tab as it is after it. The copy in memory changes before the write, so a second
  // change that comes in while this one is being written starts from it.
  async linesAction(action: LinesAction, by: string, byName: string): Promise<LinesActionResult> {
    const context = linesContext(loadConfig(stringVars(this.env)));
    const edited = editLines(await this.lineBook(), action, context, { by, byName, now: Date.now() });
    if ('problem' in edited) return edited;
    this.savedLines = edited.saved;
    try {
      await this.ctx.storage.put(LINES_KEY, edited.saved);
    } catch (error) {
      this.savedLines = null;
      throw error;
    }
    return buildLinesPage(edited.saved, context);
  }

  // Lifts timed bans whose time is up, if the ban on the server is still the bot's. One that fails is tried again at
  // the next check.
  private async expireBans(config: Config): Promise<void> {
    const now = Date.now();
    const book = parseBanBook(await this.ctx.storage.get('bans'));
    const due = expiredBans(book, now);
    if (due.length === 0) return;
    const http = socketHttp(connect);
    try {
      const onServer = await fetchBans(config.rconUrl, config.rconPassword, http);
      for (const steamId of due) {
        const ban = book[steamId];
        if (ban === undefined) continue;
        const current = onServer.find((b) => b.steamId === steamId);
        const label = `${JSON.stringify(ban.name)} (${steamId})`;
        if (current === undefined || !isBotBan(current.reason, ban)) {
          // Lifted already, or lifted and banned again some other way: that ban is not the bot's to lift. A ban still
          // waiting for the player to join was never on the server.
          await this.record(steamId, null, { ban: null });
          const why = current !== undefined ? 'has a newer ban, left alone' : ban.waiting ? 'ran out before they joined' : 'was already unbanned';
          console.info(`Ban ended: ${label} ${why}`);
          continue;
        }
        await removeBan(config.rconUrl, config.rconPassword, steamId, http);
        await this.record(
          steamId,
          { action: 'unban', at: now, by: 'bot', name: ban.name, reason: 'The ban ran out' },
          { ban: null, serverBan: null },
        );
        console.info(`Ban ended: ${label}`);
      }
    } catch (error) {
      console.error(`Lifting ended bans failed: ${errorText(error)}`);
    }
  }

  // Bans staff made while the player was not in game, which the game refuses: they go on the server, with a kick, at
  // the first check that sees the player. A ban or kick that fails is tried again at the next check, and a kick until
  // the player has gone.
  private async applyWaitingBans(config: Config, snapshot: Snapshot | null): Promise<void> {
    if (snapshot === null) return;
    try {
      const book = parseBanBook(await this.ctx.storage.get('bans'));
      const work = joinWork(book, snapshot.players.map((p) => p.steamId), Date.now());
      const http = socketHttp(connect);
      const label = (steamId: string): string => `${JSON.stringify(book[steamId]?.name ?? '')} (${steamId})`;
      // Saves the ban as on the server, with a kick still owed or not. `banned` is set when it has just gone on the server.
      const applied = async (steamId: string, kicking: boolean, banned = false): Promise<void> => {
        const old = book[steamId];
        if (old === undefined) return;
        const { waiting: _waiting, kicking: _kicking, ...ban } = old;
        book[steamId] = kicking ? { ...ban, kicking } : ban;
        await this.record(steamId, null, { ban: book[steamId], ...(banned ? { serverBan: { reason: ban.serverReason, bannedBy: null } } : {}) });
      };
      for (const steamId of work.gone) await applied(steamId, false);
      const kick = [...work.kick];
      for (const steamId of work.ban) {
        const ban = book[steamId];
        if (ban === undefined) continue;
        try {
          await addBan(config.rconUrl, config.rconPassword, steamId, ban.serverReason, http);
        } catch (error) {
          // Left again before the ban went in: it waits for the next time they join.
          if (!isNotInGame(error)) console.error(`Waiting ban on ${label(steamId)} failed: ${errorText(error)}`);
          continue;
        }
        await applied(steamId, true, true);
        console.info(`Ban put on the server as they joined: ${label(steamId)}`);
        kick.push(steamId);
      }
      for (const steamId of kick) {
        const ban = book[steamId];
        if (ban === undefined) continue;
        try {
          await kickPlayer(config.rconUrl, config.rconPassword, steamId, banKickReason(ban.reason, config.siteUrl), http);
        } catch (error) {
          // Not in game any more is as good as kicked: the ban keeps them out.
          if (!isNotInGame(error)) {
            console.error(`Kick after the waiting ban on ${label(steamId)} failed, trying again next check: ${errorText(error)}`);
            continue;
          }
        }
        await applied(steamId, false);
      }
    } catch (error) {
      console.error(`Waiting bans failed: ${errorText(error)}`);
    }
  }

  // Bans made or lifted outside the bot (in game, in ServerSettings.ini, or by another tool) go in the player's staff
  // history and to the moderation log. The first reading is only saved, so a deploy does not post every ban there is.
  // It runs one at a time with the bot's own ban changes, which keep the saved list up to date as they make them. Skipped
  // while the server is not answering; a failure is tried again at the next check.
  private async watchBans(config: Config, snapshot: Snapshot | null): Promise<void> {
    if (snapshot === null) return;
    const storage = this.ctx.storage;
    try {
      const onServer = await fetchBans(config.rconUrl, config.rconPassword, socketHttp(connect));
      const stored = await storage.get(['serverBans', 'bans']);
      const saved = parseServerBans(stored.get('serverBans'));
      const current: ServerBans = Object.fromEntries(onServer.map(({ steamId, reason, bannedBy }) => [steamId, { reason, bannedBy }]));
      if (saved === null) {
        await storage.put('serverBans', current);
        console.info(`Watching the server's ban list: ${onServer.length} bans`);
        return;
      }
      const { added, lifted } = banChanges(saved, onServer);
      if (added.length === 0 && lifted.length === 0) return;
      const book = parseBanBook(stored.get('bans'));
      const names = await this.namesFor([...added, ...lifted].map((b) => b.steamId), snapshot);
      const now = Date.now();
      const by = (ban: ServerBan) => (ban.bannedBy ? { detail: `By ${ban.bannedBy}` } : {});
      for (const { steamId, ban } of added) {
        // One of the bot's own that the saved list missed, such as a ban that timed out but went through.
        const ours = book[steamId];
        if (ours !== undefined && isBotBan(ban.reason, ours)) continue;
        const name = names.get(steamId) ?? steamId;
        await this.record(steamId, { action: 'ban', at: now, by: 'server', name, ...(ban.reason ? { reason: ban.reason } : {}), ...by(ban) });
        console.info(`Ban made outside the bot: ${JSON.stringify(name)} (${steamId}): ${JSON.stringify(ban.reason ?? '')}`);
      }
      for (const { steamId, ban } of lifted) {
        const name = names.get(steamId) ?? steamId;
        // One of the bot's own bans, lifted some other way: the bot forgets it too, so it no longer counts as banned.
        const ours = book[steamId];
        const theirs = ours !== undefined && isBotBan(ban.reason, ours);
        await this.record(
          steamId,
          { action: 'unban', at: now, by: 'server', name, ...(ban.reason ? { reason: `Was banned for: ${ban.reason}` } : {}) },
          theirs ? { ban: null } : {},
        );
        console.info(`Ban lifted outside the bot: ${JSON.stringify(name)} (${steamId})`);
      }
      await storage.put('serverBans', current);
    } catch (error) {
      console.error(`Watching the ban list failed: ${errorText(error)}`);
    }
  }

  // The best name the bot has for each Steam ID: in game now, then the newest of the last 90 days' records, its bans and
  // staff history.
  private async namesFor(steamIds: string[], snapshot: Snapshot | null): Promise<Map<string, string>> {
    const wanted = new Set(steamIds);
    const names = new Map<string, string>();
    const stored = await this.ctx.storage.get(['bans', ...steamIds.map(modLogKey)]);
    for (const steamId of wanted) {
      const logged = parseModLog(stored.get(modLogKey(steamId))).findLast((e) => e.name !== undefined && e.name !== steamId)?.name;
      if (logged !== undefined) names.set(steamId, logged);
    }
    for (const [steamId, ban] of Object.entries(parseBanBook(stored.get('bans')))) if (wanted.has(steamId)) names.set(steamId, ban.name);
    for (const day of await this.recentDays(Date.now())) {
      for (const [steamId, t] of Object.entries(day.players)) if (wanted.has(steamId)) names.set(steamId, t.name);
    }
    for (const p of snapshot?.players ?? []) if (wanted.has(p.steamId)) names.set(p.steamId, p.name);
    return names;
  }

  // STEAM_API_KEY, the key for the Steam Web API, or null when it is not set: then nobody is checked.
  private steamApiKey(): string | null {
    return stringVars(this.env)['STEAM_API_KEY']?.trim() || null;
  }

  // The Steam checks for these players, read from storage once and then kept in memory.
  private async loadSteam(steamIds: string[]): Promise<Map<string, SteamCheck | null>> {
    const missing = [...new Set(steamIds)].filter((steamId) => !this.steamChecks.has(steamId));
    // Reads take as many keys at once as writes.
    for (let i = 0; i < missing.length; i += RECORDS_PER_WRITE) {
      const part = missing.slice(i, i + RECORDS_PER_WRITE);
      const stored = await this.ctx.storage.get(part.map(steamKey));
      // One saved while this was being read is newer.
      for (const steamId of part) if (!this.steamChecks.has(steamId)) this.steamChecks.set(steamId, parseSteamCheck(stored.get(steamKey(steamId))));
    }
    return this.steamChecks;
  }

  // The saved Steam checks for these players, for a post: none without STEAM_API_KEY, or when storage cannot be read, so
  // the post still goes out.
  private async savedSteam(steamIds: string[]): Promise<Map<string, SteamCheck | null>> {
    if (this.steamApiKey() === null) return new Map();
    try {
      return await this.loadSteam(steamIds);
    } catch (error) {
      console.error(`Reading Steam checks failed: ${errorText(error)}`);
      return new Map();
    }
  }

  // Keeps the highest score posted so far, so a check saved from an earlier reading never makes an alert go out again,
  // and never saves a check over a newer one.
  private async saveSteam(checks: [string, SteamCheck][]): Promise<void> {
    for (let i = 0; i < checks.length; i += RECORDS_PER_WRITE) {
      const part = checks.slice(i, i + RECORDS_PER_WRITE).map(([steamId, check]): [string, SteamCheck] => {
        const saved = this.steamChecks.get(steamId) ?? null;
        const latest = saved !== null && saved.at > check.at ? saved : check;
        const alerted = Math.max(check.alerted ?? 0, saved?.alerted ?? 0);
        return [steamId, alerted > 0 ? { ...latest, alerted } : latest];
      });
      await this.ctx.storage.put(Object.fromEntries(part.map(([steamId, check]) => [steamKey(steamId), check])));
      for (const [steamId, check] of part) this.steamChecks.set(steamId, check);
    }
  }

  // Asks Steam about the players in game it has not checked, or not for a day, up to 100 at a check, and posts those with
  // an account at the alert mark (RISK.alert) to the moderation log channel: once, and again only if it gets riskier.
  // High-risk accounts below it are only logged, listed on the staff page and shown on griefing posts. After Steam fails
  // or refuses, it waits STEAM_RETRY_MS before asking again. A failure never stops the rest of the check.
  private async checkSteam(snapshot: Snapshot | null): Promise<void> {
    const apiKey = this.steamApiKey();
    if (apiKey === null || snapshot === null || snapshot.players.length === 0) return;
    const now = Date.now();
    try {
      const names = new Map(snapshot.players.map((p) => [p.steamId, p.name]));
      const inGame = [...names.keys()];
      const known = await this.loadSteam(inGame);
      const due = now >= this.steamRetryAt ? checksDue(inGame, known, now) : [];
      const changed = new Map<string, SteamCheck>();
      if (due.length > 0) {
        try {
          for (const [steamId, check] of await fetchSteamChecks(apiKey, due, now)) {
            // The score last posted is kept, so a check that finds nothing new posts nothing.
            const alerted = known.get(steamId)?.alerted;
            changed.set(steamId, alerted === undefined ? check : { ...check, alerted });
          }
        } catch (error) {
          this.steamRetryAt = now + STEAM_RETRY_MS;
          console.error(`Steam checks failed, trying again in ${STEAM_RETRY_MS / 60_000} minutes: ${errorText(error)}`);
        }
      }
      const checked = [...changed];
      const { modLogWebhookUrl, steamAlerts, siteUrl } = this.posting();
      const alerts =
        modLogWebhookUrl === undefined || !steamAlerts
          ? []
          : inGame.flatMap((steamId): SteamAlert[] => {
              const check = changed.get(steamId) ?? known.get(steamId) ?? null;
              if (check === null || !alertDue(check, now)) return [];
              return [{ steamId, name: names.get(steamId) || steamId, check: { ...check, alerted: assess(check, now).score } }];
            });
      // Marked as posted in the same write, before posting: a post that fails is logged, not retried.
      for (const alert of alerts) changed.set(alert.steamId, alert.check);
      if (changed.size === 0) return;
      await this.saveSteam([...changed]);
      for (const [steamId, check] of checked) {
        const { risk, score } = assess(check, now);
        if (risk === 'low') continue;
        console.info(
          `Risky Steam account: ${JSON.stringify(names.get(steamId) ?? '')} (${steamId}): ${RISK_LABELS[risk]}, ${score} points: ` +
            steamFacts(check, now).join(', '),
        );
      }
      if (checked.length > 0) console.info(`Steam checks: ${checked.length} players`);
      if (modLogWebhookUrl === undefined || alerts.length === 0) return;
      const messages = buildSteamAlerts(alerts, now, siteUrl);
      // In order, in the background, so a slow Discord never holds up the check.
      this.ctx.waitUntil(
        (async () => {
          for (const message of messages) {
            await postWebhook(modLogWebhookUrl, message).catch((error: unknown) => console.error(`Risky Steam account alert failed: ${errorText(error)}`));
          }
        })(),
      );
    } catch (error) {
      console.error(`Steam checks failed: ${errorText(error)}`);
    }
  }

  // A player's Steam check for /player: the saved one, or one made now when there is none or it is a day old. Staff
  // asked, so it does not wait out a failure, and it is not posted to the moderation log.
  async steamLookup(steamId: string): Promise<SteamLookup> {
    const apiKey = this.steamApiKey();
    if (apiKey === null) return 'off';
    return this.steamChecking(async (): Promise<SteamLookup> => {
      const now = Date.now();
      const saved = (await this.loadSteam([steamId])).get(steamId) ?? null;
      if (saved !== null && now - saved.at < RECHECK_MS) return saved;
      try {
        const check = (await fetchSteamChecks(apiKey, [steamId], now)).get(steamId);
        if (check === undefined) return saved ?? 'failed';
        await this.saveSteam([[steamId, check]]);
        return this.steamChecks.get(steamId) ?? check;
      } catch (error) {
        console.error(`Steam check for /player failed (${steamId}): ${errorText(error)}`);
        return saved ?? 'failed';
      }
    });
  }

  // The staff page's Steam checks: everyone seen in the period or in game now, and the kill feed's kills and headshots
  // over the period for the risky ones. Null without STEAM_API_KEY.
  private async steamSources(playerDays: PlayerDay[], online: OnlineSnapshot | null, now: number, days: number): Promise<AdminSteamSources | null> {
    if (this.steamApiKey() === null) return null;
    const inGame = new Set(online?.players.map((p) => p.steamId) ?? []);
    const seen = steamPlayers(playerDays, inGame);
    const checks = await this.loadSteam(seen);
    const risky = riskySteamIds(seen, checks, now, inGame).slice(0, STEAM_ACCOUNTS_LISTED);
    const stored = risky.length === 0 ? new Map<string, unknown>() : await this.ctx.storage.get(risky.map(playerWeaponsKey));
    const oldest = dayOf(now - (days - 1) * DAY_MS);
    const feed = new Map(risky.map((steamId) => [steamId, feedKillsSince(parsePlayerWeapons(stored.get(playerWeaponsKey(steamId))), oldest)]));
    return { checks, inGame, feed };
  }

  // Every 10 minutes: gives VIP to players who have earned it, and takes it back when their time is up, and keeps a
  // staff spot on the reserved list for each staff member who linked their Steam account. A staff member who linked
  // or unlinked since the last update is seen to at the next check. VIP staff gave ends on time even when automatic
  // VIP is off.
  private async updateVip(config: Config): Promise<void> {
    const rule = config.vip;
    const storage = this.ctx.storage;
    const now = Date.now();
    const keys = rule === null ? [] : recentDayKeys(now, rule.windowDays);
    const stored = await storage.get(['vip', STAFF_PROFILES_KEY]);
    const state = parseVipState(stored.get('vip'));
    const staff = staffBySteam(parseStaffProfiles(stored.get(STAFF_PROFILES_KEY)));
    const idle = Object.keys(state.granted).length === 0 && staff.size === 0 && Object.keys(state.staffSpots).length === 0;
    if (rule === null && idle) return;
    if (!vipDue(state, now) && !staffSpotsDue(state, staff.keys())) return;
    const days = await storage.get(keys);
    const staffIds = new Set(staff.keys());
    try {
      const next = await syncVip({
        rule,
        days: keys.map((key) => withoutStaffSeeding(parsePlayerDay(days.get(key)), staffIds)),
        state,
        now,
        staff,
        rcon: this.settingsFile({ config, http: socketHttp(connect) }),
        log: console,
      });
      await storage.put('vip', next.state);
      // Posted once, after the list is saved: a failed post is logged, not retried, so nobody is announced twice.
      if (rule !== null && (next.added.length > 0 || next.renewed.length > 0)) {
        await postWebhook(config.webhookUrl, buildVipMessage(next.added, next.renewed, rule, config.siteUrl)).catch((error: unknown) =>
          console.error(`VIP announcement failed: ${errorText(error)}`),
        );
      }
    } catch (error) {
      console.error(`VIP update failed: ${errorText(error)}`);
      // Try again at the next 10-minute mark rather than on every check.
      await storage.put('vip', { ...state, checkedAt: now });
    }
  }

  // A batch from the game's kill feed: the day's weapon totals, each killer's, and the live match, in one write. Only
  // storage is awaited, so no other batch is counted part-way through. Returns how many deaths were new.
  async recordFeed(events: FeedEvent[]): Promise<number> {
    const fresh = events.filter((e, i) => !this.killsSeen.has(e.eventId) && events.findIndex((o) => o.eventId === e.eventId) === i);
    if (fresh.length === 0) return 0;
    const now = Date.now();
    const day = dayOf(now);
    const dayKey = weaponDayKey(now);
    const kills = fresh.filter(isKill);
    const killers = [...new Set(kills.map((k) => k.killerSteamId))];
    const griefKey = griefDayKey(now);
    const stored = await this.ctx.storage.get([
      dayKey,
      griefKey,
      'killFeedSince',
      'live',
      'online',
      'state',
      KILL_FEED_KEY,
      ...killers.map(playerWeaponsKey),
    ]);
    const oldest = dayOf(now - (PROFILE_DAYS - 1) * DAY_MS);
    const first = typeof stored.get('killFeedSince') !== 'string';
    // The feed does not say who is on which side: the bot's last check does.
    const online = parseOnline(stored.get('online'));
    const tracked = parseState(stored.get('state'))?.match?.players ?? {};
    const factionOf = (steamId: string): string | null =>
      online?.players.find((p) => p.steamId === steamId)?.faction ?? tracked[steamId]?.faction ?? null;
    const grief = hasGrief(fresh, factionOf) ? recordGrief(parseGriefDay(stored.get(griefKey)), fresh, now, factionOf) : null;
    const staffKills = toStaffKills(kills, now, factionOf);
    const write = this.ctx.storage.put({
      live: recordLive(parseLiveMatch(stored.get('live')), fresh, now, factionOf),
      ...(grief === null ? {} : { [griefKey]: grief.day }),
      ...(first ? { killFeedSince: day } : {}),
      ...(kills.length === 0
        ? {}
        : {
            [dayKey]: recordWeaponDay(parseWeaponDay(stored.get(dayKey)), kills),
            [KILL_FEED_KEY]: recordKillFeed(parseKillFeed(stored.get(KILL_FEED_KEY)), staffKills),
          }),
      ...Object.fromEntries(
        killers.map((steamId) => {
          const key = playerWeaponsKey(steamId);
          const theirs = kills.filter((k) => k.killerSteamId === steamId);
          return [key, recordPlayerWeapons(parsePlayerWeapons(stored.get(key)), theirs, day, oldest)];
        }),
      ),
    });
    // Remembered as the write goes out, so a copy of this batch arriving now is not counted again.
    for (const e of fresh) this.killsSeen.add(e.eventId);
    for (const id of this.killsSeen) {
      if (this.killsSeen.size <= KILLS_REMEMBERED) break;
      this.killsSeen.delete(id);
    }
    try {
      await write;
    } catch (error) {
      for (const e of fresh) this.killsSeen.delete(e.eventId);
      throw error;
    }
    // Once the batch is counted, so a batch sent again after a failed write is not added twice.
    if (staffKills.length > 0) this.recordKillDays(day, now, staffKills);
    if (first) console.info(`Kill feed: first kills received. Weapon stats start today (${day}, UTC).`);
    if (grief !== null && grief.alerts.length > 0) this.postGriefAlerts(grief.alerts);
    if (staffKills.length > 0) this.broadcastStaff({ type: 'kills', kills: adminFeed(staffKills) });
    await this.broadcastLive();
    return fresh.length;
  }

  // The SQLite database, with the staff page's kill_days table, which is made the first time.
  private killSql(): Sql {
    const sql = this.ctx.storage.sql;
    if (!this.killTable) {
      createKillDays(sql);
      this.killTable = true;
    }
    return sql;
  }

  // A batch's kills for the staff page: each killer's day, in one transaction, and once a day the days no longer kept
  // go. A failure is only logged, as the batch's other records are saved already.
  private recordKillDays(day: string, now: number, kills: StaffKill[]): void {
    try {
      const sql = this.killSql();
      const killers = [...new Set(kills.map((k) => k.killer))];
      this.ctx.storage.transactionSync(() => {
        const known = readKillDays(sql, day, killers);
        writeKillDays(
          sql,
          killers.map((steamId) => recordKillDay(known.get(steamId) ?? null, steamId, day, kills.filter((k) => k.killer === steamId))),
        );
        if (this.killsPrunedOn !== day) {
          pruneKillDays(sql, dayOf(now - (KILL_DAYS_STORED - 1) * DAY_MS), dayOf(now - (KILL_DAYS_KEPT - 1) * DAY_MS));
        }
      });
      this.killsPrunedOn = day;
    } catch (error) {
      console.error(`Staff page kill records failed: ${errorText(error)}`);
    }
  }

  // Everyone's kill days over the KILL_DAYS_KEPT UTC days to `now`, oldest first.
  private keptKillDays(sql: Sql, now: number): KillDaySummary[] {
    const days = Array.from({ length: KILL_DAYS_KEPT }, (_, i) => dayOf(now - (KILL_DAYS_KEPT - 1 - i) * DAY_MS));
    const past = days.slice(0, -2);
    const missing = past.filter((day) => !this.killDayCache.has(day));
    for (const day of this.killDayCache.keys()) if (!past.includes(day)) this.killDayCache.delete(day);
    if (missing.length > 0) {
      const read = new Map(missing.map((day): [string, KillDaySummary[]] => [day, []]));
      for (const d of killDaySummaries(sql, missing[0] ?? '', missing[missing.length - 1] ?? '')) read.get(d.day)?.push(d);
      for (const [day, list] of read) this.killDayCache.set(day, list);
    }
    const fresh = killDaySummaries(sql, days[days.length - 2] ?? '', days[days.length - 1] ?? '');
    return [...past.flatMap((day) => this.killDayCache.get(day) ?? []), ...fresh];
  }

  // The staff page's Kill feed tab: the server's latest kills, and who gets the most headshots over the last `days` UTC
  // days.
  async adminKills(days: number): Promise<AdminKills> {
    const now = Date.now();
    const stored = await this.ctx.storage.get([KILL_FEED_KEY, 'online']);
    const sql = this.killSql();
    return buildAdminKills({
      now,
      days,
      since: firstKillDay(sql),
      from: dayOf(now - (days - 1) * DAY_MS),
      kept: this.keptKillDays(sql, now),
      inGame: new Set(this.onlineNow(now, stored.get('online'))?.players.map((p) => p.steamId)),
      feed: parseKillFeed(stored.get(KILL_FEED_KEY)),
    });
  }

  // Today's headshots of those in game, for the staff page's server list. A failure only leaves them out.
  private headshotsToday(now: number, steamIds: string[]): Map<string, HeadshotDay> {
    if (steamIds.length === 0) return new Map();
    try {
      return headshotsOn(this.keptKillDays(this.killSql(), now), dayOf(now), steamIds);
    } catch (error) {
      console.error(`Staff page: today's headshots could not be read: ${errorText(error)}`);
      return new Map();
    }
  }

  // One player's kills over the last `days` UTC days, for the Kill feed tab.
  async adminPlayerKills(steamId: string, days: number): Promise<AdminPlayerKills> {
    const now = Date.now();
    const [stored, ids] = await Promise.all([this.ctx.storage.get('online'), this.idsFor([steamId])]);
    const online = this.onlineNow(now, stored);
    const sql = this.killSql();
    const from = dayOf(now - (days - 1) * DAY_MS);
    return buildPlayerKills({
      now,
      days,
      since: firstKillDay(sql),
      from,
      kept: this.keptKillDays(sql, now),
      inGame: new Set(online?.players.map((p) => p.steamId)),
      steamId,
      rows: playerKillDays(sql, steamId, from),
      name: online?.players.find((p) => p.steamId === steamId)?.name,
      idOf: (id) => ids.get(id),
    });
  }

  // The live page: the server and its match from the last check, and the kill feed's match while it is the one on now.
  async live(): Promise<LiveSnapshot> {
    const now = Date.now();
    const stored = await this.ctx.storage.get(['stats', 'live', 'killFeedSince']);
    const stats = parseStats(stored.get('stats'));
    const server = stats.server !== null && now - stats.server.seenAt < OFFLINE_AFTER_MS ? stats.server : null;
    const onServer = server === null ? null : stats.currentMatch;
    const saved = parseLiveMatch(stored.get('live'));
    const match = saved !== null && isCurrent(saved, onServer, now) ? saved : null;
    const ids = await this.idsFor([
      ...liveSteamIds(match),
      ...(onServer?.top.flatMap((p) => (p.steamId === undefined ? [] : [p.steamId])) ?? []),
    ]);
    const idOf = (steamId: string) => ids.get(steamId);
    return {
      generatedAt: now,
      feed: typeof stored.get('killFeedSince') === 'string',
      server: stats.server,
      currentMatch: publicCurrentMatch(onServer, idOf),
      match: match === null ? null : liveStats(match, idOf),
    };
  }

  // Sends every open live page what it shows now. A page that has gone is skipped; the runtime closes it.
  private async broadcastLive(): Promise<void> {
    const sockets = this.ctx.getWebSockets(LIVE_TAG);
    if (sockets.length === 0) return;
    try {
      const message = JSON.stringify(await this.live());
      for (const socket of sockets) {
        try {
          socket.send(message);
        } catch {
          // Closing already.
        }
      }
    } catch (error) {
      console.error(`Live page update failed: ${errorText(error)}`);
    }
  }

  // A live page's WebSocket. It gets what the page shows straight away, then again after every kill feed batch and
  // every check. The object can sleep between them; the sockets stay open.
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    const url = new URL(request.url);
    if (url.pathname === STAFF_SOCKET_PATH) return this.staffSocket(Number(url.searchParams.get('until')));
    if (this.ctx.getWebSockets(LIVE_TAG).length >= LIVE_VIEWERS) return new Response('Too many live pages open', { status: 503 });
    const snapshot = JSON.stringify(await this.live());
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [LIVE_TAG]);
    server.send(snapshot);
    return new Response(null, { status: 101, webSocket: client });
  }

  // A signed-in staff page's live kill feed (see staffSocket below), open until its session runs out (`until`). It gets
  // the latest kills straight away, then each batch's as it comes in.
  private async staffSocket(until: number): Promise<Response> {
    if (this.ctx.getWebSockets(STAFF_TAG).length >= STAFF_VIEWERS) return new Response('Too many staff pages open', { status: 503 });
    const feed = parseKillFeed(await this.ctx.storage.get(KILL_FEED_KEY));
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [STAFF_TAG]);
    server.serializeAttachment({ until });
    server.send(JSON.stringify({ type: 'feed', feed: adminFeed(feed) } satisfies StaffLiveMessage));
    return new Response(null, { status: 101, webSocket: client, headers: { 'sec-websocket-protocol': STAFF_SOCKET_PROTOCOL } });
  }

  // Sends every open staff page a batch's kills. One whose session has run out is closed instead, with 4401: the page
  // then asks its user to sign in again.
  private broadcastStaff(message: StaffLiveMessage): void {
    const sockets = this.ctx.getWebSockets(STAFF_TAG);
    if (sockets.length === 0) return;
    const now = Date.now();
    const text = JSON.stringify(message);
    for (const socket of sockets) {
      const until = z.object({ until: z.number() }).safeParse(socket.deserializeAttachment()).data?.until ?? 0;
      try {
        if (until > now) socket.send(text);
        else socket.close(4401, 'Sign in again');
      } catch {
        // Closing already.
      }
    }
  }

  // Pages only send pings, which the auto-response answers.
  async webSocketMessage(): Promise<void> {}

  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    try {
      socket.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  // The weapons of the last `count` UTC days, oldest first, today last.
  private async recentWeaponDays(now: number, count: number): Promise<WeaponDay[]> {
    const keys = Array.from({ length: count }, (_, i) => weaponDayKey(now - (count - 1 - i) * DAY_MS));
    const fresh = keys.slice(-2);
    const read = keys.filter((key) => fresh.includes(key) || !this.weaponDayCache.has(key));
    const stored = await this.ctx.storage.get(read);
    for (const key of this.weaponDayCache.keys()) if (!keys.includes(key)) this.weaponDayCache.delete(key);
    for (const key of read) if (!fresh.includes(key)) this.weaponDayCache.set(key, parseWeaponDay(stored.get(key)));
    return keys.map((key) => (fresh.includes(key) ? parseWeaponDay(stored.get(key)) : (this.weaponDayCache.get(key) ?? {})));
  }

  async stats(): Promise<PublicStats> {
    const config = loadConfig(stringVars(this.env));
    const now = Date.now();
    const [stored, days, weaponDays, records] = await Promise.all([
      this.ctx.storage.get(['stats', 'killFeedSince', 'vip', STAFF_PROFILES_KEY]),
      this.recentDays(now),
      this.recentWeaponDays(now, LEADERBOARD_DAYS),
      this.matchRecords(now),
    ]);
    const stats = parseStats(stored.get('stats'));
    const since = stored.get('killFeedSince');
    const board = leaderboard(days.slice(-LEADERBOARD_DAYS).map((d) => d.players), LEADERBOARD_DAYS, LEADERBOARD_SIZE);
    const staff = staffSteamIds(parseStaffProfiles(stored.get(STAFF_PROFILES_KEY)));
    const seeders = config.vip === null ? null : seederVip(parseVipState(stored.get('vip')), now, staff);
    const ids = await this.idsFor([
      ...namedSteamIds(stats, board),
      ...weaponHolders(weaponDays),
      ...(seeders ?? []).map((p) => p.steamId),
    ]);
    const idOf = (steamId: string) => ids.get(steamId);
    const weapons = typeof since === 'string' ? weaponBoard(weaponDays, LEADERBOARD_DAYS, since, WEAPONS_LISTED, idOf) : null;
    const { seeding, live } = config.rules;
    const extras = { leaderboard: board, vip: config.vip, seederVip: seeders, weapons, teams: teamBoard(records, LEADERBOARD_DAYS, now) };
    return publicStats(stats, { seeding, live, busy: config.busyThreshold }, now, extras, idOf);
  }

  // The key for players' public ids, made the first time it is needed. Changing it would change every id, and break
  // every link to a player page, so it is stored with the records.
  private publicIdKey(): Promise<CryptoKey> {
    this.idKey ??= (async () => {
      const stored = await this.ctx.storage.get('playerIdKey');
      const key = isIdKey(stored) ? stored : newIdKey();
      if (key !== stored) await this.ctx.storage.put('playerIdKey', key);
      return importIdKey(key);
    })().catch((error: unknown) => {
      this.idKey = null;
      throw error;
    });
    return this.idKey;
  }

  // Works out the public ids it does not know yet, and returns every id it knows, by Steam ID.
  private async idsFor(steamIds: Iterable<string>): Promise<Map<string, string>> {
    const missing = [...new Set(steamIds)].filter((steamId) => !this.ids.has(steamId));
    if (missing.length > 0) {
      const key = await this.publicIdKey();
      const made = await Promise.all(missing.map(async (steamId) => [steamId, await publicId(key, steamId)] as const));
      for (const [steamId, id] of made) this.ids.set(steamId, id);
    }
    return this.ids;
  }

  // Each player's totals for every UTC day of the player pages, oldest first, today last. Staff's time counts as
  // playing, never seeding (see withoutStaffSeeding); the cache keeps the records as they are.
  private async recentDays(now: number): Promise<DayRecords[]> {
    const keys = recentDayKeys(now, PROFILE_DAYS);
    const fresh = keys.slice(-2);
    const read = keys.filter((key) => fresh.includes(key) || !this.dayCache.has(key));
    const stored = await this.ctx.storage.get([...read, STAFF_PROFILES_KEY]);
    const staff = staffSteamIds(parseStaffProfiles(stored.get(STAFF_PROFILES_KEY)));
    for (const key of this.dayCache.keys()) if (!keys.includes(key)) this.dayCache.delete(key);
    for (const key of read) if (!fresh.includes(key)) this.dayCache.set(key, parsePlayerDay(stored.get(key)));
    return keys.map((key) => ({
      day: dayOfKey(key),
      players: withoutStaffSeeding(fresh.includes(key) ? parsePlayerDay(stored.get(key)) : (this.dayCache.get(key) ?? {}), staff),
    }));
  }

  // The records of the matches that ended in the same UTC days, as a match counts on the day it ended. Records are
  // keyed by when the match started, so they are read from a day earlier, for a match that ran past midnight.
  private async matchRecords(now: number): Promise<MatchRecord[]> {
    const first = Date.parse(`${dayOf(now - (PROFILE_DAYS - 1) * DAY_MS)}T00:00:00Z`);
    const start = matchRecordKey(first - DAY_MS);
    const last = [...this.matchCache.keys()].at(-1);
    const stored = await this.ctx.storage.list({ prefix: 'match:', ...(last === undefined ? { start } : { startAfter: last }) });
    for (const [key, value] of stored) {
      const record = parseMatchRecord(value);
      if (record !== null) this.matchCache.set(key, record);
    }
    for (const key of this.matchCache.keys()) if (key < start) this.matchCache.delete(key);
    return [...this.matchCache.values()].filter((record) => record.endedAt >= first);
  }

  // Who was in game at the last check, unless the server has stopped answering since.
  private onlineNow(now: number, raw: unknown): OnlineSnapshot | null {
    const online = parseOnline(raw);
    return online !== null && now - online.at < OFFLINE_AFTER_MS ? online : null;
  }

  // Everyone seen in the last PROFILE_DAYS days, to find a player page in.
  async players(): Promise<PlayerDirectory> {
    const now = Date.now();
    const [days, stored] = await Promise.all([this.recentDays(now), this.ctx.storage.get('online')]);
    const ids = await this.idsFor(days.flatMap((d) => Object.keys(d.players)));
    const online = new Set(this.onlineNow(now, stored)?.players.map((p) => p.steamId));
    return directory(days, (steamId) => ids.get(steamId), online, now);
  }

  // One player's page, by public id. Null when nobody seen in the last PROFILE_DAYS days has that id.
  async profile(id: string): Promise<PlayerProfile | null> {
    const now = Date.now();
    const days = await this.recentDays(now);
    const ids = await this.idsFor(days.flatMap((d) => Object.keys(d.players)));
    const steamId = [...ids].find(([, known]) => known === id)?.[0];
    if (steamId === undefined) return null;
    const [matches, stored, staff] = await Promise.all([
      this.matchRecords(now),
      this.ctx.storage.get(['state', 'vip', 'online', 'killFeedSince', playerWeaponsKey(steamId)]),
      this.staffSteam(),
    ]);
    const snapshot = this.onlineNow(now, stored.get('online'));
    const inGame = snapshot?.players.find((p) => p.steamId === steamId);
    const tracked = parseState(stored.get('state'))?.match?.players[steamId];
    const online: OnlineNow | null =
      snapshot === null || inGame === undefined
        ? null
        : {
            map: mapName(snapshot.map),
            faction: inGame.faction ?? tracked?.faction ?? null,
            kills: tracked?.kills ?? inGame.kills ?? 0,
            deaths: tracked?.deaths ?? inGame.deaths ?? 0,
          };
    const config = loadConfig(stringVars(this.env));
    const since = stored.get('killFeedSince');
    return buildProfile({
      steamId,
      id,
      now,
      days,
      matches,
      rankDays: LEADERBOARD_DAYS,
      online,
      vip: parseVipState(stored.get('vip')).granted[steamId] ?? null,
      // Staff cannot earn seeder VIP, so their page does not count them towards it.
      rule: staff.has(steamId) ? null : config.vip,
      weapons:
        typeof since === 'string'
          ? { since, used: playerWeaponDays(parsePlayerWeapons(stored.get(playerWeaponsKey(steamId))), days[0]?.day ?? since) }
          : null,
    });
  }

  // The staff page: who is in game now, possible griefers and their incidents over the last `days` UTC days, risky Steam
  // accounts, what staff did in them, and the bans on the server now. The ban list is read from the server; without it
  // the rest still shows.
  async adminOverview(days: number): Promise<AdminOverview> {
    const now = Date.now();
    const griefKeys = Array.from({ length: days }, (_, i) => griefDayKey(now - (days - 1 - i) * DAY_MS));
    const { config } = this.rcon();
    const http = socketHttp(connect, SUGGEST_TIMEOUT_MS);
    const [stored, recent, logs, serverBans, serverConfig] = await Promise.all([
      this.ctx.storage.get([
        ...griefKeys,
        'killFeedSince',
        'bans',
        'vip',
        'online',
        'state',
        'stats',
        STAFF_NAMES_KEY,
        STAFF_PROFILES_KEY,
      ]),
      this.recentDays(now),
      this.ctx.storage.list({ prefix: 'mod:' }),
      fetchBans(config.rconUrl, config.rconPassword, http).catch((error: unknown) => {
        console.error(`Staff page: the ban list could not be read: ${errorText(error)}`);
        return null;
      }),
      fetchConfig(config.rconUrl, config.rconPassword, http).catch((error: unknown) => {
        console.error(`Staff page: ServerSettings.ini could not be read: ${errorText(error)}`);
        return null;
      }),
    ]);
    const reserved = ((): ReservedListing | null => {
      if (serverConfig === null) return null;
      try {
        return reservedListing(serverConfig.text);
      } catch (error) {
        console.error(`Staff page: the reserved list could not be read: ${errorText(error)}`);
        return null;
      }
    })();
    const vip = parseVipState(stored.get('vip'));
    const grief = griefKeys.map((key) => parseGriefDay(stored.get(key)));
    const modLogs = new Map([...logs].map(([key, value]) => [key.slice('mod:'.length), parseModLog(value)]));
    const banBook = parseBanBook(stored.get('bans'));
    const online = this.onlineNow(now, stored.get('online'));
    const playerDays = recent.slice(-days).map((d) => d.players);
    const steam = await this.steamSources(playerDays, online, now, days);
    const staffProfiles = parseStaffProfiles(stored.get(STAFF_PROFILES_KEY));
    const steamIds = [
      ...adminSteamIds(grief, modLogs, serverBans, banBook, reserved?.ids ?? []),
      ...staffSteamIds(staffProfiles),
      ...(online?.players.map((p) => p.steamId) ?? []),
      ...(steam === null ? [] : riskySteamIds(steamPlayers(playerDays, steam.inGame), steam.checks, now, steam.inGame).slice(0, STEAM_ACCOUNTS_LISTED)),
    ];
    const names = new Map<string, string>();
    for (const [steamId, log] of modLogs) {
      const logged = log.findLast((e) => e.name !== undefined && e.name !== steamId)?.name;
      if (logged !== undefined) names.set(steamId, logged);
    }
    for (const [steamId, ban] of Object.entries(banBook)) names.set(steamId, ban.name);
    for (const [steamId, grant] of Object.entries(vip.granted)) names.set(steamId, grant.name);
    for (const day of grief) for (const [steamId, t] of Object.entries(day.players)) if (t.name !== '') names.set(steamId, t.name);
    for (const day of recent) for (const [steamId, t] of Object.entries(day.players)) names.set(steamId, t.name);
    for (const p of online?.players ?? []) names.set(p.steamId, p.name);
    const ids = await this.idsFor(steamIds);
    const since = stored.get('killFeedSince');
    const staffNames = parseStaffNames(stored.get(STAFF_NAMES_KEY));
    const overview = buildAdminOverview({
      now,
      days,
      feedSince: typeof since === 'string' ? since : null,
      grief,
      playerDays,
      modLogs,
      serverBans,
      banBook,
      nameOf: (steamId) => names.get(steamId),
      idOf: (steamId) => ids.get(steamId),
      staffNames,
      staffProfiles,
      reserved,
      vip,
      steam,
      server: parseStats(stored.get('stats')).server,
      online,
      match: parseState(stored.get('state'))?.match?.players ?? {},
      history: recent,
      headshots: this.headshotsToday(now, online?.players.map((p) => p.steamId) ?? []),
    });
    const staffIds = adminStaffIds(overview);
    const found = await this.lookUpStaff(staffIds, staffNames, now);
    return found === null ? overview : { ...overview, staff: staffFor(staffIds, found, modLogs) };
  }

  // With DISCORD_BOT_TOKEN, asks Discord who the staff are that the bot has not seen sign in or use a staff command, a
  // few at a time, and remembers them. Null when there was nobody to ask about, or no token.
  private async lookUpStaff(ids: string[], known: StaffNames, now: number): Promise<StaffNames | null> {
    const token = stringVars(this.env)['DISCORD_BOT_TOKEN']?.trim();
    if (!token) return null;
    const failures = parseLookupFailures(await this.ctx.storage.get(LOOKUP_FAILURES_KEY));
    const due = lookupsDue(known, ids, now, failures);
    if (due.length === 0) return null;
    const learned: [string, { name: string; username: string }][] = [];
    const failed: string[] = [];
    for (const id of due) {
      try {
        const user = await fetchDiscordUser(token, id);
        if (user === null) failed.push(id);
        else learned.push([id, user]);
      } catch (error) {
        // A refused token or a rate limit: the rest wait for a later load.
        failed.push(id);
        console.error(`Staff names: ${errorText(error)}`);
        break;
      }
    }
    // Read again, so a name noted while Discord was being asked is not lost.
    const latest = parseStaffNames(await this.ctx.storage.get(STAFF_NAMES_KEY));
    const merged = { ...latest, ...Object.fromEntries(learned.map(([id, user]) => [id, { ...user, at: now }])) };
    await this.ctx.storage.put({
      ...(learned.length === 0 ? {} : { [STAFF_NAMES_KEY]: merged }),
      [LOOKUP_FAILURES_KEY]: withFailures(failures, failed, now),
    });
    if (learned.length > 0) console.info(`Staff names: looked up ${learned.length} on Discord`);
    return learned.length === 0 ? null : merged;
  }

  // Links the signed-in staff member's Steam account, or unlinks theirs or another staff member's (see staffprofiles.ts).
  // `player` is the name that account last had in game, when the bot has seen it, so the page can say whose it is.
  async staffProfile(
    action: ProfileAction,
    user: { id: string; name: string },
  ): Promise<{ steamId: string | null; player: string | null } | { problem: string }> {
    // One at a time with the VIP updates: one that read the staff before this change and is still writing the reserved
    // list would otherwise save VIP for an account linked meanwhile. Waiting for it makes it come before the link.
    const changed = await this.serial(async (): Promise<{ steamId: string | null } | { problem: string }> => {
      const storage = this.ctx.storage;
      const profiles = parseStaffProfiles(await storage.get(STAFF_PROFILES_KEY));
      if (action.action === 'unlink') {
        const target = action.userId ?? user.id;
        const was = profiles[target];
        if (was === undefined) return { steamId: null };
        await storage.put(STAFF_PROFILES_KEY, unlinkSteam(profiles, target));
        console.info(`Staff page: ${JSON.stringify(user.name)} unlinked Steam account ${was.steamId} from Discord user ${target}`);
        return { steamId: null };
      }
      const linked = linkSteam(profiles, user, action.steamId, Date.now());
      if ('problem' in linked) return linked;
      await storage.put(STAFF_PROFILES_KEY, linked.profiles);
      console.info(`Staff page: ${JSON.stringify(user.name)} (Discord user ${user.id}) linked Steam account ${linked.steamId}`);
      return { steamId: linked.steamId };
    });
    if ('problem' in changed) return changed;
    const { steamId } = changed;
    if (steamId === null) return { steamId, player: null };
    const seen = (await this.recentDays(Date.now())).findLast((d) => d.players[steamId] !== undefined);
    return { steamId, player: seen?.players[steamId]?.name ?? null };
  }

  // A staff member's name, as seen when they sign in to the staff page or use a staff command. Only written when it
  // changed, or has not been seen for a while.
  async noteStaff(id: string, name: string, username: string | null): Promise<void> {
    const next = noteStaffName(parseStaffNames(await this.ctx.storage.get(STAFF_NAMES_KEY)), id, name, username, Date.now());
    if (next !== null) await this.ctx.storage.put(STAFF_NAMES_KEY, next);
  }

  // Recent matches, newest first, to pick from in /removematch.
  async recentMatches(): Promise<RecentMatch[]> {
    return parseStats(await this.ctx.storage.get('stats')).matches;
  }

  // Deletes a match recorded by mistake: from the recent matches, its private record, and its players' totals for
  // the day it was credited to. Returns null if no recent match ended at that time.
  async removeMatch(endedAt: number): Promise<{ match: RecentMatch; players: number } | null> {
    const storage = this.ctx.storage;
    const { stats, removed } = removeRecentMatch(parseStats(await storage.get('stats')), endedAt);
    if (removed === null) return null;
    const records = await storage.list({ prefix: 'match:', reverse: true, limit: MATCH_RECORDS_SEARCHED });
    const found = [...records].find(([, value]) => parseMatchRecord(value)?.endedAt === endedAt);
    const record = found === undefined ? null : parseMatchRecord(found[1]);
    if (found === undefined || record === null) {
      await storage.put('stats', stats);
      return { match: removed, players: 0 };
    }
    const dayKey = playerDayKey(endedAt);
    const day = unrecordMatchPlayers(parsePlayerDay(await storage.get(dayKey)), record.players);
    // Issued together with no await in between, so they are written at once: a failure cannot leave it half removed.
    await Promise.all([storage.put({ stats, [dayKey]: day }), storage.delete(found[0])]);
    // The player pages read the records again, without it.
    this.dayCache.clear();
    this.matchCache.clear();
    return { match: removed, players: record.players.length };
  }

  // What the bot knows about one player, for /player.
  async playerRecord(steamId: string): Promise<PlayerRecord> {
    const keys = recentDayKeys(Date.now(), PROFILE_DAYS);
    const key = modLogKey(steamId);
    const stored = await this.ctx.storage.get([...keys, key, 'vip', 'bans', STAFF_PROFILES_KEY]);
    const staff = staffSteamIds(parseStaffProfiles(stored.get(STAFF_PROFILES_KEY)));
    const found = totals(keys.map((k) => withoutStaffSeeding(parsePlayerDay(stored.get(k)), staff))).find((p) => p.steamId === steamId);
    const vip = parseVipState(stored.get('vip'));
    const log = parseModLog(stored.get(key));
    const ban = parseBanBook(stored.get('bans'))[steamId] ?? null;
    return {
      name: found?.name ?? vip.granted[steamId]?.name ?? ban?.name ?? log.findLast((e) => e.name !== undefined)?.name ?? null,
      totals: found === undefined ? null : withoutId(found),
      vip: vip.granted[steamId] ?? null,
      vipBlockedUntil: vip.revoked[steamId] ?? null,
      staffSpot: staff.has(steamId),
      log,
      ban,
    };
  }

  // Players seen in the last 30 days, with VIP from the bot or banned by it, newest name first.
  async knownPlayers(): Promise<Named[]> {
    const keys = recentDayKeys(Date.now(), KNOWN_PLAYER_DAYS);
    const stored = await this.ctx.storage.get([...keys, 'vip', 'bans']);
    const seen = totals(keys.map((k) => parsePlayerDay(stored.get(k))));
    const vip = Object.entries(parseVipState(stored.get('vip')).granted);
    const bans = Object.entries(parseBanBook(stored.get('bans')));
    const all = [...seen, ...[...vip, ...bans].map(([steamId, { name }]) => ({ steamId, name }))];
    const ids = new Set<string>();
    return all.filter((p) => !ids.has(p.steamId) && ids.add(p.steamId)).map(({ steamId, name }) => ({ steamId, name }));
  }

  async logAction(steamId: string, entry: ModEntry): Promise<void> {
    await this.record(steamId, entry);
  }

  // Bans a player on the server, and remembers when a timed ban ends so the bot can lift it. A player who is already
  // banned is left as they are, so no ban is ever lifted to change it: staff /unban first. The game only bans players
  // who are in game, so for anyone else the ban waits, and the check that next sees them puts it on the server.
  async ban({ steamId, name, length, reason, by, byName }: BanRequest): Promise<BanResult> {
    const option = BAN_LENGTHS.find((l) => l.value === length);
    if (option === undefined) throw new Error(`Unknown ban length: ${length}`);
    const named = byName === undefined ? {} : { byName };
    return this.serial(async () => {
      const { config, http } = this.rcon();
      const at = Date.now();
      const until = option.ms === null ? null : at + option.ms;
      const current = (await fetchBans(config.rconUrl, config.rconPassword, http)).find((b) => b.steamId === steamId);
      const ours = parseBanBook(await this.ctx.storage.get('bans'))[steamId];
      if (current !== undefined) {
        const byBot = ours !== undefined && isBotBan(current.reason, ours);
        return { outcome: 'already-banned', until: byBot ? ours.until : null, byBot };
      }
      if (ours?.waiting && (ours.until === null || ours.until > at)) {
        return { outcome: 'already-banned', until: ours.until, byBot: true, waiting: true };
      }
      // Remembered before the server is asked, so a ban that goes through but times out still ends on time. If the
      // server refuses, it is forgotten again; the bot also forgets it at its end if the server never had it.
      const ban: BanRecord = { name, until, reason, serverReason: banReason(reason, until), by, at };
      await this.record(steamId, null, { ban });
      try {
        await addBan(config.rconUrl, config.rconPassword, steamId, ban.serverReason, http);
      } catch (error) {
        if (isNotInGame(error)) {
          const detail = `${option.name}, waits for them to join`;
          await this.record(steamId, { action: 'ban', at, by, ...named, name, reason, detail }, { ban: { ...ban, waiting: true } });
          return { outcome: 'banned', until, byBot: true, waiting: true };
        }
        if (error instanceof RconError) await this.record(steamId, null, { ban: null });
        throw error;
      }
      await this.record(
        steamId,
        { action: 'ban', at, by, ...named, name, reason, detail: option.name },
        { serverBan: { reason: ban.serverReason, bannedBy: null } },
      );
      return { outcome: 'banned', until, byBot: true };
    });
  }

  // False when they had no ban: none on the server, and none waiting for them to join. The bot forgets its own record
  // of the ban either way.
  async unban({ steamId, name }: Named, by: string, byName?: string): Promise<boolean> {
    return this.serial(async () => {
      const { config, http } = this.rcon();
      const waiting = parseBanBook(await this.ctx.storage.get('bans'))[steamId]?.waiting === true;
      const removed = (await removeBan(config.rconUrl, config.rconPassword, steamId, http)) || waiting;
      const entry: ModEntry = { action: 'unban', at: Date.now(), by, ...(byName === undefined ? {} : { byName }), name };
      await this.record(steamId, removed ? entry : null, { ban: null, serverBan: null });
      return removed;
    });
  }

  async vipAdd({ steamId, name, days, reason, by, byName }: Named & { days: number | null; reason: string; by: string; byName?: string }): Promise<VipAddResult> {
    return this.serial(async () => {
      const now = Date.now();
      const state = parseVipState(await this.ctx.storage.get('vip'));
      const change = await addVip({ steamId, name, days, now, state, rcon: this.settingsFile(this.rcon()) });
      if (change.outcome === 'already-reserved') {
        // Nothing given, but any block from /vip remove is lifted.
        await this.record(steamId, null, { vip: change.state });
        return { outcome: change.outcome };
      }
      const outcome = change.outcome === 'extended' ? 'extended' : 'added';
      const length = days === null ? 'permanent' : `${days} day${days === 1 ? '' : 's'}`;
      const entry: ModEntry = {
        action: 'vip-add',
        at: now,
        by,
        ...(byName === undefined ? {} : { byName }),
        name,
        reason,
        detail: outcome === 'extended' ? `${length} (already had VIP)` : length,
      };
      await this.record(steamId, entry, { vip: change.state });
      return { outcome, ...(change.until === undefined ? {} : { until: change.until }) };
    });
  }

  async vipRemove({ steamId, name, reason, by, byName }: Named & { reason?: string; by: string; byName?: string }): Promise<VipRemoveResult> {
    return this.serial(async () => {
      // A staff spot follows the staff member's linked Steam account: the next check would only put it back.
      if (await this.staffSteam().then((staff) => staff.has(steamId))) return { outcome: 'staff-spot' };
      const now = Date.now();
      const state = parseVipState(await this.ctx.storage.get('vip'));
      const change = await removeVip({ steamId, now, state, rcon: this.settingsFile(this.rcon()) });
      const outcome = change.outcome === 'removed' ? 'removed' : 'not-reserved';
      const entry: ModEntry = {
        action: 'vip-remove',
        at: now,
        by,
        ...(byName === undefined ? {} : { byName }),
        name,
        ...(reason === undefined ? {} : { reason }),
        // Still logged: automatic VIP skips them for 7 days either way.
        detail: outcome === 'removed' ? 'automatic VIP off for 7 days' : "wasn't on the reserved list; automatic VIP off for 7 days",
      };
      await this.record(steamId, entry, { vip: change.state });
      return { outcome };
    });
  }

  // Notes the map staff set to play next, and the map being played now: once the server leaves that, it has been played.
  // The map being played comes from the server when staff set it, or else from the last check.
  async stageNextMap(map: string, playing: string | null): Promise<void> {
    const match = playing ? null : (parseState(await this.ctx.storage.get('state'))?.match ?? null);
    const fromMap = playing || (match === null ? '' : matchMap(match));
    if (fromMap === '') return;
    const staged: StagedMap = { map, fromMap, at: Date.now() };
    await this.ctx.storage.put('nextMap', staged);
  }

  // Posts a /seednow call. Its time is saved first, so the automatic seeding alert holds back even when the post times
  // out after Discord took it.
  async seedCall(message: DiscordMessage): Promise<void> {
    const { webhookUrl } = loadConfig(stringVars(this.env));
    await this.alerting(async () => {
      await this.ctx.storage.put('seedCall', Date.now());
      await postWebhook(webhookUrl, message);
    });
  }

  // The top seeders over the last `days` UTC days, including today, and who has VIP from the bot.
  async seeders(days: number): Promise<SeederRow[]> {
    const keys = recentDayKeys(Date.now(), days);
    const stored = await this.ctx.storage.get([...keys, 'vip', STAFF_PROFILES_KEY]);
    const { granted } = parseVipState(stored.get('vip'));
    const staff = staffSteamIds(parseStaffProfiles(stored.get(STAFF_PROFILES_KEY)));
    return rankSeeders(keys.map((key) => withoutStaffSeeding(parsePlayerDay(stored.get(key)), staff)), SEEDERS_LISTED).map((p) => ({
      steamId: p.steamId,
      name: p.name,
      seedingMinutes: p.seedingMinutes,
      seedDays: p.seedDays,
      vipUntil: granted[p.steamId]?.expiresAt ?? null,
    }));
  }
}

// The stats only change once a minute. Each Worker instance keeps its last answers for a short while so a busy page
// does not wake the Durable Object on every request. Requests that arrive while a refresh is in flight wait for that
// one instead of starting their own. The live page's answer changes with every kill, so it is kept for less; the page
// mostly gets it over its WebSocket instead.
const CACHE_MS = 30_000;
const LIVE_CACHE_MS = 5_000;
// One answer per player page; past this many, the oldest are dropped.
const CACHE_ENTRIES = 200;
const cache = new Map<string, { body: Promise<string | null>; at: number }>();

// Public, read-only numbers, so any site may show them.
const PUBLIC_HEADERS = { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=30' };

// `load` answers null when there is no such thing, which is a 404.
const serveJson = async (key: string, load: () => Promise<unknown>, ctx: ExecutionContext, keepMs = CACHE_MS): Promise<Response> => {
  const now = Date.now();
  let entry = cache.get(key);
  if (entry === undefined || now - entry.at >= keepMs) {
    const fresh = { body: load().then((value) => (value === null ? null : JSON.stringify(value))), at: now };
    entry = fresh;
    // Re-added, so the oldest answers are always first.
    cache.delete(key);
    cache.set(key, fresh);
    for (const old of cache.keys()) {
      if (cache.size <= CACHE_ENTRIES) break;
      cache.delete(old);
    }
    // Other requests may be waiting on this refresh, so it must finish even if this request is cancelled.
    // A failed refresh is dropped so the next request tries again.
    ctx.waitUntil(
      fresh.body.catch(() => {
        if (cache.get(key) === fresh) cache.delete(key);
      }),
    );
  }
  const body = await entry.body;
  const headers = { ...PUBLIC_HEADERS, 'cache-control': `public, max-age=${Math.round(keepMs / 1000)}` };
  if (body === null) return Response.json({ error: 'Not found' }, { status: 404, headers });
  return new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
};

// The website's JSON: the server's stats, the live match, everyone to find a player page for, and one player's page.
const publicRoute = (
  url: URL,
  watcher: () => DurableObjectStub<Watcher>,
): { key: string; load: () => Promise<unknown>; keepMs?: number } | null => {
  if (url.pathname === '/api/stats') return { key: 'stats', load: () => watcher().stats() };
  if (url.pathname === '/api/live') return { key: 'live', load: () => watcher().live(), keepMs: LIVE_CACHE_MS };
  if (url.pathname === '/api/players') return { key: 'players', load: () => watcher().players() };
  const id = url.searchParams.get('id') ?? '';
  if (url.pathname === '/api/player' && PLAYER_ID.test(id)) return { key: `player:${id}`, load: () => watcher().profile(id) };
  return null;
};

// The staff page's sign-in (see adminauth.ts): Discord sends the browser back to CALLBACK_PATH on this Worker, which must
// be listed under OAuth2 → Redirects in the Discord Developer Portal.
const callbackUrl = (request: Request): string => `${new URL(request.url).origin}${CALLBACK_PATH}`;

// Logged each time, so the reason the staff page cannot load is in the Worker logs, not only on the page.
const notSetUp = (missing: string[]): Response => {
  console.error(notSetUpText(missing));
  return new Response(notSetUpText(missing), { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
};

const staffLogin = async (request: Request, vars: Record<string, string>): Promise<Response> => {
  const config = adminAuthConfig(vars);
  if ('missing' in config) return notSetUp(config.missing);
  const returnTo = returnAddress(new URL(request.url).searchParams.get('return'), config.siteOrigin);
  const { location, cookie } = await startLogin(config, callbackUrl(request), returnTo, Date.now());
  return new Response(null, { status: 302, headers: { location, 'set-cookie': cookie, 'cache-control': 'no-store' } });
};

const staffCallback = async (request: Request, vars: Record<string, string>, watcher: () => DurableObjectStub<Watcher>): Promise<Response> => {
  const config = adminAuthConfig(vars);
  if ('missing' in config) return notSetUp(config.missing);
  const url = new URL(request.url);
  // Back to the page, with the session or what went wrong after the #, which no server sees.
  const back = (returnTo: string, fragment: string): Response =>
    new Response(null, {
      status: 302,
      headers: {
        location: `${returnTo}#${fragment}`,
        'set-cookie': CLEAR_LOGIN_COOKIE,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      },
    });
  const returnTo = await checkState(config.clientSecret, url.searchParams.get('state'), request.headers.get('cookie'), Date.now());
  if (returnTo === null) return back(`${config.siteOrigin}${ADMIN_PAGE}`, 'error=expired');
  const code = url.searchParams.get('code');
  if (code === null) return back(returnTo, `error=${url.searchParams.get('error') === 'access_denied' ? 'cancelled' : 'failed'}`);
  try {
    const result = await finishLogin(config, code, callbackUrl(request));
    if ('problem' in result) {
      console.info(`Staff sign-in refused: ${result.problem}`);
      return back(returnTo, `error=${result.problem}`);
    }
    console.info(`Staff signed in: ${JSON.stringify(result.user.name)} (Discord user ${result.user.id})`);
    const { id, name, username } = result.user;
    await watcher()
      .noteStaff(id, name, username)
      .catch((error: unknown) => console.error(`Noting a staff name failed: ${errorText(error)}`));
    return back(returnTo, `session=${await createSession(config.clientSecret, result.user, Date.now())}`);
  } catch (error) {
    console.error(`Staff sign-in failed: ${errorText(error)}`);
    return back(returnTo, 'error=failed');
  }
};

// The slash commands, run and suggested for in the same way from Discord and from the staff page.
const commandTools = (
  vars: Record<string, string>,
  watcher: () => DurableObjectStub<Watcher>,
): { run: (request: CommandRequest) => Promise<CommandReply>; suggest: (request: CommandRequest) => Promise<Choice[]> } => {
  const records: StaffRecords = {
    player: (steamId) => watcher().playerRecord(steamId),
    knownPlayers: () => watcher().knownPlayers(),
    log: (steamId, entry) => watcher().logAction(steamId, entry),
    ban: (ban) => watcher().ban(ban),
    unban: (target, by, byName) => watcher().unban(target, by, byName),
    vipAdd: (grant) => watcher().vipAdd(grant),
    vipRemove: (target) => watcher().vipRemove(target),
    nextMap: (map, playing) => watcher().stageNextMap(map, playing),
    steam: (steamId) => watcher().steamLookup(steamId),
    rotations: () => watcher().rotationBook(),
    editRotations: (edit, by, byName) => watcher().editRotations(edit, by, byName),
  };
  return {
    run: runCommand({
      config: () => loadConfig(vars),
      http: socketHttp(connect),
      lastMatch: async () => (await watcher().recentMatches())[0] ?? null,
      roundup: (choice) => watcher().roundup(choice),
      seeders: (days) => watcher().seeders(days),
      removeMatch: (endedAt) => watcher().removeMatch(endedAt),
      seedCall: (message) => watcher().seedCall(message),
      records,
      now: Date.now,
      log: console,
    }),
    suggest: suggestOptions({
      recentMatches: () => watcher().recentMatches(),
      config: () => loadConfig(vars),
      http: socketHttp(connect, SUGGEST_TIMEOUT_MS),
      records,
    }),
  };
};

// A staff page request to run a staff command, or for suggestions while staff fill one in. Far smaller than this.
const STAFF_BODY_BYTES = 8_192;
const StaffBodySchema = z.object({
  name: z.string().max(40),
  options: z.record(z.string().max(40), z.union([z.string().max(1_000), z.number(), z.boolean()])).default({}),
  focused: z.string().max(40).optional(),
});

const readStaffBody = async (request: Request): Promise<z.infer<typeof StaffBodySchema> | null> => {
  if (Number(request.headers.get('content-length') ?? 0) > STAFF_BODY_BYTES) return null;
  const body = await request.arrayBuffer();
  if (body.byteLength > STAFF_BODY_BYTES) return null;
  try {
    const parsed = StaffBodySchema.safeParse(JSON.parse(new TextDecoder().decode(body)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

// The staff page's live kill feed (see killfeed.ts), for a signed-in session from the website only. Sockets are not
// bound by CORS, so the Origin is checked here. The Durable Object keeps the socket, until the session runs out.
const staffSocket = async (
  request: Request,
  secret: string,
  siteOrigin: string | null,
  watcher: () => DurableObjectStub<Watcher>,
): Promise<Response> => {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
  if (siteOrigin === null || request.headers.get('origin') !== siteOrigin) return new Response('Not the staff page', { status: 403 });
  const token = socketSession(request.headers.get('sec-websocket-protocol'));
  const session = token === null ? null : await readSession(secret, `Bearer ${token}`, Date.now());
  if (session === null) return new Response('Sign in again', { status: 401 });
  const url = new URL(STAFF_SOCKET_PATH, request.url);
  url.searchParams.set('until', String(session.expiresAt));
  return watcher().fetch(new Request(url, request));
};

// The staff page's data, for a signed-in session only. Only the website may read it from a browser, and nothing keeps a
// copy.
const staffApi = async (request: Request, vars: Record<string, string>, watcher: () => DurableObjectStub<Watcher>): Promise<Response> => {
  const config = adminAuthConfig(vars);
  // The website may read even a refusal, so the page can say why. Without SITE_URL no site may.
  const headers = {
    'access-control-allow-origin': siteOriginOf(vars) ?? 'null',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-max-age': '600',
    'cache-control': 'no-store',
    vary: 'origin',
  };
  // Logged on the browser's preflight too: without SITE_URL the browser stops there and never sends the request.
  if ('missing' in config) console.error(notSetUpText(config.missing));
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if ('missing' in config) return Response.json({ error: notSetUpText(config.missing) }, { status: 503, headers });
  if (request.method === 'GET' && new URL(request.url).pathname === '/api/admin/live') {
    return staffSocket(request, config.clientSecret, siteOriginOf(vars), watcher);
  }
  const session = await readSession(config.clientSecret, request.headers.get('authorization'), Date.now());
  if (session === null) return Response.json({ error: 'Sign in again' }, { status: 401, headers });
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname}`;
  if (route === 'GET /api/admin/commands') return Response.json({ commands: ADMIN_COMMAND_DEFINITIONS }, { headers });
  if (route === 'POST /api/admin/command' || route === 'POST /api/admin/suggest') {
    const body = await readStaffBody(request);
    if (body === null) return Response.json({ error: 'Not a staff page request' }, { status: 400, headers });
    const { name } = body;
    if (!isCommandName(name) || !isAdminCommand(name)) return Response.json({ error: `/${name} is not a staff command` }, { status: 400, headers });
    const tools = commandTools(vars, watcher);
    if (route === 'POST /api/admin/suggest') {
      const options = Object.fromEntries(Object.entries(body.options).map(([key, value]) => [key, String(value)]));
      const focused = body.focused ?? '';
      if (!isOptionOf(name, focused, options['subcommand'])) return Response.json({ choices: [] }, { headers });
      const choices = await tools.suggest({ name, options, userId: session.userId, focused }).catch((error: unknown) => {
        console.error(`/${name} suggestions for the staff page failed: ${errorText(error)}`);
        return [];
      });
      return Response.json({ choices }, { headers });
    }
    // Checked as Discord checks a slash command, then run by the same code, as the signed-in staff member.
    const checked = checkOptions(name, body.options);
    if ('problem' in checked) return Response.json({ error: checked.problem }, { status: 400, headers });
    console.info(`Staff page: /${name} by ${JSON.stringify(session.name)} (Discord user ${session.userId})`);
    try {
      const reply = await tools.run({ name, options: checked.options, userId: session.userId, userName: session.name });
      return Response.json(reply, { headers });
    } catch (error) {
      console.error(`/${name} from the staff page failed: ${errorText(error)}`);
      return Response.json({ error: failureText(name, error) }, { status: 502, headers });
    }
  }
  // The Rotations tab: what it shows, and a change to the saved rotations.
  if (route === 'GET /api/admin/rotations' || route === 'POST /api/admin/rotations') {
    try {
      if (route === 'GET /api/admin/rotations') return Response.json(await watcher().rotationsPage(), { headers });
      const action = await readRotationAction(request);
      if (action === null) return Response.json({ error: 'Not a rotations request' }, { status: 400, headers });
      const what = 'entries' in action ? ` (${action.entries.length} maps)` : 'days' in action ? ` for days ${action.days.join(',')}` : '';
      console.info(
        `Staff page: rotations ${action.action} ${JSON.stringify(action.name)}${what} by ${JSON.stringify(session.name)} (Discord user ${session.userId})`,
      );
      const result = await watcher().rotationsAction(action, session.userId, session.name);
      if ('problem' in result) return Response.json({ error: result.problem }, { status: 400, headers });
      return Response.json(result, { headers });
    } catch (error) {
      console.error(`Staff page rotations failed: ${errorText(error)}`);
      return Response.json({ error: "Couldn't reach the rotations right now. If it was a change, check before trying again." }, { status: 503, headers });
    }
  }
  // The Lines tab: the lines the bot says in game, and a change to them.
  if (route === 'GET /api/admin/lines' || route === 'POST /api/admin/lines') {
    try {
      if (route === 'GET /api/admin/lines') return Response.json(await watcher().linesPage(), { headers });
      const action = await readLinesAction(request);
      if (action === null) return Response.json({ error: 'Not a lines request' }, { status: 400, headers });
      const what = action.action === 'save' ? ` (${action.lines.length} lines)` : '';
      console.info(
        `Staff page: lines ${action.action} ${JSON.stringify(action.list)}${what} by ${JSON.stringify(session.name)} (Discord user ${session.userId})`,
      );
      const result = await watcher().linesAction(action, session.userId, session.name);
      if ('problem' in result) return Response.json({ error: result.problem }, { status: 400, headers });
      return Response.json(result, { headers });
    } catch (error) {
      console.error(`Staff page lines failed: ${errorText(error)}`);
      return Response.json({ error: "Couldn't reach the lines right now. If it was a change, check before trying again." }, { status: 503, headers });
    }
  }
  // A staff member links their Steam account, so the bot never counts them as a seeder, or unlinks one.
  if (route === 'POST /api/admin/profile') {
    const action = await readProfileAction(request);
    if (action === null) return Response.json({ error: 'Not a staff profile request' }, { status: 400, headers });
    try {
      const result = await watcher().staffProfile(action, { id: session.userId, name: session.name });
      if ('problem' in result) return Response.json({ error: result.problem }, { status: 400, headers });
      return Response.json(result, { headers });
    } catch (error) {
      console.error(`Staff profile change failed: ${errorText(error)}`);
      return Response.json({ error: "Couldn't save that just now. Try again in a minute." }, { status: 503, headers });
    }
  }
  const asked = Number(url.searchParams.get('days'));
  const days = ADMIN_PERIODS.find((d) => d === asked) ?? ADMIN_DEFAULT_DAYS;
  // The Kill feed tab: the latest kills and the headshots list, or one player's kills.
  if (route === 'GET /api/admin/kills') {
    const player = url.searchParams.get('player');
    if (player !== null && !/^\d{17}$/.test(player)) return Response.json({ error: 'Not a Steam ID' }, { status: 400, headers });
    try {
      const page = player === null ? await watcher().adminKills(days) : await watcher().adminPlayerKills(player, days);
      return Response.json(page, { headers });
    } catch (error) {
      console.error(`Staff page kills failed: ${errorText(error)}`);
      return Response.json({ error: 'The kill feed is unavailable' }, { status: 503, headers });
    }
  }
  if (route !== 'GET /api/admin/overview') return Response.json({ error: 'Not found' }, { status: 404, headers });
  try {
    const overview = await watcher().adminOverview(days);
    return Response.json({ ...overview, user: { id: session.userId, name: session.name } }, { headers });
  } catch (error) {
    console.error(`Staff page failed: ${errorText(error)}`);
    return Response.json({ error: 'The staff page is unavailable' }, { status: 503, headers });
  }
};

// A refused kill feed post is logged at most this often, so a wrong token does not fill the logs every two seconds.
const REFUSAL_LOG_MS = 10 * 60_000;
let refusalLoggedAt = 0;

// The game's kill feed (see weapons.ts). It is only taken with the KILL_FEED_TOKEN secret as the bearer; without the
// secret, the route is not there.
const ingestKills = async (request: Request, vars: Record<string, string>, watcher: () => DurableObjectStub<Watcher>): Promise<Response> => {
  const token = vars['KILL_FEED_TOKEN']?.trim() ?? '';
  if (token === '') return new Response('Not found', { status: 404 });
  if (token.length < MIN_FEED_TOKEN) {
    console.error(`Kill feed refused: KILL_FEED_TOKEN must be at least ${MIN_FEED_TOKEN} characters`);
    return Response.json({ error: 'KILL_FEED_TOKEN is too short' }, { status: 500 });
  }
  if (!(await feedAuthorized(request.headers.get('authorization'), token))) {
    if (Date.now() - refusalLoggedAt >= REFUSAL_LOG_MS) {
      refusalLoggedAt = Date.now();
      console.error('Kill feed refused: the token does not match KILL_FEED_TOKEN. Check Token under [WDServerFeed] in ServerSettings.ini.');
    }
    return Response.json({ error: 'Unknown kill feed token' }, { status: 401 });
  }
  if (Number(request.headers.get('content-length') ?? 0) > MAX_FEED_BYTES) return Response.json({ error: 'Batch too large' }, { status: 413 });
  // Measured in bytes, as a body sent in chunks has no length up front.
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_FEED_BYTES) return Response.json({ error: 'Batch too large' }, { status: 413 });
  let batch: ReturnType<typeof parseFeed> = null;
  try {
    batch = parseFeed(JSON.parse(new TextDecoder().decode(body)));
  } catch {
    // Not JSON: refused below.
  }
  if (batch === null) return Response.json({ error: 'Not a kill feed batch' }, { status: 400 });
  try {
    const accepted = batch.events.length === 0 ? 0 : await watcher().recordFeed(batch.events);
    return Response.json({ ok: true, accepted, skipped: batch.skipped });
  } catch (error) {
    console.error(`Kill feed batch failed: ${errorText(error)}`);
    return Response.json({ error: 'Could not record the kills' }, { status: 503 });
  }
};

export default {
  async scheduled(_controller, env) {
    await env.WATCHER.get(env.WATCHER.idFromName('watcher')).check();
  },

  // GET /api/stats, /api/players and /api/player feed the community website. The game POSTs its kill feed to
  // /api/ingest/events, after whatever path its Url has. Staff sign in to the website's staff page through /auth/login
  // and read its data from /api/admin/. Slash commands: Discord POSTs signed interactions to this Worker's URL.
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const watcher = () => env.WATCHER.get(env.WATCHER.idFromName('watcher'));
    if (request.method === 'POST' && url.pathname.endsWith(FEED_PATH)) return ingestKills(request, stringVars(env), watcher);
    if (request.method === 'GET' && url.pathname === '/auth/login') return staffLogin(request, stringVars(env));
    if (request.method === 'GET' && url.pathname === CALLBACK_PATH) return staffCallback(request, stringVars(env), watcher);
    if (url.pathname.startsWith('/api/admin/')) return staffApi(request, stringVars(env), watcher);
    // The live page's WebSocket goes straight to the Durable Object, which keeps it.
    if (request.method === 'GET' && url.pathname === '/api/live/socket') return watcher().fetch(request);
    if (request.method === 'GET' && url.pathname.startsWith('/api/')) {
      const route = publicRoute(url, watcher);
      if (route === null) return Response.json({ error: 'Not found' }, { status: 404, headers: PUBLIC_HEADERS });
      try {
        return await serveJson(route.key, route.load, ctx, route.keepMs);
      } catch (error) {
        console.error(`${url.pathname} failed: ${error instanceof Error ? error.message : String(error)}`);
        return Response.json({ error: 'Stats are unavailable' }, { status: 503, headers: { 'access-control-allow-origin': '*' } });
      }
    }
    if (request.method !== 'POST') return new Response('Not found', { status: 404 });
    const vars = stringVars(env);
    const publicKey = vars['DISCORD_PUBLIC_KEY'];
    if (!publicKey) return new Response('DISCORD_PUBLIC_KEY is not set', { status: 500 });
    const { run, suggest } = commandTools(vars, watcher);
    const result = await handleInteraction(
      await request.text(),
      request.headers.get('x-signature-ed25519'),
      request.headers.get('x-signature-timestamp'),
      {
        publicKey,
        // Each staff command also tells the staff page who that Discord user is.
        runCommand: async (request) => {
          const { userId, userName, userHandle } = request;
          const noted =
            isAdminCommand(request.name) && userId && userName
              ? watcher()
                  .noteStaff(userId, userName, userHandle ?? null)
                  .catch((error: unknown) => console.error(`Noting a staff name failed: ${errorText(error)}`))
              : Promise.resolve();
          try {
            return await run(request);
          } finally {
            await noted;
          }
        },
        suggest,
        editReply: editOriginalReply(),
        log: console,
        now: Date.now,
        adminGuildId: vars['DISCORD_GUILD_ID']?.trim() || undefined,
        adminRoleIds: (vars['DISCORD_ADMIN_ROLE_IDS'] ?? '')
          .split(',')
          .map((id) => id.trim())
          .filter((id) => /^\d+$/.test(id)),
      },
    );
    if (result.followUp) {
      ctx.waitUntil(result.followUp().catch((error: unknown) => console.error(`Command reply failed: ${String(error)}`)));
    }
    return Response.json(result.body, { status: result.status });
  },
} satisfies ExportedHandler<Env>;
