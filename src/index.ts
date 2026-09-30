import { loadConfig } from './config.ts';
import { postWebhook } from './discord.ts';
import { createPoller, memoryStore } from './poller.ts';
import { fetchHttp, fetchSnapshot, sendBroadcast } from './rcon.ts';

const config = loadConfig(process.env);

const timestamped =
  (write: (line: string) => void) =>
  (message: string): void =>
    write(`${new Date().toISOString()} ${message}`);

const poll = createPoller({
  config,
  fetchSnapshot: () => fetchSnapshot(config.rconUrl, config.rconPassword, fetchHttp()),
  send: (message) => postWebhook(config.webhookUrl, message),
  broadcast: (message) => sendBroadcast(config.rconUrl, config.rconPassword, message, fetchHttp()),
  now: Date.now,
  log: { info: timestamped(console.log), error: timestamped(console.error) },
  store: memoryStore(),
});

const loop = async (): Promise<void> => {
  await poll();
  setTimeout(loop, config.pollIntervalMs);
};

// Node running as PID 1 in a container ignores SIGTERM unless a handler is registered.
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

void loop();
