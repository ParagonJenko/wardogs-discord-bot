import { describe, expect, it } from 'vitest';
import {
  buildLastMatchEmbed,
  buildMatchSummary,
  buildMessage,
  buildPlayersEmbed,
  buildRotationEmbed,
  buildSeedersEmbed,
  buildStatusEmbed,
  postWebhook,
} from '../src/discord.ts';

const server = { name: 'UK Wardogs #1', players: 7, maxPlayers: 64 };

describe('buildMessage', () => {
  it('announces seeding with the server name and population', () => {
    const [embed] = buildMessage('seeding', server, { lowPop: 20 }).embeds;

    expect(embed?.title).toMatch(/UK Wardogs #1 is seeding/);
    expect(embed?.description).toContain('7/64');
  });

  it('tells people what seeding earns when automatic VIP is on, only on the seeding alert', () => {
    const vip = { seedDays: 3, seedMinutes: 10, windowDays: 7, lengthDays: 7 };
    const [seeding] = buildMessage('seeding', server, { lowPop: 20, vip }).embeds;
    const [live] = buildMessage('live', { ...server, players: 20 }, { lowPop: 20, vip }).embeds;

    expect(seeding?.description).toBe(
      '**7/64** players. Jump in and help get it live!\n🎖️ Seed on 3 days in a week and get a reserved slot for a week. ' +
        "A seed counts when you're on for more than 10 min and the server goes live.",
    );
    expect(live?.description).not.toContain('🎖️');
  });

  it('announces going live', () => {
    const [embed] = buildMessage('live', { ...server, players: 20 }, { lowPop: 20 }).embeds;

    expect(embed?.title).toMatch(/UK Wardogs #1 is live/);
    expect(embed?.description).toContain('20/64');
  });

  it('announces a drop below the low-pop threshold', () => {
    const [embed] = buildMessage('lowPop', { ...server, players: 18 }, { lowPop: 20 }).embeds;

    expect(embed?.title).toMatch(/UK Wardogs #1 dropped below 20 players/);
    expect(embed?.description).toContain('18/64');
  });

  it('keeps the title within Discord\'s 256 character limit for long server names', () => {
    const [embed] = buildMessage('lowPop', { ...server, name: 'x'.repeat(500) }, { lowPop: 20 }).embeds;

    expect(embed?.title.length).toBeLessThanOrEqual(256);
    expect(embed?.title).toMatch(/dropped below 20 players$/);
  });

  it('credits the top seeders when the server goes live', () => {
    const [embed] = buildMessage('live', { ...server, players: 20 }, {
      lowPop: 20,
      seeders: [
        { name: 'Ash', minutes: 42 },
        { name: 'b_o_b', minutes: 30 },
        { name: 'Cy', minutes: 12 },
      ],
    }).embeds;

    expect(embed?.fields).toEqual([
      { name: 'Top seeders', value: '1. Ash (42 min)\n2. b\\_o\\_b (30 min)\n3. Cy (12 min)' },
    ]);
  });

  it('adds no seeder list when nobody seeded', () => {
    const [embed] = buildMessage('live', server, { lowPop: 20, seeders: [] }).embeds;

    expect(embed?.fields).toBeUndefined();
  });

  it('pings only the configured role', () => {
    const message = buildMessage('live', server, { lowPop: 20, roleId: '999' });

    expect(message.content).toBe('<@&999>');
    expect(message.allowed_mentions).toEqual({ parse: [], roles: ['999'] });
  });

  it('pings nobody when no role is configured, even if the server name contains @everyone', () => {
    const message = buildMessage('live', { ...server, name: '@everyone join' }, { lowPop: 20 });

    expect(message.content).toBeUndefined();
    expect(message.allowed_mentions).toEqual({ parse: [], roles: [] });
  });
});

describe('buildMatchSummary', () => {
  const summary = {
    map: 'Kavkazi',
    durationMs: 38 * 60_000,
    peakPlayers: 64,
    factionScores: [
      { name: 'Valkyra', score: 250 },
      { name: 'Kharr', score: 300 },
    ],
    top: [
      { name: 'Cy', kills: 12, deaths: 3 },
      { name: '**Ash**', kills: 11, deaths: 1 },
    ],
  };

  it('names the map, winner, scores, length and peak population', () => {
    const [embed] = buildMatchSummary(summary, 'UK Wardogs #1').embeds;

    expect(embed?.title).toBe('🏁 Match over on Bakurani');
    expect(embed?.description).toBe('**Kharr** won 300 – 250 · 38 min · peak 64 players');
  });

  it('lists the top players with kills, deaths and K/D, escaping their names', () => {
    const [embed] = buildMatchSummary(summary, 'UK Wardogs #1').embeds;

    expect(embed?.fields).toEqual([
      { name: 'Top players', value: '1. Cy: 12 kills, 3 deaths (4.00 K/D)\n2. \\*\\*Ash\\*\\*: 11 kills, 1 death (11.00 K/D)' },
    ]);
  });

  it('keeps the player list within Discord\'s 1024 character field limit for long names', () => {
    const longNames = Array.from({ length: 5 }, (_, i) => ({ name: `${'_'.repeat(300)}${i}`, kills: 9, deaths: 9 }));
    const [embed] = buildMatchSummary({ ...summary, top: longNames }, 'UK').embeds;

    expect(embed?.fields?.[0]?.value.length).toBeLessThanOrEqual(1024);
    expect(embed?.fields?.[0]?.value.split('\n')).toHaveLength(5);
  });

  it('never pings anyone', () => {
    expect(buildMatchSummary(summary, 'UK Wardogs #1').allowed_mentions).toEqual({ parse: [], roles: [] });
  });

  it('falls back to the raw map id and leaves out missing scores', () => {
    const [embed] = buildMatchSummary({ ...summary, map: 'NewMap', factionScores: [], top: [] }, 'UK').embeds;

    expect(embed?.title).toBe('🏁 Match over on NewMap');
    expect(embed?.description).toBe('38 min · peak 64 players');
    expect(embed?.fields).toBeUndefined();
  });
});

describe('buildStatusEmbed', () => {
  const status = {
    name: 'UK Wardogs #1',
    players: 24,
    maxPlayers: 98,
    map: 'Europe',
    rotationIndex: 2,
    factionScores: [
      { name: 'Valkyra', score: 120 },
      { name: 'Kharr', score: 95 },
    ],
  };
  const rules = { seeding: 1, live: 20, lowPop: 20, cooldownMs: 0 };

  it('shows population, state, map and scores', () => {
    expect(buildStatusEmbed(status, rules)).toEqual({
      title: 'UK Wardogs #1',
      description: '🟢 **Live** · **24/98** players',
      color: 0x2ecc71,
      fields: [
        { name: 'Map', value: 'Ozeti', inline: true },
        { name: 'Score', value: 'Valkyra 120 – 95 Kharr', inline: true },
      ],
    });
  });

  it('shows a seeding or empty server', () => {
    expect(buildStatusEmbed({ ...status, players: 5 }, rules).description).toBe('🌱 **Seeding** · **5/98** players');
    expect(buildStatusEmbed({ ...status, players: 0, factionScores: [] }, rules)).toMatchObject({
      description: '⚪ **Empty** · **0/98** players',
      fields: [{ name: 'Map', value: 'Ozeti', inline: true }],
    });
  });
});

describe('buildPlayersEmbed', () => {
  const player = (name: string, kills: number | null, deaths: number | null) => ({ steamId: name, name, kills, deaths });

  it('lists players by kills, fewer deaths first on a tie', () => {
    const embed = buildPlayersEmbed([player('Ash', 3, 1), player('Bo_b', 9, 4), player('Cy', 9, 2), player('Di', 1, 1)]);

    expect(embed.title).toBe('👥 4 players online');
    expect(embed.description).toBe(
      '1. Cy: 9 kills, 2 deaths\n2. Bo\\_b: 9 kills, 4 deaths\n3. Ash: 3 kills, 1 death\n4. Di: 1 kill, 1 death',
    );
  });

  it('shows a dash for counts the server left out', () => {
    expect(buildPlayersEmbed([player('Ash', null, null)]).description).toBe('1. Ash: – kills, – deaths');
  });

  it('lists the top 30 and counts the rest', () => {
    const players = Array.from({ length: 40 }, (_, i) => player(`P${i}`, i, 0));
    const lines = buildPlayersEmbed(players).description.split('\n');

    expect(lines).toHaveLength(31);
    expect(lines[0]).toBe('1. P39: 39 kills, 0 deaths');
    expect(lines[30]).toBe('…and 10 more');
  });

  it('says when nobody is on', () => {
    expect(buildPlayersEmbed([])).toMatchObject({ title: '👥 Nobody is on the server' });
  });
});

describe('buildRotationEmbed', () => {
  const entries = [
    { map: 'Kavkazi', status: null },
    { map: 'Europe', status: 'now' },
    { map: 'NorthAmerica', status: 'next' },
    { map: 'Kavkazi', status: null },
  ];

  it('lists the maps from the current one onwards, wrapping round', () => {
    expect(buildRotationEmbed({ enabled: true, mode: 'ordered', entries }).description).toBe(
      '▶ **Ozeti** (now)\nZestafona (next)\nBakurani\nBakurani',
    );
  });

  it('only shows the next map for a random rotation', () => {
    expect(buildRotationEmbed({ enabled: true, mode: 'random', entries }).description).toBe(
      '▶ **Ozeti** (now)\nZestafona (next)\n\nRandom order, so only the next map is known.',
    );
  });

  it('puts the current map first in a random rotation even when the next one comes earlier in the list', () => {
    const wrapped = [
      { map: 'NorthAmerica', status: 'next' },
      { map: 'Europe', status: 'now' },
    ];

    expect(buildRotationEmbed({ enabled: true, mode: 'random', entries: wrapped }).description).toBe(
      '▶ **Ozeti** (now)\nZestafona (next)\n\nRandom order, so only the next map is known.',
    );
  });

  it('says when the rotation is off', () => {
    expect(buildRotationEmbed({ enabled: false, mode: 'ordered', entries }).description).toBe(
      '▶ **Ozeti** (now)\n\nRotation is off, so this map repeats.',
    );
  });

  it('says when there is no rotation', () => {
    expect(buildRotationEmbed({ enabled: true, mode: 'ordered', entries: [] }).description).toBe(
      'No maps in the rotation.',
    );
  });
});

describe('buildLastMatchEmbed', () => {
  it('is the match summary with when it ended', () => {
    const embed = buildLastMatchEmbed({
      map: 'Bakurani',
      endedAt: 1_727_690_000_000,
      durationMs: 38 * 60_000,
      peakPlayers: 64,
      factionScores: [],
      top: [{ name: 'Cy', kills: 12, deaths: 3 }],
    });

    expect(embed.title).toBe('🏁 Match over on Bakurani');
    expect(embed.description).toBe('38 min · peak 64 players · ended <t:1727690000:R>');
    expect(embed.fields?.[0]?.value).toBe('1. Cy: 12 kills, 3 deaths (4.00 K/D)');
  });
});

describe('buildSeedersEmbed', () => {
  it('lists seeders with their seed days, minutes, Steam IDs and VIP', () => {
    const embed = buildSeedersEmbed(
      [
        { steamId: '76561198000000001', name: 'Ash_1', seedingMinutes: 95, seedDays: 3, vipUntil: 1_727_690_000_000 },
        { steamId: '76561198000000002', name: 'Bo', seedingMinutes: 40, seedDays: 1, vipUntil: null },
      ],
      7,
      10,
      null,
    );

    expect(embed.title).toBe('🌱 Top seeders, last 7 days');
    expect(embed.description).toBe(
      [
        '1. Ash\\_1: 3 seed days, 95 min · `76561198000000001` · 🎖️ VIP until <t:1727690000:f>',
        '2. Bo: 1 seed day, 40 min · `76561198000000002`',
        '',
        'A seed day: on for more than 10 min while the server seeded, and it then went live. Days are UTC.',
      ].join('\n'),
    );
  });

  it('says so when nobody seeded, and gives the VIP rule when it is on', () => {
    const vip = { seedDays: 3, seedMinutes: 10, windowDays: 7, lengthDays: 7 };
    const embed = buildSeedersEmbed([], 1, 10, vip);

    expect(embed.title).toBe('🌱 Top seeders, last 1 day');
    expect(embed.description).toMatch(/^Nobody seeded in that time\.\n\n/);
    expect(embed.description).toContain('🎖️ Seed on 3 days in a week and get a reserved slot for a week.');
  });
});

describe('postWebhook', () => {
  const message = buildMessage('seeding', server, { lowPop: 20 });

  it('posts the message as JSON to the webhook', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(null, { status: 204 });
    };

    await postWebhook('https://discord.com/api/webhooks/1/abc', message, fetchFn);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://discord.com/api/webhooks/1/abc');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(message);
  });

  it('throws when Discord rejects the message', async () => {
    const fetchFn = async () => new Response('{"message":"Unknown Webhook"}', { status: 404 });

    await expect(postWebhook('https://discord.com/api/webhooks/1/abc', message, fetchFn)).rejects.toThrow(
      /404/,
    );
  });

  it('gives up on a request that stalls', async () => {
    const stalled = (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });

    await expect(postWebhook('https://discord.com/api/webhooks/1/abc', message, stalled, 10)).rejects.toThrow();
  });
});
