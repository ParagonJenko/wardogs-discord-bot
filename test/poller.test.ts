import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.ts';
import type { DiscordMessage } from '../src/discord.ts';
import { createPoller, memoryStore, parseState, type BotState } from '../src/poller.ts';
import type { Player, Snapshot } from '../src/rcon.ts';

const config: Config = {
  rconUrl: 'http://203.0.113.10:7776',
  rconPassword: 'secret',
  webhookUrl: 'https://discord.com/api/webhooks/1/abc',
  roleId: undefined,
  pollIntervalMs: 60_000,
  rules: { seeding: 1, live: 20, lowPop: 20, cooldownMs: 600_000 },
};

const player = (steamId: string, kills = 0): Player => ({ steamId, name: `P${steamId}`, kills, deaths: 0 });

// n players: the named ones first, padded with anonymous players.
const crowd = (n: number, named: Player[] = []): Player[] => [
  ...named,
  ...Array.from({ length: Math.max(0, n - named.length) }, (_, i) => player(`x${i}`)),
];

const snapshot = (players: Player[], map = 'Kavkazi'): Snapshot => ({
  status: { name: 'UK Wardogs #1', players: players.length, maxPlayers: 98, map, rotationIndex: 0, factionScores: [] },
  players,
});

const setup = (snapshots: (Snapshot | Error)[], store = memoryStore()) => {
  const queue = [...snapshots];
  const sent: DiscordMessage[] = [];
  const send = vi.fn(async (message: DiscordMessage) => {
    sent.push(message);
  });
  const log = { info: vi.fn(), error: vi.fn() };
  let clock = 0;
  const tick = createPoller({
    config,
    fetchSnapshot: async () => {
      const next = queue.shift() ?? snapshot([]);
      if (next instanceof Error) throw next;
      return next;
    },
    send,
    now: () => (clock += 60_000),
    log,
    store,
  });
  const run = async (times: number) => {
    for (let i = 0; i < times; i++) await tick();
  };
  return { tick, run, send, sent, log, store };
};

const titles = (sent: DiscordMessage[]) => sent.map((m) => m.embeds[0]?.title);

describe('poller', () => {
  it('posts nothing on the first check, so restarts do not re-announce', async () => {
    const { tick, send } = setup([snapshot(crowd(25))]);

    await tick();

    expect(send).not.toHaveBeenCalled();
  });

  it('posts an alert when the population crosses a threshold', async () => {
    const { run, sent } = setup([snapshot([]), snapshot(crowd(3))]);

    await run(2);

    expect(titles(sent)).toEqual(['🌱 UK Wardogs #1 is seeding']);
  });

  it('credits the players who seeded longest when the server goes live', async () => {
    const a = player('a');
    const b = player('b');
    const { run, sent } = setup([
      snapshot([]),
      snapshot([a]),
      snapshot([a, b]),
      snapshot(crowd(3, [a, b])),
      snapshot(crowd(20, [a, b])),
    ]);

    await run(5);

    expect(sent[1]?.embeds[0]?.fields?.[0]?.value).toMatch(/^1\. Pa \(4 min\)\n2\. Pb \(3 min\)\n3\. Px0 \(2 min\)$/);
  });

  it('starts the seeding count again after the server empties', async () => {
    const a = player('a');
    const b = player('b');
    const { run, sent } = setup([
      snapshot([]),
      snapshot([a]),
      snapshot([a]),
      snapshot([]),
      snapshot([b]),
      snapshot(crowd(20, [b])),
    ]);

    await run(6);

    expect(sent.at(-1)?.embeds[0]?.fields?.[0]?.value).toMatch(/^1\. Pb \(2 min\)/);
  });

  it('posts a match summary when the map changes after a live match', async () => {
    const { run, sent } = setup([
      snapshot(crowd(22, [player('a', 3)])),
      snapshot(crowd(22, [player('a', 9)])),
      snapshot(crowd(22), 'Europe'),
    ]);

    await run(3);

    expect(titles(sent)).toEqual(['🏁 Match over on Bakurani']);
    expect(sent[0]?.embeds[0]?.fields?.[0]?.value).toMatch(/^1\. Pa: 9 kills/);
  });

  it('retries a failed alert without posting the match summary twice', async () => {
    const { run, send } = setup([
      snapshot(crowd(22)),
      snapshot(crowd(10), 'Europe'),
      snapshot(crowd(10), 'Europe'),
      snapshot(crowd(10), 'Europe'),
    ]);
    send.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Discord webhook failed: 500'));

    await run(4);

    expect(send.mock.calls.map(([m]) => m.embeds[0]?.title)).toEqual([
      '🏁 Match over on Bakurani',
      '🔻 UK Wardogs #1 dropped below 20 players',
      '🔻 UK Wardogs #1 dropped below 20 players',
    ]);
  });

  it('retries the alert on the next check when Discord rejects it', async () => {
    const { run, send, log } = setup([snapshot([]), snapshot(crowd(20)), snapshot(crowd(20)), snapshot(crowd(20))]);
    send.mockRejectedValueOnce(new Error('Discord webhook failed: 500'));

    await run(4);

    expect(send).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('500'));
  });

  it('drops a failed alert that is no longer true by the next check', async () => {
    const { run, send } = setup([snapshot([]), snapshot(crowd(20)), snapshot([])]);
    send.mockRejectedValueOnce(new Error('Discord webhook failed: 500'));

    await run(3);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps going when RCON is unreachable', async () => {
    const { run, tick, sent, log } = setup([snapshot([]), new Error('fetch failed'), snapshot(crowd(1))]);

    await tick();
    await expect(tick()).resolves.toBeUndefined();
    await run(1);

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('fetch failed'));
    expect(sent).toHaveLength(1);
  });

  it('picks up from saved state instead of starting over', async () => {
    const saved: BotState = { alerts: { phase: 'live', lastAlertAt: { live: 0 } }, seeding: {}, match: null };
    const store = memoryStore(saved);
    const { tick, sent } = setup([snapshot(crowd(15))], store);

    await tick();

    expect(titles(sent)).toEqual(['🔻 UK Wardogs #1 dropped below 20 players']);
    await expect(store.load()).resolves.toMatchObject({ alerts: { phase: 'seeding' } });
  });
});

describe('parseState', () => {
  it('upgrades state saved by the first release', () => {
    expect(parseState({ phase: 'live', lastAlertAt: { live: 5 } })).toEqual({
      alerts: { phase: 'live', lastAlertAt: { live: 5 } },
      seeding: {},
      match: null,
    });
  });

  it('starts fresh when nothing or something unrecognisable was saved', () => {
    expect(parseState(undefined)).toBeNull();
    expect(parseState({ phase: 'unknown' })).toBeNull();
  });
});
