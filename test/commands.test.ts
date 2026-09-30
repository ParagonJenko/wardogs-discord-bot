import { describe, expect, it, vi } from 'vitest';
import { runCommand } from '../src/commands.ts';
import type { Config } from '../src/config.ts';
import type { HttpClient } from '../src/rcon.ts';

const config: Config = {
  rconUrl: 'http://203.0.113.10:7776',
  rconPassword: 'secret',
  webhookUrl: 'https://discord.com/api/webhooks/1/abc',
  roleId: undefined,
  inviteCode: undefined,
  pollIntervalMs: 60_000,
  rules: { seeding: 1, live: 20, lowPop: 20, cooldownMs: 600_000 },
};

// A fake RCON server keyed by path; records what was sent.
const rcon = (responses: Record<string, unknown>) => {
  const sent: { path: string; body?: string }[] = [];
  const http: HttpClient = async (url, _headers, body) => {
    sent.push({ path: url.pathname, ...(body === undefined ? {} : { body }) });
    return { status: 200, body: JSON.stringify(responses[url.pathname] ?? {}) };
  };
  return { http, sent };
};

const setup = (responses: Record<string, unknown> = {}, lastMatch: unknown = null) => {
  const server = rcon(responses);
  const log = { info: vi.fn() };
  const run = runCommand({
    config: () => config,
    http: server.http,
    lastMatch: async () => lastMatch as never,
    log,
  });
  return { run, sent: server.sent, log };
};

describe('runCommand', () => {
  it('/serverstatus shows the status embed', async () => {
    const { run } = setup({ '/v1/status': { serverName: 'UK Wardogs #1', map: 'Europe', players: { current: 24, max: 98 } } });

    const reply = await run({ name: 'serverstatus', options: {}, userId: null });

    expect(reply.embeds?.[0]).toMatchObject({ title: 'UK Wardogs #1', description: '🟢 **Live** · **24/98** players' });
  });

  it('/players lists who is online', async () => {
    const { run } = setup({ '/v1/players': { players: [{ name: 'Ash', steamId: '1', kills: 3, deaths: 1 }], count: 1 } });

    const reply = await run({ name: 'players', options: {}, userId: null });

    expect(reply.embeds?.[0]).toMatchObject({ title: '👥 1 player online', description: '1. Ash: 3 kills, 1 death' });
  });

  it('/rotation shows the rotation', async () => {
    const { run } = setup({ '/v1/rotation': { enabled: true, mode: 'ordered', entries: [{ map: 'Kavkazi', status: 'now' }] } });

    const reply = await run({ name: 'rotation', options: {}, userId: null });

    expect(reply.embeds?.[0]?.description).toBe('▶ **Bakurani** (now)');
  });

  it('/lastmatch shows the most recent finished match', async () => {
    const match = { map: 'Ozeti', endedAt: 0, durationMs: 60_000, peakPlayers: 30, factionScores: [], top: [] };
    const { run } = setup({}, match);

    const reply = await run({ name: 'lastmatch', options: {}, userId: null });

    expect(reply.embeds?.[0]?.title).toBe('🏁 Match over on Ozeti');
  });

  it('/lastmatch says so when no match has finished yet', async () => {
    const { run } = setup();

    await expect(run({ name: 'lastmatch', options: {}, userId: null })).resolves.toEqual({
      content: 'No finished matches recorded yet.',
    });
  });

  it('/broadcast sends the message in game and logs who sent it', async () => {
    const { run, sent, log } = setup();

    const reply = await run({ name: 'broadcast', options: { message: '  Seeding now!  ' }, userId: '42' });

    expect(sent).toEqual([{ path: '/v1/broadcast', body: JSON.stringify({ message: 'Seeding now!' }) }]);
    expect(reply).toEqual({ content: '📢 Sent in game: Seeding now!' });
    expect(log.info).toHaveBeenCalledWith('/broadcast by Discord user 42: Seeding now!');
  });

  it('/broadcast sends nothing for an empty message', async () => {
    const { run, sent } = setup();

    await expect(run({ name: 'broadcast', options: { message: '   ' }, userId: '42' })).resolves.toEqual({
      content: 'Nothing to send.',
    });
    expect(sent).toEqual([]);
  });
});
