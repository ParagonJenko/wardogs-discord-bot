import { connect } from 'cloudflare:sockets';
import { DurableObject } from 'cloudflare:workers';
import { withSeedCall } from './alerts.ts';
import { loadConfig } from './config.ts';
import { runCommand, suggestOptions } from './commands.ts';
import { nextMap, parseBoardRef, parseStagedMap, showBoard, type StagedMap } from './board.ts';
import { buildLiveStatus, buildVipMessage, mapName, postWebhook } from './discord.ts';
import { editOriginalReply, handleInteraction } from './interactions.ts';
import { fetchInviteCounts } from './invite.ts';
import type { Config } from './config.ts';
import type { SeederRow } from './discord.ts';
import {
  appendMod,
  BAN_LENGTHS,
  banReason,
  expiredBans,
  isBotBan,
  modLogKey,
  parseBanBook,
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
import { createPoller, parseState } from './poller.ts';
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
  fetchRotation,
  fetchSnapshot,
  putConfig,
  RconError,
  removeBan,
  sendBroadcast,
  validateConfig,
  type HttpClient,
  type ServerConfig,
  type Snapshot,
} from './rcon.ts';
import { socketHttp } from './socket-http.ts';
import {
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
import { matchMap, summarise, type MatchState } from './tracking.ts';
import { addVip, parseVipState, removeVip, syncVip, vipDue, type VipState } from './vip.ts';

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

// A single Durable Object holds the bot's state, so it survives between cron runs and is never read stale.
// Storage keys: 'state' (alerts and the match in progress), 'stats' (public, for /api/stats), the private player
// records: 'players:<UTC date>' (each player's totals that day) and 'match:<start time>' (each finished match),
// 'vip' (who the bot put on the reserved list, and until when), 'mod:<Steam ID>' (what staff did to that player through
// the bot), 'bans' (the bans the bot made, and when the timed ones end), 'board' (which Discord message is the live
// status), 'nextMap' (the map staff set to play next), 'playerIdKey' (the key for players' public ids), 'online' (who
// was in game at the last check that reached the server) and 'seedCall' (when staff last sent /seednow).
export class Watcher extends DurableObject<Env> {
  // Bans and the reserved list both live in the server's settings file. Changes to them run one at a time, so one
  // never overwrites another, or the VIP state, with what it read before the other finished.
  private queue: Promise<unknown> = Promise.resolve();

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  // The player records the website's pages read. Past days and finished matches only change through /removematch,
  // which clears them, so they are kept in memory and each read only fetches the last two days and any new matches.
  // The day before is fetched too, as a check that started before midnight may still be writing to it.
  private dayCache = new Map<string, PlayerDay>();
  private matchCache = new Map<string, MatchRecord>();
  // Steam ID → public id.
  private ids = new Map<string, string>();
  private idKey: Promise<CryptoKey> | null = null;

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

  async check(): Promise<void> {
    // The cron fires every minute whatever POLL_INTERVAL_SECONDS says, and seeding minutes are counted per check.
    const config = { ...loadConfig(stringVars(this.env)), pollIntervalMs: 60_000 };
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
      store: {
        // A /seednow call is kept apart from 'state', so a check that saves 'state' never overwrites it.
        load: async () => {
          const stored = await storage.get(['state', 'seedCall']);
          const state = parseState(stored.get('state'));
          const calledAt = stored.get('seedCall');
          return state && typeof calledAt === 'number' ? { ...state, alerts: withSeedCall(state.alerts, calledAt) } : state;
        },
        save: (state) => storage.put('state', state),
      },
      stats: {
        check: (observation) => this.recordCheck(observation, minutesPerCheck, config.busyThreshold),
        seeded: (seeders, at) => this.recordSeed(seeders, at, config.seedMinutes),
        matchEnded: (match, at) => this.recordMatchEnd(match, at),
      },
    });
    await poll();
    await this.updateBoard(config, seen.snapshot);
    await this.serial(() => this.expireBans(config));
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
          // Lifted already, or lifted and banned again some other way: that ban is not the bot's to lift.
          await this.record(steamId, null, { ban: null });
          console.info(`Ban ended: ${label} ${current === undefined ? 'was already unbanned' : 'has a newer ban, left alone'}`);
          continue;
        }
        await removeBan(config.rconUrl, config.rconPassword, steamId, http);
        await this.record(steamId, { action: 'unban', at: now, by: 'bot', name: ban.name, reason: 'The ban ran out' }, { ban: null });
        console.info(`Ban ended: ${label}`);
      }
    } catch (error) {
      console.error(`Lifting ended bans failed: ${errorText(error)}`);
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
          console.error(`VIP announcement failed: ${errorText(error)}`),
        );
      }
    } catch (error) {
      console.error(`VIP update failed: ${errorText(error)}`);
      // Try again at the next 10-minute mark rather than on every check.
      await storage.put('vip', { ...state, checkedAt: now });
    }
  }

  async stats(): Promise<PublicStats> {
    const config = loadConfig(stringVars(this.env));
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
    const config = loadConfig(stringVars(this.env));
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
  // banned is left as they are, so no ban is ever lifted to change it: staff /unban first.
  async ban({ steamId, name, length, reason, by }: BanRequest): Promise<BanResult> {
    const option = BAN_LENGTHS.find((l) => l.value === length);
    if (option === undefined) throw new Error(`Unknown ban length: ${length}`);
    return this.serial(async () => {
      const { config, http } = this.rcon();
      const at = Date.now();
      const until = option.ms === null ? null : at + option.ms;
      const current = (await fetchBans(config.rconUrl, config.rconPassword, http)).find((b) => b.steamId === steamId);
      if (current !== undefined) {
        const ours = parseBanBook(await this.ctx.storage.get('bans'))[steamId];
        const byBot = ours !== undefined && isBotBan(current.reason, ours);
        return { outcome: 'already-banned', until: byBot ? ours.until : null, byBot };
      }
      // Remembered before the server is asked, so a ban that goes through but times out still ends on time. If the
      // server refuses, it is forgotten again; the bot also forgets it at its end if the server never had it.
      const ban: BanRecord = { name, until, reason, serverReason: banReason(reason, until), by, at };
      await this.record(steamId, null, { ban });
      try {
        await addBan(config.rconUrl, config.rconPassword, steamId, ban.serverReason, http);
      } catch (error) {
        if (error instanceof RconError) await this.record(steamId, null, { ban: null });
        throw error;
      }
      await this.record(steamId, { action: 'ban', at, by, name, reason, detail: option.name });
      return { outcome: 'banned', until, byBot: true };
    });
  }

  // False when the server had no ban for them. The bot forgets its own record of the ban either way.
  async unban({ steamId, name }: Named, by: string): Promise<boolean> {
    return this.serial(async () => {
      const { config, http } = this.rcon();
      const removed = await removeBan(config.rconUrl, config.rconPassword, steamId, http);
      await this.record(steamId, removed ? { action: 'unban', at: Date.now(), by, name } : null, { ban: null });
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

  // When staff sent /seednow, so the automatic seeding alert does not ping the role again straight after.
  async seedCalled(at: number): Promise<void> {
    await this.ctx.storage.put('seedCall', at);
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
// one instead of starting their own.
const CACHE_MS = 30_000;
// One answer per player page; past this many, the oldest are dropped.
const CACHE_ENTRIES = 200;
const cache = new Map<string, { body: Promise<string | null>; at: number }>();

// Public, read-only numbers, so any site may show them.
const PUBLIC_HEADERS = { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=30' };

// `load` answers null when there is no such thing, which is a 404.
const serveJson = async (key: string, load: () => Promise<unknown>, ctx: ExecutionContext): Promise<Response> => {
  const now = Date.now();
  let entry = cache.get(key);
  if (entry === undefined || now - entry.at >= CACHE_MS) {
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
  if (body === null) return Response.json({ error: 'Not found' }, { status: 404, headers: PUBLIC_HEADERS });
  return new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8', ...PUBLIC_HEADERS } });
};

// The website's JSON: the server's stats, everyone to find a player page for, and one player's page.
const publicRoute = (url: URL, watcher: () => DurableObjectStub<Watcher>): { key: string; load: () => Promise<unknown> } | null => {
  if (url.pathname === '/api/stats') return { key: 'stats', load: () => watcher().stats() };
  if (url.pathname === '/api/players') return { key: 'players', load: () => watcher().players() };
  const id = url.searchParams.get('id') ?? '';
  if (url.pathname === '/api/player' && PLAYER_ID.test(id)) return { key: `player:${id}`, load: () => watcher().profile(id) };
  return null;
};

export default {
  async scheduled(_controller, env) {
    await env.WATCHER.get(env.WATCHER.idFromName('watcher')).check();
  },

  // GET /api/stats, /api/players and /api/player feed the community website. Slash commands: Discord POSTs signed
  // interactions to this Worker's URL.
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const watcher = () => env.WATCHER.get(env.WATCHER.idFromName('watcher'));
    if (request.method === 'GET' && url.pathname.startsWith('/api/')) {
      const route = publicRoute(url, watcher);
      if (route === null) return Response.json({ error: 'Not found' }, { status: 404, headers: PUBLIC_HEADERS });
      try {
        return await serveJson(route.key, route.load, ctx);
      } catch (error) {
        console.error(`${url.pathname} failed: ${error instanceof Error ? error.message : String(error)}`);
        return Response.json({ error: 'Stats are unavailable' }, { status: 503, headers: { 'access-control-allow-origin': '*' } });
      }
    }
    if (request.method !== 'POST') return new Response('Not found', { status: 404 });
    const vars = stringVars(env);
    const publicKey = vars['DISCORD_PUBLIC_KEY'];
    if (!publicKey) return new Response('DISCORD_PUBLIC_KEY is not set', { status: 500 });
    const records: StaffRecords = {
      player: (steamId) => watcher().playerRecord(steamId),
      knownPlayers: () => watcher().knownPlayers(),
      log: (steamId, entry) => watcher().logAction(steamId, entry),
      ban: (ban) => watcher().ban(ban),
      unban: (target, by) => watcher().unban(target, by),
      vipAdd: (grant) => watcher().vipAdd(grant),
      vipRemove: (target) => watcher().vipRemove(target),
      nextMap: (map, playing) => watcher().stageNextMap(map, playing),
    };
    const result = await handleInteraction(
      await request.text(),
      request.headers.get('x-signature-ed25519'),
      request.headers.get('x-signature-timestamp'),
      {
        publicKey,
        runCommand: runCommand({
          config: () => loadConfig(vars),
          http: socketHttp(connect),
          lastMatch: async () => (await watcher().recentMatches())[0] ?? null,
          seeders: (days) => watcher().seeders(days),
          removeMatch: (endedAt) => watcher().removeMatch(endedAt),
          seedCall: async (message) => {
            await postWebhook(loadConfig(vars).webhookUrl, message);
            // The call is out, so a failure here only costs holding back the automatic alert; the reply still says it posted.
            await watcher()
              .seedCalled(Date.now())
              .catch((error: unknown) => console.error(`/seednow posted, but its time was not saved: ${errorText(error)}`));
          },
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
