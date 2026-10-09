import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from 'wrangler';

// The Worker as Cloudflare runs it: built from wrangler.jsonc by Wrangler and run in workerd, the same runtime, with the
// Durable Object and its SQLite storage. The other tests cover each part on its own; these check they still fit
// together, so a deploy does not break the cron, the website's API, the kill feed or the slash commands.
//
// The game server is a fake one on localhost, and nothing here reaches Discord: every request that would is either
// refused before it leaves (a bad signature, someone who is not staff) or answered by the Worker itself (PING,
// suggestions).

// No telemetry, and no fetch of Cloudflare's Request.cf data, from a test run.
process.env['WRANGLER_SEND_METRICS'] = 'false';
process.env['CLOUDFLARE_CF_FETCH_ENABLED'] = 'false';

const GUILD = '100000000000000001';
const STAFF_ROLE = '100000000000000002';
const FEED_TOKEN = 'kill-feed-token-for-tests';
const REVIEW_TOKEN = 'review-token-for-tests';
const ASH = '76561198000000001';
const BO = '76561198000000002';

// A WARDOGS server's RCON API, enough of it for a check: its status, who is on, the ban list, ServerSettings.ini, the
// map rotation and in-game messages.
type FakePlayer = { name: string; steamId: string; kills: number; deaths: number; faction: string };
type FakeRcon = {
  url: string;
  requests: string[];
  players: FakePlayer[];
  // Each request has its connection dropped, as when the server is off.
  down: boolean;
  close: () => Promise<void>;
};

const startFakeRcon = async (password: string): Promise<FakeRcon> => {
  const fake = { requests: [] as string[], players: [] as FakePlayer[], down: false };
  // ServerSettings.ini, which the bot writes the map rotation and the reserved list to.
  let config = { revision: 1, text: '' };
  const answer = (req: IncomingMessage, body: string): { status: number; body: unknown } => {
    if (req.headers.authorization !== `Bearer ${password}`) return { status: 401, body: { error: { code: 'unauthorized' } } };
    if (req.method === 'GET' && req.url === '/v1/status') {
      return {
        status: 200,
        body: {
          serverName: 'WARDOGS Test',
          map: 'Kavkazi',
          players: { current: fake.players.length, max: 64 },
          factionScores: [
            { name: 'Valkyra', score: 12 },
            { name: 'Kharr', score: 9 },
          ],
          rotation: { nowIndex: 0 },
        },
      };
    }
    if (req.method === 'GET' && req.url === '/v1/players') return { status: 200, body: { players: fake.players } };
    if (req.method === 'GET' && req.url === '/v1/bans') return { status: 200, body: { bans: [] } };
    if (req.method === 'GET' && req.url === '/v1/config') return { status: 200, body: { ...config, writable: true } };
    if (req.method === 'POST' && req.url === '/v1/config/validate') return { status: 200, body: { ok: true } };
    if (req.method === 'PUT' && req.url === '/v1/config') {
      if (req.headers['if-match'] !== `"${config.revision}"`) return { status: 412, body: { error: { code: 'revision_mismatch' } } };
      config = { revision: config.revision + 1, text: body };
      return { status: 200, body: { ok: true } };
    }
    if (req.method === 'GET' && req.url === '/v1/rotation') {
      return { status: 200, body: { enabled: true, mode: 'Sequential', entries: [{ map: 'Kavkazi', status: 'current' }] } };
    }
    if (req.method === 'POST' && (req.url === '/v1/broadcast' || /^\/v1\/players\/\d{17}\/message$/.test(req.url ?? ''))) {
      return { status: 200, body: {} };
    }
    return { status: 404, body: { error: { code: 'not_found', message: `${req.method} ${req.url}` } } };
  };
  const server: Server = createServer((req, res) => {
    fake.requests.push(`${req.method} ${req.url}`);
    if (fake.down) {
      req.socket.destroy();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const { status, body } = answer(req, Buffer.concat(chunks).toString());
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(fake, {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  });
};

// Discord signs each interaction with the application's Ed25519 key; the Worker checks it with DISCORD_PUBLIC_KEY.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUBLIC_KEY_HEX = Buffer.from(publicKey.export({ format: 'jwk' }).x ?? '', 'base64url').toString('hex');

const signed = (interaction: unknown, timestamp = String(Math.floor(Date.now() / 1000))) => {
  const body = JSON.stringify(interaction);
  const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString('hex');
  return { method: 'POST', body, headers: { 'x-signature-ed25519': signature, 'x-signature-timestamp': timestamp } };
};

const PING = 1;
const PONG = 1;
const APPLICATION_COMMAND = 2;
const AUTOCOMPLETE = 4;
const AUTOCOMPLETE_RESULT = 8;
const CHANNEL_MESSAGE = 4;
const EPHEMERAL = 64;

const staffMember = { roles: [STAFF_ROLE], permissions: '0', user: { id: '100000000000000003', username: 'staffer' } };
const playerMember = { roles: [], permissions: '0', user: { id: '100000000000000004', username: 'player' } };

const command = (name: string, member: unknown, guildId = GUILD) => ({
  type: APPLICATION_COMMAND,
  application_id: '100000000000000005',
  token: 'interaction-token',
  guild_id: guildId,
  member,
  data: { name, options: [{ type: 3, name: 'player', value: 'Ash' }] },
});

const killEvent = (eventId: string, killer: string, victim: string, cause = 'Id.Item.AK74M') => ({
  eventId,
  type: 'killed',
  eventTime: 120,
  matchId: 'match-1',
  mapName: 'Kavkazi',
  killerSteamId: killer,
  killerName: killer === ASH ? 'Ash' : 'Bo',
  victimSteamId: victim,
  victimName: victim === ASH ? 'Ash' : 'Bo',
  cause,
  distance: 4_250,
  contextTags: ['Meta.PlayerKillFlag.Player.Headshot'],
});

const feedPost = (body: unknown, token = FEED_TOKEN) => ({
  method: 'POST',
  body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
});

describe('the Worker in workerd', { timeout: 30_000 }, () => {
  let rcon: FakeRcon;
  let server: TestHarness;

  const errors = (): string[] => server.getLogs().flatMap((log) => (log.level === 'error' ? [log.message] : []));
  const json = async (path: string, init?: Parameters<TestHarness['fetch']>[1]): Promise<{ status: number; body: any }> => {
    const response = await server.fetch(path, init);
    const text = await response.text();
    return { status: response.status, body: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text };
  };
  const runCron = () => server.getWorker().scheduled({ cron: '* * * * *' });

  beforeAll(async () => {
    rcon = await startFakeRcon('rcon-password');
    server = createTestHarness({
      workers: [
        {
          configPath: './wrangler.jsonc',
          // The real settings, but nothing that would post to Discord or reach Steam on its own.
          vars: {
            DISCORD_GUILD_ID: GUILD,
            DISCORD_ADMIN_ROLE_IDS: STAFF_ROLE,
            DISCORD_INVITE: '',
            ROUNDUPS: 'off',
          },
          secrets: {
            RCON_URL: rcon.url,
            RCON_PASSWORD: 'rcon-password',
            DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/not-a-real-webhook',
            DISCORD_PUBLIC_KEY: PUBLIC_KEY_HEX,
            KILL_FEED_TOKEN: FEED_TOKEN,
            REVIEW_TOKEN,
          },
        },
      ],
    });
    await server.listen();
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    await rcon?.close();
  });

  afterEach((context) => {
    if (context.task.result?.state === 'fail') server.debug();
  });

  it('runs the cron check against the game server', async () => {
    rcon.players = [{ name: 'Ash', steamId: ASH, kills: 3, deaths: 1, faction: 'Valkyra' }];
    rcon.requests.length = 0;
    server.clearLogs();

    expect(await runCron()).toMatchObject({ outcome: 'ok' });
    expect(rcon.requests).toEqual(expect.arrayContaining(['GET /v1/status', 'GET /v1/players']));
    expect(errors()).toEqual([]);
  });

  it('keeps running when the game server is down', async () => {
    rcon.down = true;
    rcon.requests.length = 0;
    try {
      expect(await runCron()).toMatchObject({ outcome: 'ok' });
      expect(rcon.requests).toContain('GET /v1/status');
    } finally {
      rcon.down = false;
    }
    // Back up: the next check reads it again.
    server.clearLogs();
    expect(await runCron()).toMatchObject({ outcome: 'ok' });
    expect(errors()).toEqual([]);
  });

  describe('Discord interactions', () => {
    it('answers the PING Discord sends to check the endpoint', async () => {
      expect(await json('/', signed({ type: PING, application_id: '1' }))).toEqual({ status: 200, body: { type: PONG } });
    });

    it('refuses a request without a valid signature', async () => {
      expect((await json('/', { method: 'POST', body: JSON.stringify({ type: PING, application_id: '1' }) })).status).toBe(401);

      const tampered = signed({ type: PING, application_id: '1' });
      expect((await json('/', { ...tampered, body: tampered.body.replace('"1"', '"2"') })).status).toBe(401);
    });

    it('refuses a replayed request', async () => {
      const hourAgo = String(Math.floor(Date.now() / 1000) - 3_600);
      expect(await json('/', signed({ type: PING, application_id: '1' }, hourAgo))).toMatchObject({
        status: 401,
        body: { error: 'stale request' },
      });
    });

    it('keeps the staff commands to staff, in this Discord server', async () => {
      const notStaff = await json('/', signed(command('kick', playerMember)));
      expect(notStaff.body).toEqual({
        type: CHANNEL_MESSAGE,
        data: { content: 'Only Administrators and staff can use this.', flags: EPHEMERAL },
      });

      const elsewhere = await json('/', signed(command('kick', staffMember, '999999999999999999')));
      expect(elsewhere.body.data.content).toMatch(/only be used in the Discord server that runs this bot/);
    });

    it('suggests the players on the server to staff', async () => {
      rcon.players = [
        { name: 'Ash', steamId: ASH, kills: 3, deaths: 1, faction: 'Valkyra' },
        { name: 'Bo', steamId: BO, kills: 1, deaths: 3, faction: 'Kharr' },
      ];
      const typing = {
        ...command('kick', staffMember),
        type: AUTOCOMPLETE,
        data: { name: 'kick', options: [{ type: 3, name: 'player', value: 'As', focused: true }] },
      };
      const { status, body } = await json('/', signed(typing));
      expect(status).toBe(200);
      expect(body.type).toBe(AUTOCOMPLETE_RESULT);
      expect(body.data.choices.map((c: { name: string }) => c.name)).toEqual([expect.stringContaining('Ash')]);

      // Someone who is not staff gets none.
      const theirs = await json('/', signed({ ...typing, member: playerMember }));
      expect(theirs.body).toEqual({ type: AUTOCOMPLETE_RESULT, data: { choices: [] } });
    });
  });

  describe('the kill feed', () => {
    it('only takes batches with the token', async () => {
      const batch = { events: [killEvent('e0', ASH, BO)] };
      expect((await json('/api/ingest/events', feedPost(batch, 'not-the-kill-feed-token'))).status).toBe(401);
      expect((await json('/api/ingest/events', { method: 'POST', body: JSON.stringify(batch) })).status).toBe(401);
    });

    it('refuses what is not a batch', async () => {
      expect((await json('/api/ingest/events', feedPost('not json'))).status).toBe(400);
      expect((await json('/api/ingest/events', feedPost({ kills: [] }))).status).toBe(400);
    });

    it('records each kill once', async () => {
      const batch = { events: [killEvent('e1', ASH, BO), killEvent('e2', BO, ASH, 'Id.Item.SVDM'), { type: 'chat' }] };
      expect(await json('/api/ingest/events', feedPost(batch))).toEqual({ status: 200, body: { ok: true, accepted: 2, skipped: 1 } });
      // The game sends a batch again when it did not hear back.
      expect(await json('/api/ingest/events', feedPost(batch))).toEqual({ status: 200, body: { ok: true, accepted: 0, skipped: 1 } });
    });

    it('takes it after whatever path the game was given', async () => {
      const batch = { events: [killEvent('e3', ASH, BO)] };
      expect((await json('/some/prefix/api/ingest/events', feedPost(batch))).body).toMatchObject({ ok: true, accepted: 1 });
    });
  });

  describe("the website's API", () => {
    it('serves the stats the checks and the kill feed recorded', async () => {
      const response = await server.fetch('/api/stats');
      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      const stats: any = await response.json();
      // RCON's map id, by the name players know it by.
      expect(stats.server).toMatchObject({ name: 'WARDOGS Test', map: 'Bakurani', maxPlayers: 64 });
      expect(stats.thresholds).toEqual({ seeding: 1, live: 20, busy: 97 });
      expect(stats.weapons).not.toBeNull();
    });

    it('serves the live match and the players', async () => {
      const live = await json('/api/live');
      expect(live.status).toBe(200);
      expect(live.body).toMatchObject({ feed: true, server: { name: 'WARDOGS Test' } });

      const players = await json('/api/players');
      expect(players.status).toBe(200);
      expect(Array.isArray(players.body.players)).toBe(true);
    });

    it('sends live pages the match straight away', async () => {
      const { url } = await server.listen();
      const socket = new WebSocket(new URL('/api/live/socket', url.href.replace(/^http/, 'ws')));
      try {
        const first = await new Promise<string>((resolve, reject) => {
          socket.addEventListener('message', (event) => resolve(String(event.data)), { once: true });
          socket.addEventListener('error', () => reject(new Error('The live socket failed')), { once: true });
        });
        expect(JSON.parse(first)).toMatchObject({ server: { name: 'WARDOGS Test' } });
      } finally {
        socket.close();
      }
    });

    it('answers 404 for what is not there', async () => {
      const unknown = await server.fetch('/api/nothing-here');
      expect(unknown.status).toBe(404);
      expect(unknown.headers.get('access-control-allow-origin')).toBe('*');
      expect((await server.fetch('/api/player?id=not-an-id')).status).toBe(404);
      expect((await server.fetch('/')).status).toBe(404);
    });
  });

  describe('the alert review', () => {
    it('is only there with the token', async () => {
      expect((await json('/api/review', { headers: { authorization: 'Bearer wrong-review-token-x' } })).status).toBe(401);
      const review = await json('/api/review?days=7', { headers: { authorization: `Bearer ${REVIEW_TOKEN}` } });
      expect(review.status).toBe(200);
      expect(review.body).toBeTypeOf('object');
    });
  });

  describe('the staff page', () => {
    it('says what is missing for the Discord sign-in', async () => {
      const login = await json('/auth/login');
      expect(login.status).toBe(503);
      expect(login.body).toMatch(/DISCORD_CLIENT_SECRET/);
    });

    it('refuses its API without a session', async () => {
      expect((await server.fetch('/api/admin/overview')).status).not.toBe(200);
    });
  });
});
