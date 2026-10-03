import { z } from 'zod';

// Signing in to the staff page with Discord. The page is on the website (SITE_URL); the Worker does the OAuth2 sign-in
// and serves the page's data. Staff are the same people who can use the staff commands: members of DISCORD_GUILD_ID with
// Discord's Administrator permission or a role in DISCORD_ADMIN_ROLE_IDS.
//
// 1. The page links to <worker>/auth/login. The Worker sets a short-lived cookie with a random nonce and sends the browser
//    to Discord, with a signed `state` holding the nonce and where to go back to.
// 2. Discord sends the browser back to <worker>/auth/callback with a code. The Worker checks the state against the
//    cookie, swaps the code for an access token, and asks Discord who the user is and what roles they have in the
//    server. The access token is only used for that, then dropped.
// 3. Staff go back to the page with a signed session token after `#session=` (a fragment never reaches a server or a
//    Referer header). The page sends it as a bearer token to the Worker's /api/admin/ routes. It lasts SESSION_HOURS.
//
// Tokens are signed with an HMAC of DISCORD_CLIENT_SECRET, so resetting the client secret signs everyone out.

export const SESSION_HOURS = 8;
const SESSION_MS = SESSION_HOURS * 60 * 60_000;
// How long someone has to finish signing in at Discord.
const LOGIN_MS = 10 * 60_000;
export const LOGIN_COOKIE = 'wardogs_login';
export const CALLBACK_PATH = '/auth/callback';
// The page on the website that shows the staff tools.
export const ADMIN_PAGE = '/admin';

const DISCORD_API = 'https://discord.com/api/v10';
const SCOPES = 'identify guilds guilds.members.read';
// Discord permission bit for "Administrator".
const ADMINISTRATOR = 1n << 3n;

export type Session = { userId: string; name: string; expiresAt: number };

// Why a sign-in did not give a session, as the page is told after `#error=`.
export type LoginProblem = 'cancelled' | 'expired' | 'not-member' | 'not-staff' | 'failed';

export type AdminAuthConfig = {
  clientId: string;
  clientSecret: string;
  guildId: string;
  adminRoleIds: string[];
  // The website's origin, such as https://gaminginit.com: the only place a session token is sent back to.
  siteOrigin: string;
};

// The sign-in's settings, or what is missing while any are.
export const adminAuthConfig = (vars: Record<string, string>): AdminAuthConfig | { missing: string[] } => {
  const value = (key: string): string => vars[key]?.trim() ?? '';
  let siteOrigin = '';
  try {
    siteOrigin = value('SITE_URL') === '' ? '' : new URL(value('SITE_URL')).origin;
  } catch {
    // Reported as missing below.
  }
  const missing = [
    ...(/^\d+$/.test(value('DISCORD_APPLICATION_ID')) ? [] : ['DISCORD_APPLICATION_ID']),
    ...(value('DISCORD_CLIENT_SECRET') === '' ? ['DISCORD_CLIENT_SECRET'] : []),
    ...(/^\d+$/.test(value('DISCORD_GUILD_ID')) ? [] : ['DISCORD_GUILD_ID']),
    ...(siteOrigin === '' ? ['SITE_URL'] : []),
  ];
  if (missing.length > 0) return { missing };
  return {
    clientId: value('DISCORD_APPLICATION_ID'),
    clientSecret: value('DISCORD_CLIENT_SECRET'),
    guildId: value('DISCORD_GUILD_ID'),
    adminRoleIds: value('DISCORD_ADMIN_ROLE_IDS')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => /^\d+$/.test(id)),
    siteOrigin,
  };
};

const encoder = new TextEncoder();

const base64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fromBase64url = (text: string): Uint8Array<ArrayBuffer> | null => {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
};

const signingKey = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

// `purpose` keeps a login state from ever passing as a session, and the other way round.
type Purpose = 'session' | 'state';

const sign = async (secret: string, purpose: Purpose, payload: unknown): Promise<string> => {
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign('HMAC', await signingKey(secret), encoder.encode(`${purpose}.${body}`));
  return `${body}.${base64url(new Uint8Array(signature))}`;
};

// The payload, when the token was signed with this secret for this purpose. crypto.subtle.verify compares in constant time.
const verify = async (secret: string, purpose: Purpose, token: string): Promise<unknown> => {
  const [body, signature, ...rest] = token.split('.');
  if (body === undefined || signature === undefined || rest.length > 0) return null;
  const bytes = fromBase64url(signature);
  if (bytes === null) return null;
  const ok = await crypto.subtle.verify('HMAC', await signingKey(secret), bytes, encoder.encode(`${purpose}.${body}`));
  if (!ok) return null;
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64url(body) ?? new Uint8Array()));
  } catch {
    return null;
  }
};

const SessionSchema = z.object({ userId: z.string(), name: z.string(), expiresAt: z.number() });
const StateSchema = z.object({ nonce: z.string(), returnTo: z.string(), expiresAt: z.number() });

export const createSession = (secret: string, user: { id: string; name: string }, now: number): Promise<string> =>
  sign(secret, 'session', { userId: user.id, name: user.name, expiresAt: now + SESSION_MS } satisfies Session);

// The session in an Authorization header, while it lasts.
export const readSession = async (secret: string, header: string | null, now: number): Promise<Session | null> => {
  const token = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '')?.[1];
  if (token === undefined) return null;
  const parsed = SessionSchema.safeParse(await verify(secret, 'session', token));
  return parsed.success && parsed.data.expiresAt > now ? parsed.data : null;
};

// Where to send someone back to: a page on the website, the staff page unless they came from another.
export const returnAddress = (asked: string | null, siteOrigin: string): string => {
  const fallback = `${siteOrigin}${ADMIN_PAGE}`;
  if (asked === null) return fallback;
  try {
    const url = new URL(asked);
    return url.origin === siteOrigin ? `${url.origin}${url.pathname}${url.search}` : fallback;
  } catch {
    return fallback;
  }
};

const randomNonce = (): string => base64url(crypto.getRandomValues(new Uint8Array(24)));

// The redirect to Discord, and the cookie that ties the sign-in to this browser.
export const startLogin = async (
  config: AdminAuthConfig,
  redirectUri: string,
  returnTo: string,
  now: number,
): Promise<{ location: string; cookie: string }> => {
  const nonce = randomNonce();
  const state = await sign(config.clientSecret, 'state', { nonce, returnTo, expiresAt: now + LOGIN_MS });
  const url = new URL('https://discord.com/oauth2/authorize');
  url.search = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    // Someone who has said yes before is not asked again.
    prompt: 'none',
  }).toString();
  return {
    location: url.href,
    cookie: `${LOGIN_COOKIE}=${nonce}; Path=/auth; Max-Age=${LOGIN_MS / 1000}; HttpOnly; Secure; SameSite=Lax`,
  };
};

// Clears the sign-in cookie once it has been used.
export const CLEAR_LOGIN_COOKIE = `${LOGIN_COOKIE}=; Path=/auth; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

const cookieValue = (header: string | null, name: string): string | null => {
  for (const part of (header ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return null;
};

// The page to go back to, when the state is the one this browser started with and has not run out.
export const checkState = async (secret: string, state: string | null, cookieHeader: string | null, now: number): Promise<string | null> => {
  const nonce = cookieValue(cookieHeader, LOGIN_COOKIE);
  if (state === null || nonce === null || nonce === '') return null;
  const parsed = StateSchema.safeParse(await verify(secret, 'state', state));
  if (!parsed.success || parsed.data.expiresAt <= now || parsed.data.nonce !== nonce) return null;
  return parsed.data.returnTo;
};

const TokenSchema = z.object({ access_token: z.string() });
const UserSchema = z.object({ id: z.string(), username: z.string(), global_name: z.string().nullish() });
const MemberSchema = z.object({ roles: z.array(z.string()), nick: z.string().nullish() });
const GuildsSchema = z.array(z.object({ id: z.string(), owner: z.boolean().nullish(), permissions: z.string().nullish() }));

const isAdministrator = (permissions: string | null | undefined): boolean => {
  try {
    return permissions != null && (BigInt(permissions) & ADMINISTRATOR) === ADMINISTRATOR;
  } catch {
    return false;
  }
};

export type LoginResult = { user: { id: string; name: string } } | { problem: LoginProblem };

// Swaps Discord's code for who the user is, and whether they are staff in the server.
export const finishLogin = async (
  config: AdminAuthConfig,
  code: string,
  redirectUri: string,
  fetchFn: typeof fetch = fetch,
): Promise<LoginResult> => {
  const call = (path: string, init: RequestInit = {}) => fetchFn(`${DISCORD_API}${path}`, { signal: AbortSignal.timeout(8_000), ...init });
  const tokenResponse = await call('/oauth2/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }).toString(),
  });
  if (!tokenResponse.ok) throw new Error(`Discord refused the sign-in code: ${tokenResponse.status} ${await tokenResponse.text()}`);
  const { access_token: accessToken } = TokenSchema.parse(await tokenResponse.json());
  const asUser = { headers: { authorization: `Bearer ${accessToken}` } };
  const [userResponse, memberResponse] = await Promise.all([call('/users/@me', asUser), call(`/users/@me/guilds/${config.guildId}/member`, asUser)]);
  if (!userResponse.ok) throw new Error(`Discord did not say who signed in: ${userResponse.status}`);
  const user = UserSchema.parse(await userResponse.json());
  if (memberResponse.status === 404) return { problem: 'not-member' };
  if (!memberResponse.ok) throw new Error(`Discord did not give their roles: ${memberResponse.status}`);
  const member = MemberSchema.parse(await memberResponse.json());
  const named = { id: user.id, name: member.nick || user.global_name || user.username };
  if (member.roles.some((role) => config.adminRoleIds.includes(role))) return { user: named };
  // Not a staff role: an Administrator, or the server's owner, is staff too.
  const guildsResponse = await call('/users/@me/guilds', asUser);
  if (!guildsResponse.ok) throw new Error(`Discord did not give their servers: ${guildsResponse.status}`);
  const guild = GuildsSchema.parse(await guildsResponse.json()).find((g) => g.id === config.guildId);
  return guild !== undefined && (guild.owner === true || isAdministrator(guild.permissions)) ? { user: named } : { problem: 'not-staff' };
};
