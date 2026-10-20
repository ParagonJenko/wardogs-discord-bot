import {
  ACCOUNT_PREFIX,
  ACCOUNT_WORK_KEY,
  accountKey,
  adopt,
  applied,
  dmText,
  linkSteam,
  MEMBER_FRESH_MS,
  parseAccount,
  parseSteamLink,
  parseWork,
  planAccount,
  RETRY_MS,
  signedIn,
  steamLinkKey,
  unlinkSteam,
  type Account,
  type AccountRule,
  type AccountView,
  type LinkProblem,
  type RoleName,
} from './accounts.ts';
import { makePrivate, makePublic, parsePrivateProfiles, PRIVATE_PROFILES_KEY } from './privacy.ts';
import { parseStaffProfiles, STAFF_PROFILES_KEY } from './staffprofiles.ts';
import type { VipState } from './vip.ts';

// The bot's work on player accounts (see accounts.ts for what an account is), against the Durable Object's storage and
// Discord. Kept out of the Watcher so it can be tested with a map for storage and a pretend Discord. The Watcher runs
// each of these one at a time.

// The bits of storage used, which the Durable Object's storage fits.
export type BookStorage = {
  get: (keys: string[]) => Promise<Map<string, unknown>>;
  put: (entries: Record<string, unknown>) => Promise<unknown>;
  delete: (keys: string[]) => Promise<unknown>;
  list: (options: { prefix: string; limit?: number }) => Promise<Map<string, unknown>>;
};

// What the bot does in the server, with its token. Null when there is no token: no roles, no messages, no checks.
export type Discord = {
  isMember: (userId: string) => Promise<boolean | null>;
  setRole: (userId: string, roleId: string, on: boolean) => Promise<'done' | 'gone'>;
  direct: (userId: string, content: string) => Promise<'sent' | 'closed'>;
};

export type BookDeps = {
  storage: BookStorage;
  now: number;
  rule: AccountRule;
  discord: Discord | null;
  log: { info: (message: string) => void; error: (message: string) => void };
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// Discord calls one pass may make. A Worker may only make so many requests, and the rest waits for the next pass.
export const CALL_BUDGET = 40;
// Accounts one pass looks at.
export const PER_PASS = 15;
// The most accounts read for the staff page's numbers.
const COUNTED = 20_000;

// Who has this Steam account: a staff profile (which staff typed in, and nothing proved), or a player's account. Null for
// nobody. A staff profile comes first: a staff member can have both, and the staff one is the one a claim must not take.
const steamOwner = async (storage: BookStorage, steamId: string): Promise<{ kind: 'player' | 'staff'; userId: string } | null> => {
  const got = await storage.get([steamLinkKey(steamId), STAFF_PROFILES_KEY]);
  const staff = Object.entries(parseStaffProfiles(got.get(STAFF_PROFILES_KEY))).find(([, p]) => p.steamId === steamId)?.[0];
  if (staff !== undefined) return { kind: 'staff', userId: staff };
  const link = parseSteamLink(got.get(steamLinkKey(steamId)));
  return link === null ? null : { kind: 'player', userId: link.u };
};

// Links a Steam account to a player who has just proved they own it: with the connection on their Discord profile, or by
// signing in with Steam. Whoever proves it now has it, so a player who lost their old Discord account gets it back; the
// account that had it is unlinked. A staff profile is different: staff typed it in, so it is only given up on the staff page.
const claim = async (
  deps: BookDeps,
  account: Account,
  userId: string,
  steamId: string,
  via: 'discord' | 'steam',
  vip: VipState,
): Promise<Account | { problem: LinkProblem }> => {
  const { storage, now } = deps;
  const owner = await steamOwner(storage, steamId);
  if (owner?.kind === 'staff' && owner.userId !== userId) return { problem: 'steam-taken' };
  const linked = linkSteam(account, userId, steamId, via, null, now);
  if ('problem' in linked) return linked;
  if (owner?.kind === 'player' && owner.userId !== userId) {
    const old = parseAccount((await storage.get([accountKey(owner.userId)])).get(accountKey(owner.userId)));
    if (old !== null) {
      await save(storage, owner.userId, unlinkSteam(old), steamId);
      await setWork(storage, { add: [owner.userId] });
    }
    deps.log.info(`Player account: Steam account ${steamId} moved from Discord user ${owner.userId} to ${userId}`);
  }
  return linked.steamId === account.steamId ? linked : adopt(linked, vip.granted[steamId], now);
};

// Saves an account and its Steam link in one write, and forgets the link it had before when the Steam account changed.
const save = async (storage: BookStorage, userId: string, account: Account, previousSteamId: string | null): Promise<void> => {
  await storage.put({
    [accountKey(userId)]: account,
    ...(account.steamId === null ? {} : { [steamLinkKey(account.steamId)]: { u: userId, m: account.member === true } }),
  });
  if (previousSteamId !== null && previousSteamId !== account.steamId) await storage.delete([steamLinkKey(previousSteamId)]);
};

const setWork = async (storage: BookStorage, change: { add?: string[]; remove?: string[] }): Promise<void> => {
  const work = parseWork((await storage.get([ACCOUNT_WORK_KEY])).get(ACCOUNT_WORK_KEY));
  const next = [...new Set([...work.filter((id) => !(change.remove ?? []).includes(id)), ...(change.add ?? [])])];
  if (next.length !== work.length || next.some((id, i) => id !== work[i])) await storage.put({ [ACCOUNT_WORK_KEY]: next });
};

export type SignInResult = { steam: 'linked' | 'none' | 'taken' };

// A player signed in with Discord. `login.steamId` is the Steam account on their Discord profile, when it has one.
export const recordSignIn = async (
  deps: BookDeps,
  user: { id: string; name: string },
  login: { member: boolean; joined: boolean; steamId: string | null; roles?: string[] | null },
  vip: VipState,
): Promise<SignInResult> => {
  const { storage, now } = deps;
  const before = parseAccount((await storage.get([accountKey(user.id)])).get(accountKey(user.id)));
  let account = signedIn(before, user, { member: login.member, joined: login.joined }, now);
  // Discord takes a member's roles when they leave, and the bot only knows what it last did: what Discord says now is true.
  // Someone not in the server has none, and one just added has none; the pass gives them back.
  const seen = login.roles ?? null;
  const { linked: linkedRole, vip: vipRole } = deps.rule.roles;
  if (!login.member) account = { ...account, roles: { linked: false, vip: false } };
  else if (seen !== null) {
    account = {
      ...account,
      roles: {
        linked: linkedRole === undefined ? account.roles.linked : seen.includes(linkedRole),
        vip: vipRole === undefined ? account.roles.vip : seen.includes(vipRole),
      },
    };
  }
  let steam: SignInResult['steam'] = account.steamId === null ? 'none' : 'linked';
  // A Steam account they linked with Steam's own sign-in stays theirs: the Steam account on their Discord profile is only taken
  // when they have none, or it came from Discord before (and so follows it).
  const explicit = account.steamId !== null && account.via === 'steam';
  if (login.steamId !== null && login.steamId !== account.steamId && !explicit) {
    const linked = await claim(deps, account, user.id, login.steamId, 'discord', vip);
    if ('problem' in linked) {
      steam = 'taken';
    } else {
      account = linked;
      steam = 'linked';
      deps.log.info(`Player account: ${JSON.stringify(user.name)} (Discord user ${user.id}) linked Steam account ${login.steamId} from Discord`);
    }
  }
  await save(storage, user.id, account, before?.steamId ?? null);
  await setWork(storage, { add: [user.id] });
  return { steam };
};

// Links the Steam account Steam's own sign-in vouched for to the signed-in player (they ask for this because their Discord
// profile has no Steam connection, or has another).
export const linkWithProof = async (
  deps: BookDeps,
  userId: string,
  steamId: string,
  vip: VipState,
): Promise<{ steamId: string } | { problem: LinkProblem | 'no-account' }> => {
  const { storage } = deps;
  const before = parseAccount((await storage.get([accountKey(userId)])).get(accountKey(userId)));
  if (before === null) return { problem: 'no-account' };
  const account = await claim(deps, before, userId, steamId, 'steam', vip);
  if ('problem' in account) return account;
  await save(storage, userId, account, before.steamId);
  await setWork(storage, { add: [userId] });
  deps.log.info(`Player account: Discord user ${userId} linked Steam account ${steamId} with Steam`);
  return { steamId };
};

export type ActionResult = { ok: true } | { problem: string };

export const unlink = async (deps: BookDeps, userId: string): Promise<ActionResult> => {
  const { storage } = deps;
  const before = parseAccount((await storage.get([accountKey(userId)])).get(accountKey(userId)));
  if (before === null) return { problem: 'Sign in again.' };
  if (before.steamId === null) return { ok: true };
  await save(storage, userId, unlinkSteam(before), before.steamId);
  // The roles come off at the next pass.
  await setWork(storage, { add: [userId] });
  deps.log.info(`Player account: Discord user ${userId} unlinked Steam account ${before.steamId}`);
  return { ok: true };
};

export const setAlerts = async (deps: BookDeps, userId: string, on: boolean): Promise<ActionResult> => {
  const before = parseAccount((await deps.storage.get([accountKey(userId)])).get(accountKey(userId)));
  if (before === null) return { problem: 'Sign in again.' };
  await save(deps.storage, userId, { ...before, alerts: on }, before.steamId);
  return { ok: true };
};

// Makes their own profile private or public. Staff keep control of one they made private: a player cannot undo that.
export const setPrivate = async (
  deps: BookDeps,
  userId: string,
  on: boolean,
  playerName: (steamId: string) => Promise<string | null>,
): Promise<ActionResult> => {
  const { storage, now } = deps;
  const got = await storage.get([accountKey(userId), PRIVATE_PROFILES_KEY]);
  const account = parseAccount(got.get(accountKey(userId)));
  if (account === null) return { problem: 'Sign in again.' };
  if (account.steamId === null) return { problem: 'Link your Steam account first.' };
  const profiles = parsePrivateProfiles(got.get(PRIVATE_PROFILES_KEY));
  const current = profiles[account.steamId];
  if (on) {
    const next = makePrivate(profiles, { steamId: account.steamId, name: (await playerName(account.steamId)) ?? account.name }, userId, account.name, now, true);
    if (next !== null) await storage.put({ [PRIVATE_PROFILES_KEY]: next });
    return { ok: true };
  }
  if (current === undefined) return { ok: true };
  // One the player made themselves is theirs to undo, from whichever Discord account now owns the Steam account.
  if (current.by !== userId && current.self !== true) return { problem: 'Staff made this profile private. Ask them in Discord to change it.' };
  const next = makePublic(profiles, account.steamId);
  if (next !== null) await storage.put({ [PRIVATE_PROFILES_KEY]: next });
  return { ok: true };
};

// Forgets an account, and takes the roles the bot gave it. When a role cannot be taken (Discord refused or is down) nothing is
// deleted: the roles would stay on someone nothing remembers. They are told to try again. The profile stays as it is, private or not.
export const forget = async (deps: BookDeps, userId: string): Promise<ActionResult> => {
  const { storage, rule, discord } = deps;
  const before = parseAccount((await storage.get([accountKey(userId)])).get(accountKey(userId)));
  if (before === null) return { ok: true };
  if (discord !== null) {
    for (const role of ['linked', 'vip'] as const) {
      const roleId = rule.roles[role];
      if (roleId === undefined || !before.roles[role]) continue;
      try {
        await discord.setRole(userId, roleId, false);
      } catch (error) {
        deps.log.error(`Player account: taking ${role} role from ${userId} failed, so the account is kept: ${errorText(error)}`);
        return { problem: "Couldn't take your Discord roles just now, so nothing was deleted. Try again in a minute." };
      }
    }
  }
  await storage.delete([accountKey(userId), ...(before.steamId === null ? [] : [steamLinkKey(before.steamId)])]);
  await setWork(storage, { remove: [userId] });
  deps.log.info(`Player account: Discord user ${userId} deleted their account`);
  return { ok: true };
};

export type ViewDeps = BookDeps & {
  // The public id of their player page, or null when they have none (not seen lately, or private).
  playerPage: (steamId: string) => Promise<string | null>;
  // Whether this Worker can add people to the server (a bot token with the right to).
  canJoin: boolean;
  // Their votes in the vote that is open, when they have cast any.
  ballotOf: (userId: string) => Promise<AccountView['ballot']>;
};

// What the account page shows. Null when there is no account (they were forgotten, or never signed in).
export const view = async (deps: ViewDeps, userId: string, vip: VipState): Promise<AccountView | null> => {
  const { storage, now, rule, discord } = deps;
  const got = await storage.get([accountKey(userId), PRIVATE_PROFILES_KEY]);
  let account = parseAccount(got.get(accountKey(userId)));
  if (account === null) return null;
  // Asked again once the last answer is a few minutes old: they may have joined, or left, since.
  if (discord !== null && now - account.memberAt > MEMBER_FRESH_MS) {
    try {
      const member = await discord.isMember(userId);
      if (member !== null) {
        account = { ...account, member, memberAt: now };
        await save(storage, userId, account, account.steamId);
      }
    } catch (error) {
      deps.log.error(`Player account: could not check if ${userId} is a member: ${errorText(error)}`);
    }
  }
  const grant = account.steamId === null ? undefined : vip.granted[account.steamId];
  const profile = account.steamId === null ? undefined : parsePrivateProfiles(got.get(PRIVATE_PROFILES_KEY))[account.steamId];
  return {
    user: { id: userId, name: account.name },
    member: account.member,
    steam: { linked: account.steamId !== null, via: account.via },
    playerId: account.steamId === null || profile !== undefined ? null : await deps.playerPage(account.steamId),
    vip: grant !== undefined && grant.expiresAt > now ? { until: grant.expiresAt, source: grant.source === 'staff' ? 'staff' : 'seeding' } : null,
    alerts: account.alerts,
    private: { on: profile !== undefined, byYou: profile?.by === userId || profile?.self === true },
    ballot: await deps.ballotOf(userId),
    perks: {
      role: rule.roles.linked !== undefined && discord !== null,
      vipRole: rule.roles.vip !== undefined && discord !== null,
      messages: rule.messages,
      join: deps.canJoin,
    },
  };
};

// Whether someone is a member now, as the account last saw or the server says: a vote on the website needs it.
export const isMemberNow = async (deps: BookDeps, userId: string): Promise<boolean> => {
  const { storage, now, discord } = deps;
  const account = parseAccount((await storage.get([accountKey(userId)])).get(accountKey(userId)));
  if (account === null) return false;
  if (discord === null) return account.member === true;
  if (account.member === true && now - account.memberAt <= MEMBER_FRESH_MS) return true;
  const looked = await discord.isMember(userId).catch(() => null);
  // Remembered after every answer, so the next votes in the next minutes do not each ask Discord; not when Discord could not say.
  if (looked !== null) await save(storage, userId, { ...account, member: looked, memberAt: now }, account.steamId);
  return looked ?? account.member === true;
};

// Steam accounts that are linked (`all`), and those of them whose players are in the server (`members`): their welcome in
// game has no invite in it, and nobody linked is asked to link.
export const steamLinks = async (storage: BookStorage): Promise<{ members: Set<string>; all: Set<string> }> => {
  const links = await storage.list({ prefix: 'steamLink:' });
  const members = new Set<string>();
  const all = new Set<string>();
  for (const [key, value] of links) {
    const steamId = key.slice('steamLink:'.length);
    all.add(steamId);
    if (parseSteamLink(value)?.m === true) members.add(steamId);
  }
  return { members, all };
};

export const linkedMembers = async (storage: BookStorage): Promise<Set<string>> => (await steamLinks(storage)).members;

// One pass of what the bot owes accounts: roles to give or take, and VIP messages to send. It looks at the accounts in
// 'accountWork' and at the owners of the Steam accounts that have VIP (so a new VIP is found), at most PER_PASS of them and
// CALL_BUDGET calls to Discord. What it could not finish is looked at again at the next pass.
export const syncAccounts = async (deps: BookDeps, vip: VipState, force: boolean): Promise<void> => {
  const { storage, now, rule, discord } = deps;
  if (discord === null) return;
  const work = parseWork((await storage.get([ACCOUNT_WORK_KEY])).get(ACCOUNT_WORK_KEY));
  const granted = Object.keys(vip.granted);
  const owners = new Set<string>();
  for (let i = 0; i < granted.length; i += 100) {
    const got = await storage.get(granted.slice(i, i + 100).map(steamLinkKey));
    for (const value of got.values()) {
      const link = parseSteamLink(value);
      // Not someone known to be out of the server: asking Discord about them every pass would only get a 404, until they sign in.
      if (link !== null && link.m) owners.add(link.u);
    }
  }
  const candidates = [...new Set([...work, ...owners])];
  const looked = candidates.slice(0, PER_PASS);
  const accounts = await storage.get(looked.map(accountKey));
  let calls = 0;
  // Looked at and still to do. Everything not looked at this pass (the rest of the work list, and the owners of VIP found
  // above) goes to the front of the list, so the next pass starts with them: otherwise accounts that stay "working" for days,
  // such as those with VIP, would hold the first places and starve the rest.
  const stillWorking: string[] = [];
  const gone = new Set<string>();
  for (const userId of looked) {
    const found = parseAccount(accounts.get(accountKey(userId)));
    if (found === null) {
      gone.add(userId);
      continue;
    }
    if (!force && found.retryAt > now) {
      stillWorking.push(userId);
      continue;
    }
    const grant = found.steamId === null ? undefined : vip.granted[found.steamId];
    const plan = planAccount(found, grant, now, rule);
    const cost = plan.add.length + plan.remove.length + plan.dms.length * 2;
    if (calls + cost > CALL_BUDGET) {
      stillWorking.push(userId);
      continue;
    }
    let account = plan.next;
    const added: RoleName[] = [];
    const removed: RoleName[] = [];
    let failed = false;
    let notMember = false;
    for (const [role, on] of [...plan.remove.map((r) => [r, false] as const), ...plan.add.map((r) => [r, true] as const)]) {
      const roleId = rule.roles[role];
      if (roleId === undefined || failed || notMember) continue;
      calls++;
      try {
        const done = await discord.setRole(userId, roleId, on);
        if (done === 'gone') {
          // Not in the server: nothing to give or take, until they sign in again.
          notMember = true;
        } else {
          (on ? added : removed).push(role);
        }
      } catch (error) {
        failed = true;
        deps.log.error(`Player account: ${on ? 'giving' : 'taking'} the ${role} role for ${userId} failed: ${errorText(error)}`);
      }
    }
    account = applied(account, added, removed);
    if (notMember) account = { ...account, member: false, memberAt: now, roles: { linked: false, vip: false } };
    if (failed) account = { ...account, retryAt: now + RETRY_MS };
    for (const kind of notMember ? [] : plan.dms) {
      calls += 2;
      try {
        const result = await discord.direct(userId, dmText(kind, account.notified?.expiresAt ?? null, rule));
        if (result === 'closed') {
          account = { ...account, dmClosed: true };
          deps.log.info(`Player account: ${userId} takes no private messages, so their VIP messages stop until they sign in again`);
          break;
        }
        deps.log.info(`Player account: sent ${userId} the ${kind} VIP message`);
      } catch (error) {
        deps.log.error(`Player account: the ${kind} VIP message to ${userId} failed: ${errorText(error)}`);
      }
    }
    await save(storage, userId, account, found.steamId);
    const working = notMember ? false : failed || planAccount(account, grant, now, rule).working;
    if (working) stillWorking.push(userId);
    else gone.add(userId);
  }
  const next = [...new Set([...candidates.slice(PER_PASS), ...stillWorking])].filter((id) => !gone.has(id));
  if (next.length !== work.length || next.some((id, i) => id !== work[i])) await storage.put({ [ACCOUNT_WORK_KEY]: next });
};

export type Growth = {
  accounts: number;
  linked: number;
  members: number;
  joinedOnSite: number;
  withVipRole: number;
};

// The numbers for the staff page: how many have signed in, linked a Steam account, are in the server, and joined with the
// website's button. Only counts; nothing about anyone.
export const growth = async (storage: BookStorage): Promise<Growth> => {
  const all = await storage.list({ prefix: ACCOUNT_PREFIX, limit: COUNTED });
  const counts: Growth = { accounts: 0, linked: 0, members: 0, joinedOnSite: 0, withVipRole: 0 };
  for (const value of all.values()) {
    const account = parseAccount(value);
    if (account === null) continue;
    counts.accounts++;
    if (account.steamId !== null) counts.linked++;
    if (account.member === true) counts.members++;
    if (account.joined === 'site') counts.joinedOnSite++;
    if (account.roles.vip) counts.withVipRole++;
  }
  return counts;
};
