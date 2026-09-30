import { connect } from 'cloudflare:sockets';
import { DurableObject } from 'cloudflare:workers';
import { loadConfig } from './config.ts';
import { runCommand, suggestOptions } from './commands.ts';
import { buildVipMessage, postWebhook } from './discord.ts';
import { editOriginalReply, handleInteraction } from './interactions.ts';
import { fetchInviteCounts } from './invite.ts';
import type { Config } from './config.ts';
import type { SeederRow } from './discord.ts';
import {
  leaderboard,
  matchRecord,
  matchRecordKey,
  parseMatchRecord,
  parsePlayerDay,
  playerDayKey,
  rankSeeders,
  recentDayKeys,
  recordActivity,
  recordMatchPlayers,
  recordSeed,
  unrecordMatchPlayers,
  type SeedCredit,
} from './players.ts';
import { createPoller, parseState } from './poller.ts';
import { fetchConfig, fetchSnapshot, putConfig, validateConfig } from './rcon.ts';
import { socketHttp } from './socket-http.ts';
import {
  discordDue,
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
import { summarise, type MatchState } from './tracking.ts';
import { parseVipState, syncVip, vipDue } from './vip.ts';

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

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// A single Durable Object holds the bot's state, so it survives between cron runs and is never read stale.
// Storage keys: 'state' (alerts and the match in progress), 'stats' (public, for /api/stats), the private player
// records: 'players:<UTC date>' (each player's totals that day) and 'match:<start time>' (each finished match),
// and 'vip' (who the bot put on the reserved list, and until when).
export class Watcher extends DurableObject<Env> {
  private async updateStats(change: (stats: SiteStats) => SiteStats): Promise<void> {
    const storage = this.ctx.storage;
    await storage.put('stats', change(parseStats(await storage.get('stats'))));
  }

  // One write for the site's stats and today's player totals.
  private async recordCheck(observation: Observation, minutes: number): Promise<void> {
    const dayKey = playerDayKey(observation.at);
    const stored = await this.ctx.storage.get(['stats', dayKey]);
    const stats = recordObservation(parseStats(stored.get('stats')), observation, minutes);
    if (observation.phase === 'empty' || observation.players.length === 0) {
      await this.ctx.storage.put('stats', stats);
      return;
    }
    const kind = observation.seeding ? 'seeding' : 'live';
    const day = recordActivity(parsePlayerDay(stored.get(dayKey)), observation.players, kind, minutes);
    await this.ctx.storage.put({ stats, [dayKey]: day });
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
    const poll = createPoller({
      config,
      fetchSnapshot: () => fetchSnapshot(config.rconUrl, config.rconPassword, socketHttp(connect)),
      send: (message) => postWebhook(config.webhookUrl, message),
      now: Date.now,
      log: console,
      store: {
        load: async () => parseState(await storage.get('state')),
        save: (state) => storage.put('state', state),
      },
      stats: {
        check: (observation) => this.recordCheck(observation, minutesPerCheck),
        seeded: (seeders, at) => this.recordSeed(seeders, at, config.seedMinutes),
        matchEnded: (match, at) => this.recordMatchEnd(match, at),
      },
    });
    await poll();
    await this.updateVip(config);

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

  // Every 10 minutes: gives VIP to players who have earned it, and takes it back when their week is up.
  private async updateVip(config: Config): Promise<void> {
    const rule = config.vip;
    if (rule === null) return;
    const storage = this.ctx.storage;
    const now = Date.now();
    const state = parseVipState(await storage.get('vip'));
    if (!vipDue(state, now)) return;
    const keys = recentDayKeys(now, rule.windowDays);
    const stored = await storage.get(keys);
    const http = socketHttp(connect);
    try {
      const next = await syncVip({
        rule,
        days: keys.map((key) => parsePlayerDay(stored.get(key))),
        state,
        now,
        rcon: {
          fetchConfig: () => fetchConfig(config.rconUrl, config.rconPassword, http),
          validate: (text) => validateConfig(config.rconUrl, config.rconPassword, text, http),
          put: (serverConfig) => putConfig(config.rconUrl, config.rconPassword, serverConfig, http),
        },
        log: console,
      });
      await storage.put('vip', next.state);
      // Posted once, after the list is saved: a failed post is logged, not retried, so nobody is announced twice.
      if (next.added.length > 0 || next.renewed.length > 0) {
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
    const keys = recentDayKeys(now, LEADERBOARD_DAYS);
    const stored = await this.ctx.storage.get(['stats', ...keys]);
    return publicStats(parseStats(stored.get('stats')), config.rules, now, {
      leaderboard: leaderboard(keys.map((key) => parsePlayerDay(stored.get(key))), LEADERBOARD_DAYS, LEADERBOARD_SIZE),
      vip: config.vip,
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
    return { match: removed, players: record.players.length };
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

// The stats only change once a minute. Each Worker instance keeps the last answer for a short while so a busy
// page does not wake the Durable Object on every request. Requests that arrive while a refresh is in flight wait
// for that one instead of starting their own.
const STATS_CACHE_MS = 30_000;
let cachedStats: { body: Promise<string>; at: number } | null = null;

const serveStats = async (env: Env, ctx: ExecutionContext): Promise<Response> => {
  const now = Date.now();
  if (cachedStats === null || now - cachedStats.at >= STATS_CACHE_MS) {
    const body = env.WATCHER.get(env.WATCHER.idFromName('watcher'))
      .stats()
      .then((stats) => JSON.stringify(stats));
    const entry = { body, at: now };
    cachedStats = entry;
    // Other requests may be waiting on this refresh, so it must finish even if this request is cancelled.
    // A failed refresh is dropped so the next request tries again.
    ctx.waitUntil(
      body.catch(() => {
        if (cachedStats === entry) cachedStats = null;
      }),
    );
  }
  return new Response(await cachedStats.body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Public, read-only numbers, so any site may show them.
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=30',
    },
  });
};

export default {
  async scheduled(_controller, env) {
    await env.WATCHER.get(env.WATCHER.idFromName('watcher')).check();
  },

  // GET /api/stats feeds the community website. Slash commands: Discord POSTs signed interactions to this Worker's URL.
  async fetch(request, env, ctx) {
    if (request.method === 'GET' && new URL(request.url).pathname === '/api/stats') {
      try {
        return await serveStats(env, ctx);
      } catch (error) {
        console.error(`/api/stats failed: ${error instanceof Error ? error.message : String(error)}`);
        return Response.json(
          { error: 'Stats are unavailable' },
          { status: 503, headers: { 'access-control-allow-origin': '*' } },
        );
      }
    }
    if (request.method !== 'POST') return new Response('Not found', { status: 404 });
    const vars = stringVars(env);
    const publicKey = vars['DISCORD_PUBLIC_KEY'];
    if (!publicKey) return new Response('DISCORD_PUBLIC_KEY is not set', { status: 500 });

    const result = await handleInteraction(
      await request.text(),
      request.headers.get('x-signature-ed25519'),
      request.headers.get('x-signature-timestamp'),
      {
        publicKey,
        runCommand: runCommand({
          config: () => loadConfig(vars),
          http: socketHttp(connect),
          lastMatch: async () => (await env.WATCHER.get(env.WATCHER.idFromName('watcher')).stats()).matches[0] ?? null,
          seeders: (days) => env.WATCHER.get(env.WATCHER.idFromName('watcher')).seeders(days),
          removeMatch: (endedAt) => env.WATCHER.get(env.WATCHER.idFromName('watcher')).removeMatch(endedAt),
          log: console,
        }),
        suggest: suggestOptions({ recentMatches: () => env.WATCHER.get(env.WATCHER.idFromName('watcher')).recentMatches() }),
        editReply: editOriginalReply(),
        log: console,
        now: Date.now,
        adminGuildId: vars['DISCORD_GUILD_ID']?.trim() || undefined,
      },
    );
    if (result.followUp) {
      ctx.waitUntil(result.followUp().catch((error: unknown) => console.error(`Command reply failed: ${String(error)}`)));
    }
    return Response.json(result.body, { status: result.status });
  },
} satisfies ExportedHandler<Env>;
