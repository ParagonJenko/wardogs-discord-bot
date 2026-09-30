import { connect } from 'cloudflare:sockets';
import { DurableObject } from 'cloudflare:workers';
import type { MonitorState } from './alerts.ts';
import { loadConfig } from './config.ts';
import { postWebhook } from './discord.ts';
import { createPoller } from './poller.ts';
import { fetchStatus } from './rcon.ts';
import { socketGet } from './socket-http.ts';

type Env = {
  WATCHER: DurableObjectNamespace<Watcher>;
  [key: string]: unknown;
};

const stringVars = (env: Env): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );

// A single Durable Object holds the alert state, so it survives between cron runs and is never read stale.
export class Watcher extends DurableObject<Env> {
  async check(): Promise<void> {
    const config = loadConfig(stringVars(this.env));
    const storage = this.ctx.storage;
    const poll = createPoller({
      config,
      fetchServer: () => fetchStatus(config.rconUrl, config.rconPassword, socketGet(connect)),
      send: (message) => postWebhook(config.webhookUrl, message),
      now: Date.now,
      log: console,
      store: {
        load: async () => (await storage.get<MonitorState>('state')) ?? null,
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
} satisfies ExportedHandler<Env>;
