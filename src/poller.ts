import { initialState, step, type MonitorState } from './alerts.ts';
import type { ServerStatus } from './battlemetrics.ts';
import type { Config } from './config.ts';
import { buildMessage, type DiscordMessage } from './discord.ts';

type Logger = { info: (message: string) => void; error: (message: string) => void };

type PollerDeps = {
  config: Config;
  fetchServer: () => Promise<ServerStatus>;
  send: (message: DiscordMessage) => Promise<void>;
  now: () => number;
  log: Logger;
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// Returns a function that runs one check. It never throws, so a bad poll does not stop the loop.
export const createPoller = ({ config, fetchServer, send, now, log }: PollerDeps) => {
  let state: MonitorState | null = null;

  const check = async (): Promise<void> => {
    const server = await fetchServer();

    if (state === null) {
      state = initialState(server.players, config.rules);
      log.info(`Watching "${server.name}": ${server.players}/${server.maxPlayers} players (${state.phase})`);
      return;
    }

    const result = step(state, server.players, now(), config.rules);
    if (result.alert !== null) {
      await send(buildMessage(result.alert, server, { lowPop: config.rules.lowPop, roleId: config.roleId }));
      log.info(`Sent ${result.alert} alert at ${server.players}/${server.maxPlayers} players`);
    }
    // Only advance after a successful send, so a failed post is retried on the next check.
    state = result.state;
  };

  return async (): Promise<void> => {
    try {
      await check();
    } catch (error) {
      log.error(`Check failed: ${errorText(error)}`);
    }
  };
};
