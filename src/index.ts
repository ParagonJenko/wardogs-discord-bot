import { fetchServer } from './battlemetrics.ts';
import { loadConfig } from './config.ts';
import { postWebhook } from './discord.ts';
import { createPoller } from './poller.ts';

const config = loadConfig(process.env);

const timestamped =
  (write: (line: string) => void) =>
  (message: string): void =>
    write(`${new Date().toISOString()} ${message}`);

const poll = createPoller({
  config,
  fetchServer: () => fetchServer(config.serverId),
  send: (message) => postWebhook(config.webhookUrl, message),
  now: Date.now,
  log: { info: timestamped(console.log), error: timestamped(console.error) },
});

const loop = async (): Promise<void> => {
  await poll();
  setTimeout(loop, config.pollIntervalMs);
};

// Node running as PID 1 in a container ignores SIGTERM unless a handler is registered.
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

void loop();
