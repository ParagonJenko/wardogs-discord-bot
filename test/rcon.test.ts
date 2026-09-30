import { describe, expect, it } from 'vitest';
import { fetchPlayers, fetchRotation, fetchStatus, sendBroadcast, type HttpClient } from '../src/rcon.ts';

const statusBody = {
  serverName: 'UK Wardogs #1',
  map: 'Kavkazi',
  experiences: ['Kavkazi_KOTH_01'],
  lighting: 'DayClear',
  scoreTick: { current: 20, min: 18, max: 30 },
  players: { current: 14, max: 98 },
  factionScores: [
    { name: 'Valkyra', colorHex: '#3366ff', score: 412 },
    { name: 'Kharr', colorHex: '#ff3333', score: 388 },
  ],
  rotation: { nowIndex: 0, nextIndex: 1 },
};

const respondWith = (status: number, body: unknown) => {
  const requests: { url: string; headers: Record<string, string>; body?: string }[] = [];
  const get: HttpClient = async (url, headers, sent) => {
    requests.push({ url: url.href, headers, ...(sent === undefined ? {} : { body: sent }) });
    return { status, body: typeof body === 'string' ? body : JSON.stringify(body) };
  };
  return { get, requests };
};

describe('fetchStatus', () => {
  it('returns the server name, population, map and scores from /v1/status', async () => {
    const { get } = respondWith(200, statusBody);

    await expect(fetchStatus('http://203.0.113.10:7776', 'secret', get)).resolves.toEqual({
      name: 'UK Wardogs #1',
      players: 14,
      maxPlayers: 98,
      map: 'Kavkazi',
      rotationIndex: 0,
      factionScores: [
        { name: 'Valkyra', score: 412 },
        { name: 'Kharr', score: 388 },
      ],
    });
  });

  it('copes with a live build that leaves out the optional fields', async () => {
    const { get } = respondWith(200, { serverName: 'Bare', players: { current: 0, max: 98 } });

    await expect(fetchStatus('http://203.0.113.10:7776', 'secret', get)).resolves.toEqual({
      name: 'Bare',
      players: 0,
      maxPlayers: 98,
      map: '',
      rotationIndex: null,
      factionScores: [],
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

describe('fetchPlayers', () => {
  it('returns each player with their kills and deaths from /v1/players', async () => {
    const { get, requests } = respondWith(200, {
      players: [
        { name: 'Ash', steamId: '76561198000000001', faction: 'Valkyra', kills: 12, deaths: 3, cash: 900, pingMs: 40 },
        { name: 'Bo', steamId: '76561198000000002', faction: 'Kharr', kills: 0, deaths: 1, cash: 100, pingMs: 60 },
      ],
      count: 2,
    });

    await expect(fetchPlayers('http://203.0.113.10:7776', 'secret', get)).resolves.toEqual([
      { steamId: '76561198000000001', name: 'Ash', kills: 12, deaths: 3 },
      { steamId: '76561198000000002', name: 'Bo', kills: 0, deaths: 1 },
    ]);
    expect(requests[0]?.url).toBe('http://203.0.113.10:7776/v1/players');
  });

  it('reports a missing kill or death count as unknown rather than zero', async () => {
    const { get } = respondWith(200, { players: [{ name: 'Ash', steamId: '1' }], count: 1 });

    await expect(fetchPlayers('http://203.0.113.10:7776', 'secret', get)).resolves.toEqual([
      { steamId: '1', name: 'Ash', kills: null, deaths: null },
    ]);
  });
});

describe('fetchRotation', () => {
  it('returns the rotation entries in order with which one is playing now', async () => {
    const { get, requests } = respondWith(200, {
      enabled: true,
      mode: 'ordered',
      entries: [
        { index: 0, map: 'Kavkazi', experiences: ['Kavkazi_KOTH_01'], lighting: 'DayClear', status: null, denied: false },
        { index: 1, map: 'Europe', experiences: ['Europe_KOTH_01'], lighting: 'DayEarlyFog', status: 'now', denied: false },
        { index: 2, map: 'NorthAmerica', experiences: [], lighting: 'DayLateClear', status: 'next', denied: false },
      ],
    });

    await expect(fetchRotation('http://203.0.113.10:7776', 'secret', get)).resolves.toEqual({
      enabled: true,
      mode: 'ordered',
      entries: [
        { map: 'Kavkazi', status: null },
        { map: 'Europe', status: 'now' },
        { map: 'NorthAmerica', status: 'next' },
      ],
    });
    expect(requests[0]?.url).toBe('http://203.0.113.10:7776/v1/rotation');
  });
});

describe('sendBroadcast', () => {
  it('posts the message to /v1/broadcast', async () => {
    const { get, requests } = respondWith(200, { message: 'Broadcast sent.' });

    await sendBroadcast('http://203.0.113.10:7776', 'secret', 'Seeding now, jump in!', get);

    expect(requests).toEqual([
      {
        url: 'http://203.0.113.10:7776/v1/broadcast',
        headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
        body: JSON.stringify({ message: 'Seeding now, jump in!' }),
      },
    ]);
  });

  it('throws when the server refuses it', async () => {
    const { get } = respondWith(400, { error: { code: 'bad_request', message: 'Message too long' } });

    await expect(sendBroadcast('http://203.0.113.10:7776', 'secret', 'x', get)).rejects.toThrow(/400/);
  });
});
