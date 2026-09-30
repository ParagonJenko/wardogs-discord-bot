import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.ts';
import type { DiscordMessage } from '../src/discord.ts';
import { createPoller, memoryStore, parseState, type BotState, type StatsSink } from '../src/poller.ts';
import type { Player, Snapshot } from '../src/rcon.ts';
import type { Observation } from '../src/stats.ts';
import type { MatchState } from '../src/tracking.ts';

const config: Config = {
  rconUrl: 'http://203.0.113.10:7776',
  rconPassword: 'secret',
  webhookUrl: 'https://discord.com/api/webhooks/1/abc',
  roleId: undefined,
  inviteCode: undefined,
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

const setup = (snapshots: (Snapshot | Error)[], store = memoryStore(), stats?: StatsSink) => {
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
    stats,
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

    expect(sent[1]?.embeds[0]?.fields?.[0]?.value).toBe('1. Pa (3 min)\n2. Pb (2 min)\n3. Px0 (1 min)');
  });

  it('does not credit players who only joined on the check that went live', async () => {
    const a = player('a');
    const { run, sent } = setup([snapshot([]), snapshot([a]), snapshot(crowd(20, [a]))]);

    await run(3);

    expect(sent[1]?.embeds[0]?.fields?.[0]?.value).toBe('1. Pa (1 min)');
  });

  it('counts players who were already seeding when the bot started', async () => {
    const a = player('a');
    const { run, sent } = setup([snapshot([a]), snapshot([a]), snapshot(crowd(20, [a]))]);

    await run(3);

    expect(sent[0]?.embeds[0]?.fields?.[0]?.value).toBe('1. Pa (2 min)');
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

    expect(sent.at(-1)?.embeds[0]?.fields?.[0]?.value).toBe('1. Pb (1 min)');
  });

  it('posts a match summary when the map changes after a live match', async () => {
    const { run, sent } = setup([
      snapshot(crowd(5)),
      snapshot(crowd(22, [player('a', 3)])),
      snapshot(crowd(22, [player('a', 9)])),
      snapshot(crowd(22), 'Europe'),
    ]);

    await run(4);

    expect(titles(sent)).toEqual(['🟢 UK Wardogs #1 is live', '🏁 Match over on Bakurani']);
    expect(sent[1]?.embeds[0]?.fields?.[0]?.value).toMatch(/^1\. Pa: 9 kills/);
  });

  it('does not summarise the match that was already live when the bot started', async () => {
    const { run, sent } = setup([snapshot(crowd(22, [player('a', 3)])), snapshot(crowd(22), 'Europe')]);

    await run(2);

    expect(sent).toEqual([]);
  });

  it('retries a failed alert without posting the match summary twice', async () => {
    const { run, send } = setup([
      snapshot(crowd(5)),
      snapshot(crowd(22)),
      snapshot(crowd(10), 'Europe'),
      snapshot(crowd(10), 'Europe'),
      snapshot(crowd(10), 'Europe'),
    ]);
    send
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Discord webhook failed: 500'));

    await run(5);

    expect(send.mock.calls.map(([m]) => m.embeds[0]?.title)).toEqual([
      '🟢 UK Wardogs #1 is live',
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

    // The live alert is not retried; the match that was live for that minute is still summarised once it empties.
    expect(send.mock.calls.map(([m]) => m.embeds[0]?.title)).toEqual(['🟢 UK Wardogs #1 is live', '🏁 Match over on Bakurani']);
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
    const saved: BotState = {
      alerts: { phase: 'live', lastAlertAt: { live: 0 } },
      seeding: {},
      match: null,
      unsentSummary: null,
    };
    const store = memoryStore(saved);
    const { tick, sent } = setup([snapshot(crowd(15))], store);

    await tick();

    expect(titles(sent)).toEqual(['🔻 UK Wardogs #1 dropped below 20 players']);
    await expect(store.load()).resolves.toMatchObject({ alerts: { phase: 'seeding' } });
  });
});

describe('poller stats', () => {
  const sink = () => ({
    check: vi.fn(async (_observation: Observation) => {}),
    matchEnded: vi.fn(async (_match: MatchState, _at: number) => {}),
  });

  it('reports every check that reached the server', async () => {
    const stats = sink();
    const { run } = setup([snapshot([]), new Error('fetch failed'), snapshot(crowd(3))], memoryStore(), stats);

    await run(3);

    expect(stats.check.mock.calls.map(([o]) => [o.status.players, o.phase])).toEqual([
      [0, 'empty'],
      [3, 'seeding'],
    ]);
  });

  it('records the check even when the Discord post fails, so the site still sees the server', async () => {
    const stats = sink();
    const { run, send } = setup([snapshot([]), snapshot(crowd(1)), snapshot(crowd(2))], memoryStore(), stats);
    send.mockRejectedValue(new Error('Discord webhook failed: 404'));

    await run(3);

    expect(stats.check.mock.calls.map(([o]) => o.status.players)).toEqual([0, 1, 2]);
  });

  it('records a finished match once, even when the alert after it is retried', async () => {
    const stats = sink();
    // Seeding, then live, then a new map; the low-pop alert after the summary fails once and is retried.
    const { run, send } = setup(
      [snapshot(crowd(5)), snapshot(crowd(22)), snapshot(crowd(10), 'Europe'), snapshot(crowd(10), 'Europe')],
      memoryStore(),
      stats,
    );
    send
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Discord webhook failed: 500'));

    await run(4);

    expect(send).toHaveBeenCalledTimes(4);
    expect(stats.matchEnded).toHaveBeenCalledTimes(1);
    expect(stats.matchEnded).toHaveBeenCalledWith(expect.objectContaining({ key: 'Kavkazi#0', peakPlayers: 22 }), 180_000);
  });

  it('records a finished match even when Discord rejects its summary, and keeps tracking the next one', async () => {
    const stats = sink();
    const { run, send, log } = setup(
      [
        snapshot(crowd(5)),
        snapshot(crowd(22, [player('a', 3)])),
        snapshot(crowd(22, [player('b', 1)]), 'Europe'),
        snapshot(crowd(22, [player('b', 6)]), 'Europe'),
        snapshot(crowd(22), 'Zestafona'),
      ],
      memoryStore(),
      stats,
    );
    send.mockImplementation(async (message: DiscordMessage) => {
      if (message.embeds[0]?.title.startsWith('🏁')) throw new Error('Discord webhook failed: 404');
    });

    await run(5);

    expect(stats.matchEnded.mock.calls.map(([m, at]) => [m.key, m.startedAt, at])).toEqual([
      ['Kavkazi#0', 60_000, 180_000],
      ['Europe#0', 180_000, 300_000],
    ]);
    expect(stats.matchEnded.mock.calls[1]?.[0].players['b']).toEqual({ name: 'Pb', kills: 6, deaths: 0 });
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('404'));
  });

  it('records a match that went live while every Discord post was failing', async () => {
    const stats = sink();
    const { run, send } = setup(
      [snapshot(crowd(5)), snapshot(crowd(22, [player('a', 2)])), snapshot(crowd(22, [player('a', 7)])), snapshot(crowd(22), 'Europe')],
      memoryStore(),
      stats,
    );
    send.mockRejectedValue(new Error('Discord webhook failed: 404'));

    await run(4);

    expect(stats.matchEnded).toHaveBeenCalledTimes(1);
    expect(stats.matchEnded.mock.calls[0]?.[0]).toMatchObject({ key: 'Kavkazi#0', liveAt: 120_000, players: { a: { kills: 7 } } });
  });

  it('posts a summary Discord rejected on a later check, once', async () => {
    const { run, send } = setup([
      snapshot(crowd(5)),
      snapshot(crowd(22)),
      snapshot(crowd(22), 'Europe'),
      snapshot(crowd(22), 'Europe'),
      snapshot(crowd(22), 'Europe'),
    ]);
    send
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Discord webhook failed: 500'));

    await run(5);

    expect(send.mock.calls.map(([m]) => m.embeds[0]?.title)).toEqual([
      '🟢 UK Wardogs #1 is live',
      '🏁 Match over on Bakurani',
      '🏁 Match over on Bakurani',
    ]);
  });

  it('still sends alerts and saves state when the stats update fails', async () => {
    const stats = sink();
    stats.check.mockRejectedValue(new Error('storage full'));
    const { run, sent, log, store } = setup([snapshot([]), snapshot(crowd(1))], memoryStore(), stats);

    await run(2);

    expect(titles(sent)).toEqual(['🌱 UK Wardogs #1 is seeding']);
    expect(log.error).toHaveBeenCalledWith('Stats update failed: storage full');
    expect(log.error).not.toHaveBeenCalledWith(expect.stringContaining('Check failed'));
    await expect(store.load()).resolves.toMatchObject({ alerts: { phase: 'seeding' } });
  });
});

describe('parseState', () => {
  it('upgrades state saved by the first release', () => {
    expect(parseState({ phase: 'live', lastAlertAt: { live: 5 } })).toEqual({
      alerts: { phase: 'live', lastAlertAt: { live: 5 } },
      seeding: {},
      match: null,
      unsentSummary: null,
    });
  });

  it('reads state saved before unsent summaries were kept', () => {
    const saved = { alerts: { phase: 'seeding', lastAlertAt: {} }, seeding: { a: { name: 'Pa', checks: 2 } }, match: null };

    expect(parseState(saved)).toEqual({ ...saved, unsentSummary: null });
  });

  it('starts fresh when nothing or something unrecognisable was saved', () => {
    expect(parseState(undefined)).toBeNull();
    expect(parseState({ phase: 'unknown' })).toBeNull();
  });
});
