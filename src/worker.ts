import { connect } from 'cloudflare:sockets';
import { DurableObject } from 'cloudflare:workers';
import { loadConfig } from './config.ts';
import { buildStatusEmbed, postWebhook } from './discord.ts';
import { editOriginalReply, handleInteraction } from './interactions.ts';
import { createPoller, parseState } from './poller.ts';
import { fetchSnapshot, fetchStatus } from './rcon.ts';
import { socketGet } from './socket-http.ts';

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
  async check(): Promise<void> {
    // The cron fires every minute whatever POLL_INTERVAL_SECONDS says, and seeding minutes are counted per check.
    const config = { ...loadConfig(stringVars(this.env)), pollIntervalMs: 60_000 };
    const storage = this.ctx.storage;
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
    });
    await poll();
  }
}

export default {
  async scheduled(_controller, env) {
    await env.WATCHER.get(env.WATCHER.idFromName('watcher')).check();
  },

  // Slash commands: Discord POSTs signed interactions to this Worker's URL.
  async fetch(request, env, ctx) {
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
        now: Date.now,
      },
    );
    if (result.followUp) {
      ctx.waitUntil(result.followUp().catch((error: unknown) => console.error(`/status reply failed: ${String(error)}`)));
    }
    return Response.json(result.body, { status: result.status });
  },
} satisfies ExportedHandler<Env>;
