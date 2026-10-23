import { z } from 'zod';
import type { VipRule } from './config.ts';
import { playerName, seedTerms } from './discord.ts';
import type { VipGrant } from './vip.ts';

// Player accounts: a player signs in to the website with Discord, and links the Steam account they play on (from the
// Steam account on their Discord profile, or by signing in with Steam). The bot then knows who they are in game, and can
// give them what only a linked account gets: a role in the server, and a Discord message when their seeder VIP is earned,
// about to end or over. Kept by Discord user ID, one key each ('account:<ID>'), because there may be thousands and a
// stored value cannot be over 128 KiB; the Steam account's owner is 'steamLink:<Steam ID>', so one Steam account is one
// player's. 'accountWork' lists who the bot still has something to do for (a role to give or take, VIP to tell them of),
// so a check never reads every account. Never sent to the public pages: nobody can learn from the website who is who.

export const ACCOUNT_PREFIX = 'account:';
export const accountKey = (userId: string): string => `${ACCOUNT_PREFIX}${userId}`;
export const steamLinkKey = (steamId: string): string => `steamLink:${steamId}`;
export const ACCOUNT_WORK_KEY = 'accountWork';

export const DISCORD_ID = /^\d{15,25}$/;
export const STEAM_ID = /^7656119\d{10}$/;

// The VIP ending warning goes out this long before, once. A grant shorter than twice this gets no warning: it would come
// straight after the message that it was given.
export const WARN_MS = 24 * 60 * 60_000;
// A renewal is a new grant that starts as the old one ends. The check that does it may be a little later than the end.
const RENEW_SLACK_MS = 60 * 60_000;
// After a role change fails, the bot waits this long before trying that account again.
export const RETRY_MS = 15 * 60_000;
// Someone in the server is looked up again once the last answer is this old.
export const MEMBER_FRESH_MS = 5 * 60_000;

export type RoleName = 'linked' | 'vip';

// What the bot last told one account about its VIP: the grant (by when it was given) and its end, whether the warning
// went out and whether the end did. Nothing is sent twice.
export type Notified = { grantedAt: number; expiresAt: number; warned: boolean; ended: boolean };

export type Account = {
  // What they go by in the server, as of their last sign-in.
  name: string;
  createdAt: number;
  signedInAt: number;
  // The Steam account, and how it was proved: from their Discord profile, or by signing in with Steam.
  steamId: string | null;
  via: 'discord' | 'steam' | null;
  linkedAt: number | null;
  // Set when they joined the server with the website's join button.
  joined: 'site' | null;
  // Whether they are in the server, and when that was last known.
  member: boolean | null;
  memberAt: number;
  // Whether they want Discord messages about their VIP. On until they turn it off.
  alerts: boolean;
  // The roles the bot has given them, as far as it knows.
  roles: Record<RoleName, boolean>;
  notified: Notified | null;
  // Their last message could not be delivered (private messages closed): none are tried again until they sign in.
  dmClosed: boolean;
  // When they were last asked back to seed after time away (see returnDue), or 0.
  returnedAt: number;
  // Role changes that failed wait for this time.
  retryAt: number;
};

const AccountSchema = z.object({
  name: z.string(),
  createdAt: z.number(),
  signedInAt: z.number(),
  steamId: z.string().nullable().default(null),
  via: z.enum(['discord', 'steam']).nullable().default(null),
  linkedAt: z.number().nullable().default(null),
  joined: z.literal('site').nullable().default(null),
  member: z.boolean().nullable().default(null),
  memberAt: z.number().default(0),
  alerts: z.boolean().default(true),
  roles: z.object({ linked: z.boolean().default(false), vip: z.boolean().default(false) }).default({ linked: false, vip: false }),
  notified: z
    .object({ grantedAt: z.number(), expiresAt: z.number(), warned: z.boolean(), ended: z.boolean() })
    .nullable()
    .default(null),
  dmClosed: z.boolean().default(false),
  returnedAt: z.number().default(0),
  retryAt: z.number().default(0),
});

export const parseAccount = (raw: unknown): Account | null => {
  const parsed = AccountSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

// Who has a Steam account: 'u' is the Discord user, 'm' whether they are in the server. Read by the welcome (which leaves the
// invite out for members) and when a Steam account is asked for, so neither reads the account.
export type SteamLink = { u: string; m: boolean };

const SteamLinkSchema = z.object({ u: z.string().regex(DISCORD_ID), m: z.boolean() });

export const parseSteamLink = (raw: unknown): SteamLink | null => {
  const parsed = SteamLinkSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

export const parseWork = (raw: unknown): string[] => {
  const parsed = z.array(z.string().regex(DISCORD_ID)).safeParse(raw);
  return parsed.success ? parsed.data : [];
};

// An account that signed in now. `member` is whether they are in the server; `joined` is set when the website's join
// button just added them.
export const signedIn = (
  existing: Account | null,
  user: { name: string },
  state: { member: boolean; joined: boolean },
  now: number,
): Account => {
  const base: Account = existing ?? {
    name: user.name,
    createdAt: now,
    signedInAt: now,
    steamId: null,
    via: null,
    linkedAt: null,
    joined: null,
    member: null,
    memberAt: 0,
    alerts: true,
    roles: { linked: false, vip: false },
    notified: null,
    dmClosed: false,
    returnedAt: 0,
    retryAt: 0,
  };
  return {
    ...base,
    name: user.name,
    signedInAt: now,
    member: state.member,
    memberAt: now,
    joined: state.joined ? 'site' : base.joined,
    // They signed in again: a closed message box may be open now, and a failed role is worth another try.
    dmClosed: false,
    retryAt: 0,
  };
};

// Why a Steam account cannot be linked: it is another player's (taken), or a staff member's.
export type LinkProblem = 'steam-taken' | 'not-a-steam-id';

// Links a Steam account, or changes the one linked. `owner` is who has it now: another Discord user's account or a staff
// profile (see staffprofiles.ts), by Discord user ID.
export const linkSteam = (
  account: Account,
  userId: string,
  steamId: string,
  via: 'discord' | 'steam',
  owner: string | null,
  now: number,
): Account | { problem: LinkProblem } => {
  if (!STEAM_ID.test(steamId)) return { problem: 'not-a-steam-id' };
  if (owner !== null && owner !== userId) return { problem: 'steam-taken' };
  if (account.steamId === steamId) return { ...account, via };
  // A different account: nothing that was told about the old one carries over.
  return { ...account, steamId, via, linkedAt: now, notified: null };
};

export const unlinkSteam = (account: Account): Account => ({ ...account, steamId: null, via: null, linkedAt: null, notified: null });

export type VipView = Pick<VipGrant, 'grantedAt' | 'expiresAt' | 'source'>;

// The VIP an account has now: only through a linked Steam account, and only while it lasts.
export const activeGrant = (account: Account, grant: VipView | null | undefined, now: number): VipView | null =>
  account.steamId !== null && grant != null && grant.expiresAt > now ? grant : null;

export type DmKind = 'earned' | 'renewed' | 'staff' | 'bounty' | 'expiring' | 'ended';

// The roles to give or take: only those with a role ID set (`ids`) are looked at.
export type AccountRule = { roles: Partial<Record<RoleName, string>>; messages: boolean; siteUrl: string | undefined; vip: VipRule | null };

export type AccountPlan = {
  next: Account;
  add: RoleName[];
  remove: RoleName[];
  dms: DmKind[];
  // Whether the bot still has something to do for this account at a later check.
  working: boolean;
};

const unix = (ms: number): number => Math.floor(ms / 1000);

// What the bot does for one account now: the roles it should have (the linked one for a linked Steam account, the VIP one
// while they have VIP), and the messages about their VIP that have not been sent. `next` has the messages as sent and the
// roles unchanged: the caller records the roles it managed to change with `applied`, so a failure is tried again.
export const planAccount = (account: Account, grant: VipView | null | undefined, now: number, rule: AccountRule): AccountPlan => {
  const active = activeGrant(account, grant, now);
  const dms: DmKind[] = [];
  let notified = account.notified;
  if (account.steamId === null) {
    notified = null;
  } else if (active !== null) {
    if (notified === null || notified.grantedAt !== active.grantedAt) {
      const renewal = notified !== null && !notified.ended && notified.expiresAt <= active.grantedAt + RENEW_SLACK_MS;
      dms.push(active.source === 'staff' ? 'staff' : active.source === 'bounty' ? 'bounty' : renewal ? 'renewed' : 'earned');
      notified = { grantedAt: active.grantedAt, expiresAt: active.expiresAt, warned: false, ended: false };
    } else if (notified.expiresAt !== active.expiresAt) {
      // Staff made it longer: the warning is for the new end.
      notified = { ...notified, expiresAt: active.expiresAt, warned: false };
    }
    if (!notified.warned && active.expiresAt - now <= WARN_MS && active.expiresAt - active.grantedAt > 2 * WARN_MS) {
      dms.push('expiring');
      notified = { ...notified, warned: true };
    }
  } else if (notified !== null && !notified.ended) {
    // Over, when its time has passed. Gone before that (taken away, or made permanent): nothing to say.
    if (now >= notified.expiresAt) {
      dms.push('ended');
      notified = { ...notified, ended: true };
    } else {
      notified = null;
    }
  }
  const wanted: Record<RoleName, boolean> = { linked: account.steamId !== null, vip: active !== null };
  const names = (Object.keys(wanted) as RoleName[]).filter((role) => rule.roles[role] !== undefined);
  const add = names.filter((role) => wanted[role] && !account.roles[role]);
  const remove = names.filter((role) => !wanted[role] && account.roles[role]);
  // Messages only for someone who wants them and can get them.
  const sendable = rule.messages && account.alerts && !account.dmClosed && account.member !== false ? dms : [];
  const next: Account = { ...account, notified };
  return {
    next,
    add,
    remove,
    dms: sendable,
    working: add.length > 0 || remove.length > 0 || (notified !== null && !notified.ended),
  };
};

// The account after the bot changed these roles.
export const applied = (account: Account, added: RoleName[], removed: RoleName[]): Account => ({
  ...account,
  roles: {
    ...account.roles,
    ...Object.fromEntries(added.map((role) => [role, true])),
    ...Object.fromEntries(removed.map((role) => [role, false])),
  },
});

// How the account stands when it signs in, without sending anything: a VIP they already have is not news. Used when a
// Steam account is linked, so the first message is about a change, not about what they could already see.
export const adopt = (account: Account, grant: VipView | null | undefined, now: number): Account => {
  const active = activeGrant(account, grant, now);
  return {
    ...account,
    notified:
      active === null
        ? null
        : {
            grantedAt: active.grantedAt,
            expiresAt: active.expiresAt,
            warned: active.expiresAt - now <= WARN_MS,
            ended: false,
          },
  };
};

export const dmText = (kind: DmKind, expiresAt: number | null, rule: Pick<AccountRule, 'siteUrl' | 'vip'>): string => {
  const until = expiresAt === null ? '' : `<t:${unix(expiresAt)}:f>`;
  const site = rule.siteUrl === undefined ? null : rule.siteUrl.replace(/\/+$/, '');
  const keep = rule.vip === null ? '' : ` Seed ${seedTerms(rule.vip)} to keep it.`;
  const more = site === null ? '' : ` ${site}/seeding`;
  const off = site === null ? '' : `\n-# Turn these messages off at ${site}/account`;
  const body = {
    earned: `You earned **seeder VIP** on the WARDOGS server, thanks for seeding. It lasts until ${until}. The server picks it up at its next restart.${keep}`,
    renewed: `Your **seeder VIP** on the WARDOGS server is renewed until ${until}. Thanks for seeding again.`,
    staff: `Staff gave you **VIP** on the WARDOGS server until ${until}. The server picks it up at its next restart.`,
    bounty: `You ended a long kill streak and earned **VIP** on the WARDOGS server until ${until}. The server picks it up at its next restart.`,
    expiring: `Your VIP on the WARDOGS server ends <t:${unix(expiresAt ?? 0)}:R>.${keep}${more}`,
    ended: `Your VIP on the WARDOGS server has ended.${keep}${more}`,
  }[kind];
  return `${body}${off}`;
};

// What the website shows of an account: never the Discord ID of anyone but the signed-in player, and no Steam ID.
export type AccountView = {
  user: { id: string; name: string };
  // Whether they are in the server. Null when the bot could not tell.
  member: boolean | null;
  steam: { linked: boolean; via: 'discord' | 'steam' | null };
  // The page of their linked Steam account, by the public id players have. Null without one, or before they were seen.
  playerId: string | null;
  vip: { until: number; source: 'seeding' | 'staff' } | null;
  alerts: boolean;
  // Whether their profile is private, and whether they made it so (staff keep control of what they made private).
  private: { on: boolean; byYou: boolean };
  // Their votes in the next-map vote that is open, for the vote page. Null with no vote open, or no vote cast.
  ballot: { poll: string; map: string | null; light: string | null; weather: string | null } | null;
  // What linking gives them in this server, for the page to say.
  perks: { role: boolean; vipRole: boolean; messages: boolean; join: boolean };
};

// What the website asks for on an account.
export type AccountAction =
  | { action: 'steam'; proof: string }
  | { action: 'unlink' }
  | { action: 'alerts'; on: boolean }
  | { action: 'private'; on: boolean }
  | { action: 'forget' };

const AccountActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('steam'), proof: z.string().max(600) }),
  z.object({ action: z.literal('unlink') }),
  z.object({ action: z.literal('alerts'), on: z.boolean() }),
  z.object({ action: z.literal('private'), on: z.boolean() }),
  z.object({ action: z.literal('forget') }),
]);

const ACCOUNT_BODY_BYTES = 1_024;

export const readAccountAction = async (request: Request): Promise<AccountAction | null> => {
  if (Number(request.headers.get('content-length') ?? 0) > ACCOUNT_BODY_BYTES) return null;
  const body = await request.arrayBuffer();
  if (body.byteLength > ACCOUNT_BODY_BYTES) return null;
  try {
    const parsed = AccountActionSchema.safeParse(JSON.parse(new TextDecoder().decode(body)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

// A vote cast from the website: the vote's id, and the map, the time of day (`light`) or the weather.
export type WebVote = { poll: string; map?: string; light?: string; weather?: string };

const WebVoteSchema = z
  .object({
    poll: z.string().regex(/^\d{1,20}$/),
    map: z.string().max(80).optional(),
    light: z.string().max(20).optional(),
    weather: z.string().max(20).optional(),
  })
  .refine((v) => [v.map, v.light, v.weather].filter((x) => x !== undefined).length === 1);

export const readWebVote = async (request: Request): Promise<WebVote | null> => {
  if (Number(request.headers.get('content-length') ?? 0) > ACCOUNT_BODY_BYTES) return null;
  const body = await request.arrayBuffer();
  if (body.byteLength > ACCOUNT_BODY_BYTES) return null;
  try {
    const parsed = WebVoteSchema.safeParse(JSON.parse(new TextDecoder().decode(body)));
    if (!parsed.success) return null;
    const { poll, map, light, weather } = parsed.data;
    return {
      poll,
      ...(map === undefined ? {} : { map }),
      ...(light === undefined ? {} : { light }),
      ...(weather === undefined ? {} : { weather }),
    };
  } catch {
    return null;
  }
};

// Regulars who have not linked are asked to in their welcome in game, at most once in this long. Who was asked, and when,
// is kept in LINK_NUDGES_KEY by Steam ID, for this long only.
export const LINK_NUDGES_KEY = 'linkNudges';
export const NUDGE_AGAIN_MS = 7 * 24 * 60 * 60_000;
// A regular has played this many matches in the leaderboard's 30 days.
export const REGULAR_MATCHES = 5;

export type LinkNudges = Record<string, number>;

export const parseNudges = (raw: unknown): LinkNudges => {
  const parsed = z.record(z.string(), z.number()).safeParse(raw);
  return parsed.success ? parsed.data : {};
};

// Who was asked lately, after these were asked now.
export const withNudged = (nudges: LinkNudges, steamIds: string[], now: number): LinkNudges => ({
  ...Object.fromEntries(Object.entries(nudges).filter(([, at]) => now - at < NUDGE_AGAIN_MS)),
  ...Object.fromEntries(steamIds.map((id) => [id, now])),
});

// The regulars to ask: `matches` is each player's matches in the leaderboard's days, by Steam ID. Not anyone linked, not
// staff, not anyone asked lately.
export const nudgesDue = (
  matches: ReadonlyMap<string, number>,
  linked: ReadonlySet<string>,
  staff: ReadonlySet<string>,
  nudges: LinkNudges,
  now: number,
): Set<string> =>
  new Set(
    [...matches]
      .filter(([steamId, count]) => count >= REGULAR_MATCHES && !linked.has(steamId) && !staff.has(steamId) && now - (nudges[steamId] ?? 0) >= NUDGE_AGAIN_MS)
      .map(([steamId]) => steamId),
  );

// ---- Asking players back ----

// A linked player not seen on the server for RETURN_AWAY_DAYS (but seen in the days the bot keeps) gets a Discord message
// when the server is seeding, at most once in RETURN_AGAIN_MS, and only RETURN_PER_DAY of them a day, the ones seen most
// lately first.
export const RETURN_AWAY_DAYS = 14;
export const RETURN_AGAIN_MS = 30 * 24 * 60 * 60_000;
export const RETURN_PER_DAY = 5;
// The UTC day ("2026-10-20") the last batch went out, so there is one a day.
export const RETURN_DAY_KEY = 'returnDay';

const DAY_MS = 24 * 60 * 60_000;

// Whether to ask this account back now. `lastSeen` is the last UTC day they were on, null when not in the days kept.
export const returnDue = (account: Account, lastSeen: string | null, now: number): boolean =>
  account.steamId !== null &&
  account.alerts &&
  !account.dmClosed &&
  account.member !== false &&
  lastSeen !== null &&
  now - Date.parse(`${lastSeen}T00:00:00Z`) >= RETURN_AWAY_DAYS * DAY_MS &&
  now - account.returnedAt >= RETURN_AGAIN_MS;

// The message: the server is seeding with `players` on, how to join (`serverId`, when set), what seeding earns, and how
// to turn these off.
export const returnText = (name: string, players: number, rule: Pick<AccountRule, 'siteUrl' | 'vip'> & { serverId: string | undefined }): string => {
  const site = rule.siteUrl === undefined ? null : rule.siteUrl.replace(/\/+$/, '');
  const join = rule.serverId === undefined ? '' : ` Join by ID: \`${rule.serverId}\`.`;
  const earn = rule.vip === null ? '' : ` Seed ${seedTerms(rule.vip)} for a VIP whitelist slot.`;
  const off = site === null ? '' : `\n-# Turn these messages off at ${site}/account`;
  return `Hey ${playerName(name)}, it's been a while! The WARDOGS server is seeding now with ${players} on. Jump in and help get it live.${join}${earn}${off}`;
};
