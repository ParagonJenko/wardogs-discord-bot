import { describe, expect, it, vi } from 'vitest';
import {
  adminAuthConfig,
  checkState,
  createSession,
  finishLogin,
  LOGIN_COOKIE,
  readSession,
  returnAddress,
  SESSION_HOURS,
  startLogin,
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

    await expect(finishLogin(config, 'the-code', CALLBACK, fetchFn)).resolves.toEqual({ user: { id: '42', name: 'Sarge' } });
    expect(fetchFn.mock.calls.map(([url]) => String(url))).not.toContain('https://discord.com/api/v10/users/@me/guilds');
  });

  it("lets in the server's Administrators and owner", async () => {
    await expect(
      finishLogin(config, 'the-code', CALLBACK, discord({ guilds: [{ id: '888', permissions: '8' }, { id: '777', owner: false, permissions: String(8 | 16) }] })),
    ).resolves.toEqual({ user: { id: '42', name: 'Paragon' } });
    await expect(finishLogin(config, 'the-code', CALLBACK, discord({ guilds: [{ id: '777', owner: true, permissions: '0' }] }))).resolves.toEqual({
      user: { id: '42', name: 'Paragon' },
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
