import { describe, expect, it, vi } from 'vitest';
import { nextMap, parseBoardRef, parseStagedMap, showBoard } from '../src/board.ts';
import type { DiscordMessage } from '../src/discord.ts';
import type { Rotation } from '../src/rcon.ts';

const WEBHOOK = 'https://discord.com/api/webhooks/111/token';
const message: DiscordMessage = { embeds: [{ title: 'UK Wardogs #1', color: 0 }], allowed_mentions: { parse: [], roles: [] } };

// Answers each request with the next reply, and keeps what was asked.
const discord = (...replies: Response[]) => {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: JSON.parse(String(init?.body)) });
    const reply = replies.shift();
    if (reply === undefined) throw new Error('No reply left');
    return reply;
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
};

const posted = (id: string) => Response.json({ id, content: '' });

describe('showBoard', () => {
  it('posts the status the first time, and keeps which message it is', async () => {
    const { fetchFn, calls } = discord(posted('900'));

    await expect(showBoard(WEBHOOK, message, null, fetchFn)).resolves.toEqual({ webhookId: '111', messageId: '900' });
    expect(calls).toEqual([{ url: `${WEBHOOK}?wait=true`, method: 'POST', body: message }]);
  });

  it('edits the same message after that', async () => {
    const { fetchFn, calls } = discord(Response.json({ id: '900' }));
    const ref = { webhookId: '111', messageId: '900' };

    await expect(showBoard(WEBHOOK, message, ref, fetchFn)).resolves.toBe(ref);
    expect(calls).toEqual([{ url: `${WEBHOOK}/messages/900`, method: 'PATCH', body: message }]);
  });

  it('posts a new one when the message was deleted', async () => {
    const { fetchFn, calls } = discord(new Response('Unknown Message', { status: 404 }), posted('901'));

    await expect(showBoard(WEBHOOK, message, { webhookId: '111', messageId: '900' }, fetchFn)).resolves.toEqual({
      webhookId: '111',
      messageId: '901',
    });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`PATCH ${WEBHOOK}/messages/900`, `POST ${WEBHOOK}?wait=true`]);
  });

  it('posts a new one when the webhook changed, as only the webhook that posted a message can edit it', async () => {
    const { fetchFn, calls } = discord(posted('950'));

    await expect(showBoard(WEBHOOK, message, { webhookId: '555', messageId: '900' }, fetchFn)).resolves.toEqual({
      webhookId: '111',
      messageId: '950',
    });
    expect(calls.map((c) => c.method)).toEqual(['POST']);
  });

  it('never posts a second message when an edit fails for another reason', async () => {
    const { fetchFn, calls } = discord(new Response('rate limited', { status: 429 }));

    await expect(showBoard(WEBHOOK, message, { webhookId: '111', messageId: '900' }, fetchFn)).rejects.toThrow(
      'Discord webhook edit failed: 429 rate limited',
    );
    expect(calls).toHaveLength(1);
  });

  it('fails when Discord will not take the post', async () => {
    const { fetchFn } = discord(new Response('Unknown Webhook', { status: 404 }));

    await expect(showBoard(WEBHOOK, message, null, fetchFn)).rejects.toThrow('Discord webhook failed: 404 Unknown Webhook');
  });
});

describe('parseBoardRef and parseStagedMap', () => {
  it('read what was saved, and nothing else', () => {
    expect(parseBoardRef({ webhookId: '111', messageId: '900' })).toEqual({ webhookId: '111', messageId: '900' });
    expect(parseBoardRef(undefined)).toBeNull();
    expect(parseBoardRef({ messageId: 900 })).toBeNull();
    expect(parseStagedMap({ map: 'Kavkazi', fromMap: 'Europe', at: 5 })).toEqual({ map: 'Kavkazi', fromMap: 'Europe', at: 5 });
    expect(parseStagedMap('Kavkazi')).toBeNull();
  });
});

describe('nextMap', () => {
  const NOW = 10 * 60 * 60_000;
  const rotation: Rotation = {
    enabled: true,
    mode: 'ordered',
    entries: [
      { map: 'Europe', status: 'now' },
      { map: 'NorthAmerica', status: 'next' },
      { map: 'Kavkazi', status: null },
    ],
  };

  it("is the rotation's next map", () => {
    expect(nextMap('Europe', null, rotation, NOW)).toBe('NorthAmerica');
  });

  it('is the map staff set, while the map it was set on is still being played', () => {
    const staged = { map: 'Kavkazi', fromMap: 'Europe', at: NOW - 30 * 60_000 };

    expect(nextMap('Europe', staged, rotation, NOW)).toBe('Kavkazi');
    // The server moved on, so the staged map is being played now (or was replaced).
    expect(nextMap('Kavkazi', staged, { ...rotation, entries: [] }, NOW)).toBeNull();
  });

  it('forgets a staged map after two hours, longer than any match', () => {
    const staged = { map: 'Kavkazi', fromMap: 'Europe', at: NOW - 2 * 60 * 60_000 };

    expect(nextMap('Europe', staged, rotation, NOW)).toBe('NorthAmerica');
  });

  it('is the same map when the rotation is off, and unknown without the rotation', () => {
    expect(nextMap('Europe', null, { ...rotation, enabled: false }, NOW)).toBe('Europe');
    expect(nextMap('Europe', null, null, NOW)).toBeNull();
  });
});
