import { describe, expect, it } from 'vitest';
import { buildMatchSummary, buildMessage, buildStatusEmbed, postWebhook } from '../src/discord.ts';

const server = { name: 'UK Wardogs #1', players: 7, maxPlayers: 64 };

describe('buildMessage', () => {
  it('announces seeding with the server name and population', () => {
    const [embed] = buildMessage('seeding', server, { lowPop: 20 }).embeds;

    expect(embed?.title).toMatch(/UK Wardogs #1 is seeding/);
    expect(embed?.description).toContain('7/64');
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
