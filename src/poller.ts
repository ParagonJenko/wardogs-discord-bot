import { initialState, step, type MonitorState } from './alerts.ts';
import type { ServerStatus } from './rcon.ts';
import type { Config } from './config.ts';
import { buildMessage, type DiscordMessage } from './discord.ts';

type Logger = { info: (message: string) => void; error: (message: string) => void };

export type StateStore = {
  load: () => Promise<MonitorState | null>;
  save: (state: MonitorState) => Promise<void>;
};

type PollerDeps = {
  config: Config;
  fetchServer: () => Promise<ServerStatus>;
  send: (message: DiscordMessage) => Promise<void>;
  now: () => number;
  log: Logger;
  store: StateStore;
};

export const memoryStore = (initial: MonitorState | null = null): StateStore => {
  let state = initial;
  return {
    load: async () => state,
    save: async (next) => {
      state = next;
    },
  };
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// Returns a function that runs one check. It never throws, so a bad poll does not stop the loop.
export const createPoller = ({ config, fetchServer, send, now, log, store }: PollerDeps) => {
  const check = async (): Promise<void> => {
    const server = await fetchServer();
    const state = await store.load();

    if (state === null) {
      const first = initialState(server.players, config.rules);
      await store.save(first);
      log.info(`Watching "${server.name}": ${server.players}/${server.maxPlayers} players (${first.phase})`);
      return;
    }

    const result = step(state, server.players, now(), config.rules);
    if (result.alert !== null) {
      await send(buildMessage(result.alert, server, { lowPop: config.rules.lowPop, roleId: config.roleId }));
      log.info(`Sent ${result.alert} alert at ${server.players}/${server.maxPlayers} players`);
    }
    // Only save after a successful send, so a failed post is retried on the next check.
    await store.save(result.state);
  };

  return async (): Promise<void> => {
    try {
      await check();
    } catch (error) {
      log.error(`Check failed: ${errorText(error)}`);
    }
  };
};
