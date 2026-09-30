import { describe, expect, it } from 'vitest';
import {
  addBan,
  endMatch,
  fetchBans,
  fetchConfig,
  fetchMaps,
  fetchPlayers,
  kickPlayer,
  messagePlayer,
  queueMap,
  removeBan,
  switchFaction,
  fetchRotation,
  fetchStatus,
  putConfig,
  sendBroadcast,
  validateConfig,
  type HttpClient,
} from '../src/rcon.ts';

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
        { name: 'Valkyra', score: 412, colorHex: '#3366ff' },
        { name: 'Kharr', score: 388, colorHex: '#ff3333' },
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
      { steamId: '76561198000000001', name: 'Ash', kills: 12, deaths: 3, faction: 'Valkyra' },
      { steamId: '76561198000000002', name: 'Bo', kills: 0, deaths: 1, faction: 'Kharr' },
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

  it('accepts an empty success reply', async () => {
    const { get } = respondWith(204, '');

    await expect(sendBroadcast('http://203.0.113.10:7776', 'secret', 'hi', get)).resolves.toBeUndefined();
  });

  it('throws when the server refuses it', async () => {
    const { get } = respondWith(400, { error: { code: 'bad_request', message: 'Message too long' } });

    await expect(sendBroadcast('http://203.0.113.10:7776', 'secret', 'x', get)).rejects.toThrow(/400/);
  });
});

describe('server config', () => {
  const recorder = (status: number, body: unknown) => {
    const requests: { path: string; method: string; headers: Record<string, string>; body?: string }[] = [];
    const http: HttpClient = async (url, headers, sent, method) => {
      requests.push({ path: url.pathname, method: sent === undefined ? 'GET' : (method ?? 'POST'), headers, ...(sent === undefined ? {} : { body: sent }) });
      return { status, body: JSON.stringify(body) };
    };
    return { http, requests };
  };
  const ini = '[/Script/WDGame.WDGameSession]\n+DefaultReservedPlayerIds=76561198000000001\n';

  it('reads ServerSettings.ini and its revision', async () => {
    const { http } = recorder(200, { revision: 7, writable: true, text: ini, sections: [] });

    await expect(fetchConfig('http://203.0.113.10:7776', 'secret', http)).resolves.toEqual({ revision: '7', writable: true, text: ini });
  });

  it('validates as plain text, then writes it only if the revision still matches', async () => {
    const { http, requests } = recorder(200, { ok: true, errors: [], stripped: [], shadowed: [] });

    await validateConfig('http://203.0.113.10:7776', 'secret', ini, http);
    await putConfig('http://203.0.113.10:7776', 'secret', { revision: 'abc', writable: true, text: ini }, http);

    expect(requests.map((r) => [r.method, r.path, r.headers['Content-Type'], r.headers['If-Match'], r.body])).toEqual([
      ['POST', '/v1/config/validate', 'text/plain; charset=utf-8', undefined, ini],
      ['PUT', '/v1/config', 'text/plain; charset=utf-8', '"abc"', ini],
    ]);
  });

  it('reports errors, and keys the server strips or pins', async () => {
    const { http } = recorder(200, { ok: false, errors: [{ key: 'MaxPlayers', message: 'too high' }], stripped: ['DefaultReservedPlayerIds'] });

    await expect(validateConfig('http://203.0.113.10:7776', 'secret', ini, http)).resolves.toEqual({
      ok: false,
      errors: ['{"key":"MaxPlayers","message":"too high"}'],
      ignored: ['DefaultReservedPlayerIds'],
    });
  });

  it('throws when someone else changed the file since it was read', async () => {
    const { http } = recorder(412, { error: 'revision mismatch' });

    await expect(putConfig('http://203.0.113.10:7776', 'secret', { revision: '"abc"', writable: true, text: ini }, http)).rejects.toThrow(/412/);
  });
});

describe('staff actions', () => {
  const RCON = 'http://203.0.113.10:7776';
  const ASH = '76561198000000001';
  // Answers each request in turn with the next status and body, recording what was sent.
  const server = (...replies: [number, unknown][]) => {
    const requests: { method: string; path: string; body?: string }[] = [];
    const http: HttpClient = async (url, _headers, sent, method) => {
      requests.push({ method: method ?? (sent === undefined ? 'GET' : 'POST'), path: url.pathname, ...(sent === undefined ? {} : { body: sent }) });
      const [status, body] = replies[Math.min(requests.length, replies.length) - 1] ?? [200, {}];
      return { status, body: typeof body === 'string' ? body : JSON.stringify(body) };
    };
    return { http, requests };
  };

  it('messages, kicks and moves a player by Steam ID', async () => {
    const { http, requests } = server([200, {}]);

    await messagePlayer(RCON, 'secret', ASH, 'Staff warning: stop', http);
    await kickPlayer(RCON, 'secret', ASH, 'Spawn camping', http);
    await switchFaction(RCON, 'secret', ASH, 'Kharr', http);

    expect(requests).toEqual([
      { method: 'POST', path: `/v1/players/${ASH}/message`, body: JSON.stringify({ message: 'Staff warning: stop' }) },
      { method: 'POST', path: `/v1/players/${ASH}/kick`, body: JSON.stringify({ reason: 'Spawn camping' }) },
      { method: 'PATCH', path: `/v1/players/${ASH}`, body: JSON.stringify({ faction: 'Kharr' }) },
      { method: 'POST', path: `/v1/players/${ASH}/kill`, body: '{}' },
    ]);
  });

  it('still moves a player whose respawn fails, but not one the server refuses to move', async () => {
    const dead = server([200, {}], [409, { error: 'no pawn' }]);
    await expect(switchFaction(RCON, 'secret', ASH, 'Kharr', dead.http)).resolves.toBeUndefined();

    const refused = server([400, { error: 'unknown faction' }]);
    await expect(switchFaction(RCON, 'secret', ASH, 'Nobody', refused.http)).rejects.toThrow(/400/);
    expect(refused.requests).toHaveLength(1);
  });

  it('refuses anything that is not a Steam ID before sending', async () => {
    const { http, requests } = server([200, {}]);

    await expect(kickPlayer(RCON, 'secret', '../config', 'x', http)).rejects.toThrow(/Steam ID/);
    await expect(addBan(RCON, 'secret', 'Ash', 'x', http)).rejects.toThrow(/Steam ID/);
    await expect(removeBan(RCON, 'secret', '1', http)).rejects.toThrow(/Steam ID/);
    expect(requests).toEqual([]);
  });

  it('lists, adds and removes bans, saying when there was no ban', async () => {
    const { http, requests } = server([200, { bans: [{ steamId: ASH, reason: 'Cheating', bannedBy: null }] }], [201, ''], [204, ''], [404, { error: { code: 'ban_not_found' } }]);

    await expect(fetchBans(RCON, 'secret', http)).resolves.toEqual([{ steamId: ASH, reason: 'Cheating', bannedBy: null }]);
    await addBan(RCON, 'secret', ASH, 'Cheating', http);
    await expect(removeBan(RCON, 'secret', ASH, http)).resolves.toBe(true);
    await expect(removeBan(RCON, 'secret', ASH, http)).resolves.toBe(false);

    expect(requests.map((r) => [r.method, r.path, r.body])).toEqual([
      ['GET', '/v1/bans', undefined],
      ['POST', '/v1/bans', JSON.stringify({ steamId: ASH, reason: 'Cheating' })],
      ['DELETE', `/v1/bans/${ASH}`, undefined],
      ['DELETE', `/v1/bans/${ASH}`, undefined],
    ]);
  });

  it('still throws when removing a ban fails for another reason', async () => {
    const { http } = server([500, { error: 'boom' }]);

    await expect(removeBan(RCON, 'secret', ASH, http)).rejects.toThrow(/500/);
  });

  it('lists maps, queues the next one and ends the match', async () => {
    const { http, requests } = server([200, { maps: [{ id: 'Kavkazi', displayName: 'Kavkazi Pass' }, { id: 'Europe' }] }], [200, {}]);

    await expect(fetchMaps(RCON, 'secret', http)).resolves.toEqual([
      { id: 'Kavkazi', name: 'Kavkazi Pass' },
      { id: 'Europe', name: 'Europe' },
    ]);
    await queueMap(RCON, 'secret', 'Europe', http);
    await endMatch(RCON, 'secret', http);

    expect(requests.map((r) => [r.method, r.path, r.body])).toEqual([
      ['GET', '/v1/catalog/maps', undefined],
      ['POST', '/v1/match/map', JSON.stringify({ map: 'Europe' })],
      ['POST', '/v1/match/end', '{}'],
    ]);
  });
});
