import { connect } from 'cloudflare:sockets';
import { DurableObject } from 'cloudflare:workers';
import { loadConfig } from './config.ts';
import { buildStatusEmbed, postWebhook } from './discord.ts';
import { editOriginalReply, handleInteraction } from './interactions.ts';
import { fetchInviteCounts } from './invite.ts';
import { createPoller, parseState } from './poller.ts';
import { fetchSnapshot, fetchStatus } from './rcon.ts';
import { socketGet } from './socket-http.ts';
import {
  discordDue,
  parseStats,
  publicStats,
  recordDiscord,
  recordMatch,
  recordObservation,
  type PublicStats,
  type SiteStats,
} from './stats.ts';

type Env = {
  WATCHER: DurableObjectNamespace<Watcher>;
  [key: string]: unknown;
};

const stringVars = (env: Env): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );

// A single Durable Object holds the bot's state, so it survives between cron runs and is never read stale.
export class Watcher extends DurableObject<Env> {
  private async updateStats(change: (stats: SiteStats) => SiteStats): Promise<void> {
    const storage = this.ctx.storage;
    await storage.put('stats', change(parseStats(await storage.get('stats'))));
  }

  async check(): Promise<void> {
    const config = loadConfig(stringVars(this.env));
    const storage = this.ctx.storage;
    const minutesPerCheck = config.pollIntervalMs / 60_000;
    const poll = createPoller({
      config,
      fetchSnapshot: () => fetchSnapshot(config.rconUrl, config.rconPassword, socketGet(connect)),
      send: (message) => postWebhook(config.webhookUrl, message),
      now: Date.now,
      log: console,
      store: {
        load: async () => parseState(await storage.get('state')),
        save: (state) => storage.put('state', state),
      },
      stats: {
        check: (observation) => this.updateStats((stats) => recordObservation(stats, observation, minutesPerCheck)),
        matchEnded: (summary, at) => this.updateStats((stats) => recordMatch(stats, summary, at)),
      },
    });
    await poll();

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

  async stats(): Promise<PublicStats> {
    const config = loadConfig(stringVars(this.env));
    return publicStats(parseStats(await this.ctx.storage.get('stats')), config.rules, Date.now());
  }
}

// The stats only change once a minute. Each Worker instance keeps the last answer for a short while so a busy
// page does not wake the Durable Object on every request.
const STATS_CACHE_MS = 30_000;
let cachedStats: { body: string; at: number } | null = null;

const serveStats = async (env: Env): Promise<Response> => {
  const now = Date.now();
  if (cachedStats === null || now - cachedStats.at >= STATS_CACHE_MS) {
    const stats = await env.WATCHER.get(env.WATCHER.idFromName('watcher')).stats();
    cachedStats = { body: JSON.stringify(stats), at: now };
  }
  return new Response(cachedStats.body, {
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
        return await serveStats(env);
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
    const config = loadConfig(vars);

    const result = await handleInteraction(
      await request.text(),
      request.headers.get('x-signature-ed25519'),
      request.headers.get('x-signature-timestamp'),
      {
        publicKey,
        getStatusEmbed: async () =>
          buildStatusEmbed(await fetchStatus(config.rconUrl, config.rconPassword, socketGet(connect)), config.rules),
        editReply: editOriginalReply(),
        log: console,
      },
    );
    if (result.followUp) {
      ctx.waitUntil(result.followUp().catch((error: unknown) => console.error(`/status reply failed: ${String(error)}`)));
    }
    return Response.json(result.body, { status: result.status });
  },
} satisfies ExportedHandler<Env>;
