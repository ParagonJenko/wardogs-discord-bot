import { describe, expect, it } from 'vitest';
import { fetchServer } from '../src/battlemetrics.ts';

const serverBody = (attributes: Record<string, unknown>) => ({
  data: {
    type: 'server',
    id: '123',
    attributes: { name: 'UK Wardogs #1', players: 14, maxPlayers: 64, status: 'online', ...attributes },
  },
});

const respondWith = (body: unknown, status = 200) => {
  const requested: string[] = [];
  const fetchFn = async (url: string | URL | Request) => {
    requested.push(String(url));
    return new Response(JSON.stringify(body), { status });
  };
  return { fetchFn, requested };
};

describe('fetchServer', () => {
  it('returns the server name and population from BattleMetrics', async () => {
    const { fetchFn, requested } = respondWith(serverBody({}));

    await expect(fetchServer('123', fetchFn)).resolves.toEqual({
      id: '123',
      name: 'UK Wardogs #1',
      players: 14,
      maxPlayers: 64,
    });
    expect(requested).toEqual(['https://api.battlemetrics.com/servers/123']);
  });

  it('reports an offline server as empty', async () => {
    const { fetchFn } = respondWith(serverBody({ status: 'offline', players: 30 }));

    await expect(fetchServer('123', fetchFn)).resolves.toMatchObject({ players: 0 });
  });

  it('throws when BattleMetrics returns an error status', async () => {
    const { fetchFn } = respondWith({ errors: [{ title: 'Not Found' }] }, 404);

    await expect(fetchServer('123', fetchFn)).rejects.toThrow(/404/);
  });

  it('throws when the response is not a server', async () => {
    const { fetchFn } = respondWith({ data: [] });

    await expect(fetchServer('123', fetchFn)).rejects.toThrow();
  });
});
