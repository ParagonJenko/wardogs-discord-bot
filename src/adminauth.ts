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
//
// Players sign in the same way (flow 'player'), through the same callback, so no second redirect has to be registered
// with Discord. Their session is a different kind of token ('player'), which the staff routes never accept: a valid
// session there means staff. A player sign-in also asks for their connections (to find the Steam account they
// connected to Discord) and, when they pressed "Sign in and join", `guilds.join`, so the bot can add them to the server.

export const SESSION_HOURS = 36;
const SESSION_MS = SESSION_HOURS * 60 * 60_000;
// A player stays signed in much longer than staff: it gives them nothing but their own account.
export const PLAYER_SESSION_DAYS = 30;
const PLAYER_SESSION_MS = PLAYER_SESSION_DAYS * 24 * 60 * 60_000;
// How long someone has to come back from Steam with the proof, and use it on the website.
const STEAM_PROOF_MS = 10 * 60_000;
// How long someone has to finish signing in at Discord.
const LOGIN_MS = 10 * 60_000;
export const LOGIN_COOKIE = 'wardogs_login';
export const CALLBACK_PATH = '/auth/callback';
// The page on the website that shows the staff tools.
export const ADMIN_PAGE = '/admin';
// The page on the website where players sign in and see their account.
export const ACCOUNT_PAGE = '/account';

const DISCORD_API = 'https://discord.com/api/v10';
const SCOPES = 'identify guilds guilds.members.read';
const PLAYER_SCOPES = 'identify connections guilds.members.read';
const JOIN_SCOPE = 'guilds.join';
// Discord permission bit for "Administrator".
const ADMINISTRATOR = 1n << 3n;

export type Session = { userId: string; name: string; expiresAt: number };

// Why a sign-in did not give a session, as the page is told after `#error=`. A player is never 'not-staff', and 'not-member'
// is not a problem for them (they sign in, and the page offers to join).
export type LoginProblem = 'cancelled' | 'expired' | 'not-member' | 'not-staff' | 'failed';

// Which sign-in this is: staff for the staff page, or a player's for their account.
export type LoginFlow = 'staff' | 'player';

export type AdminAuthConfig = {
  clientId: string;
  clientSecret: string;
  guildId: string;
  adminRoleIds: string[];
  // The website's origin, such as https://gaminginit.com: the only place a session token is sent back to.
  siteOrigin: string;
};

// The website's origin from SITE_URL, or null when it is not set or not a URL.
export const siteOriginOf = (vars: Record<string, string>): string | null => {
  try {
    const url = vars['SITE_URL']?.trim() ?? '';
    return url === '' ? null : new URL(url).origin;
  } catch {
    return null;
  }
};

// Why staff cannot sign in, for the logs and the staff page.
export const notSetUpText = (missing: string[]): string =>
  `Staff sign-in is not set up on the bot. Missing: ${missing.join(', ')}. See the bot's README, "Staff page".`;

// The sign-in's settings, or what is missing while any are.
export const adminAuthConfig = (vars: Record<string, string>): AdminAuthConfig | { missing: string[] } => {
  const value = (key: string): string => vars[key]?.trim() ?? '';
  const siteOrigin = siteOriginOf(vars) ?? '';
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

// `purpose` keeps a login state from ever passing as a session, and a player's session from ever passing as staff's.
type Purpose = 'session' | 'state' | 'player' | 'steam';

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
const StateSchema = z.object({
  nonce: z.string(),
  returnTo: z.string(),
  expiresAt: z.number(),
  // Missing from states signed before players could sign in.
  flow: z.enum(['staff', 'player']).default('staff'),
  join: z.boolean().default(false),
});
const SteamProofSchema = z.object({ steamId: z.string().regex(/^\d{17}$/), expiresAt: z.number() });

export const createSession = (secret: string, user: { id: string; name: string }, now: number): Promise<string> =>
  sign(secret, 'session', { userId: user.id, name: user.name, expiresAt: now + SESSION_MS } satisfies Session);

// The session in an Authorization header, while it lasts.
export const readSession = async (secret: string, header: string | null, now: number): Promise<Session | null> => {
  const token = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '')?.[1];
  if (token === undefined) return null;
  const parsed = SessionSchema.safeParse(await verify(secret, 'session', token));
  return parsed.success && parsed.data.expiresAt > now ? parsed.data : null;
};

export const createPlayerSession = (secret: string, user: { id: string; name: string }, now: number): Promise<string> =>
  sign(secret, 'player', { userId: user.id, name: user.name, expiresAt: now + PLAYER_SESSION_MS } satisfies Session);

// A player's session in an Authorization header, while it lasts. Never a staff session.
export const readPlayerSession = async (secret: string, header: string | null, now: number): Promise<Session | null> => {
  const token = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '')?.[1];
  if (token === undefined) return null;
  const parsed = SessionSchema.safeParse(await verify(secret, 'player', token));
  return parsed.success && parsed.data.expiresAt > now ? parsed.data : null;
};

// What Steam's sign-in proved: this browser's owner has the Steam account. It names no Discord user, so it is worth
// nothing alone: the website sends it with the player's own session, and the Worker links the two.
export const createSteamProof = (secret: string, steamId: string, now: number): Promise<string> =>
  sign(secret, 'steam', { steamId, expiresAt: now + STEAM_PROOF_MS });

export const readSteamProof = async (secret: string, token: string | null, now: number): Promise<string | null> => {
  if (token === null) return null;
  const parsed = SteamProofSchema.safeParse(await verify(secret, 'steam', token));
  return parsed.success && parsed.data.expiresAt > now ? parsed.data.steamId : null;
};

// Where to send someone back to: a page on the website, the staff page unless they came from another.
export const returnAddress = (asked: string | null, siteOrigin: string, fallbackPage: string = ADMIN_PAGE): string => {
  const fallback = `${siteOrigin}${fallbackPage}`;
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
  options: { flow?: LoginFlow; join?: boolean } = {},
): Promise<{ location: string; cookie: string }> => {
  const flow = options.flow ?? 'staff';
  // Only a player can ask to be added to the server.
  const join = flow === 'player' && options.join === true;
  const nonce = randomNonce();
  const state = await sign(config.clientSecret, 'state', { nonce, returnTo, expiresAt: now + LOGIN_MS, flow, join });
  const url = new URL('https://discord.com/oauth2/authorize');
  url.search = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: flow === 'staff' ? SCOPES : join ? `${PLAYER_SCOPES} ${JOIN_SCOPE}` : PLAYER_SCOPES,
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

export type LoginState = { returnTo: string; flow: LoginFlow; join: boolean };

// Which sign-in a state is for, whoever's browser it came back in: only to say where to show an error. It never signs anyone in.
export const peekState = async (secret: string, state: string | null, now: number): Promise<LoginState | null> => {
  if (state === null) return null;
  const parsed = StateSchema.safeParse(await verify(secret, 'state', state));
  if (!parsed.success || parsed.data.expiresAt <= now) return null;
  const { returnTo, flow, join } = parsed.data;
  return { returnTo, flow, join };
};

// The state, when it is the one this browser started with and has not run out.
export const readState = async (secret: string, state: string | null, cookieHeader: string | null, now: number): Promise<LoginState | null> => {
  const nonce = cookieValue(cookieHeader, LOGIN_COOKIE);
  if (state === null || nonce === null || nonce === '') return null;
  const parsed = StateSchema.safeParse(await verify(secret, 'state', state));
  if (!parsed.success || parsed.data.expiresAt <= now || parsed.data.nonce !== nonce) return null;
  const { returnTo, flow, join } = parsed.data;
  return { returnTo, flow, join };
};

// The page to go back to, when the state is the one this browser started with and has not run out.
export const checkState = async (secret: string, state: string | null, cookieHeader: string | null, now: number): Promise<string | null> =>
  (await readState(secret, state, cookieHeader, now))?.returnTo ?? null;

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

export type LoginResult = { user: { id: string; name: string; username: string } } | { problem: LoginProblem };

const discordCall =
  (fetchFn: typeof fetch) =>
  (path: string, init: RequestInit = {}): Promise<Response> =>
    fetchFn(`${DISCORD_API}${path}`, { signal: AbortSignal.timeout(8_000), ...init });

// Swaps the code Discord sent back for an access token, which is only used for the calls that follow, then dropped.
const exchangeCode = async (config: AdminAuthConfig, code: string, redirectUri: string, fetchFn: typeof fetch): Promise<string> => {
  const response = await discordCall(fetchFn)('/oauth2/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }).toString(),
  });
  if (!response.ok) throw new Error(`Discord refused the sign-in code: ${response.status} ${await response.text()}`);
  return TokenSchema.parse(await response.json()).access_token;
};

// Swaps Discord's code for who the user is, and whether they are staff in the server.
export const finishLogin = async (
  config: AdminAuthConfig,
  code: string,
  redirectUri: string,
  fetchFn: typeof fetch = fetch,
): Promise<LoginResult> => {
  const call = discordCall(fetchFn);
  const accessToken = await exchangeCode(config, code, redirectUri, fetchFn);
  const asUser = { headers: { authorization: `Bearer ${accessToken}` } };
  const [userResponse, memberResponse] = await Promise.all([call('/users/@me', asUser), call(`/users/@me/guilds/${config.guildId}/member`, asUser)]);
  if (!userResponse.ok) throw new Error(`Discord did not say who signed in: ${userResponse.status}`);
  const user = UserSchema.parse(await userResponse.json());
  if (memberResponse.status === 404) return { problem: 'not-member' };
  if (!memberResponse.ok) throw new Error(`Discord did not give their roles: ${memberResponse.status}`);
  const member = MemberSchema.parse(await memberResponse.json());
  const named = { id: user.id, name: member.nick || user.global_name || user.username, username: user.username };
  if (member.roles.some((role) => config.adminRoleIds.includes(role))) return { user: named };
  // Not a staff role: an Administrator, or the server's owner, is staff too.
  const guildsResponse = await call('/users/@me/guilds', asUser);
  if (!guildsResponse.ok) throw new Error(`Discord did not give their servers: ${guildsResponse.status}`);
  const guild = GuildsSchema.parse(await guildsResponse.json()).find((g) => g.id === config.guildId);
  return guild !== undefined && (guild.owner === true || isAdministrator(guild.permissions)) ? { user: named } : { problem: 'not-staff' };
};

const ConnectionsSchema = z.array(z.object({ type: z.string(), id: z.string(), verified: z.boolean().nullish() }));

// A Steam64 ID: 17 digits, starting 7656119.
const STEAM64 = /^7656119\d{10}$/;

// The Steam account a player connected to their Discord profile, when there is one. Discord checks a connection with the
// service, so a verified one is proof they own the account. Null for none, an unverified one, or an ID that is not a Steam64.
export const steamFromConnections = (raw: unknown): string | null => {
  const parsed = ConnectionsSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data.find((c) => c.type === 'steam' && c.verified !== false && STEAM64.test(c.id))?.id ?? null;
};

// How the bot adds someone to the server with the access token they gave (see accountsdiscord.ts): 'added', or 'already'
// when they were in it, or a reason it did not.
export type JoinOutcome = 'added' | 'already' | 'banned' | 'unavailable';

export type PlayerLogin = {
  user: { id: string; name: string; username: string };
  // Whether they are in the server now, counting an add that just worked.
  member: boolean;
  // Set when they pressed "Sign in and join": what happened.
  join: JoinOutcome | null;
  // The Steam account on their Discord profile, when it has one.
  steamId: string | null;
};

// Swaps Discord's code for who the player is, whether they are in the server, and the Steam account they connected to
// Discord. When they asked to join and are not in the server, `addMember` adds them with their access token (it needs the
// `guilds.join` scope they just agreed to, and the bot's token); it is not called for someone already in.
export const finishPlayerLogin = async (
  config: AdminAuthConfig,
  code: string,
  redirectUri: string,
  join: boolean,
  addMember: (userId: string, accessToken: string) => Promise<JoinOutcome>,
  fetchFn: typeof fetch = fetch,
): Promise<PlayerLogin> => {
  const call = discordCall(fetchFn);
  const accessToken = await exchangeCode(config, code, redirectUri, fetchFn);
  const asUser = { headers: { authorization: `Bearer ${accessToken}` } };
  const [userResponse, memberResponse, connectionsResponse] = await Promise.all([
    call('/users/@me', asUser),
    call(`/users/@me/guilds/${config.guildId}/member`, asUser),
    call('/users/@me/connections', asUser),
  ]);
  if (!userResponse.ok) throw new Error(`Discord did not say who signed in: ${userResponse.status}`);
  const user = UserSchema.parse(await userResponse.json());
  if (!memberResponse.ok && memberResponse.status !== 404) throw new Error(`Discord did not say if they are in the server: ${memberResponse.status}`);
  const member = memberResponse.ok ? MemberSchema.parse(await memberResponse.json()) : null;
  // No connections is not a failure: they are linked with Steam's own sign-in instead.
  const steamId = connectionsResponse.ok ? steamFromConnections(await connectionsResponse.json().catch(() => null)) : null;
  const named = { id: user.id, name: member?.nick || user.global_name || user.username, username: user.username };
  if (member !== null) return { user: named, member: true, join: join ? 'already' : null, steamId };
  if (!join) return { user: named, member: false, join: null, steamId };
  const outcome = await addMember(user.id, accessToken);
  return { user: named, member: outcome === 'added' || outcome === 'already', join: outcome, steamId };
};
