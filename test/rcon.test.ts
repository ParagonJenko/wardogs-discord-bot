import { describe, expect, it } from 'vitest';
import { fetchStatus, type HttpGet } from '../src/rcon.ts';

const statusBody = {
  serverName: 'UK Wardogs #1',
  map: 'Kavkazi',
  experiences: ['Kavkazi_KOTH_01'],
  lighting: 'DayClear',
  scoreTick: { current: 20, min: 18, max: 30 },
  players: { current: 14, max: 98 },
  factionScores: [],
  rotation: { nowIndex: 0, nextIndex: 1 },
};

const respondWith = (status: number, body: unknown) => {
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const get: HttpGet = async (url, headers) => {
    requests.push({ url: url.href, headers });
    return { status, body: typeof body === 'string' ? body : JSON.stringify(body) };
  };
  return { get, requests };
};

describe('fetchStatus', () => {
  it('returns the server name and population from /v1/status', async () => {
    const { get } = respondWith(200, statusBody);

    await expect(fetchStatus('http://203.0.113.10:7776', 'secret', get)).resolves.toEqual({
      name: 'UK Wardogs #1',
      players: 14,
      maxPlayers: 98,
    });
  });

  it('authenticates with the RCON password as a bearer token', async () => {
    const { get, requests } = respondWith(200, statusBody);

    await fetchStatus('http://203.0.113.10:7776/', 'secret', get);

    expect(requests).toEqual([
      {
        url: 'http://203.0.113.10:7776/v1/status',
        headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
      },
    ]);
  });

  it('says so when the password is rejected', async () => {
    const { get } = respondWith(401, { error: { code: 'unauthorized', message: 'Bad token' } });

    await expect(fetchStatus('http://203.0.113.10:7776', 'wrong', get)).rejects.toThrow(/password/i);
  });

  it('throws on any other error status', async () => {
    const { get } = respondWith(429, { error: { code: 'rate_limited', message: 'Slow down' } });

    await expect(fetchStatus('http://203.0.113.10:7776', 'secret', get)).rejects.toThrow(/429/);
  });

  it('throws when the response is not a status document', async () => {
    const { get } = respondWith(200, '<html>not rcon</html>');

    await expect(fetchStatus('http://203.0.113.10:7776', 'secret', get)).rejects.toThrow();
  });
});
