import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.ts';
import type { DiscordMessage } from '../src/discord.ts';
import { createPoller } from '../src/poller.ts';

const config: Config = {
  serverId: '123',
  webhookUrl: 'https://discord.com/api/webhooks/1/abc',
  roleId: undefined,
  pollIntervalMs: 60_000,
  rules: { seeding: 1, live: 20, lowPop: 20, cooldownMs: 600_000 },
};

const setup = (populations: (number | Error)[]) => {
  const queue = [...populations];
  const sent: DiscordMessage[] = [];
  const send = vi.fn(async (message: DiscordMessage) => {
    sent.push(message);
  });
  const log = { info: vi.fn(), error: vi.fn() };
  let clock = 0;
  const tick = createPoller({
    config,
    fetchServer: async () => {
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return { id: '123', name: 'UK Wardogs #1', players: next ?? 0, maxPlayers: 64 };
    },
    send,
    now: () => (clock += 60_000),
    log,
  });
  return { tick, send, sent, log };
};

describe('poller', () => {
  it('posts nothing on the first check, so restarts do not re-announce', async () => {
    const { tick, send } = setup([25]);

    await tick();

    expect(send).not.toHaveBeenCalled();
  });

  it('posts an alert when the population crosses a threshold', async () => {
    const { tick, sent } = setup([0, 3]);

    await tick();
    await tick();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.embeds[0]?.title).toMatch(/is seeding/);
  });

  it('retries the alert on the next check when Discord rejects it', async () => {
    const { tick, send, log } = setup([0, 20, 20, 20]);
    send.mockRejectedValueOnce(new Error('Discord webhook failed: 500'));

    await tick();
    await tick();
    await tick();
    await tick();

    expect(send).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('500'));
  });

  it('keeps going when BattleMetrics is unreachable', async () => {
    const { tick, sent, log } = setup([0, new Error('fetch failed'), 1]);

    await tick();
    await expect(tick()).resolves.toBeUndefined();
    await tick();

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('fetch failed'));
    expect(sent).toHaveLength(1);
  });
});
