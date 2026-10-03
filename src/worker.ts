import { connect } from 'cloudflare:sockets';
import { DurableObject } from 'cloudflare:workers';
import { handleAdmin, type TenantAdmin, type TenantView } from './admin.ts';
import { withSeedCall } from './alerts.ts';
import { loadConfig, loadSettings, parseSecrets, SECRET_NAMES, SETTING_NAMES, type SecretName, type Settings } from './config.ts';
import { runCommand, suggestOptions } from './commands.ts';
import { nextMap, parseBoardRef, parseStagedMap, showBoard, type StagedMap } from './board.ts';
import { buildLiveStatus, buildRoundupMessage, buildVipMessage, mapName, postWebhook } from './discord.ts';
import {
  editOriginalReply,
  handleInteraction,
  type Choice,
  type CommandReply,
  type CommandRequest,
  type TenantHandlers,
} from './interactions.ts';
import { fetchInviteCounts } from './invite.ts';
import type { Config } from './config.ts';
import type { DiscordMessage, SeederRow } from './discord.ts';
import {
  appendMod,
  BAN_LENGTHS,
  banReason,
  expiredBans,
  isBotBan,
  modLogKey,
  parseBanBook,
  joinWork,
  parseModLog,
  type BanRecord,
  type ModEntry,
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
  fetchStatus,
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
import {
  changeSettings,
  isSettingName,
  mergeSecrets,
  rconChanged,
  settingsEmbed,
  setupReply,
  webhookProblem,
  webhooksChanged,
  type SaveSecretsResult,
} from './setup.ts';
import { socketHttp } from './socket-http.ts';
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
  publicStats,
  recordDiscord,
  recordMatch,
  recordObservation,
  removeRecentMatch,
  type Observation,
  type PublicStats,
  type RecentMatch,
  type SiteStats,
} from './stats.ts';
import {
  afterCheck,
  applyTenantInput,
  maxTenants,
  MinuteBudget,
  objectName,
  parseHealth,
  parseTenantRecord,
  TENANT_ID,
  type Health,
  type TenantRecord,
} from './tenants.ts';
import { matchMap, settleWin, summarise, type MatchState } from './tracking.ts';
import { masterKeys, seal, unseal } from './vault.ts';
import { addVip, parseVipState, removeVip, syncVip, vipDue, type VipState } from './vip.ts';

// Secrets: DISCORD_PUBLIC_KEY (the Discord application every community uses), TENANT_SECRETS_KEY (encrypts each
// community's secrets) and ADMIN_TOKEN (the operator's API). See the README.
type Env = {
  WATCHER: DurableObjectNamespace<Watcher>;
  REGISTRY: DurableObjectNamespace<Registry>;
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
const DAY_MS = 24 * 60 * 60_000;
// How far back staff can pick players who are not online.
const KNOWN_PLAYER_DAYS = 30;
// Suggestions must reach Discord within 3 seconds.
const SUGGEST_TIMEOUT_MS = 2_000;

// A server that stopped answering this recently is most likely slow, not down, so the live status is left as it was.
const OFFLINE_AFTER_MS = 3 * 60_000;

const withoutId = ({ steamId: _id, ...rest }: RankedPlayer): PlayerTotals => rest;

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

type Log = { info: (message: string) => void; error: (message: string) => void };

// Every line a community's Durable Object logs starts with its id, so the operator can tell communities apart.
const tenantLog = (id: string): Log => ({
  info: (message) => console.info(`[${id}] ${message}`),
  error: (message) => console.error(`[${id}] ${message}`),
});

// Suggestions are allowed this many times a community's command limit: Discord asks for them as staff type.
const SUGGESTIONS_PER_COMMAND = 5;
const SLOW_DOWN = 'The bot is getting a lot of commands from this server right now. Try again in a minute.';
const PAUSED = 'The bot is paused for this server. Ask whoever runs the bot.';
const NOT_THIS_SERVER = "This Discord server isn't connected to the bot. Ask whoever runs the bot to add it.";

// A community's settings, and its secrets once decrypted, as stored in its Durable Object.
type Stored = { settings: Record<string, string>; secrets: Partial<Record<SecretName, string>> };

const pick = (values: Partial<Record<string, string>>, names: readonly string[]): Record<string, string> =>
  Object.fromEntries(names.flatMap((name) => (values[name] ? [[name, values[name]]] : [])));

// Runs work one at a time, in the order it was asked for. A failure does not hold up what comes after it.
const oneAtATime = () => {
  let queue: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work);
    queue = run.catch(() => undefined);
    return run;
  };
};

// Each community has a Durable Object of its own, which holds everything the bot knows about it, so one community's
// records, settings and secrets are never in the same storage as another's. The first community it is used for owns it
// for good: it refuses to act for any other. Storage keys: 'tenant' (the community, as the operator last set it),
// 'settings' (what its admins set with /settings), 'secrets' (the RCON address and password and the webhooks,
// encrypted), 'health' (whether the game server answers, to check one that does not less often), 'purgedAt' (when the
// operator deleted the community), 'state' (alerts and the match in progress), 'stats' (public, for /api/stats), the private player
// records: 'players:<UTC date>' (each player's totals that day) and 'match:<start time>' (each finished match),
// 'vip' (who the bot put on the reserved list, and until when), 'mod:<Steam ID>' (what staff did to that player through
// the bot), 'bans' (the bans the bot made, and when the timed ones end), 'board' (which Discord message is the live
// status), 'nextMap' (the map staff set to play next), 'playerIdKey' (the key for players' public ids), 'online' (who
// was in game at the last check that reached the server), 'seedCall' (when staff last sent /seednow), 'winsSettled'
// (set once the matches saved before settleWin have been put right) and 'roundups' (the first day of the last week and
// month whose roundup went out).
export class Watcher extends DurableObject<Env> {
  private tenant: TenantRecord | null = null;
  // What callers are waiting on now, so deleting the community can let it finish first.
  private inFlight = new Set<Promise<unknown>>();
  // Set while the community is deleted, and after, until it is added again.
  private purging = false;
  private log: Log = console;
  private stored: Promise<Stored> | null = null;
  // Limits on what the community's website and Discord server can ask of it each minute.
  private reads = new MinuteBudget();
  private commands = new MinuteBudget();
  private suggestions = new MinuteBudget();

  // Bans and the reserved list both live in the server's settings file. Changes to them run one at a time, so one
  // never overwrites another, or the VIP state, with what it read before the other finished.
  private serial = oneAtATime();
  // The alerts and /seednow run one at a time, so a check never sends the seeding alert while a seeding call is going out.
  private alerting = oneAtATime();
  // A roundup is posted by one check at a time, so two checks close together cannot both post it.
  private roundingUp = oneAtATime();
  // Settings and secrets change one at a time, so two changes made together cannot undo each other.
  private configuring = oneAtATime();

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

  // Takes the community this call is for, and returns it as it now stands. The object belongs to the first community
  // it is used for, and refuses any other, so a mistake in routing can never mix two communities' records. A
  // community the operator deleted and added again (created later) starts afresh. Worker instances can hold a copy of
  // the community up to a minute old, so the newest copy wins: an older one never undoes a suspension or a limit.
  private async adopt(record: TenantRecord): Promise<TenantRecord> {
    if (this.tenant !== null && this.tenant.id !== record.id) {
      throw new Error(`This Durable Object belongs to "${this.tenant.id}", not "${record.id}"`);
    }
    if (this.tenant !== null && this.tenant.updatedAt >= record.updatedAt) return this.tenant;
    const storage = this.ctx.storage;
    const stored = await storage.get(['tenant', 'purgedAt']);
    const known = parseTenantRecord(stored.get('tenant'));
    if (known !== null && known.id !== record.id) throw new Error(`This Durable Object belongs to "${known.id}", not "${record.id}"`);
    const purgedAt = stored.get('purgedAt');
    if (typeof purgedAt === 'number' && record.createdAt <= purgedAt) throw new Error(`"${record.id}" was deleted`);
    const current = known !== null && known.updatedAt >= record.updatedAt ? known : record;
    if (current !== known) {
      await storage.put('tenant', current);
      if (purgedAt !== undefined) await storage.delete('purgedAt');
    }
    // Added again after it was deleted: a fresh start.
    if (typeof purgedAt === 'number') this.purging = false;
    this.tenant = current;
    this.log = tenantLog(current.id);
    return current;
  }

  // Every call from outside goes through here. Deleting the community waits for these to finish, and refuses new
  // ones, so nothing they write can outlive the deletion.
  private async run<T>(given: TenantRecord, work: (record: TenantRecord) => Promise<T>): Promise<T> {
    const record = await this.adopt(given);
    if (this.purging) throw new Error(`"${record.id}" is being deleted`);
    const running = work(record);
    this.inFlight.add(running);
    try {
      return await running;
    } finally {
      this.inFlight.delete(running);
    }
  }

  private get id(): string {
    if (this.tenant === null) throw new Error('No community yet');
    return this.tenant.id;
  }

  // The settings and decrypted secrets, read once and kept until they change. The community the bot ran for alone
  // takes its settings and secrets from the Worker's environment the first time, then keeps its own.
  private load(): Promise<Stored> {
    this.stored ??= (async () => {
      const storage = this.ctx.storage;
      const raw = await storage.get(['settings', 'secrets']);
      const settings = (raw.get('settings') ?? {}) as Record<string, string>;
      const sealed = raw.get('secrets');
      if (sealed === undefined) return (await this.importLegacy()) ?? { settings, secrets: {} };
      const keys = masterKeys(this.env);
      const opened = await unseal(keys, this.id, sealed);
      if (opened.stale) {
        await storage.put('secrets', await seal(keys, this.id, opened.values));
        this.log.info('Secrets sealed again with the current TENANT_SECRETS_KEY');
      }
      return { settings, secrets: pick(opened.values, SECRET_NAMES) };
    })().catch((error: unknown) => {
      this.stored = null;
      throw error;
    });
    return this.stored;
  }

  private async importLegacy(): Promise<Stored | null> {
    const record = this.tenant;
    if (record === null || !record.legacy || this.env['LEGACY_TENANT'] !== record.id) return null;
    const vars = stringVars(this.env);
    const secrets = parseSecrets(pick(vars, SECRET_NAMES));
    if ('problems' in secrets) return null;
    const settings = pick(vars, SETTING_NAMES);
    await this.ctx.storage.put({ settings, secrets: await seal(masterKeys(this.env), record.id, pick(secrets.values, SECRET_NAMES)) });
    this.log.info(`Took its settings (${Object.keys(settings).join(', ') || 'none'}) and secrets from the Worker's environment`);
    return { settings, secrets: secrets.values };
  }

  private async config(): Promise<Config> {
    const { settings, secrets } = await this.load();
    if (secrets.RCON_URL === undefined) throw new Error('Not connected to a game server yet: an Administrator can run /setup');
    return loadConfig({ ...settings, ...secrets });
  }

  // Without the secrets, for the website.
  private async settings(): Promise<Settings> {
    return loadSettings((await this.load()).settings);
  }

  private async hasSecrets(): Promise<boolean> {
    return (await this.load()).secrets.RCON_URL !== undefined;
  }

  private async rcon(): Promise<{ config: Config; http: HttpClient }> {
    return { config: await this.config(), http: socketHttp(connect) };
  }

  private vipRcon({ config, http }: { config: Config; http: HttpClient }) {
    return {
      fetchConfig: () => fetchConfig(config.rconUrl, config.rconPassword, http),
      validate: (text: string) => validateConfig(config.rconUrl, config.rconPassword, text, http),
      put: (serverConfig: ServerConfig) => putConfig(config.rconUrl, config.rconPassword, serverConfig, http),
    };
  }

  // Adds to a player's log, and changes their ban (null lifts it) or the VIP state in the same write.
  private async record(steamId: string, entry: ModEntry | null, change: { ban?: BanRecord | null; vip?: VipState } = {}): Promise<void> {
    const key = modLogKey(steamId);
    const stored = await this.ctx.storage.get([key, 'bans']);
    const { [steamId]: _old, ...others } = parseBanBook(stored.get('bans'));
    await this.ctx.storage.put({
      ...(entry === null ? {} : { [key]: appendMod(parseModLog(stored.get(key)), entry) }),
      ...(change.ban === undefined ? {} : { bans: change.ban === null ? others : { ...others, [steamId]: change.ban } }),
      ...(change.vip === undefined ? {} : { vip: change.vip }),
    });
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
  // The operator can turn them off for a community (joinChecks), as they are the most Durable Object alarms it uses.
  private async startJoinChecks(config: Config, record: TenantRecord): Promise<void> {
    if (config.seedingMessages === null || !record.limits.joinChecks) return;
    try {
      const storage = this.ctx.storage;
      if (parseState(await storage.get('state'))?.alerts.phase !== 'seeding') return;
      if ((await storage.getAlarm()) === null) await storage.setAlarm(Date.now() + JOIN_CHECK_MS);
    } catch (error) {
      this.log.error(`Starting join checks failed: ${errorText(error)}`);
    }
  }

  // One quick join check. It runs with the alerts, so it never saves the state while a check is part-way through. A
  // suspended community, or one whose join checks were turned off, stops having them.
  async alarm(): Promise<void> {
    const stored = this.tenant ?? parseTenantRecord(await this.ctx.storage.get('tenant'));
    if (stored === null) return;
    // A failure is logged rather than thrown, so the runtime does not retry the alarm.
    await this.run(stored, (record) => this.joinCheck(record)).catch((error: unknown) => this.log.error(`Join check failed: ${errorText(error)}`));
  }

  private async joinCheck(record: TenantRecord): Promise<void> {
    if (record.status !== 'active' || !record.limits.joinChecks) return;
    let rcon: { config: Config; http: HttpClient };
    try {
      rcon = await this.rcon();
    } catch (error) {
      this.log.error(`Join check skipped: ${errorText(error)}`);
      return;
    }
    const { config, http } = rcon;
    const joinCheck = createJoinCheck({
      config,
      fetchPlayers: () => fetchPlayers(config.rconUrl, config.rconPassword, http),
      broadcast: (message) => sendBroadcast(config.rconUrl, config.rconPassword, message, http),
      now: Date.now,
      log: this.log,
      store: this.stateStore(),
    });
    if (await this.alerting(joinCheck)) await this.ctx.storage.setAlarm(Date.now() + JOIN_CHECK_MS);
  }

  private async updateStats(change: (stats: SiteStats) => SiteStats): Promise<void> {
    const storage = this.ctx.storage;
    await storage.put('stats', change(parseStats(await storage.get('stats'))));
  }

  // One write for the site's stats, who is online and today's player totals.
  private async recordCheck(observation: Observation, minutes: number, busyThreshold: number): Promise<void> {
    const dayKey = playerDayKey(observation.at);
    const stored = await this.ctx.storage.get(['stats', dayKey]);
    const stats = recordObservation(parseStats(stored.get('stats')), observation, minutes, busyThreshold);
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
      this.log.info(`Settled wins saved one point short: ${records} match records, ${recent} recent matches`);
    } catch (error) {
      this.log.error(`Settling saved wins failed: ${errorText(error)}`);
    }
  }

  // The cron calls this every minute for each active community. Nothing happens until the community has set up its
  // game server, and a game server that stops answering is checked less often (see afterCheck).
  async check(given: TenantRecord): Promise<void> {
    return this.run(given, (record) => this.checkNow(record));
  }

  private async checkNow(record: TenantRecord): Promise<void> {
    if (record.status !== 'active' || !(await this.hasSecrets())) return;
    const storage = this.ctx.storage;
    const health = parseHealth(await storage.get('health'));
    if (health.nextCheckAt > Date.now()) return;
    // The cron fires every minute whatever POLL_INTERVAL_SECONDS says, and seeding minutes are counted per check.
    const config = { ...(await this.config()), pollIntervalMs: 60_000 };
    await this.settleSavedWins(config.scoreToWin);
    const minutesPerCheck = config.pollIntervalMs / 60_000;
    // What this check read from the server, for the live status.
    const seen: { snapshot: Snapshot | null } = { snapshot: null };
    const poll = createPoller({
      config,
      fetchSnapshot: async () => (seen.snapshot = await fetchSnapshot(config.rconUrl, config.rconPassword, socketHttp(connect))),
      send: (message) => postWebhook(config.webhookUrl, message),
      broadcast: (message) => sendBroadcast(config.rconUrl, config.rconPassword, message, socketHttp(connect)),
      now: Date.now,
      log: this.log,
      store: this.stateStore(),
      stats: {
        check: (observation) => this.recordCheck(observation, minutesPerCheck, config.busyThreshold),
        seeded: (seeders, at) => this.recordSeed(seeders, at, config.seedMinutes),
        matchEnded: (match, at) => this.recordMatchEnd(match, at),
      },
    });
    await this.alerting(poll);
    await this.recordHealth(health, seen.snapshot !== null);
    // Join checks only run while the server answers: one that has stopped answering would otherwise be read every 5
    // seconds, whatever the backoff above.
    if (seen.snapshot === null) await storage.deleteAlarm();
    else await this.startJoinChecks(config, record);
    await this.updateBoard(config, seen.snapshot);
    await this.serial(() => this.expireBans(config));
    await this.serial(() => this.applyWaitingBans(config, seen.snapshot));
    await this.serial(() => this.updateVip(config));

    const { inviteCode } = config;
    if (inviteCode && discordDue(parseStats(await storage.get('stats')), Date.now())) {
      try {
        const counts = await fetchInviteCounts(inviteCode, Date.now());
        await this.updateStats((stats) => recordDiscord(stats, counts));
      } catch (error) {
        this.log.error(`Discord member count failed: ${errorText(error)}`);
      }
    }
    await this.roundingUp(() => this.postRoundups(config));
  }

  private async recordHealth(health: Health, reached: boolean): Promise<void> {
    const next = afterCheck(health, reached, Date.now());
    if (next.failures === health.failures && next.nextCheckAt === health.nextCheckAt) return;
    await this.ctx.storage.put('health', next);
    if (reached && health.failures >= 15) this.log.info(`The game server answers again, after ${health.failures} checks: checking every minute`);
    if (next.failures === 15 || next.failures === 60) {
      this.log.error(`The game server has not answered ${next.failures} checks in a row: checking every ${next.failures === 15 ? 5 : 15} minutes`);
    }
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
          this.log.info(roundup === null ? `No ${label}: nobody played` : `Posted the ${label}`);
        } catch (error) {
          this.log.error(`The ${label} failed, trying again next check: ${errorText(error)}`);
        }
      }
    } catch (error) {
      this.log.error(`Roundups failed: ${errorText(error)}`);
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
  private async roundup(choice: RoundupChoice): Promise<Roundup | null> {
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
        this.log.info(`Posted the live status (message ${shown.messageId})`);
      }
    } catch (error) {
      this.log.error(`Live status update failed: ${errorText(error)}`);
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
          this.log.info(`Ban ended: ${label} ${why}`);
          continue;
        }
        await removeBan(config.rconUrl, config.rconPassword, steamId, http);
        await this.record(steamId, { action: 'unban', at: now, by: 'bot', name: ban.name, reason: 'The ban ran out' }, { ban: null });
        this.log.info(`Ban ended: ${label}`);
      }
    } catch (error) {
      this.log.error(`Lifting ended bans failed: ${errorText(error)}`);
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
      // Saves the ban as on the server, with a kick still owed or not.
      const applied = async (steamId: string, kicking: boolean): Promise<void> => {
        const old = book[steamId];
        if (old === undefined) return;
        const { waiting: _waiting, kicking: _kicking, ...ban } = old;
        book[steamId] = kicking ? { ...ban, kicking } : ban;
        await this.record(steamId, null, { ban: book[steamId] });
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
          if (!isNotInGame(error)) this.log.error(`Waiting ban on ${label(steamId)} failed: ${errorText(error)}`);
          continue;
        }
        await applied(steamId, true);
        this.log.info(`Ban put on the server as they joined: ${label(steamId)}`);
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
            this.log.error(`Kick after the waiting ban on ${label(steamId)} failed, trying again next check: ${errorText(error)}`);
            continue;
          }
        }
        await applied(steamId, false);
      }
    } catch (error) {
      this.log.error(`Waiting bans failed: ${errorText(error)}`);
    }
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
          this.log.error(`VIP announcement failed: ${errorText(error)}`),
        );
      }
    } catch (error) {
      this.log.error(`VIP update failed: ${errorText(error)}`);
      // Try again at the next 10-minute mark rather than on every check.
      await storage.put('vip', { ...state, checkedAt: now });
    }
  }

  private async stats(): Promise<PublicStats> {
    const config = await this.settings();
    const now = Date.now();
    const [stored, days] = await Promise.all([this.ctx.storage.get('stats'), this.recentDays(now)]);
    const stats = parseStats(stored);
    const board = leaderboard(days.slice(-LEADERBOARD_DAYS).map((d) => d.players), LEADERBOARD_DAYS, LEADERBOARD_SIZE);
    const ids = await this.idsFor(namedSteamIds(stats, board));
    const { seeding, live } = config.rules;
    return publicStats(stats, { seeding, live, busy: config.busyThreshold }, now, { leaderboard: board, vip: config.vip }, (steamId) =>
      ids.get(steamId),
    );
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
  private async players(): Promise<PlayerDirectory> {
    const now = Date.now();
    const [days, stored] = await Promise.all([this.recentDays(now), this.ctx.storage.get('online')]);
    const ids = await this.idsFor(days.flatMap((d) => Object.keys(d.players)));
    const online = new Set(this.onlineNow(now, stored)?.players.map((p) => p.steamId));
    return directory(days, (steamId) => ids.get(steamId), online, now);
  }

  // One player's page, by public id. Null when nobody seen in the last PROFILE_DAYS days has that id.
  private async profile(id: string): Promise<PlayerProfile | null> {
    const now = Date.now();
    const days = await this.recentDays(now);
    const ids = await this.idsFor(days.flatMap((d) => Object.keys(d.players)));
    const steamId = [...ids].find(([, known]) => known === id)?.[0];
    if (steamId === undefined) return null;
    const [matches, stored] = await Promise.all([this.matchRecords(now), this.ctx.storage.get(['state', 'vip', 'online'])]);
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
    const config = await this.settings();
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
    });
  }

  // Recent matches, newest first, to pick from in /removematch.
  private async recentMatches(): Promise<RecentMatch[]> {
    return parseStats(await this.ctx.storage.get('stats')).matches;
  }

  // Deletes a match recorded by mistake: from the recent matches, its private record, and its players' totals for
  // the day it was credited to. Returns null if no recent match ended at that time.
  private async removeMatch(endedAt: number): Promise<{ match: RecentMatch; players: number } | null> {
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
  private async playerRecord(steamId: string): Promise<PlayerRecord> {
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
  private async knownPlayers(): Promise<Named[]> {
    const keys = recentDayKeys(Date.now(), KNOWN_PLAYER_DAYS);
    const stored = await this.ctx.storage.get([...keys, 'vip', 'bans']);
    const seen = totals(keys.map((k) => parsePlayerDay(stored.get(k))));
    const vip = Object.entries(parseVipState(stored.get('vip')).granted);
    const bans = Object.entries(parseBanBook(stored.get('bans')));
    const all = [...seen, ...[...vip, ...bans].map(([steamId, { name }]) => ({ steamId, name }))];
    const ids = new Set<string>();
    return all.filter((p) => !ids.has(p.steamId) && ids.add(p.steamId)).map(({ steamId, name }) => ({ steamId, name }));
  }

  private async logAction(steamId: string, entry: ModEntry): Promise<void> {
    await this.record(steamId, entry);
  }

  // Bans a player on the server, and remembers when a timed ban ends so the bot can lift it. A player who is already
  // banned is left as they are, so no ban is ever lifted to change it: staff /unban first. The game only bans players
  // who are in game, so for anyone else the ban waits, and the check that next sees them puts it on the server.
  private async ban({ steamId, name, length, reason, by }: BanRequest): Promise<BanResult> {
    const option = BAN_LENGTHS.find((l) => l.value === length);
    if (option === undefined) throw new Error(`Unknown ban length: ${length}`);
    return this.serial(async () => {
      const { config, http } = await this.rcon();
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
          await this.record(steamId, { action: 'ban', at, by, name, reason, detail }, { ban: { ...ban, waiting: true } });
          return { outcome: 'banned', until, byBot: true, waiting: true };
        }
        if (error instanceof RconError) await this.record(steamId, null, { ban: null });
        throw error;
      }
      await this.record(steamId, { action: 'ban', at, by, name, reason, detail: option.name });
      return { outcome: 'banned', until, byBot: true };
    });
  }

  // False when they had no ban: none on the server, and none waiting for them to join. The bot forgets its own record
  // of the ban either way.
  private async unban({ steamId, name }: Named, by: string): Promise<boolean> {
    return this.serial(async () => {
      const { config, http } = await this.rcon();
      const waiting = parseBanBook(await this.ctx.storage.get('bans'))[steamId]?.waiting === true;
      const removed = (await removeBan(config.rconUrl, config.rconPassword, steamId, http)) || waiting;
      await this.record(steamId, removed ? { action: 'unban', at: Date.now(), by, name } : null, { ban: null });
      return removed;
    });
  }

  private async vipAdd({ steamId, name, days, by }: Named & { days: number; by: string }): Promise<VipAddResult> {
    return this.serial(async () => {
      const now = Date.now();
      const state = parseVipState(await this.ctx.storage.get('vip'));
      const change = await addVip({ steamId, name, days, now, state, rcon: this.vipRcon(await this.rcon()) });
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

  private async vipRemove({ steamId, name, by }: Named & { by: string }): Promise<VipRemoveResult> {
    return this.serial(async () => {
      const now = Date.now();
      const state = parseVipState(await this.ctx.storage.get('vip'));
      const change = await removeVip({ steamId, now, state, rcon: this.vipRcon(await this.rcon()) });
      const outcome = change.outcome === 'removed' ? 'removed' : 'not-reserved';
      await this.record(steamId, { action: 'vip-remove', at: now, by, name }, { vip: change.state });
      return { outcome };
    });
  }

  // Notes the map staff set to play next, and the map being played now: once the server leaves that, it has been played.
  // The map being played comes from the server when staff set it, or else from the last check.
  private async stageNextMap(map: string, playing: string | null): Promise<void> {
    const match = playing ? null : (parseState(await this.ctx.storage.get('state'))?.match ?? null);
    const fromMap = playing || (match === null ? '' : matchMap(match));
    if (fromMap === '') return;
    const staged: StagedMap = { map, fromMap, at: Date.now() };
    await this.ctx.storage.put('nextMap', staged);
  }

  // Posts a /seednow call. Its time is saved first, so the automatic seeding alert holds back even when the post times
  // out after Discord took it.
  private async seedCall(message: DiscordMessage): Promise<void> {
    const { webhookUrl } = await this.config();
    await this.alerting(async () => {
      await this.ctx.storage.put('seedCall', Date.now());
      await postWebhook(webhookUrl, message);
    });
  }

  // The top seeders over the last `days` UTC days, including today, and who has VIP from the bot.
  private async seeders(days: number): Promise<SeederRow[]> {
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

  private staffRecords(): StaffRecords {
    return {
      player: (steamId) => this.playerRecord(steamId),
      knownPlayers: () => this.knownPlayers(),
      log: (steamId, entry) => this.logAction(steamId, entry),
      ban: (ban) => this.ban(ban),
      unban: (target, by) => this.unban(target, by),
      vipAdd: (grant) => this.vipAdd(grant),
      vipRemove: (target) => this.vipRemove(target),
      nextMap: (map, playing) => this.stageNextMap(map, playing),
    };
  }

  // The community's website: its stats, everyone to find a player page for, and one player's page. Null is a 404.
  async publicRead(
    given: TenantRecord,
    what: 'stats' | 'players' | 'player',
    id = '',
  ): Promise<{ status: 200; value: unknown } | { status: 404 | 429 }> {
    return this.run(given, (record) => this.read(record, what, id));
  }

  private async read(record: TenantRecord, what: 'stats' | 'players' | 'player', id: string): Promise<{ status: 200; value: unknown } | { status: 404 | 429 }> {
    if (record.status !== 'active' || !record.limits.publicApi) return { status: 404 };
    if (!this.reads.take(record.limits.publicReadsPerMinute, Date.now())) return { status: 429 };
    if (what === 'stats') return { status: 200, value: await this.stats() };
    if (what === 'players') return { status: 200, value: await this.players() };
    const profile = await this.profile(id);
    return profile === null ? { status: 404 } : { status: 200, value: profile };
  }

  // A slash command from the community's Discord server. It runs here, so the RCON password never leaves this object.
  // `guildId` is the Discord server it came from: a Worker's list of communities can be a minute old, so a server the
  // community has just moved from is refused here, by its newest record.
  async command(given: TenantRecord, guildId: string, request: CommandRequest): Promise<CommandReply> {
    return this.run(given, (record) => (record.guildId === guildId ? this.commandNow(record, request) : Promise.resolve({ content: NOT_THIS_SERVER })));
  }

  private async commandNow(record: TenantRecord, request: CommandRequest): Promise<CommandReply> {
    if (record.status !== 'active') return { content: PAUSED };
    if (!this.commands.take(record.limits.commandsPerMinute, Date.now())) return { content: SLOW_DOWN };
    if (request.name === 'settings') return this.settingsCommand(record, request);
    // Read lazily, so /lastmatch and /roundup still work before the game server is set up.
    const loaded: Config | Error = await this.config().catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
    const config = (): Config => {
      if (loaded instanceof Error) throw loaded;
      return loaded;
    };
    return runCommand({
      config,
      http: socketHttp(connect),
      lastMatch: async () => (await this.recentMatches())[0] ?? null,
      roundup: (choice) => this.roundup(choice),
      seeders: (days) => this.seeders(days),
      removeMatch: (endedAt) => this.removeMatch(endedAt),
      seedCall: (message) => this.seedCall(message),
      records: this.staffRecords(),
      now: Date.now,
      log: this.log,
    })(request);
  }

  async suggest(given: TenantRecord, guildId: string, request: CommandRequest): Promise<Choice[]> {
    return this.run(given, (record) => (record.guildId === guildId ? this.suggestNow(record, request) : Promise.resolve([])));
  }

  private async suggestNow(record: TenantRecord, request: CommandRequest): Promise<Choice[]> {
    if (record.status !== 'active') return [];
    if (!this.suggestions.take(record.limits.commandsPerMinute * SUGGESTIONS_PER_COMMAND, Date.now())) return [];
    const config = await this.config();
    return suggestOptions({
      recentMatches: () => this.recentMatches(),
      config: () => config,
      http: socketHttp(connect, SUGGEST_TIMEOUT_MS),
      records: this.staffRecords(),
    })(request);
  }

  async adminRoleIds(given: TenantRecord, guildId: string): Promise<string[]> {
    return this.run(given, async (record) => (record.guildId === guildId ? (await this.settings()).adminRoleIds : []));
  }

  private async settingsCommand(record: TenantRecord, { options, userId }: CommandRequest): Promise<CommandReply> {
    const subcommand = options['subcommand'];
    if (subcommand === 'set' || subcommand === 'reset') {
      const name = options['name'];
      if (!isSettingName(name)) return { content: 'Pick a setting from the list.' };
      const result = await this.saveSettings(record, { [name]: subcommand === 'set' ? (options['value'] ?? '') : null }, `Discord user ${userId ?? 'unknown'}`);
      if (!result.ok) return { content: `❌ Not changed: ${result.problem}` };
      const value = result.settings[name];
      return { content: value === undefined ? `✅ \`${name}\` is back to its default.` : `✅ \`${name}\` is now **${value}**.` };
    }
    const { settings, secrets } = await this.load();
    const server = parseStats(await this.ctx.storage.get('stats')).server;
    const connected = secrets.RCON_URL === undefined ? null : (server?.name ?? 'your game server (not reached yet)');
    const secretsSet = SECRET_NAMES.filter((name) => secrets[name] !== undefined);
    return { embeds: [settingsEmbed(settings, secretsSet, record.limits, connected)] };
  }

  // From /settings or the operator's API.
  async saveSettings(
    given: TenantRecord,
    changes: Record<string, string | null>,
    by: string,
  ): Promise<{ ok: true; settings: Record<string, string> } | { ok: false; problem: string }> {
    return this.run(given, () =>
      this.configuring(async () => {
        const result = changeSettings((await this.load()).settings, changes);
        if ('problem' in result) return { ok: false as const, problem: result.problem };
        await this.ctx.storage.put('settings', result.settings);
        this.stored = null;
        const said = Object.entries(changes).map(([name, value]) => `${name}=${value === null ? 'default' : JSON.stringify(value)}`);
        this.log.info(`Settings changed by ${by}: ${said.join(', ')}`);
        return { ok: true as const, settings: result.settings };
      }),
    );
  }

  // From the /setup form or the operator's API. A new RCON address or password is only saved once the game server
  // answers to it, and a new webhook once Discord says it is in the community's own server. Only the names of what
  // changed are logged.
  async saveSecrets(given: TenantRecord, change: Record<string, string>, by: string): Promise<SaveSecretsResult> {
    return this.run(given, (record) => this.saveSecretsNow(record, change, by));
  }

  private async saveSecretsNow(record: TenantRecord, change: Record<string, string>, by: string): Promise<SaveSecretsResult> {
    return this.configuring(async (): Promise<SaveSecretsResult> => {
      const merged = mergeSecrets((await this.load()).secrets, change);
      if ('problems' in merged) return { ok: false, problems: merged.problems };
      if (merged.changed.length === 0) return { ok: true, changed: [], server: null };
      const { values } = merged;
      let server: { name: string; players: number; maxPlayers: number } | null = null;
      if (rconChanged(merged.changed)) {
        try {
          const status = await fetchStatus(values.RCON_URL ?? '', values.RCON_PASSWORD ?? '', socketHttp(connect));
          server = { name: status.name, players: status.players, maxPlayers: status.maxPlayers };
        } catch (error) {
          return { ok: false, problems: [`The game server did not answer: ${errorText(error)}`] };
        }
      }
      for (const name of webhooksChanged(merged.changed)) {
        const url = values[name];
        const problem = url === undefined ? null : await webhookProblem(url, record.guildId);
        if (problem !== null) return { ok: false, problems: [`${name}: ${problem}`] };
      }
      await this.ctx.storage.put('secrets', await seal(masterKeys(this.env), record.id, pick(values, SECRET_NAMES)));
      this.stored = null;
      this.log.info(`Secrets changed by ${by}: ${merged.changed.join(', ')}`);
      return { ok: true, changed: merged.changed, server };
    });
  }

  async submitSetup(given: TenantRecord, guildId: string, values: Record<string, string>, userId: string | null): Promise<CommandReply> {
    return this.run(given, async (record) => {
      if (record.guildId !== guildId) return { content: NOT_THIS_SERVER };
      if (record.status !== 'active') return { content: PAUSED };
      // Each one may open a connection to the address given, so it counts as a command.
      if (!this.commands.take(record.limits.commandsPerMinute, Date.now())) return { content: SLOW_DOWN };
      return { content: setupReply(await this.saveSecretsNow(record, values, `Discord user ${userId ?? 'unknown'}`)) };
    });
  }

  // For the operator: settings, which secrets are set (never what they are), and whether the game server answers.
  async view(given: TenantRecord): Promise<TenantView> {
    return this.run(given, async () => {
      const [{ settings, secrets }, stored] = await Promise.all([this.load(), this.ctx.storage.get(['health', 'stats'])]);
      const server = parseStats(stored.get('stats')).server;
      return {
        settings,
        secretsSet: SECRET_NAMES.filter((name) => secrets[name] !== undefined),
        health: parseHealth(stored.get('health')),
        server: server === null ? null : { name: server.name, seenAt: server.seenAt },
      };
    });
  }

  async testConnection(given: TenantRecord): ReturnType<TenantAdmin['test']> {
    return this.run(given, async () => {
      try {
        const { config, http } = await this.rcon();
        const status = await fetchStatus(config.rconUrl, config.rconPassword, http);
        return { ok: true as const, server: { name: status.name, players: status.players, maxPlayers: status.maxPlayers } };
      } catch (error) {
        return { ok: false as const, problem: errorText(error) };
      }
    });
  }

  // Deletes everything the bot holds for the community. New calls are refused at once, and calls still running finish
  // first, so nothing they write survives. The object then refuses the community, unless it is added again.
  async purge(given: TenantRecord): Promise<void> {
    await this.adopt(given);
    this.purging = true;
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.put('purgedAt', Date.now());
    this.log.info('Deleted every record');
    this.tenant = null;
    this.stored = null;
    this.dayCache.clear();
    this.matchCache.clear();
    this.ids.clear();
    this.idKey = null;
    this.winsSettled = false;
  }
}

// The list of communities: who they are, their Discord server, and the operator's limits. No secrets, settings or
// records: those are in each community's own Durable Object. One instance, named 'registry'.
export class Registry extends DurableObject<Env> {
  async list(): Promise<TenantRecord[]> {
    const stored = await this.ctx.storage.list({ prefix: 'tenant:' });
    return [...stored.values()].flatMap((raw) => {
      const record = parseTenantRecord(raw);
      return record === null ? [] : [record];
    });
  }

  // Only storage is awaited between reading the list and writing, so two changes cannot interleave.
  async put(id: string, input: unknown): Promise<{ record: TenantRecord } | { error: string }> {
    const result = applyTenantInput(await this.list(), id, input, Date.now(), maxTenants(this.env['MAX_TENANTS']));
    if ('record' in result) await this.ctx.storage.put(`tenant:${id}`, result.record);
    return result;
  }

  async remove(id: string): Promise<void> {
    await this.ctx.storage.delete(`tenant:${id}`);
  }
}

// The stats only change once a minute. Each Worker instance keeps its last answers for a short while so a busy page
// does not wake the Durable Object on every request. Requests that arrive while a refresh is in flight wait for that
// one instead of starting their own. Answers are kept by community, so one community's are never served for another.
const CACHE_MS = 30_000;
// One answer per player page; past this many, the oldest are dropped.
const CACHE_ENTRIES = 500;
type Answer = { status: number; body: string };
const cache = new Map<string, { answer: Promise<Answer>; at: number }>();

// Public, read-only numbers, so any site may show them.
const PUBLIC_HEADERS = { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=30', 'x-content-type-options': 'nosniff' };

const ERRORS: Record<number, string> = { 404: 'Not found', 429: 'Too many requests for this community; try again in a minute' };

const publicError = (status: number, error = ERRORS[status] ?? 'Stats are unavailable'): Response =>
  Response.json({ error }, { status, headers: { ...PUBLIC_HEADERS, ...(status === 429 ? { 'retry-after': '30' } : {}) } });

type Read = { status: 200; value: unknown } | { status: 404 | 429 };

const serveJson = async (key: string, load: () => Promise<Read>, ctx: ExecutionContext): Promise<Response> => {
  const now = Date.now();
  let entry = cache.get(key);
  if (entry === undefined || now - entry.at >= CACHE_MS) {
    const fresh = {
      answer: load().then((read): Answer => (read.status === 200 ? { status: 200, body: JSON.stringify(read.value) } : { status: read.status, body: '' })),
      at: now,
    };
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
      fresh.answer.catch(() => {
        if (cache.get(key) === fresh) cache.delete(key);
      }),
    );
  }
  const answer = await entry.answer;
  if (answer.status !== 200) return publicError(answer.status);
  return new Response(answer.body, { headers: { 'content-type': 'application/json; charset=utf-8', ...PUBLIC_HEADERS } });
};

// The communities, by id and by Discord server. Each Worker instance reads the list at most once a minute, so a request
// for a community or Discord server that does not exist never reaches a Durable Object, however many are made.
type TenantIndex = { byId: Map<string, TenantRecord>; byGuild: Map<string, TenantRecord> };
const INDEX_MS = 60_000;
let index: { at: number; value: Promise<TenantIndex> } | null = null;

const registry = (env: Env) => env.REGISTRY.get(env.REGISTRY.idFromName('registry'));

const buildIndex = (tenants: TenantRecord[]): TenantIndex => ({
  byId: new Map(tenants.map((t) => [t.id, t])),
  byGuild: new Map(tenants.map((t) => [t.guildId, t])),
});

const tenantIndex = (env: Env): Promise<TenantIndex> => {
  const now = Date.now();
  if (index === null || now - index.at >= INDEX_MS) {
    const fresh = { at: now, value: registry(env).list().then(buildIndex) };
    index = fresh;
    fresh.value.catch(() => {
      if (index === fresh) index = null;
    });
  }
  return index.value;
};

const watcherOf = (env: Env, record: TenantRecord) => env.WATCHER.get(env.WATCHER.idFromName(objectName(record)));

const PUBLIC_PATH = /^\/t\/([^/]+)\/api\/(stats|players|player)$/;
const LEGACY_PATH = /^\/api\/(stats|players|player)$/;

// GET /t/<community>/api/stats, /players and /player?id=<id>. /api/... is DEFAULT_TENANT's, for websites made before
// the bot served several communities.
const servePublic = async (url: URL, env: Env, ctx: ExecutionContext): Promise<Response> => {
  const scoped = PUBLIC_PATH.exec(url.pathname);
  const legacy = scoped === null ? LEGACY_PATH.exec(url.pathname) : null;
  const tenantId = scoped?.[1] ?? (legacy === null ? undefined : String(env['DEFAULT_TENANT'] ?? ''));
  const what = (scoped?.[2] ?? legacy?.[1]) as 'stats' | 'players' | 'player' | undefined;
  if (tenantId === undefined || what === undefined || !TENANT_ID.test(tenantId)) return publicError(404);
  try {
    const record = (await tenantIndex(env)).byId.get(tenantId);
    if (record === undefined || record.status !== 'active' || !record.limits.publicApi) return publicError(404);
    const id = url.searchParams.get('id') ?? '';
    if (what === 'player' && !PLAYER_ID.test(id)) return publicError(404);
    const key = `${record.id}:${what === 'player' ? `player:${id}` : what}`;
    return await serveJson(key, () => watcherOf(env, record).publicRead(record, what, id), ctx);
  } catch (error) {
    console.error(`${url.pathname} failed: ${errorText(error)}`);
    return publicError(503);
  }
};

// The commands of the community a Discord server belongs to. A suspended community gets none.
const tenantHandlers =
  (env: Env) =>
  async (guildId: string): Promise<TenantHandlers | null> => {
    const record = (await tenantIndex(env)).byGuild.get(guildId);
    if (record === undefined || record.status !== 'active') return null;
    const watcher = () => watcherOf(env, record);
    // The Discord server goes too: the community's own record decides whether it is still theirs.
    return {
      runCommand: (request) => watcher().command(record, guildId, request),
      suggest: (request) => watcher().suggest(record, guildId, request),
      adminRoleIds: () => watcher().adminRoleIds(record, guildId),
      submitSetup: (values, userId) => watcher().submitSetup(record, guildId, values, userId),
    };
  };

const adminTenant = (env: Env, record: TenantRecord): TenantAdmin => {
  const watcher = () => watcherOf(env, record);
  return {
    view: () => watcher().view(record),
    saveSecrets: (values, by) => watcher().saveSecrets(record, values, by),
    saveSettings: (changes, by) => watcher().saveSettings(record, changes, by),
    test: () => watcher().testConnection(record),
    purge: () => watcher().purge(record),
  };
};

// Discord's interactions are small; anything much bigger is not one.
const MAX_INTERACTION_BYTES = 64 * 1024;

// The community the bot ran for before it served several (LEGACY_TENANT) is added the first time, with the Discord
// server in DISCORD_GUILD_ID. Its Durable Object takes its settings and secrets from the Worker's environment.
const ensureLegacyTenant = async (env: Env, tenants: TenantRecord[]): Promise<TenantRecord[]> => {
  const id = String(env['LEGACY_TENANT'] ?? '').trim();
  if (id === '' || tenants.some((t) => t.id === id)) return tenants;
  const result = await registry(env).put(id, { guildId: String(env['DISCORD_GUILD_ID'] ?? '').trim(), legacy: true });
  if ('error' in result) {
    console.error(`[${id}] Could not add the legacy community: ${result.error}`);
    return tenants;
  }
  console.info(`[${id}] Added as the legacy community, with its existing records`);
  return [...tenants, result.record];
};

export default {
  // Every minute, each active community's Durable Object checks its game server. They run side by side, and one that
  // fails or is slow does not hold up the others.
  async scheduled(_controller, env) {
    const tenants = await ensureLegacyTenant(env, await registry(env).list());
    index = { at: Date.now(), value: Promise.resolve(buildIndex(tenants)) };
    const active = tenants.filter((t) => t.status === 'active');
    const results = await Promise.allSettled(active.map((record) => watcherOf(env, record).check(record)));
    results.forEach((result, i) => {
      if (result.status === 'rejected') console.error(`[${active[i]?.id}] Check failed: ${errorText(result.reason)}`);
    });
  },

  // GET /t/<community>/api/... feeds each community's website. POST / (or /interactions): Discord's signed slash
  // commands, for every community. /admin/...: the operator's API.
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/admin/')) {
      try {
        return await handleAdmin(request, {
          token: typeof env['ADMIN_TOKEN'] === 'string' ? env['ADMIN_TOKEN'] : undefined,
          registry: {
            list: () => registry(env).list(),
            put: (id, input) => registry(env).put(id, input),
            remove: (id) => registry(env).remove(id),
          },
          tenant: (record) => adminTenant(env, record),
          changed: () => {
            index = null;
            cache.clear();
          },
          log: console,
        });
      } catch (error) {
        console.error(`${request.method} ${url.pathname} failed: ${errorText(error)}`);
        return Response.json({ error: errorText(error) }, { status: 500, headers: { 'cache-control': 'no-store' } });
      }
    }
    if (request.method === 'GET' && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/t/'))) {
      return servePublic(url, env, ctx);
    }
    if (request.method !== 'POST' || (url.pathname !== '/' && url.pathname !== '/interactions')) {
      return new Response('Not found', { status: 404 });
    }
    const publicKey = typeof env['DISCORD_PUBLIC_KEY'] === 'string' ? env['DISCORD_PUBLIC_KEY'] : '';
    if (!publicKey) return new Response('DISCORD_PUBLIC_KEY is not set', { status: 500 });
    if (Number(request.headers.get('content-length') ?? 0) > MAX_INTERACTION_BYTES) return new Response('Too large', { status: 413 });
    const body = await request.text();
    if (body.length > MAX_INTERACTION_BYTES) return new Response('Too large', { status: 413 });
    const result = await handleInteraction(body, request.headers.get('x-signature-ed25519'), request.headers.get('x-signature-timestamp'), {
      publicKey,
      tenantFor: tenantHandlers(env),
      editReply: editOriginalReply(),
      log: console,
      now: Date.now,
    });
    if (result.followUp) {
      ctx.waitUntil(result.followUp().catch((error: unknown) => console.error(`Command reply failed: ${String(error)}`)));
    }
    return Response.json(result.body, { status: result.status });
  },
} satisfies ExportedHandler<Env>;
