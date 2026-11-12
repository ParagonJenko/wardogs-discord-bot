import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestHarness, type TestHarness } from 'wrangler';
import { createPlayerSession, createSession, startLogin } from '../src/adminauth.ts';
import { isOver, seasonAt, SEASONS, shownSeason, type Season } from '../src/season.ts';

// The Worker as Cloudflare runs it: built from wrangler.jsonc by Wrangler and run in workerd, the same runtime, with the
// Durable Object and its SQLite storage. The other tests cover each part on its own; these check they still fit
// together, so a deploy does not break the cron, the website's API, the kill feed or the slash commands.
//
// The game server is a fake one on localhost, and nothing here reaches Discord: every request that would is either
// refused before it leaves (a bad signature, someone who is not staff), answered by the Worker itself (PING,
// suggestions), or a redirect to Discord that is not followed (the staff sign-in).

// No telemetry, and no fetch of Cloudflare's Request.cf data, from a test run.
process.env['WRANGLER_SEND_METRICS'] = 'false';
process.env['CLOUDFLARE_CF_FETCH_ENABLED'] = 'false';

const GUILD = '100000000000000001';
const STAFF_ROLE = '100000000000000002';
const APPLICATION_ID = '100000000000000005';
const CLIENT_SECRET = 'discord-client-secret-for-tests';
const SITE = 'https://site.example';
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
  // Whether the rotation's map playing now is infantry only, and whether the rotation has another map that is.
  infantry: boolean;
  // The chat GET /v1/chat serves, as { messages }.
  chat: { id: number; steamId: string; name: string; message: string }[];
  // ServerSettings.ini as the fake has it, and a change made behind the bot's back.
  settings: () => { revision: number; text: string };
  edit: (text: string) => void;
  close: () => Promise<void>;
};

const startFakeRcon = async (password: string): Promise<FakeRcon> => {
  const fake = { requests: [] as string[], players: [] as FakePlayer[], down: false, infantry: true, chat: [] as FakeRcon['chat'] };
  // ServerSettings.ini, which the bot writes the map rotation and the whitelist to.
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
    if (req.method === 'GET' && req.url?.startsWith('/v1/chat?')) {
      const query = new URL(req.url, 'http://fake').searchParams;
      const after = Number(query.get('after'));
      // As the game answers: `after` is inclusive, and the lines have the game's own field names.
      const messages = fake.chat
        .filter((m) => m.id >= after)
        .slice(0, Number(query.get('limit')))
        .map((m) => ({
          seq: m.id,
          sentUtc: '2026-11-12T15:29:11.106Z',
          channel: 'All',
          faction: 'Valkyra',
          steamId: m.steamId,
          realName: m.name,
          hiddenName: 'Olive',
          anonymous: false,
          text: m.message,
          rawText: m.message,
          ping: false,
        }));
      return { status: 200, body: { latestSeq: Math.max(0, ...fake.chat.map((m) => m.id)), messages, count: messages.length } };
    }
    if (req.method === 'POST' && (req.url === '/v1/bans' || /^\/v1\/players\/\d{17}\/kick$/.test(req.url ?? ''))) {
      return { status: 200, body: { message: 'OK' } };
    }
    if (req.method === 'GET' && req.url === '/v1/config') return { status: 200, body: { ...config, writable: true } };
    if (req.method === 'POST' && req.url === '/v1/config/validate') return { status: 200, body: { ok: true } };
    if (req.method === 'PUT' && req.url === '/v1/config') {
      if (req.headers['if-match'] !== `"${config.revision}"`) return { status: 412, body: { error: { code: 'revision_mismatch' } } };
      config = { revision: config.revision + 1, text: body };
      return { status: 200, body: { ok: true } };
    }
    if (req.method === 'GET' && req.url === '/v1/rotation') {
      const playing = { map: 'Kavkazi', status: 'current', ...(fake.infantry ? { experiences: ['Kavkazi_KOTH_01', 'KOTH_InfantryOnly'] } : {}) };
      const entries = fake.infantry ? [playing] : [playing, { map: 'Bakurani', experiences: ['Bakurani_KOTH_02', 'KOTH_InfantryOnly'] }];
      return { status: 200, body: { enabled: true, mode: 'Sequential', entries } };
    }
    if (req.method === 'POST' && (req.url === '/v1/match/map' || req.url === '/v1/match/end')) return { status: 200, body: {} };
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
    settings: () => config,
    edit: (text: string) => {
      config = { revision: config.revision + 1, text };
    },
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
  application_id: APPLICATION_ID,
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
            DISCORD_APPLICATION_ID: APPLICATION_ID,
            SITE_URL: SITE,
            DISCORD_INVITE: '',
            ROUNDUPS: 'off',
            // Pinned off: these tests are of the Worker with automatic VIP. INITcoins have their own, below.
            COINS: 'off',
          },
          secrets: {
            RCON_URL: rcon.url,
            RCON_PASSWORD: 'rcon-password',
            DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/not-a-real-webhook',
            DISCORD_PUBLIC_KEY: PUBLIC_KEY_HEX,
            DISCORD_CLIENT_SECRET: CLIENT_SECRET,
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

  it('changes a map that is not infantry only when the game server comes back from a restart', async () => {
    rcon.infantry = false;
    try {
      // Not a restart while the server keeps answering.
      rcon.requests.length = 0;
      expect(await runCron()).toMatchObject({ outcome: 'ok' });
      expect(rcon.requests).not.toContain('POST /v1/match/end');
      rcon.down = true;
      expect(await runCron()).toMatchObject({ outcome: 'ok' });
      rcon.down = false;
      rcon.requests.length = 0;
      server.clearLogs();
      expect(await runCron()).toMatchObject({ outcome: 'ok' });
      expect(rcon.requests).toContain('POST /v1/match/map');
      expect(rcon.requests).toContain('POST /v1/match/end');
      expect(errors()).toEqual([]);
      // Once only.
      rcon.requests.length = 0;
      expect(await runCron()).toMatchObject({ outcome: 'ok' });
      expect(rcon.requests).not.toContain('POST /v1/match/end');
    } finally {
      rcon.infantry = true;
      rcon.down = false;
    }
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

    it('answers a batch it cannot read any of, as a game update might send', async () => {
      const batch = { events: [{ ...killEvent('e4', ASH, BO), type: 'kill' }, { type: 'chat' }] };
      expect(await json('/api/ingest/events', feedPost(batch))).toEqual({ status: 200, body: { ok: true, accepted: 0, skipped: 2 } });
    });

    it("takes Season 2's joins and match states, with no deaths in the batch, each once", async () => {
      server.clearLogs();
      const batch = { events: [{ type: 'player_joined', eventId: 'j1', playerSteamId: ASH, players: 1 }, { type: 'match_state', eventId: 's1', state: 'MatchState.Playing' }] };
      expect(await json('/api/ingest/events', feedPost(batch))).toEqual({ status: 200, body: { ok: true, accepted: 2, skipped: 0 } });
      expect(await json('/api/ingest/events', feedPost(batch))).toEqual({ status: 200, body: { ok: true, accepted: 0, skipped: 0 } });
      expect(errors()).toEqual([]);
    });

    it('reads the server at once when the feed says a match ended, for the end-of-match messages', async () => {
      rcon.requests.length = 0;
      server.clearLogs();
      const batch = { events: [{ type: 'match_ended', eventId: 'r1', eventTime: 4, players: 22, winningFaction: 'Valkyra', factionScores: [] }] };

      expect(await json('/api/ingest/events', feedPost(batch))).toEqual({ status: 200, body: { ok: true, accepted: 1, skipped: 0 } });
      await vi.waitFor(() => expect(rcon.requests).toEqual(expect.arrayContaining(['GET /v1/status', 'GET /v1/players'])));
      expect(errors()).toEqual([]);
    });

    it('takes it after whatever path the game was given', async () => {
      const batch = { events: [killEvent('e3', ASH, BO)] };
      expect((await json('/some/prefix/api/ingest/events', feedPost(batch))).body).toMatchObject({ ok: true, accepted: 1 });
    });
  });

  describe('chat moderation', () => {
    const SPOKEN = { name: 'Ash', steamId: ASH };

    it('reads the chat at each check, an empty chat from the start', async () => {
      // An empty chat to start with: the first reading only finds where it is. (With lines already said, it keeps them
      // for /chat and acts on none; chatmod.test.ts covers that.)
      expect(rcon.chat).toEqual([]);
      rcon.players = [{ name: 'Ash', steamId: ASH, kills: 3, deaths: 1, faction: 'Valkyra' }];
      server.clearLogs();
      rcon.requests.length = 0;
      expect(await runCron()).toMatchObject({ outcome: 'ok' });
      expect(rcon.requests).toContain('GET /v1/chat?after=0&limit=200');
      expect(rcon.requests.filter((r) => r.startsWith('POST') && !r.includes('/v1/config'))).toEqual([]);
      expect(errors()).toEqual([]);
    });

    it('bans for an exact racist word and warns for an exact toxic one, each line once', async () => {
      rcon.players = [{ name: 'Ash', steamId: ASH, kills: 3, deaths: 1, faction: 'Valkyra' }];
      rcon.chat = [
        { id: 1, ...SPOKEN, message: 'good game everyone' },
        { id: 2, ...SPOKEN, message: 'you absolute NIGGER' },
        { id: 3, steamId: BO, name: 'Bo', message: 'kys lol' },
        { id: 4, steamId: BO, name: 'Bo', message: 'n1gg3r' },
      ];
      server.clearLogs();
      rcon.requests.length = 0;
      expect(await runCron()).toMatchObject({ outcome: 'ok' });

      const posts = rcon.requests.filter((r) => r.startsWith('POST'));
      expect(posts).toContain('POST /v1/bans');
      expect(posts).toContain(`POST /v1/players/${ASH}/kick`);
      expect(posts).toContain(`POST /v1/players/${BO}/message`);
      // Bo's fuzzy line is only an alert, and Bo is warned once, for the exact one.
      expect(posts.filter((r) => r === `POST /v1/players/${BO}/message`)).toHaveLength(1);
      expect(posts.filter((r) => r === 'POST /v1/bans')).toHaveLength(1);
      const logs = server.getLogs().map((log) => log.message);
      expect(logs.some((m) => m.includes(`Chat moderation: banned "Ash" (${ASH})`))).toBe(true);
      expect(logs.some((m) => m.includes(`Chat moderation: warned "Bo" (${BO})`))).toBe(true);
      expect(errors()).toEqual([]);

      // The next check asks after the newest line, and acts on nothing again.
      server.clearLogs();
      rcon.requests.length = 0;
      expect(await runCron()).toMatchObject({ outcome: 'ok' });
      expect(rcon.requests).toContain('GET /v1/chat?after=4&limit=200');
      expect(rcon.requests.filter((r) => r.startsWith('POST'))).toEqual([]);
      expect(errors()).toEqual([]);
    });

    it('does nothing about a line that is only an alert, and keeps it for /chat', async () => {
      rcon.chat.push({ id: 5, steamId: BO, name: 'Bo', message: 'k y s' });
      rcon.requests.length = 0;
      expect(await runCron()).toMatchObject({ outcome: 'ok' });
      expect(rcon.requests.filter((r) => r.startsWith('POST'))).toEqual([]);

      const session = await createSession(CLIENT_SECRET, { id: '100000000000000003', name: 'Staffer' }, Date.now());
      const reply = await json('/api/admin/command', {
        method: 'POST',
        headers: { authorization: `Bearer ${session}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'chat', options: { player: 'bo' } }),
      });
      expect(reply.status).toBe(200);
      expect(reply.body.content).toContain('Latest chat from "bo"');
      expect(reply.body.content).toContain('**Bo** (All, Valkyra): kys lol');
      expect(reply.body.content).toContain('**Bo** (All, Valkyra): k y s');
      expect(reply.body.content).not.toContain('**Ash**');
      expect(errors()).toEqual([]);
    });

    it('acts once on a line when checks and the live chat overlap', async () => {
      const staffer = { id: '100000000000000003', name: 'Staffer' };
      const asStaff = { authorization: `Bearer ${await createSession(CLIENT_SECRET, staffer, Date.now())}` };
      // Past the live chat's few seconds between readings, so each caller reads.
      await new Promise((resolve) => setTimeout(resolve, 3_100));
      rcon.chat.push({ id: 6, steamId: BO, name: 'Bo', message: 'you nigger' });
      rcon.requests.length = 0;
      await Promise.all([runCron(), json('/api/admin/chat?after=0', { headers: asStaff }), json('/api/admin/chat?after=0', { headers: asStaff }), runCron()]);
      expect(rcon.requests.filter((r) => r === 'POST /v1/bans')).toHaveLength(1);
      expect(errors()).toEqual([]);
    });

    it('gives staff the live chat with each verdict, after a cursor, and nobody else', async () => {
      const staffer = { id: '100000000000000003', name: 'Staffer' };
      const asStaff = { authorization: `Bearer ${await createSession(CLIENT_SECRET, staffer, Date.now())}` };
      const feed = await json('/api/admin/chat?after=0', { headers: asStaff });
      expect(feed.status).toBe(200);
      expect(feed.body).toMatchObject({ enabled: true, available: true, cursor: 6 });
      const byId = Object.fromEntries(feed.body.lines.map((l: { id: number }) => [l.id, l]));
      expect(byId[1].verdict).toEqual({ kind: 'clean', action: 'none' });
      expect(byId[2]).toMatchObject({ name: 'Ash', steamId: ASH, verdict: { kind: 'exact', list: 'racism', word: 'nigger', action: 'banned' } });
      expect(byId[3].verdict).toMatchObject({ kind: 'exact', list: 'toxicity', action: 'warned' });
      expect(byId[5].verdict).toMatchObject({ kind: 'fuzzy', word: 'kys', action: 'alert' });
      // Bo was warned for line 3, so the fuzzy line 4 in the same check is folded into it or only noted.
      expect(['alert', 'folded']).toContain(byId[4].verdict.action);

      expect((await json('/api/admin/chat?after=4', { headers: asStaff })).body.lines.map((l: { id: number }) => l.id)).toEqual([5, 6]);
      expect((await json('/api/admin/chat?after=6', { headers: asStaff })).body.lines).toEqual([]);
      expect((await json('/api/admin/chat?after=-1', { headers: asStaff })).status).toBe(400);
      expect((await json('/api/admin/chat?after=x', { headers: asStaff })).status).toBe(400);
      expect((await server.fetch('/api/admin/chat?after=0')).status).toBe(401);
    });

    it('tells a player who asks for an admin to raise a ticket, once in a while', async () => {
      rcon.chat.push({ id: 7, steamId: BO, name: 'Bo', message: '!admin someone is team killing' });
      rcon.requests.length = 0;
      expect(await runCron()).toMatchObject({ outcome: 'ok' });
      expect(rcon.requests.filter((r) => r.startsWith('POST'))).toEqual([`POST /v1/players/${BO}/message`]);

      // Asking again straight away is not answered again.
      rcon.chat.push({ id: 8, steamId: BO, name: 'Bo', message: 'ADMIN??' });
      rcon.requests.length = 0;
      expect(await runCron()).toMatchObject({ outcome: 'ok' });
      expect(rcon.requests.filter((r) => r.startsWith('POST'))).toEqual([]);
      expect(errors()).toEqual([]);
    });

    it('tells a player who says someone is cheating to report it with evidence', async () => {
      rcon.chat.push({ id: 9, steamId: ASH, name: 'Ash', message: 'blue sniper is hacking' });
      rcon.requests.length = 0;
      expect(await runCron()).toMatchObject({ outcome: 'ok' });
      expect(rcon.requests.filter((r) => r.startsWith('POST'))).toEqual([`POST /v1/players/${ASH}/message`]);
      // Staff see in the live chat that the bot answered it.
      const session = await createSession(CLIENT_SECRET, { id: '100000000000000003', name: 'Staffer' }, Date.now());
      const feed = await json('/api/admin/chat?after=8', { headers: { authorization: `Bearer ${session}` } });
      expect(feed.body.lines.find((l: { id: number }) => l.id === 9)).toMatchObject({ reply: 'cheat' });
      expect(errors()).toEqual([]);
    });
  });

  describe('the staff page chat filter', () => {
    const asStaff = async () => ({
      authorization: `Bearer ${await createSession(CLIENT_SECRET, { id: '100000000000000003', name: 'Staffer' }, Date.now())}`,
      'content-type': 'application/json',
    });
    const post = async (body: unknown) => json('/api/admin/chatwords', { method: 'POST', headers: await asStaff(), body: JSON.stringify(body) });

    it('serves the lists, takes changes and keeps them', async () => {
      const page = await json('/api/admin/chatwords', { headers: await asStaff() });
      expect(page.status).toBe(200);
      expect(page.body).toMatchObject({ enabled: true, actions: true, changed: null });
      expect(page.body.lists.map((l: { id: string }) => l.id)).toEqual(['racism', 'toxicity', 'allow']);
      expect(page.body.lists[0].defaults).toContain('nigger');

      const added = await post({ action: 'add', list: 'toxicity', word: 'Noob Scum' });
      expect(added.status).toBe(200);
      expect(added.body.lists[1].added).toEqual(['noob scum']);
      expect(added.body.changed).toMatchObject({ by: '100000000000000003', byName: 'Staffer' });

      const removed = await post({ action: 'remove', list: 'racism', word: 'chink' });
      expect(removed.body.lists[0].removed).toEqual(['chink']);
      const back = await post({ action: 'restore', list: 'racism', word: 'chink' });
      expect(back.body.lists[0].removed).toEqual([]);

      expect(await post({ action: 'add', list: 'toxicity', word: 'kys' })).toEqual({ status: 400, body: { error: '"kys" is on the list already.' } });
      expect((await post({ action: 'nope' })).status).toBe(400);
      const kept = await json('/api/admin/chatwords', { headers: await asStaff() });
      expect(kept.body.lists[1].added).toEqual(['noob scum']);
      await post({ action: 'remove', list: 'toxicity', word: 'noob scum' });
    });
  });

  describe('the staff page welcome message', () => {
    const asStaff = async () => ({
      authorization: `Bearer ${await createSession(CLIENT_SECRET, { id: '100000000000000003', name: 'Staffer' }, Date.now())}`,
      'content-type': 'application/json',
    });
    const get = async () => json('/api/admin/motd', { headers: await asStaff() });
    const post = async (body: unknown) => json('/api/admin/motd', { method: 'POST', headers: await asStaff(), body: JSON.stringify(body) });
    const section = '[/Script/WDGame.WDGameStateSession]';

    it('reads the popup from the settings (repairing escaped lines), saves real tags and never overwrites a change made elsewhere', async () => {
      rcon.edit([section, 'bLockOverpopulatedTeamsConfig=True', 'bServerWelcomeMessageEnabled=False', '!ServerWelcomeMessageLines=ClearArray', '.ServerWelcomeMessageLines=&lt;Bold&gt;Old&lt;/&gt;', ''].join('\n'));
      const page = await get();
      expect(page).toMatchObject({ status: 200, body: { enabled: false, lines: ['<Bold>Old</>'], problems: [], escaped: true } });

      const lines = ['<Header>Welcome</>', '', '<Italic>Have fun &amp; good hunting!</>'];
      const saved = await post({ enabled: true, lines, revision: page.body.revision });
      expect(saved).toMatchObject({ status: 200, body: { outcome: 'next-match', enabled: true, lines } });
      expect(rcon.settings().text).toBe(
        [
          section,
          'bLockOverpopulatedTeamsConfig=True',
          'bServerWelcomeMessageEnabled=True',
          '!ServerWelcomeMessageLines=ClearArray',
          '.ServerWelcomeMessageLines=<Header>Welcome</>',
          '.ServerWelcomeMessageLines=',
          '.ServerWelcomeMessageLines=<Italic>Have fun &amp; good hunting!</>',
          '',
        ].join('\n'),
      );
      expect(saved.body.escaped).toBe(false);

      // The page's copy is behind the file now: nothing is written, and nothing is forced.
      const before = rcon.settings().text;
      rcon.edit(`${before}Elsewhere=1\n`);
      const changed = await post({ enabled: false, lines: [], revision: saved.body.revision });
      expect(changed.status).toBe(409);
      expect(changed.body.error).toMatch(/changed somewhere else/);
      expect(rcon.settings().text).toBe(`${before}Elsewhere=1\n`);
      expect(errors()).toEqual([]);
    });

    it('refuses a message that breaks the rules, naming the lines, and a request that is not one', async () => {
      const page = await get();
      rcon.requests.length = 0;
      const bad = await post({ enabled: true, lines: ['fine', '<a href="x">link</>'], revision: page.body.revision });
      expect(bad.status).toBe(400);
      expect(bad.body.problems.map((p: { line: number }) => p.line)).toEqual([2]);
      expect(rcon.requests.filter((r) => r.startsWith('PUT'))).toEqual([]);
      expect((await post({ enabled: 'yes' })).status).toBe(400);
      expect((await server.fetch('/api/admin/motd')).status).toBe(401);
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
    it('sends staff to Discord to sign in', async () => {
      const login = await server.fetch('/auth/login', { redirect: 'manual' });
      expect(login.status).toBe(302);
      const to = new URL(login.headers.get('location') ?? '');
      expect(`${to.origin}${to.pathname}`).toBe('https://discord.com/oauth2/authorize');
      expect(to.searchParams.get('client_id')).toBe(APPLICATION_ID);
      expect(new URL(to.searchParams.get('redirect_uri') ?? '').pathname).toBe('/auth/callback');
      expect(login.headers.get('set-cookie')).toMatch(/^wardogs_login=/);
    });

    it('serves its API only with a session the Worker signed', async () => {
      const commands = (session?: string) =>
        server.fetch('/api/admin/commands', session === undefined ? {} : { headers: { authorization: `Bearer ${session}` } });
      const staffer = { id: '100000000000000003', name: 'Staffer' };

      const none = await commands();
      expect(none.status).toBe(401);
      expect(await none.json()).toEqual({ error: 'Sign in again' });
      // Only the website may read it.
      expect(none.headers.get('access-control-allow-origin')).toBe(SITE);

      const forged = await createSession('not-the-client-secret', staffer, Date.now());
      expect((await commands(forged)).status).toBe(401);

      const signedIn = await commands(await createSession(CLIENT_SECRET, staffer, Date.now()));
      expect(signedIn.status).toBe(200);
      expect(((await signedIn.json()) as { commands: unknown[] }).commands.length).toBeGreaterThan(0);
    });

    it('sees the season roundup before the public does', async () => {
      // The test's records start today: a season that is over has nobody in them, and the one going on has today.
      const now = Date.now();
      const listed = (s: Season) => ({ number: s.number, name: s.name, endsAt: s.endsAt, open: isOver(s, now) });
      const seasons = SEASONS.map(listed);
      server.clearLogs();
      const page = await json('/api/season');
      expect(page.status).toBe(200);
      const going = seasonAt(now)!;
      // The season going on now, teased with its numbers so far and nobody's name: today's player.
      const teaser = { ...listed(going), matches: 0, players: 1, kills: 0, playedMs: 0, peakPlayers: null, days: expect.any(Number) };
      expect(page.body).toEqual({ ...listed(shownSeason(now)), roundup: null, seasons, going: teaser });
      // Another season by its number.
      const first = await json('/api/season?number=1');
      expect(first.body).toMatchObject({ number: 1, name: 'Season 1', open: true, roundup: null, seasons });
      // The season going on now: not over, so the public gets no roundup.
      expect((await json(`/api/season?number=${going.number}`)).body).toEqual({ ...listed(going), roundup: null, seasons, going: teaser });
      expect((await server.fetch('/api/season?number=99')).status).toBe(404);
      expect((await server.fetch('/api/season?number=x')).status).toBe(404);

      expect((await server.fetch('/api/admin/season')).status).toBe(401);
      const session = await createSession(CLIENT_SECRET, { id: '100000000000000003', name: 'Staffer' }, Date.now());
      const early = await json('/api/admin/season', { headers: { authorization: `Bearer ${session}` } });
      expect(early.status).toBe(200);
      expect(early.body).toMatchObject({ ...listed(going), seasons });
      expect(early.body.roundup).toMatchObject({ kind: 'season', partial: true, players: 1 });
      const past = await json('/api/admin/season?number=1', { headers: { authorization: `Bearer ${session}` } });
      expect(past.body).toMatchObject({ number: 1, open: true, roundup: null });
      expect((await server.fetch('/api/admin/season?number=99', { headers: { authorization: `Bearer ${session}` } })).status).toBe(404);
      expect(errors()).toEqual([]);
    });
  });

  describe('player accounts', () => {
    const player = { id: '100000000000000009', name: 'Player' };
    const asPlayer = async (secret = CLIENT_SECRET) => ({ authorization: `Bearer ${await createPlayerSession(secret, player, Date.now())}` });

    it('sends players to Discord for their connections, and to join only when they pressed the join button', async () => {
      const scopeOf = async (path: string) => {
        const login = await server.fetch(path, { redirect: 'manual' });
        expect(login.status).toBe(302);
        expect(login.headers.get('set-cookie')).toMatch(/^wardogs_login=/);
        return new URL(login.headers.get('location') ?? '').searchParams.get('scope');
      };

      expect(await scopeOf('/auth/player/login')).toBe('identify connections guilds.members.read');
      expect(await scopeOf('/auth/player/login?join=1')).toBe('identify connections guilds.members.read guilds.join');
      expect(await scopeOf('/auth/login?join=1')).toBe('identify guilds guilds.members.read');
    });

    it('tells a player who comes back too late on their own page, and staff on theirs', async () => {
      const back = async (flow: 'player' | 'staff') => {
        const { location } = await startLogin(
          { clientId: APPLICATION_ID, clientSecret: CLIENT_SECRET, guildId: GUILD, adminRoleIds: [], siteOrigin: SITE },
          'https://x.test/auth/callback',
          `${SITE}/account`,
          Date.now(),
          { flow },
        );
        const state = new URL(location).searchParams.get('state') ?? '';
        // No cookie: not the browser that started it.
        const response = await server.fetch(`/auth/callback?code=x&state=${encodeURIComponent(state)}`, { redirect: 'manual' });
        expect(response.status).toBe(302);
        return response.headers.get('location');
      };

      expect(await back('player')).toBe(`${SITE}/account#error=expired`);
      expect(await back('staff')).toBe(`${SITE}/admin#error=expired`);
    });

    it('serves the account only to a session a player signed in with, and never takes a staff session', async () => {
      const none = await server.fetch('/api/account');
      expect(none.status).toBe(401);
      expect(none.headers.get('access-control-allow-origin')).toBe(SITE);
      expect((await server.fetch('/api/account', { method: 'OPTIONS' })).status).toBe(204);

      const staff = await createSession(CLIENT_SECRET, player, Date.now());
      expect((await server.fetch('/api/account', { headers: { authorization: `Bearer ${staff}` } })).status).toBe(401);
      expect((await server.fetch('/api/account', { headers: await asPlayer('not-the-client-secret') })).status).toBe(401);
      // Signed, but they have no account: forgotten, or never made.
      expect((await server.fetch('/api/account', { headers: await asPlayer() })).status).toBe(401);
    });

    it('gives every staff route to staff only: no session, a player session, a forged one and a session for the wrong thing are all refused', async () => {
      const routes: [string, string][] = [
        ['GET', '/api/admin/chat?after=0'],
        ['GET', '/api/admin/chatwords'],
        ['GET', '/api/admin/commands'],
        ['GET', '/api/admin/growth'],
        ['GET', '/api/admin/kills'],
        ['GET', '/api/admin/lines'],
        ['GET', '/api/admin/motd'],
        ['GET', '/api/admin/overview'],
        ['GET', '/api/admin/player?player=76561198000000001'],
        ['GET', '/api/admin/rotations'],
        ['GET', '/api/admin/rules'],
        ['GET', '/api/admin/season'],
        ['POST', '/api/admin/chatwords'],
        ['POST', '/api/admin/check'],
        ['POST', '/api/admin/command'],
        ['POST', '/api/admin/dealt'],
        ['POST', '/api/admin/lines'],
        ['POST', '/api/admin/motd'],
        ['POST', '/api/admin/profile'],
        ['POST', '/api/admin/rotations'],
        ['POST', '/api/admin/rules'],
        ['POST', '/api/admin/suggest'],
        // A route that does not exist is refused the same way, so nothing says which are there.
        ['GET', '/api/admin/anything-else'],
      ];
      const staffer = { id: '100000000000000003', name: 'Staffer' };
      const refused: Record<string, string | undefined> = {
        none: undefined,
        player: `Bearer ${await createPlayerSession(CLIENT_SECRET, staffer, Date.now())}`,
        forged: `Bearer ${await createSession('not-the-client-secret', staffer, Date.now())}`,
        expired: `Bearer ${await createSession(CLIENT_SECRET, staffer, Date.now() - 40 * 60 * 60_000)}`,
        junk: 'Bearer not-a-token',
      };
      for (const [method, path] of routes) {
        for (const [kind, authorization] of Object.entries(refused)) {
          const response = await server.fetch(path, {
            method,
            headers: { ...(authorization === undefined ? {} : { authorization }), 'content-type': 'application/json' },
            ...(method === 'POST' ? { body: '{}' } : {}),
          });
          expect(response.status, `${method} ${path} with ${kind}`).toBe(401);
        }
      }
      // The live kill feed socket takes a session too, and from the website only.
      expect((await server.fetch('/api/admin/live', { headers: { upgrade: 'websocket', origin: SITE } })).status).toBe(401);
      expect((await server.fetch('/api/admin/live', { headers: { upgrade: 'websocket', origin: 'https://evil.example' } })).status).toBe(403);
      // And the one with a session a staff member really has gets past the gate.
      const staff = await createSession(CLIENT_SECRET, staffer, Date.now());
      expect((await server.fetch('/api/admin/commands', { headers: { authorization: `Bearer ${staff}` } })).status).toBe(200);
    });

    it('never lets a player session into the staff page', async () => {
      expect((await server.fetch('/api/admin/commands', { headers: await asPlayer() })).status).toBe(401);
      expect((await server.fetch('/api/admin/growth', { headers: await asPlayer() })).status).toBe(401);
    });

    it('refuses account requests it cannot read, and a website vote from someone not in the server', async () => {
      const headers = { ...(await asPlayer()), 'content-type': 'application/json' };
      expect((await server.fetch('/api/account', { method: 'POST', headers, body: JSON.stringify({ action: 'nope' }) })).status).toBe(400);
      expect((await server.fetch('/api/account/vote', { method: 'POST', headers, body: JSON.stringify({ poll: 'x' }) })).status).toBe(400);
      const vote = await json('/api/account/vote', { method: 'POST', headers, body: JSON.stringify({ poll: '1759300000000', map: 'Foy' }) });
      expect(vote.status).toBe(403);
      expect(vote.body).toMatchObject({ code: 'not-member' });
    });

    it('sends players to Steam to sign in, and only takes a proof Steam made', async () => {
      const login = await server.fetch(`/auth/steam?return=${encodeURIComponent(`${SITE}/account`)}`, { redirect: 'manual' });
      expect(login.status).toBe(302);
      const to = new URL(login.headers.get('location') ?? '');
      expect(`${to.origin}${to.pathname}`).toBe('https://steamcommunity.com/openid/login');
      const returnTo = new URL(to.searchParams.get('openid.return_to') ?? '');
      expect(returnTo.pathname).toBe('/auth/steam/callback');
      expect(returnTo.searchParams.get('return')).toBe(`${SITE}/account`);
      // The sign-in is tied to this browser: a cookie, and the same value in the address Steam sends it back to.
      const cookie = /^wardogs_steam=([0-9a-f]{32});/.exec(login.headers.get('set-cookie') ?? '')?.[1];
      expect(cookie).toBeDefined();
      expect(returnTo.searchParams.get('n')).toBe(cookie);

      const callback = (query: string, cookieHeader?: string) =>
        server.fetch(`/auth/steam/callback?return=${encodeURIComponent(`${SITE}/account`)}&n=${cookie}${query}`, {
          redirect: 'manual',
          ...(cookieHeader === undefined ? {} : { headers: { cookie: cookieHeader } }),
        });
      // From this browser, but not a claim Steam made.
      const forged = await callback('&openid.mode=id_res', `wardogs_steam=${cookie}`);
      expect(forged.status).toBe(302);
      expect(forged.headers.get('location')).toBe(`${SITE}/account#error=steam`);
      // From another browser: an address someone else got Steam to make.
      for (const other of [undefined, 'wardogs_steam=' + '0'.repeat(32)]) {
        const elsewhere = await callback('&openid.mode=id_res', other);
        expect(elsewhere.headers.get('location')).toBe(`${SITE}/account#error=expired`);
      }
    });

    it('has no INITcoins until they are switched on', async () => {
      expect((await server.fetch('/api/coins')).status).toBe(404);
      expect((await server.fetch('/api/account/coins')).status).toBe(401);
      expect(await json('/api/account/coins', { headers: await asPlayer() })).toEqual({
        status: 200,
        body: { enabled: false, linked: false, coins: null },
      });
    });

    it('has no Discord link to count clicks for until the invite is set', async () => {
      expect((await server.fetch('/go/discord?src=hero', { redirect: 'manual' })).status).toBe(404);
    });

    it('gives staff the growth numbers', async () => {
      const staff = await createSession(CLIENT_SECRET, { id: '100000000000000003', name: 'Staffer' }, Date.now());
      const growth = await json('/api/admin/growth', { headers: { authorization: `Bearer ${staff}` } });
      expect(growth.status).toBe(200);
      expect(growth.body).toMatchObject({
        clicks: { days: 30, total: 0, places: [] },
        accounts: { accounts: 0, linked: 0, members: 0, joinedOnSite: 0, withVipRole: 0 },
      });
    });
  });
});

describe('INITcoins in workerd', { timeout: 30_000 }, () => {
  let rcon: FakeRcon;
  let server: TestHarness;
  const player = { id: '100000000000000009', name: 'Player' };
  const asPlayer = async () => ({ authorization: `Bearer ${await createPlayerSession(CLIENT_SECRET, player, Date.now())}`, 'content-type': 'application/json' });
  const json = async (path: string, init?: Parameters<TestHarness['fetch']>[1]): Promise<{ status: number; body: any }> => {
    const response = await server.fetch(path, init);
    const text = await response.text();
    return { status: response.status, body: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text };
  };

  beforeAll(async () => {
    rcon = await startFakeRcon('rcon-password');
    server = createTestHarness({
      workers: [
        {
          configPath: './wrangler.jsonc',
          vars: {
            DISCORD_GUILD_ID: GUILD,
            DISCORD_ADMIN_ROLE_IDS: STAFF_ROLE,
            DISCORD_APPLICATION_ID: APPLICATION_ID,
            SITE_URL: SITE,
            DISCORD_INVITE: '',
            ROUNDUPS: 'off',
            // One variable: the free plan allows 64 variables and secrets in all.
            COINS: '{"roles":[{"id":"100000000000000077","name":"Night Owl","price":1500}]}',
          },
          secrets: {
            RCON_URL: rcon.url,
            RCON_PASSWORD: 'rcon-password',
            DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/not-a-real-webhook',
            DISCORD_PUBLIC_KEY: PUBLIC_KEY_HEX,
            DISCORD_CLIENT_SECRET: CLIENT_SECRET,
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

  it('tells the website how they work: what they pay, what they cost, and the missions', async () => {
    const { status, body } = await json('/api/coins');
    expect(status).toBe(200);
    expect(body.info.rates).toMatchObject({ seed: 150, playMinutes: 10, activityCap: 100 });
    expect(body.info.prices).toMatchObject({ vipDay: 100, vipWeek: 600, vipAheadDays: 14 });
    expect(body.info.shop.map((i: { id: string }) => i.id)).toEqual(expect.arrayContaining(['vip-1', 'vip-7', 'title-seeder', 'role-100000000000000077']));
    expect(body.info.missions.daily).toHaveLength(3);
    expect(body.info.missions.weekly).toHaveLength(3);
    expect(body).toMatchObject({ leaders: [], players: 0, held: 0, earned: 0 });
  });

  it('replaces automatic VIP: the website is told there is no seeder VIP rule', async () => {
    const stats = await json('/api/stats');
    expect(stats.status).toBe(200);
    expect(stats.body.vip ?? null).toBeNull();
    // It says what seeding pays instead.
    expect(stats.body.coins).toEqual({ seed: 150, vipWeek: 600 });
  });

  it('runs checks with players in game without trouble', async () => {
    rcon.players = [
      { name: 'Ash', steamId: ASH, kills: 3, deaths: 1, faction: 'Valkyra' },
      { name: 'Bo', steamId: BO, kills: 1, deaths: 3, faction: 'Kharr' },
    ];
    server.clearLogs();
    expect(await server.getWorker().scheduled({ cron: '* * * * *' })).toMatchObject({ outcome: 'ok' });
    expect(await server.getWorker().scheduled({ cron: '* * * * *' })).toMatchObject({ outcome: 'ok' });
    expect(server.getLogs().flatMap((log) => (log.level === 'error' ? [log.message] : []))).toEqual([]);
  });

  it('shows a player who has not linked Steam how to, and will not sell to them', async () => {
    expect((await server.fetch('/api/account/coins')).status).toBe(401);
    expect(await json('/api/account/coins', { headers: await asPlayer() })).toEqual({
      status: 200,
      body: { enabled: true, linked: false, coins: null },
    });
    const buy = await json('/api/account/coins', { method: 'POST', headers: await asPlayer(), body: JSON.stringify({ action: 'buy', item: 'vip-1' }) });
    expect(buy.status).toBe(400);
    expect(buy.body.error).toMatch(/Link your Steam account/);
  });

  it('refuses coin requests it cannot read', async () => {
    const post = async (body: unknown) =>
      (await server.fetch('/api/account/coins', { method: 'POST', headers: await asPlayer(), body: JSON.stringify(body) })).status;
    expect(await post({ action: 'nope' })).toBe(400);
    expect(await post({ action: 'buy' })).toBe(400);
    expect(await post({ action: 'reroll', slot: 7 })).toBe(400);
    expect(await post({ action: 'title', id: 5 })).toBe(400);
  });

  it('offers the coin commands to anyone, and keeps their replies private', async () => {
    const member = { ...playerMember };
    const { body } = await json('/', signed({ ...command('coins', member), data: { name: 'coins' } }));
    expect(body).toEqual({ type: 5, data: { flags: EPHEMERAL } });
    // Suggestions for /buy list what is for sale.
    const typing = { ...command('buy', member), type: AUTOCOMPLETE, data: { name: 'buy', options: [{ type: 3, name: 'item', value: 'owl', focused: true }] } };
    const suggested = await json('/', signed(typing));
    expect(suggested.body.data.choices).toEqual([{ name: 'Discord role: Night Owl · 1,500 INITcoins', value: 'role-100000000000000077' }]);
  });
});
