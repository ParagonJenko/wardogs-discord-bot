import { connect } from 'cloudflare:sockets';
import { z } from 'zod';
import { DurableObject } from 'cloudflare:workers';
import { withSeedCall } from './alerts.ts';
import { loadConfig } from './config.ts';
import { runCommand, suggestOptions } from './commands.ts';
import { nextMap, parseBoardRef, parseStagedMap, showBoard, type StagedMap } from './board.ts';
import { ADMIN_DEFAULT_DAYS, ADMIN_PERIODS, adminStaffIds, adminSteamIds, buildAdminOverview, staffFor, type AdminOverview } from './admin.ts';
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
  POSTED_ACTIONS,
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
  type MatchRecord,
  type PlayerDay,
  type PlayerTotals,
  type RankedPlayer,
  type SeedCredit,
} from './players.ts';
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
  fetchPlayers,
  fetchRotation,
  fetchSnapshot,
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
  type Period,
  type Roundup,
  type RoundupChoice,
} from './roundup.ts';
import { socketHttp } from './socket-http.ts';
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
import { addVip, parseVipState, removeVip, reservedListing, seederVip, syncVip, vipDue, type ReservedListing, type VipState } from './vip.ts';
import {
  FEED_PATH,
  feedAuthorized,
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
const DAY_MS = 24 * 60 * 60_000;
// How far back staff can pick players who are not online.
const KNOWN_PLAYER_DAYS = 30;
// Suggestions must reach Discord within 3 seconds.
const SUGGEST_TIMEOUT_MS = 2_000;

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
// notice bans made or lifted outside the bot), 'staffNames' (staff's names on Discord, by user ID, for the staff page) and
// 'staffLookupsFailed' (when asking Discord about each of those last failed).
export class Watcher extends DurableObject<Env> {
  // Live pages keep their WebSocket open with a ping now and then, answered without waking the object.
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  // Bans and the reserved list both live in the server's settings file. Changes to them run one at a time, so one
  // never overwrites another, or the VIP state, with what it read before the other finished.
  private serial = oneAtATime();
  // The alerts and /seednow run one at a time, so a check never sends the seeding alert while a seeding call is going out.
  private alerting = oneAtATime();
  // A roundup is posted by one check at a time, so two checks close together cannot both post it.
  private roundingUp = oneAtATime();

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

  private rcon(): { config: Config; http: HttpClient } {
    return { config: loadConfig(stringVars(this.env)), http: socketHttp(connect) };
  }

  private vipRcon({ config, http }: { config: Config; http: HttpClient }) {
    return {
      fetchConfig: () => fetchConfig(config.rconUrl, config.rconPassword, http),
      validate: (text: string) => validateConfig(config.rconUrl, config.rconPassword, text, http),
      put: (serverConfig: ServerConfig) => putConfig(config.rconUrl, config.rconPassword, serverConfig, http),
    };
  }

  // Adds to a player's log, and changes their ban (null lifts it), the VIP state or the bot's copy of the server's ban
  // list (`serverBan`: the ban the bot just put on the server, or null for one it lifted) in the same write. The bot's
  // own bans go on that copy as it makes them, so the next check does not take them for bans made outside the bot.
  // Warnings, kicks, bans, unbans and team moves then go to the moderation log channel.
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
  private posting(): Pick<Config, 'modLogWebhookUrl' | 'griefAlerts' | 'siteUrl'> {
    try {
      return loadConfig(stringVars(this.env));
    } catch (error) {
      console.error(`Moderation log: ${errorText(error)}`);
      return { modLogWebhookUrl: undefined, griefAlerts: false, siteUrl: undefined };
    }
  }

  // Posted in the background, so a slow Discord never holds up a ban or the VIP update queued behind it. A post that
  // fails is logged, not retried: the staff history has the entry either way.
  private postModLog(steamId: string, entry: ModEntry): void {
    if (!POSTED_ACTIONS.includes(entry.action)) return;
    const { modLogWebhookUrl, siteUrl } = this.posting();
    if (modLogWebhookUrl === undefined) return;
    this.ctx.waitUntil(
      postWebhook(modLogWebhookUrl, buildModLogMessage(steamId, entry, siteUrl)).catch((error: unknown) =>
        console.error(`Moderation log post failed (${entry.action} ${steamId}): ${errorText(error)}`),
      ),
    );
  }

  // Possible griefing, to the moderation log channel, when GRIEF_ALERTS is on.
  private postGriefAlerts(alerts: GriefAlert[]): void {
    const { modLogWebhookUrl, griefAlerts, siteUrl } = this.posting();
    for (const alert of alerts) {
      console.info(
        `Possible griefing: ${JSON.stringify(alert.name)} (${alert.steamId}) has ${alert.teamKills} team kills and ` +
          `${alert.vehicleSuicides} vehicle suicides today`,
      );
      if (modLogWebhookUrl === undefined || !griefAlerts) continue;
      this.ctx.waitUntil(
        postWebhook(modLogWebhookUrl, buildGriefAlert(alert, weaponName, siteUrl)).catch((error: unknown) =>
          console.error(`Griefing alert failed (${alert.steamId}): ${errorText(error)}`),
        ),
      );
    }
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

  // From the same records as the player pages. Null when nobody played in the period.
  private async roundupFor(period: Period, now: number): Promise<Roundup | null> {
    const [days, matches] = await Promise.all([this.recentDays(now), this.matchRecords(now)]);
    const covered = new Set(periodDays(period));
    const ids = await this.idsFor(days.flatMap((d) => (covered.has(d.day) ? Object.keys(d.players) : [])));
    return buildRoundup({ period, days, matches, idOf: (steamId) => ids.get(steamId) });
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

  // Every 10 minutes: gives VIP to players who have earned it, and takes it back when their time is up. VIP staff
  // gave ends on time even when automatic VIP is off.
  private async updateVip(config: Config): Promise<void> {
    const rule = config.vip;
    const storage = this.ctx.storage;
    const now = Date.now();
    const state = parseVipState(await storage.get('vip'));
    if (rule === null && Object.keys(state.granted).length === 0) return;
    if (!vipDue(state, now)) return;
    const keys = rule === null ? [] : recentDayKeys(now, rule.windowDays);
    const stored = await storage.get(keys);
    try {
      const next = await syncVip({
        rule,
        days: keys.map((key) => parsePlayerDay(stored.get(key))),
        state,
        now,
        rcon: this.vipRcon({ config, http: socketHttp(connect) }),
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
    const stored = await this.ctx.storage.get([dayKey, griefKey, 'killFeedSince', 'live', 'online', 'state', ...killers.map(playerWeaponsKey)]);
    const oldest = dayOf(now - (PROFILE_DAYS - 1) * DAY_MS);
    const first = typeof stored.get('killFeedSince') !== 'string';
    // The feed does not say who is on which side: the bot's last check does.
    const online = parseOnline(stored.get('online'));
    const tracked = parseState(stored.get('state'))?.match?.players ?? {};
    const factionOf = (steamId: string): string | null =>
      online?.players.find((p) => p.steamId === steamId)?.faction ?? tracked[steamId]?.faction ?? null;
    const grief = hasGrief(fresh, factionOf) ? recordGrief(parseGriefDay(stored.get(griefKey)), fresh, now, factionOf) : null;
    const write = this.ctx.storage.put({
      live: recordLive(parseLiveMatch(stored.get('live')), fresh, now, factionOf),
      ...(grief === null ? {} : { [griefKey]: grief.day }),
      ...(first ? { killFeedSince: day } : {}),
      ...(kills.length === 0 ? {} : { [dayKey]: recordWeaponDay(parseWeaponDay(stored.get(dayKey)), kills) }),
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
    if (first) console.info(`Kill feed: first kills received. Weapon stats start today (${day}, UTC).`);
    if (grief !== null && grief.alerts.length > 0) this.postGriefAlerts(grief.alerts);
    await this.broadcastLive();
    return fresh.length;
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
    const sockets = this.ctx.getWebSockets();
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
    if (this.ctx.getWebSockets().length >= LIVE_VIEWERS) return new Response('Too many live pages open', { status: 503 });
    const snapshot = JSON.stringify(await this.live());
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.send(snapshot);
    return new Response(null, { status: 101, webSocket: client });
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
      this.ctx.storage.get(['stats', 'killFeedSince', 'vip']),
      this.recentDays(now),
      this.recentWeaponDays(now, LEADERBOARD_DAYS),
      this.matchRecords(now),
    ]);
    const stats = parseStats(stored.get('stats'));
    const since = stored.get('killFeedSince');
    const board = leaderboard(days.slice(-LEADERBOARD_DAYS).map((d) => d.players), LEADERBOARD_DAYS, LEADERBOARD_SIZE);
    const seeders = config.vip === null ? null : seederVip(parseVipState(stored.get('vip')), now);
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

  // Each player's totals for every UTC day of the player pages, oldest first, today last.
  private async recentDays(now: number): Promise<DayRecords[]> {
    const keys = recentDayKeys(now, PROFILE_DAYS);
    const fresh = keys.slice(-2);
    const read = keys.filter((key) => fresh.includes(key) || !this.dayCache.has(key));
    const stored = await this.ctx.storage.get(read);
    for (const key of this.dayCache.keys()) if (!keys.includes(key)) this.dayCache.delete(key);
    for (const key of read) if (!fresh.includes(key)) this.dayCache.set(key, parsePlayerDay(stored.get(key)));
    return keys.map((key) => ({
      day: dayOfKey(key),
      players: fresh.includes(key) ? parsePlayerDay(stored.get(key)) : (this.dayCache.get(key) ?? {}),
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
    const [matches, stored] = await Promise.all([
      this.matchRecords(now),
      this.ctx.storage.get(['state', 'vip', 'online', 'killFeedSince', playerWeaponsKey(steamId)]),
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
      rule: config.vip,
      weapons:
        typeof since === 'string'
          ? { since, used: playerWeaponDays(parsePlayerWeapons(stored.get(playerWeaponsKey(steamId))), days[0]?.day ?? since) }
          : null,
    });
  }

  // The staff page: possible griefers and their incidents over the last `days` UTC days, what staff did in them, and the
  // bans on the server now. The ban list is read from the server; without it the rest still shows.
  async adminOverview(days: number): Promise<AdminOverview> {
    const now = Date.now();
    const griefKeys = Array.from({ length: days }, (_, i) => griefDayKey(now - (days - 1 - i) * DAY_MS));
    const { config } = this.rcon();
    const http = socketHttp(connect, SUGGEST_TIMEOUT_MS);
    const [stored, recent, logs, serverBans, serverConfig] = await Promise.all([
      this.ctx.storage.get([...griefKeys, 'killFeedSince', 'bans', 'vip', STAFF_NAMES_KEY]),
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
    const steamIds = adminSteamIds(grief, modLogs, serverBans, banBook, reserved?.ids ?? []);
    const names = new Map<string, string>();
    for (const [steamId, log] of modLogs) {
      const logged = log.findLast((e) => e.name !== undefined && e.name !== steamId)?.name;
      if (logged !== undefined) names.set(steamId, logged);
    }
    for (const [steamId, ban] of Object.entries(banBook)) names.set(steamId, ban.name);
    for (const [steamId, grant] of Object.entries(vip.granted)) names.set(steamId, grant.name);
    for (const day of grief) for (const [steamId, t] of Object.entries(day.players)) if (t.name !== '') names.set(steamId, t.name);
    for (const day of recent) for (const [steamId, t] of Object.entries(day.players)) names.set(steamId, t.name);
    const ids = await this.idsFor(steamIds);
    const since = stored.get('killFeedSince');
    const staffNames = parseStaffNames(stored.get(STAFF_NAMES_KEY));
    const overview = buildAdminOverview({
      now,
      days,
      feedSince: typeof since === 'string' ? since : null,
      grief,
      playerDays: recent.slice(-days).map((d) => d.players),
      modLogs,
      serverBans,
      banBook,
      nameOf: (steamId) => names.get(steamId),
      idOf: (steamId) => ids.get(steamId),
      staffNames,
      reserved,
      vip,
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
    const stored = await this.ctx.storage.get([...keys, key, 'vip', 'bans']);
    const found = totals(keys.map((k) => parsePlayerDay(stored.get(k)))).find((p) => p.steamId === steamId);
    const vip = parseVipState(stored.get('vip'));
    const log = parseModLog(stored.get(key));
    const ban = parseBanBook(stored.get('bans'))[steamId] ?? null;
    return {
      name: found?.name ?? vip.granted[steamId]?.name ?? ban?.name ?? log.findLast((e) => e.name !== undefined)?.name ?? null,
      totals: found === undefined ? null : withoutId(found),
      vip: vip.granted[steamId] ?? null,
      vipBlockedUntil: vip.revoked[steamId] ?? null,
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

  async vipAdd({ steamId, name, days, by }: Named & { days: number; by: string }): Promise<VipAddResult> {
    return this.serial(async () => {
      const now = Date.now();
      const state = parseVipState(await this.ctx.storage.get('vip'));
      const change = await addVip({ steamId, name, days, now, state, rcon: this.vipRcon(this.rcon()) });
      if (change.outcome === 'already-reserved') {
        // Nothing given, but any block from /vip remove is lifted.
        await this.record(steamId, null, { vip: change.state });
        return { outcome: change.outcome };
      }
      const outcome = change.outcome === 'extended' ? 'extended' : 'added';
      await this.record(steamId, { action: 'vip-add', at: now, by, name, detail: `${days} day${days === 1 ? '' : 's'}` }, { vip: change.state });
      return { outcome, ...(change.until === undefined ? {} : { until: change.until }) };
    });
  }

  async vipRemove({ steamId, name, by }: Named & { by: string }): Promise<VipRemoveResult> {
    return this.serial(async () => {
      const now = Date.now();
      const state = parseVipState(await this.ctx.storage.get('vip'));
      const change = await removeVip({ steamId, now, state, rcon: this.vipRcon(this.rcon()) });
      const outcome = change.outcome === 'removed' ? 'removed' : 'not-reserved';
      await this.record(steamId, { action: 'vip-remove', at: now, by, name }, { vip: change.state });
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
    const stored = await this.ctx.storage.get([...keys, 'vip']);
    const { granted } = parseVipState(stored.get('vip'));
    return rankSeeders(keys.map((key) => parsePlayerDay(stored.get(key))), SEEDERS_LISTED).map((p) => ({
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
  if (route !== 'GET /api/admin/overview') return Response.json({ error: 'Not found' }, { status: 404, headers });
  const asked = Number(url.searchParams.get('days'));
  const days = ADMIN_PERIODS.find((d) => d === asked) ?? ADMIN_DEFAULT_DAYS;
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
