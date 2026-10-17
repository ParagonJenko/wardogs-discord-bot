import { describe, expect, it, vi } from 'vitest';
import {
  adminAuthConfig,
  checkState,
  createPlayerSession,
  createSession,
  createSteamProof,
  finishLogin,
  finishPlayerLogin,
  LOGIN_COOKIE,
  notSetUpText,
  PLAYER_SESSION_DAYS,
  peekState,
  readPlayerSession,
  readSession,
  readState,
  readSteamProof,
  returnAddress,
  SESSION_HOURS,
  siteOriginOf,
  startLogin,
  steamFromConnections,
  type AdminAuthConfig,
} from '../src/adminauth.ts';

const NOW = Date.UTC(2026, 9, 3, 20);
const SITE = 'https://gaminginit.com';
const CALLBACK = 'https://bot.example.workers.dev/auth/callback';
const config: AdminAuthConfig = {
  clientId: '1234',
  clientSecret: 'a-client-secret',
  guildId: '777',
  adminRoleIds: ['555'],
  siteOrigin: SITE,
};

describe('adminAuthConfig', () => {
  it('needs the application id, client secret, server id and website', () => {
    expect(adminAuthConfig({})).toEqual({ missing: ['DISCORD_APPLICATION_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_GUILD_ID', 'SITE_URL'] });
    expect(adminAuthConfig({ DISCORD_APPLICATION_ID: 'abc', DISCORD_CLIENT_SECRET: 's', DISCORD_GUILD_ID: '777', SITE_URL: 'nope' })).toEqual({
      missing: ['DISCORD_APPLICATION_ID', 'SITE_URL'],
    });
    expect(
      adminAuthConfig({
        DISCORD_APPLICATION_ID: ' 1234 ',
        DISCORD_CLIENT_SECRET: 'a-client-secret',
        DISCORD_GUILD_ID: '777',
        DISCORD_ADMIN_ROLE_IDS: '555, x, 666',
        SITE_URL: 'https://gaminginit.com/',
      }),
    ).toEqual({ ...config, adminRoleIds: ['555', '666'] });
  });
});

describe('when sign-in is not set up', () => {
  it('names what is missing, and still knows the website, so the page can be told why', () => {
    expect(notSetUpText(['DISCORD_APPLICATION_ID'])).toBe(
      'Staff sign-in is not set up on the bot. Missing: DISCORD_APPLICATION_ID. See the bot\'s README, "Staff page".',
    );
    expect(siteOriginOf({ SITE_URL: 'https://gaminginit.com/' })).toBe(SITE);
    expect(siteOriginOf({ SITE_URL: 'nope' })).toBeNull();
    expect(siteOriginOf({})).toBeNull();
  });
});

describe('sessions', () => {
  it('reads a session it signed, as a bearer token, until it runs out', async () => {
    const token = await createSession(config.clientSecret, { id: '42', name: 'Paragon' }, NOW);
    const session = { userId: '42', name: 'Paragon', expiresAt: NOW + SESSION_HOURS * 60 * 60_000 };

    await expect(readSession(config.clientSecret, `Bearer ${token}`, NOW)).resolves.toEqual(session);
    await expect(readSession(config.clientSecret, `bearer ${token} `, session.expiresAt - 1)).resolves.toEqual(session);
    await expect(readSession(config.clientSecret, `Bearer ${token}`, session.expiresAt)).resolves.toBeNull();
  });

  it('refuses a token signed with another secret, changed, or missing', async () => {
    const token = await createSession(config.clientSecret, { id: '42', name: 'Paragon' }, NOW);
    const [body, signature] = token.split('.');
    const forged = `${btoa(JSON.stringify({ userId: '1', name: 'x', expiresAt: NOW * 2 })).replace(/=+$/, '')}.${signature}`;

    await expect(readSession('another-secret', `Bearer ${token}`, NOW)).resolves.toBeNull();
    await expect(readSession(config.clientSecret, `Bearer ${forged}`, NOW)).resolves.toBeNull();
    await expect(readSession(config.clientSecret, `Bearer ${body}`, NOW)).resolves.toBeNull();
    await expect(readSession(config.clientSecret, `Bearer ${token}.x`, NOW)).resolves.toBeNull();
    await expect(readSession(config.clientSecret, token, NOW)).resolves.toBeNull();
    await expect(readSession(config.clientSecret, null, NOW)).resolves.toBeNull();
  });
});

describe('signing in', () => {
  it('sends the browser to Discord with a state tied to a cookie, and only takes that state back from that browser', async () => {
    const { location, cookie } = await startLogin(config, CALLBACK, `${SITE}/admin`, NOW);
    const url = new URL(location);
    const state = url.searchParams.get('state');
    const nonce = /^wardogs_login=([^;]+);/.exec(cookie)?.[1];

    expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(Object.fromEntries([...url.searchParams].filter(([key]) => key !== 'state'))).toEqual({
      client_id: '1234',
      response_type: 'code',
      redirect_uri: CALLBACK,
      scope: 'identify guilds guilds.members.read',
      prompt: 'none',
    });
    expect(cookie).toMatch(/; Path=\/auth; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/);
    await expect(checkState(config.clientSecret, state, `other=1; ${LOGIN_COOKIE}=${nonce}`, NOW + 1)).resolves.toBe(`${SITE}/admin`);
    await expect(checkState(config.clientSecret, state, `${LOGIN_COOKIE}=someone-else`, NOW)).resolves.toBeNull();
    await expect(checkState(config.clientSecret, state, null, NOW)).resolves.toBeNull();
    await expect(checkState(config.clientSecret, state, `${LOGIN_COOKIE}=${nonce}`, NOW + 10 * 60_000)).resolves.toBeNull();
    await expect(checkState('another-secret', state, `${LOGIN_COOKIE}=${nonce}`, NOW)).resolves.toBeNull();
  });

  it('never takes a session state for a login state', async () => {
    const token = await createSession(config.clientSecret, { id: '42', name: 'x' }, NOW);

    await expect(checkState(config.clientSecret, token, `${LOGIN_COOKIE}=x`, NOW)).resolves.toBeNull();
  });

  it('only sends people back to a page on the website, the staff page by default', () => {
    expect(returnAddress(null, SITE)).toBe(`${SITE}/admin`);
    expect(returnAddress(`${SITE}/admin?demo#x`, SITE)).toBe(`${SITE}/admin?demo`);
    expect(returnAddress('https://evil.example/admin', SITE)).toBe(`${SITE}/admin`);
    expect(returnAddress('https://gaminginit.com.evil.example/', SITE)).toBe(`${SITE}/admin`);
    expect(returnAddress('javascript:alert(1)', SITE)).toBe(`${SITE}/admin`);
    expect(returnAddress('not a url', SITE)).toBe(`${SITE}/admin`);
  });
});

describe('finishLogin', () => {
  type Answers = { member?: Response; guilds?: unknown; token?: Response };
  const discord = ({ member, guilds = [], token }: Answers = {}) =>
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = String(input).replace('https://discord.com/api/v10', '');
      if (path === '/oauth2/token') {
        expect(init?.headers).toMatchObject({ authorization: `Basic ${btoa('1234:a-client-secret')}` });
        expect(String(init?.body)).toBe(`grant_type=authorization_code&code=the-code&redirect_uri=${encodeURIComponent(CALLBACK)}`);
        return token ?? Response.json({ access_token: 'user-token', token_type: 'Bearer' });
      }
      expect(init?.headers).toEqual({ authorization: 'Bearer user-token' });
      if (path === '/users/@me') return Response.json({ id: '42', username: 'paragon', global_name: 'Paragon' });
      if (path === '/users/@me/guilds/777/member') return member ?? Response.json({ roles: ['111'], nick: null });
      if (path === '/users/@me/guilds') return Response.json(guilds);
      return new Response('Not found', { status: 404 });
    });

  it('lets in members with a staff role, by the name they go by in the server', async () => {
    const fetchFn = discord({ member: Response.json({ roles: ['111', '555'], nick: 'Sarge' }) });

    await expect(finishLogin(config, 'the-code', CALLBACK, fetchFn)).resolves.toEqual({ user: { id: '42', name: 'Sarge', username: 'paragon' } });
    expect(fetchFn.mock.calls.map(([url]) => String(url))).not.toContain('https://discord.com/api/v10/users/@me/guilds');
  });

  it("lets in the server's Administrators and owner", async () => {
    await expect(
      finishLogin(config, 'the-code', CALLBACK, discord({ guilds: [{ id: '888', permissions: '8' }, { id: '777', owner: false, permissions: String(8 | 16) }] })),
    ).resolves.toEqual({ user: { id: '42', name: 'Paragon', username: 'paragon' } });
    await expect(finishLogin(config, 'the-code', CALLBACK, discord({ guilds: [{ id: '777', owner: true, permissions: '0' }] }))).resolves.toEqual({
      user: { id: '42', name: 'Paragon', username: 'paragon' },
    });
  });

  it('turns away members who are not staff, and people not in the server', async () => {
    await expect(finishLogin(config, 'the-code', CALLBACK, discord({ guilds: [{ id: '777', owner: false, permissions: '32' }, { id: '888', permissions: '8' }] }))).resolves.toEqual({
      problem: 'not-staff',
    });
    await expect(finishLogin(config, 'the-code', CALLBACK, discord({ member: new Response('Unknown Guild', { status: 404 }) }))).resolves.toEqual({
      problem: 'not-member',
    });
  });

  it('fails when Discord refuses the code', async () => {
    await expect(finishLogin(config, 'the-code', CALLBACK, discord({ token: new Response('invalid_grant', { status: 400 }) }))).rejects.toThrow(
      'Discord refused the sign-in code: 400 invalid_grant',
    );
  });
});

describe('player sessions', () => {
  it('lasts for days, and is never taken for a staff session or the other way round', async () => {
    const player = await createPlayerSession(config.clientSecret, { id: '42', name: 'Paragon' }, NOW);
    const staff = await createSession(config.clientSecret, { id: '42', name: 'Paragon' }, NOW);
    const ends = NOW + PLAYER_SESSION_DAYS * 24 * 60 * 60_000;

    await expect(readPlayerSession(config.clientSecret, `Bearer ${player}`, NOW)).resolves.toEqual({ userId: '42', name: 'Paragon', expiresAt: ends });
    await expect(readPlayerSession(config.clientSecret, `Bearer ${player}`, ends)).resolves.toBeNull();
    await expect(readSession(config.clientSecret, `Bearer ${player}`, NOW)).resolves.toBeNull();
    await expect(readPlayerSession(config.clientSecret, `Bearer ${staff}`, NOW)).resolves.toBeNull();
    await expect(readPlayerSession('another-secret', `Bearer ${player}`, NOW)).resolves.toBeNull();
  });

  it('holds a Steam proof for a few minutes, which is not a session either', async () => {
    const proof = await createSteamProof(config.clientSecret, '76561198000000001', NOW);

    await expect(readSteamProof(config.clientSecret, proof, NOW + 9 * 60_000)).resolves.toBe('76561198000000001');
    await expect(readSteamProof(config.clientSecret, proof, NOW + 10 * 60_000)).resolves.toBeNull();
    await expect(readSteamProof('another-secret', proof, NOW)).resolves.toBeNull();
    await expect(readSteamProof(config.clientSecret, null, NOW)).resolves.toBeNull();
    await expect(readPlayerSession(config.clientSecret, `Bearer ${proof}`, NOW)).resolves.toBeNull();
    await expect(readSession(config.clientSecret, `Bearer ${proof}`, NOW)).resolves.toBeNull();
  });
});

describe('a player signing in', () => {
  it('asks for their connections, and only asks to join the server when they pressed the join button', async () => {
    const plain = await startLogin(config, CALLBACK, `${SITE}/account`, NOW, { flow: 'player' });
    const join = await startLogin(config, CALLBACK, `${SITE}/account`, NOW, { flow: 'player', join: true });
    const staffJoin = await startLogin(config, CALLBACK, `${SITE}/admin`, NOW, { join: true });

    expect(new URL(plain.location).searchParams.get('scope')).toBe('identify connections guilds.members.read');
    expect(new URL(join.location).searchParams.get('scope')).toBe('identify connections guilds.members.read guilds.join');
    // Staff are never asked to be added.
    expect(new URL(staffJoin.location).searchParams.get('scope')).toBe('identify guilds guilds.members.read');
  });

  it('keeps which sign-in it is in the state, and treats an older state as staff', async () => {
    const { location, cookie } = await startLogin(config, CALLBACK, `${SITE}/account`, NOW, { flow: 'player', join: true });
    const state = new URL(location).searchParams.get('state');
    const nonce = /^wardogs_login=([^;]+);/.exec(cookie)?.[1];

    await expect(readState(config.clientSecret, state, `${LOGIN_COOKIE}=${nonce}`, NOW)).resolves.toEqual({ returnTo: `${SITE}/account`, flow: 'player', join: true });
    await expect(readState(config.clientSecret, state, `${LOGIN_COOKIE}=other`, NOW)).resolves.toBeNull();
    // Without the cookie only the page for an error is known, never a sign-in.
    await expect(peekState(config.clientSecret, state, NOW)).resolves.toMatchObject({ flow: 'player' });
    await expect(peekState(config.clientSecret, state, NOW + 10 * 60_000)).resolves.toBeNull();
    await expect(peekState('another-secret', state, NOW)).resolves.toBeNull();
    await expect(peekState(config.clientSecret, null, NOW)).resolves.toBeNull();
  });

  it('falls back to the account page, not the staff page', () => {
    expect(returnAddress(null, SITE, '/account')).toBe(`${SITE}/account`);
    expect(returnAddress('https://evil.example/', SITE, '/account')).toBe(`${SITE}/account`);
    expect(returnAddress(`${SITE}/vote?x=1#y`, SITE, '/account')).toBe(`${SITE}/vote?x=1`);
  });
});

describe('steamFromConnections', () => {
  it('finds the Steam account on a Discord profile, when Discord has checked it', () => {
    expect(steamFromConnections([{ type: 'twitch', id: '1' }, { type: 'steam', id: '76561198000000001', verified: true }])).toBe('76561198000000001');
    expect(steamFromConnections([{ type: 'steam', id: '76561198000000001' }])).toBe('76561198000000001');
  });

  it('ignores an unchecked connection, an ID that is not a Steam64, and anything else', () => {
    expect(steamFromConnections([{ type: 'steam', id: '76561198000000001', verified: false }])).toBeNull();
    expect(steamFromConnections([{ type: 'steam', id: 'myname', verified: true }])).toBeNull();
    expect(steamFromConnections([{ type: 'xbox', id: '76561198000000001', verified: true }])).toBeNull();
    expect(steamFromConnections('nope')).toBeNull();
    expect(steamFromConnections([])).toBeNull();
  });
});

describe('finishPlayerLogin', () => {
  type Answers = { member?: Response; connections?: Response };
  const discord = ({ member, connections }: Answers = {}) =>
    vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const path = String(input).replace('https://discord.com/api/v10', '');
      if (path === '/oauth2/token') return Response.json({ access_token: 'user-token', token_type: 'Bearer' });
      if (path === '/users/@me') return Response.json({ id: '42', username: 'paragon', global_name: 'Paragon' });
      if (path === '/users/@me/guilds/777/member') return member ?? Response.json({ roles: [], nick: 'Sarge' });
      if (path === '/users/@me/connections') return connections ?? Response.json([{ type: 'steam', id: '76561198000000001', verified: true }]);
      return new Response('Not found', { status: 404 });
    });
  const noJoin = vi.fn(async () => 'unavailable' as const);

  it('knows a member, what they go by in the server, and the Steam account on their profile', async () => {
    await expect(finishPlayerLogin(config, 'the-code', CALLBACK, false, noJoin, discord())).resolves.toEqual({
      user: { id: '42', name: 'Sarge', username: 'paragon' },
      member: true,
      join: null,
      steamId: '76561198000000001',
    });
    expect(noJoin).not.toHaveBeenCalled();
  });

  it('lets someone in who is not a member sign in, without adding them unless they asked to join', async () => {
    const notMember = () => discord({ member: new Response('Unknown Guild', { status: 404 }) });

    await expect(finishPlayerLogin(config, 'the-code', CALLBACK, false, noJoin, notMember())).resolves.toMatchObject({
      user: { name: 'Paragon' },
      member: false,
      join: null,
    });
    expect(noJoin).not.toHaveBeenCalled();
  });

  it('adds them with the access token when they asked to join, and says what came of it', async () => {
    const notMember = () => discord({ member: new Response('Unknown Guild', { status: 404 }) });
    const added = vi.fn(async () => 'added' as const);
    const banned = vi.fn(async () => 'banned' as const);

    await expect(finishPlayerLogin(config, 'the-code', CALLBACK, true, added, notMember())).resolves.toMatchObject({ member: true, join: 'added' });
    expect(added).toHaveBeenCalledWith('42', 'user-token');
    await expect(finishPlayerLogin(config, 'the-code', CALLBACK, true, banned, notMember())).resolves.toMatchObject({ member: false, join: 'banned' });
  });

  it('does not add someone already in the server', async () => {
    const added = vi.fn(async () => 'added' as const);

    await expect(finishPlayerLogin(config, 'the-code', CALLBACK, true, added, discord())).resolves.toMatchObject({ member: true, join: 'already' });
    expect(added).not.toHaveBeenCalled();
  });

  it('signs in without a Steam account when their connections cannot be read', async () => {
    await expect(
      finishPlayerLogin(config, 'the-code', CALLBACK, false, noJoin, discord({ connections: new Response('no', { status: 403 }) })),
    ).resolves.toMatchObject({ member: true, steamId: null });
  });

  it('fails when Discord will not say who signed in, or if they are in the server', async () => {
    await expect(
      finishPlayerLogin(config, 'the-code', CALLBACK, false, noJoin, discord({ member: new Response('boom', { status: 500 }) })),
    ).rejects.toThrow('Discord did not say if they are in the server: 500');
  });
});
