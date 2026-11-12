import { describe, expect, it } from 'vitest';
import {
  addRotationEntry,
  addBan,
  endMatch,
  fetchBans,
  fetchChat,
  parseChat,
  fetchConfig,
  fetchExperiences,
  fetchLightings,
  fetchMapExperiences,
  fetchMaps,
  fetchPlayers,
  fetchZones,
  kickPlayer,
  messagePlayer,
  moveRotationEntry,
  queueMap,
  removeBan,
  switchFaction,
  fetchRotation,
  fetchRoutes,
  fetchStatus,
  isNotInGame,
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
      rotationNextIndex: 1,
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

  it("says which request failed, with the server's error code and message", async () => {
    const { get } = respondWith(404, { error: { code: 'not_found', message: 'No such\nendpoint.' } });

    await expect(fetchStatus('http://203.0.113.10:7776', 'secret', get)).rejects.toThrow(
      'RCON request failed: GET /v1/status 404 (not_found: No such endpoint.)',
    );
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
  it('returns the rotation entries in order with which one is playing now, and how each is played', async () => {
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
        { map: 'Kavkazi', status: null, experiences: ['Kavkazi_KOTH_01'], lighting: 'DayClear' },
        { map: 'Europe', status: 'now', experiences: ['Europe_KOTH_01'], lighting: 'DayEarlyFog' },
        { map: 'NorthAmerica', status: 'next', experiences: [], lighting: 'DayLateClear' },
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

  it('tells a ban refused because the player is not in game from any other refusal', async () => {
    const notOn = { error: { code: 'player_not_found', message: `Error: no player matching '${ASH}'.` } };
    const { http } = server([404, notOn], [404, { error: { code: 'not_found', message: 'No such endpoint.' } }], [500, 'oops']);

    const refused = await addBan(RCON, 'secret', ASH, 'Cheating', http).catch((error: unknown) => error);
    const missing = await addBan(RCON, 'secret', ASH, 'Cheating', http).catch((error: unknown) => error);
    const broken = await addBan(RCON, 'secret', ASH, 'Cheating', http).catch((error: unknown) => error);

    expect(String(refused)).toContain(`POST /v1/bans 404 (player_not_found: Error: no player matching '${ASH}'.)`);
    expect([refused, missing, broken].map(isNotInGame)).toEqual([true, false, false]);
    expect(String(broken)).toContain('POST /v1/bans 500');
    expect(isNotInGame(new Error('player_not_found'))).toBe(false);
  });

  it('names lightings and zone layouts from their ids when the server gives no name, and keeps the names it gives', async () => {
    const { http } = server(
      [200, { lightings: [{ id: 'DayStartClear' }, { id: 'DayLateRain', displayName: 'DayLateRain' }, { id: 'DayClear', displayName: 'Clear day' }] }],
      [
        200,
        {
          map: 'Kavkazi',
          alternators: [
            { index: 0, tag: 'ZoneAlternator.Bakurani.Default.Circle' },
            { index: 1, tag: 'ZoneAlternator.Bakurani.Default.NorthSouthLine', displayName: 'ZoneAlternator.Bakurani.Default.NorthSouthLine' },
            { index: 2, tag: 'ZoneAlternator.Bakurani.Default.Factory', displayName: 'The factory' },
          ],
          count: 3,
        },
      ],
    );

    await expect(fetchLightings(RCON, 'secret', http)).resolves.toEqual([
      { id: 'DayStartClear', name: 'Dawn, clear' },
      { id: 'DayLateRain', name: 'Afternoon, rain' },
      { id: 'DayClear', name: 'Clear day' },
    ]);
    await expect(fetchZones(RCON, 'secret', 'Kavkazi', http)).resolves.toEqual([
      { id: 'ZoneAlternator.Bakurani.Default.Circle', name: 'Circle' },
      { id: 'ZoneAlternator.Bakurani.Default.NorthSouthLine', name: 'North South Line' },
      { id: 'ZoneAlternator.Bakurani.Default.Factory', name: 'The factory' },
    ]);
  });

  it('still throws when removing a ban fails for another reason', async () => {
    const { http } = server([500, { error: 'boom' }]);

    await expect(removeBan(RCON, 'secret', ASH, http)).rejects.toThrow(/500/);
  });

  it('reads the catalogue of modes, lighting and zone layouts, refusing a map id it cannot put in a path', async () => {
    const { http, requests } = server(
      [200, { experiences: [{ id: 'Kavkazi_KOTH_01', displayName: 'King of the Hill' }, { id: 'KOTH_InfantryOnly' }] }],
      [200, { lightings: [{ id: 'DayClear', displayName: 'Day, clear' }] }],
      [200, { map: 'Kavkazi', experiences: ['Kavkazi_KOTH_01', 'KOTH_InfantryOnly'], count: 2 }],
      [200, { map: 'Kavkazi', alternators: [{ index: 0, tag: 'ZoneAlternator.Bakurani.Default.Circle', displayName: 'Circle' }], count: 1 }],
    );

    await expect(fetchExperiences(RCON, 'secret', http)).resolves.toEqual([
      { id: 'Kavkazi_KOTH_01', name: 'King of the Hill' },
      { id: 'KOTH_InfantryOnly', name: 'KOTH_InfantryOnly' },
    ]);
    await expect(fetchLightings(RCON, 'secret', http)).resolves.toEqual([{ id: 'DayClear', name: 'Day, clear' }]);
    await expect(fetchMapExperiences(RCON, 'secret', 'Kavkazi', http)).resolves.toEqual(['Kavkazi_KOTH_01', 'KOTH_InfantryOnly']);
    await expect(fetchZones(RCON, 'secret', 'Kavkazi', http)).resolves.toEqual([
      { id: 'ZoneAlternator.Bakurani.Default.Circle', name: 'Circle' },
    ]);
    await expect(fetchZones(RCON, 'secret', '../bans', http)).rejects.toThrow(/Not a map id/);
    expect(requests.map((r) => r.path)).toEqual([
      '/v1/catalog/experiences',
      '/v1/catalog/lightings',
      '/v1/catalog/maps/Kavkazi/experiences',
      '/v1/catalog/maps/Kavkazi/alternators',
    ]);
  });

  it('queues a map with its setup', async () => {
    const { http, requests } = server([200, {}]);

    await queueMap(RCON, 'secret', 'Europe', http, { experiences: ['Europe_KOTH_01', 'KOTH_InfantryOnly'], lighting: 'DayClear' });

    expect(requests[0]?.body).toBe(JSON.stringify({ map: 'Europe', experiences: ['Europe_KOTH_01', 'KOTH_InfantryOnly'], lighting: 'DayClear' }));
  });

  it('reads the routes the build serves, with each path parameter as *', async () => {
    const { http, requests } = server([200, { routes: ['GET /v1/status', 'POST /v1/rotation/entries', 'POST  /v1/rotation/entries/{index}/move'] }]);

    await expect(fetchRoutes(RCON, 'secret', http)).resolves.toEqual(['GET /v1/status', 'POST /v1/rotation/entries', 'POST /v1/rotation/entries/*/move']);
    expect(requests[0]?.path).toBe('/v1/capabilities');
  });

  it('adds and moves live rotation entries', async () => {
    const { http, requests } = server([200, {}], [200, {}]);

    await addRotationEntry(RCON, 'secret', 'Europe', http, { experiences: ['Madrid_KOTH_01', 'KOTH_InfantryOnly'], lighting: 'DayClear' });
    await moveRotationEntry(RCON, 'secret', 7, 'up', http);
    await expect(moveRotationEntry(RCON, 'secret', -1, 'up', http)).rejects.toThrow(/Not a rotation index/);

    expect(requests.map((r) => [r.method, r.path, r.body])).toEqual([
      ['POST', '/v1/rotation/entries', JSON.stringify({ map: 'Europe', experiences: ['Madrid_KOTH_01', 'KOTH_InfantryOnly'], lighting: 'DayClear' })],
      ['POST', '/v1/rotation/entries/7/move', JSON.stringify({ direction: 'up' })],
    ]);
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

describe('the chat route', () => {
  const NOW = Date.UTC(2026, 9, 7, 20);
  const ASH = '76561198000000001';

  it('asks for the lines after the cursor, authenticated', async () => {
    const { get, requests } = respondWith(200, { messages: [] });
    await expect(fetchChat('http://203.0.113.10:7776', 'secret', 41, 200, get, NOW)).resolves.toEqual({ lines: [], skipped: 0 });
    expect(requests[0]?.url).toBe('http://203.0.113.10:7776/v1/chat?after=41&limit=200');
    expect(requests[0]?.headers['Authorization']).toBe('Bearer secret');
    await expect(fetchChat('http://203.0.113.10:7776', 'secret', -1, 200, get)).rejects.toThrow('Not a chat cursor');
    await expect(fetchChat('http://203.0.113.10:7776', 'secret', 0, 0, get)).rejects.toThrow('Not a chat cursor');
  });

  it('says so when the route is not there or the password is wrong', async () => {
    await expect(fetchChat('http://203.0.113.10:7776', 'secret', 0, 200, respondWith(404, { error: { code: 'not_found' } }).get)).rejects.toMatchObject({ status: 404 });
    await expect(fetchChat('http://203.0.113.10:7776', 'secret', 0, 200, respondWith(401, {}).get)).rejects.toMatchObject({ status: 401 });
  });

  it('reads the list under any of the names, or a list on its own', () => {
    const one = { id: 1, steamId: ASH, name: 'Ash', message: 'hi' };
    for (const raw of [{ messages: [one] }, { chat: [one] }, { entries: [one] }, { lines: [one] }, [one]]) {
      expect(parseChat(raw, NOW).lines).toEqual([{ id: 1, steamId: ASH, name: 'Ash', text: 'hi', at: NOW }]);
    }
  });

  it('takes the first field present under each of the names', () => {
    const named = (fields: Record<string, unknown>) => parseChat({ messages: [fields] }, NOW).lines[0];
    expect(named({ sequence: 7, playerId: ASH, playerName: 'Bo', text: 'yo', scope: 'Team', time: '2026-10-07T20:01:00Z' })).toEqual({
      id: 7,
      steamId: ASH,
      name: 'Bo',
      text: 'yo',
      channel: 'Team',
      at: Date.UTC(2026, 9, 7, 20, 1),
    });
    expect(named({ seq: 8, senderSteamId: ASH, sender: 'Cy', body: 'hey', team: 'All', sentAtUtc: '2026-10-07T20:02:00.000Z' })).toMatchObject({
      id: 8,
      steamId: ASH,
      name: 'Cy',
      text: 'hey',
      channel: 'All',
      at: Date.UTC(2026, 9, 7, 20, 2),
    });
    expect(named({ cursor: '9', steamId: ASH, name: 'Di', message: 'ho' })).toMatchObject({ id: 9 });
    // The first name wins over a later one.
    expect(named({ id: 1, sequence: 2, steamId: ASH, playerId: '1', name: 'A', playerName: 'B', message: 'm', text: 't' })).toMatchObject({
      id: 1,
      name: 'A',
      text: 'm',
    });
  });

  it('reads a time as seconds, milliseconds or a date, and falls back to when it was read', () => {
    const at = (time: unknown) => parseChat({ messages: [{ id: 1, name: 'A', message: 'm', time }] }, NOW).lines[0]?.at;
    expect(at(1_791_400_000)).toBe(1_791_400_000_000);
    expect(at(1_791_400_000_123)).toBe(1_791_400_000_123);
    expect(at('1791400000')).toBe(1_791_400_000_000);
    expect(at('2026-10-07T20:00:00Z')).toBe(NOW);
    expect(at('not a time')).toBe(NOW);
    expect(at(undefined)).toBe(NOW);
    expect(at(true)).toBe(NOW);
  });

  it('keeps a line with no usable Steam ID, but as nobody', () => {
    const lines = parseChat(
      {
        messages: [
          { id: 1, name: 'Server', message: 'Match starting' },
          { id: 2, steamId: 76561198000000001, name: 'A', message: 'rounded' },
          { id: 3, steamId: 'abc', name: 'A', message: 'odd' },
        ],
      },
      NOW,
    ).lines;
    expect(lines.map((l) => l.steamId)).toEqual([null, null, null]);
  });

  it('skips lines it cannot read, and counts them', () => {
    const answer = parseChat(
      {
        messages: [
          { id: 1, steamId: ASH, name: 'A', message: 'ok' },
          { steamId: ASH, name: 'A', message: 'no id' },
          { id: 'x', steamId: ASH, name: 'A', message: 'odd id' },
          { id: 3, steamId: ASH, name: 'A' },
          { id: 4, steamId: ASH, name: 'A', message: '   ' },
          { id: -5, steamId: ASH, name: 'A', message: 'negative' },
          'a string',
          null,
          { id: 6, steamId: ASH, name: 'A', message: { nested: true } },
        ],
      },
      NOW,
    );
    expect(answer.lines.map((l) => l.id)).toEqual([1]);
    expect(answer.skipped).toBe(8);
  });

  it('ignores a field of the wrong type instead of failing the line', () => {
    const [line] = parseChat({ messages: [{ id: 1, steamId: ASH, name: { first: 'A' }, playerName: 'Real', message: 'hi', channel: ['x'] }] }, NOW).lines;
    expect(line).toMatchObject({ name: 'Real', text: 'hi' });
    expect(line).not.toHaveProperty('channel');
  });

  it('puts the lines oldest first, and cleans the text and name', () => {
    const { lines } = parseChat(
      { messages: [{ id: 5, name: ' B\n', message: 'second\u0000line' }, { id: 2, name: 'A', message: 'x'.repeat(400) }] },
      NOW,
    );
    expect(lines.map((l) => l.id)).toEqual([2, 5]);
    expect(lines[0]?.text).toHaveLength(300);
    expect(lines[1]).toMatchObject({ name: 'B', text: 'second line' });
  });

  it('throws when the answer holds no list of lines, so a changed shape is noticed', () => {
    for (const raw of [{}, { ok: true }, { messages: 'none' }, 'text', 5, null]) {
      expect(() => parseChat(raw, NOW), JSON.stringify(raw)).toThrow('no list of lines');
    }
    expect(parseChat({ messages: [] }, NOW)).toEqual({ lines: [], skipped: 0 });
  });
});
