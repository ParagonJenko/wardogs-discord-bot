import { loadConfig } from './config.ts';
import { postWebhook } from './discord.ts';
import { createJoinCheck, createPoller, JOIN_CHECK_MS, memoryStore } from './poller.ts';
import { fetchHttp, fetchPlayers, fetchSnapshot, sendBroadcast } from './rcon.ts';

const config = loadConfig(process.env);

const timestamped =
  (write: (line: string) => void) =>
  (message: string): void =>
    write(`${new Date().toISOString()} ${message}`);

const store = memoryStore();
const log = { info: timestamped(console.log), error: timestamped(console.error) };
const broadcast = (message: string) => sendBroadcast(config.rconUrl, config.rconPassword, message, fetchHttp());

const poll = createPoller({
  config,
  fetchSnapshot: () => fetchSnapshot(config.rconUrl, config.rconPassword, fetchHttp()),
  send: (message) => postWebhook(config.webhookUrl, message),
  broadcast,
  now: Date.now,
  log,
  store,
});

// While the server seeds, who is in game is read every few seconds between the checks, so the seeding message goes
// out 30 seconds after someone joins. Otherwise a join check only reads the saved state.
const joinCheck = createJoinCheck({
  config,
  fetchPlayers: () => fetchPlayers(config.rconUrl, config.rconPassword, fetchHttp()),
  broadcast,
  now: Date.now,
  log,
  store,
});

// Checks and join checks run one at a time, as both save the state. Neither throws.
let running: Promise<unknown> = Promise.resolve();
const oneAtATime = (work: () => Promise<unknown>): Promise<unknown> => (running = running.then(work));

const loop = async (): Promise<void> => {
  await oneAtATime(poll);
  setTimeout(loop, config.pollIntervalMs);
};

const joinLoop = async (): Promise<void> => {
  await oneAtATime(joinCheck);
  setTimeout(joinLoop, JOIN_CHECK_MS);
};

// Node running as PID 1 in a container ignores SIGTERM unless a handler is registered.
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

void loop();
void joinLoop();
