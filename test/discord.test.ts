import { describe, expect, it } from 'vitest';
import { buildMessage, postWebhook } from '../src/discord.ts';

const server = { id: '123', name: 'UK Wardogs #1', players: 7, maxPlayers: 64 };

describe('buildMessage', () => {
  it('announces seeding with the server name and population', () => {
    const [embed] = buildMessage('seeding', server, { lowPop: 20 }).embeds;

    expect(embed?.title).toMatch(/UK Wardogs #1 is seeding/);
    expect(embed?.description).toContain('7/64');
    expect(embed?.url).toBe('https://www.battlemetrics.com/servers/wardogs/123');
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
});
