import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.ts';
import type { DiscordMessage } from '../src/discord.ts';
import { createPoller, memoryStore, parseState, type BotState, type StatsSink } from '../src/poller.ts';
import type { SeedCredit } from '../src/players.ts';
import type { Player, Snapshot } from '../src/rcon.ts';
import type { Observation } from '../src/stats.ts';
import type { MatchState } from '../src/tracking.ts';

const config: Config = {
  rconUrl: 'http://203.0.113.10:7776',
  rconPassword: 'secret',
  webhookUrl: 'https://discord.com/api/webhooks/1/abc',
  statusWebhookUrl: undefined,
  roleId: undefined,
  inviteCode: undefined,
  siteUrl: undefined,
  pollIntervalMs: 60_000,
  rules: { seeding: 1, live: 20, lowPop: 20, cooldownMs: 600_000, graceMs: 0 },
  seedMinutes: 10,
  vip: null,
  matchMessages: null,
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

// A field of the first embed, by its name.
const field = (message: DiscordMessage | undefined, name: string) => message?.embeds[0]?.fields?.find((f) => f.name === name)?.value;

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

    expect(field(sent[1], 'Top seeders')).toBe('🥇 Pa · 3 min\n🥈 Pb · 2 min\n🥉 Px0 · 1 min');
  });

  it('does not credit players who only joined on the check that went live', async () => {
    const a = player('a');
    const { run, sent } = setup([snapshot([]), snapshot([a]), snapshot(crowd(20, [a]))]);

    await run(3);

    expect(field(sent[1], 'Top seeders')).toBe('🥇 Pa · 1 min');
  });

  it('counts players who were already seeding when the bot started', async () => {
    const a = player('a');
    const { run, sent } = setup([snapshot([a]), snapshot([a]), snapshot(crowd(20, [a]))]);

    await run(3);

    expect(field(sent[0], 'Top seeders')).toBe('🥇 Pa · 2 min');
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

    expect(field(sent.at(-1), 'Top seeders')).toBe('🥇 Pb · 1 min');
  });

  it('posts a match summary when the map changes after a live match', async () => {
    const { run, sent } = setup([
      snapshot(crowd(5)),
      snapshot(crowd(22, [player('a', 3)])),
      snapshot(crowd(22, [player('a', 9)])),
      snapshot(crowd(22), 'Europe'),
    ]);

    await run(4);

    expect(titles(sent)).toEqual(['🟢 UK Wardogs #1 is live', '🏁 Match over · 🟧 Bakurani']);
    expect(field(sent[1], 'Top players')).toMatch(/^🥇 \*\*Pa\*\* · 9 kills/);
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
      '🏁 Match over · 🟧 Bakurani',
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
    expect(send.mock.calls.map(([m]) => m.embeds[0]?.title)).toEqual(['🟢 UK Wardogs #1 is live', '🏁 Match over · 🟧 Bakurani']);
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
      messages: null,
    };
    const store = memoryStore(saved);
    const { tick, sent } = setup([snapshot(crowd(15))], store);

    await tick();

    expect(titles(sent)).toEqual(['🔻 UK Wardogs #1 dropped below 20 players']);
    await expect(store.load()).resolves.toMatchObject({ alerts: { phase: 'seeding' } });
  });
});

describe('poller with a grace time for drops', () => {
  // The server crashes or empties out, then players get it live again: each time is a seed.
  const day = async (timeline: (Snapshot | Error)[]) => {
    const queue = [...timeline];
    const seeded = vi.fn(async (_seeders: SeedCredit[], _at: number) => {});
    let clock = 0;
    const tick = createPoller({
      config: { ...config, rules: { ...config.rules, graceMs: 5 * 60_000 } },
      fetchSnapshot: async () => {
        const next = queue.shift() ?? snapshot([]);
        if (next instanceof Error) throw next;
        return next;
      },
      send: vi.fn(async () => {}),
      now: () => (clock += 60_000),
      log: { info: vi.fn(), error: vi.fn() },
      store: memoryStore(),
      stats: { check: vi.fn(async () => {}), seeded, matchEnded: vi.fn(async () => {}) },
    });
    for (let i = timeline.length; i > 0; i--) await tick();
    // Who seeded each time the server went live, and for how long.
    return seeded.mock.calls.map(([seeders]) => seeders.filter((s) => !s.steamId.startsWith('x')).map((s) => `${s.name} ${s.minutes}`));
  };
  const minutes = (n: number, reading: Snapshot | Error) => Array.from({ length: n }, () => reading);
  const seedBy = (n: number, seeder: Player) => minutes(n, snapshot(crowd(10, [seeder])));
  const live = (n: number) => minutes(n, snapshot(crowd(25)));
  const ash = player('ash');
  const bo = player('bo');

  it('counts a seed after a crash, even when the bot never saw the server empty', async () => {
    // Ash seeds it live; it crashes, and RCON is down until Bo is already seeding it again.
    const seeds = await day([snapshot([]), ...seedBy(30, ash), ...live(30), ...minutes(60, new Error('down')), ...seedBy(60, bo), ...live(10)]);

    // Bo's first 5 minutes are the grace time, while it could still have been a blip.
    expect(seeds).toEqual([['Pash 30'], ['Pbo 55']]);
  });

  it('counts a seed when players drift off and others get it back up, without it emptying', async () => {
    const seeds = await day([snapshot([]), ...seedBy(30, ash), ...live(30), ...seedBy(90, bo), ...live(10)]);

    expect(seeds).toEqual([['Pash 30'], ['Pbo 85']]);
  });

  it('counts a seed after a quick crash that emptied the server for less than the grace time', async () => {
    const seeds = await day([snapshot([]), ...seedBy(30, ash), ...live(30), ...minutes(3, snapshot([])), ...seedBy(87, bo), ...live(10)]);

    expect(seeds).toEqual([['Pash 30'], ['Pbo 85']]);
  });

  it('pings nobody, and counts nobody as seeding, when a live server restarts and fills again', async () => {
    const queue: (Snapshot | Error)[] = [
      snapshot(crowd(60)),
      snapshot(crowd(0)),
      new Error('RCON request timed out after 8000ms'),
      snapshot(crowd(5)),
      snapshot(crowd(30)),
      snapshot(crowd(60)),
    ];
    const send = vi.fn(async (_message: DiscordMessage) => {});
    const seeded = vi.fn(async () => {});
    let clock = 0;
    const tick = createPoller({
      config: { ...config, rules: { ...config.rules, graceMs: 5 * 60_000 } },
      fetchSnapshot: async () => {
        const next = queue.shift() ?? snapshot([]);
        if (next instanceof Error) throw next;
        return next;
      },
      send,
      now: () => (clock += 60_000),
      log: { info: vi.fn(), error: vi.fn() },
      store: memoryStore(),
      stats: { check: vi.fn(async () => {}), seeded, matchEnded: vi.fn(async () => {}) },
    });

    for (let i = 0; i < 6; i++) await tick();

    expect(send).not.toHaveBeenCalled();
    expect(seeded).not.toHaveBeenCalled();
  });
});

describe('poller stats', () => {
  const sink = () => ({
    check: vi.fn(async (_observation: Observation) => {}),
    seeded: vi.fn(async (_seeders: SeedCredit[], _at: number) => {}),
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
    expect(stats.matchEnded.mock.calls[1]?.[0].players['b']).toMatchObject({ name: 'Pb', kills: 6, deaths: 0 });
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

  it('counts seeding whenever the server is seeding: from empty, and building back up after a drop from live', async () => {
    const stats = sink();
    const a = player('a');
    const { run } = setup(
      [snapshot([]), snapshot([a]), snapshot(crowd(20, [a])), snapshot(crowd(15, [a])), snapshot(crowd(15, [a])), snapshot([]), snapshot([a])],
      memoryStore(),
      stats,
    );

    await run(7);

    expect(stats.check.mock.calls.map(([o]) => [o.phase, o.seeding])).toEqual([
      ['empty', false],
      ['seeding', true],
      ['live', false],
      ['seeding', true],
      ['seeding', true],
      ['empty', false],
      ['seeding', true],
    ]);
  });

  it('credits everyone who seeded when the server goes live, and again when they get it back up after a drop', async () => {
    const stats = sink();
    const a = player('a');
    const b = player('b');
    const { run, sent } = setup(
      [snapshot([]), snapshot([a]), snapshot([a, b]), snapshot(crowd(20, [a, b])), snapshot(crowd(15, [a])), snapshot(crowd(15, [a])), snapshot(crowd(21, [a]))],
      memoryStore(),
      stats,
    );

    await run(7);

    expect(stats.seeded.mock.calls[0]).toEqual([
      [
        { steamId: 'a', name: 'Pa', minutes: 2 },
        { steamId: 'b', name: 'Pb', minutes: 1 },
      ],
      240_000,
    ]);
    // Only a stayed on through the drop, so b gets no credit for getting it back up.
    const again = stats.seeded.mock.calls[1];
    expect(again?.[1]).toBe(420_000);
    expect(again?.[0]).toContainEqual({ steamId: 'a', name: 'Pa', minutes: 2 });
    expect(again?.[0].map((s) => s.steamId)).not.toContain('b');
    expect(field(sent.find((m) => m.embeds[0]?.title.endsWith('is live')), 'Top seeders')).toBe('🥇 Pa · 2 min\n🥈 Pb · 1 min');
  });

  it('credits seeders and names them on the live alert even when every Discord post was failing', async () => {
    const stats = sink();
    const a = player('a');
    const { run, send } = setup([snapshot([]), snapshot([a]), snapshot([a]), snapshot(crowd(20, [a])), snapshot(crowd(20, [a]))], memoryStore(), stats);
    send.mockRejectedValueOnce(new Error('Discord webhook failed: 500'));
    send.mockRejectedValueOnce(new Error('Discord webhook failed: 500'));
    send.mockRejectedValueOnce(new Error('Discord webhook failed: 500'));

    await run(5);

    expect(stats.seeded.mock.calls.map(([seeders, at]) => [seeders, at])).toEqual([
      [[{ steamId: 'a', name: 'Pa', minutes: 2 }], 240_000],
      [[{ steamId: 'a', name: 'Pa', minutes: 2 }], 300_000],
    ]);
    expect(send.mock.calls.map(([m]) => [m.embeds[0]?.title, field(m, 'Top seeders')])).toEqual([
      ['🌱 UK Wardogs #1 is seeding', undefined],
      ['🌱 UK Wardogs #1 is seeding', undefined],
      ['🟢 UK Wardogs #1 is live', '🥇 Pa · 2 min'],
      ['🟢 UK Wardogs #1 is live', '🥇 Pa · 2 min'],
    ]);
  });

  it('does not carry a seeding count past an empty server while Discord is down', async () => {
    const stats = sink();
    const a = player('a');
    const { run, send } = setup(
      [snapshot([]), snapshot([a]), snapshot([a]), snapshot(crowd(20, [a])), snapshot([]), snapshot([a]), snapshot(crowd(20, [a]))],
      memoryStore(),
      stats,
    );
    send.mockRejectedValue(new Error('Discord webhook failed: 500'));

    await run(7);

    expect(stats.seeded.mock.calls.map(([seeders]) => seeders)).toEqual([
      [{ steamId: 'a', name: 'Pa', minutes: 2 }],
      [{ steamId: 'a', name: 'Pa', minutes: 1 }],
    ]);
  });

  it('records a finished match on the next check if recording it failed, then posts the summary once', async () => {
    const stats = sink();
    stats.matchEnded.mockRejectedValueOnce(new Error('storage unavailable'));
    const { run, send, log } = setup(
      [snapshot(crowd(5)), snapshot(crowd(22, [player('a', 4)])), snapshot(crowd(22), 'Europe'), snapshot(crowd(22), 'Europe')],
      memoryStore(),
      stats,
    );

    await run(4);

    expect(log.error).toHaveBeenCalledWith('Check failed: storage unavailable');
    expect(stats.matchEnded.mock.calls.map(([m, at]) => [m.key, m.players['a']?.kills, at])).toEqual([
      ['Kavkazi#0', 4, 180_000],
      ['Kavkazi#0', 4, 240_000],
    ]);
    expect(send.mock.calls.map(([m]) => m.embeds[0]?.title)).toEqual(['🟢 UK Wardogs #1 is live', '🏁 Match over · 🟧 Bakurani']);
  });

  it('credits seeders on the next check if recording the seed failed', async () => {
    const stats = sink();
    stats.seeded.mockRejectedValueOnce(new Error('storage unavailable'));
    const a = player('a');
    const { run } = setup([snapshot([]), snapshot([a]), snapshot(crowd(20, [a])), snapshot(crowd(20, [a]))], memoryStore(), stats);

    await run(4);

    expect(stats.seeded.mock.calls.map(([seeders]) => seeders)).toEqual([
      [{ steamId: 'a', name: 'Pa', minutes: 1 }],
      [{ steamId: 'a', name: 'Pa', minutes: 1 }],
    ]);
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
      '🏁 Match over · 🟧 Bakurani',
      '🏁 Match over · 🟧 Bakurani',
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
      messages: null,
    });
  });

  it('reads state saved before unsent summaries were kept, and drops what is no longer used', () => {
    expect(parseState({ ...parseState({ phase: 'live', lastAlertAt: {} }), liveSinceEmpty: true })).not.toHaveProperty('liveSinceEmpty');

    const saved = { alerts: { phase: 'seeding', lastAlertAt: {} }, seeding: { a: { name: 'Pa', checks: 2 } }, match: null };

    expect(parseState(saved)).toEqual({ ...saved, unsentSummary: null, messages: null });
  });

  it('starts fresh when nothing or something unrecognisable was saved', () => {
    expect(parseState(undefined)).toBeNull();
    expect(parseState({ phase: 'unknown' })).toBeNull();
  });
});

describe('in-game messages', () => {
  const withScores = (players: Player[], valkyra: number, kharr: number): Snapshot => ({
    ...snapshot(players),
    status: { ...snapshot(players).status, factionScores: [{ name: 'Valkyra', score: valkyra }, { name: 'Kharr', score: kharr }] },
  });

  const on = { siteHost: 'gaminginit.com', scoreToWin: 100 };

  const messagesPoller = (snapshots: Snapshot[], broadcast = vi.fn(async (_message: string) => {}), matchMessages: typeof on | null = on) => {
    const queue = [...snapshots];
    const log = { info: vi.fn(), error: vi.fn() };
    let clock = 0;
    const tick = createPoller({
      config: { ...config, matchMessages },
      fetchSnapshot: async () => queue.shift() ?? snapshot([]),
      send: vi.fn(async () => {}),
      // Five minutes a check, so ten minutes pass quickly.
      now: () => (clock += 5 * 60_000),
      log,
      store: memoryStore(),
      broadcast,
      // The first line of every list, so the texts are known.
      random: () => 0,
    });
    return { run: async (times: number) => { for (let i = 0; i < times; i++) await tick(); }, broadcast, log };
  };

  it('sends each message once as the match goes on, and saves which were sent', async () => {
    const { run, broadcast, log } = messagesPoller([
      withScores(crowd(5), 0, 0),
      withScores(crowd(22), 5, 3),
      withScores(crowd(22), 20, 12),
      withScores(crowd(22), 35, 20),
      withScores(crowd(22), 52, 30),
      withScores(crowd(22), 91, 70),
      withScores(crowd(22), 95, 80),
    ]);

    await run(7);

    expect(broadcast.mock.calls.map(([m]) => m)).toEqual([
      '10 minutes in and nobody has rage quit yet. Rules are in our Discord, leaderboard at gaminginit.com',
      'Halfway there! Valkyra leads on 52. Not my points, OUR points, comrade. Check the leaderboard and join our Discord at gaminginit.com',
      'Valkyra has 90! Victory for the motherland is in sight, comrades. Where do you rank? Leaderboard, Discord and seeding at gaminginit.com',
    ]);
    expect(log.info).toHaveBeenCalledWith(
      'Sent in game: Halfway there! Valkyra leads on 52. Not my points, OUR points, comrade. Check the leaderboard and join our Discord at gaminginit.com',
    );
  });

  it('logs a failed message and does not send it again', async () => {
    const broadcast = vi.fn(async (_message: string) => {
      throw new Error('RCON request timed out after 8000ms');
    });
    const { run, log } = messagesPoller(
      [withScores(crowd(5), 0, 0), withScores(crowd(22), 52, 3), withScores(crowd(22), 60, 3), withScores(crowd(22), 70, 3)],
      broadcast,
    );

    await run(4);

    // Halfway fails once and is not tried again; ten minutes in is a different message, due on the last check.
    expect(broadcast.mock.calls.map(([m]) => m.split('!')[0].split('?')[0])).toEqual(['Halfway there', '10 minutes in and nobody has rage quit yet. Rules are in our Discord, leaderboard at gaminginit.com']);
    expect(log.error).toHaveBeenCalledWith('In-game message failed: RCON request timed out after 8000ms');
  });

  it('sends nothing when messages are off', async () => {
    const { run, broadcast } = messagesPoller(
      [withScores(crowd(5), 0, 0), withScores(crowd(22), 60, 3), withScores(crowd(22), 95, 3), withScores(crowd(22), 99, 3)],
      undefined,
      null,
    );

    await run(4);

    expect(broadcast).not.toHaveBeenCalled();
  });
});
