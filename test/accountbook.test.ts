import { describe, expect, it, vi } from 'vitest';
import {
  CALL_BUDGET,
  forget,
  growth,
  isMemberNow,
  linkedMembers,
  linkWithProof,
  PER_PASS,
  recordSignIn,
  setAlerts,
  setPrivate,
  syncAccounts,
  unlink,
  view,
  type BookDeps,
  type BookStorage,
  type Discord,
} from '../src/accountbook.ts';
import { ACCOUNT_WORK_KEY, accountKey, parseAccount, steamLinkKey, type AccountRule } from '../src/accounts.ts';
import type { VipState } from '../src/vip.ts';

const NOW = Date.UTC(2026, 9, 17, 12);
const DAY = 24 * 60 * 60_000;
const STEAM = '76561198000000001';
const OTHER_STEAM = '76561198000000002';
const ME = '100000000000000001';
const YOU = '100000000000000002';

const memory = (): BookStorage & { data: Map<string, unknown> } => {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (keys) => new Map(keys.flatMap((k) => (data.has(k) ? [[k, structuredClone(data.get(k))] as const] : []))),
    put: async (entries) => {
      for (const [k, v] of Object.entries(entries)) data.set(k, structuredClone(v));
    },
    delete: async (keys) => {
      for (const k of keys) data.delete(k);
    },
    list: async ({ prefix, limit }) =>
      new Map([...data].filter(([k]) => k.startsWith(prefix)).slice(0, limit ?? Infinity).map(([k, v]) => [k, structuredClone(v)] as const)),
  };
};

const pretend = (over: Partial<Discord> = {}): Discord & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    isMember: vi.fn(async () => true),
    setRole: vi.fn(async (user, role, on) => {
      calls.push(`${on ? 'give' : 'take'} ${role} ${user}`);
      return 'done' as const;
    }),
    direct: vi.fn(async (user, text) => {
      calls.push(`dm ${user}: ${text.slice(0, 30)}`);
      return 'sent' as const;
    }),
    ...over,
  };
};

const rule: AccountRule = { roles: { linked: '900', vip: '901' }, messages: true, siteUrl: 'https://gaminginit.com', vip: null };
const noVip: VipState = { granted: {}, checkedAt: 0, revoked: {}, staffSpots: {} };
const vipFor = (steamId: string, over = {}): VipState => ({
  ...noVip,
  granted: { [steamId]: { name: 'x', grantedAt: NOW - DAY, expiresAt: NOW + 6 * DAY, source: 'seeding', ...over } },
});
const log = { info: vi.fn(), error: vi.fn() };
const deps = (storage: BookStorage, discord: Discord | null = pretend(), now = NOW, over: Partial<BookDeps> = {}): BookDeps => ({
  storage,
  now,
  rule,
  discord,
  log,
  ...over,
});
const accountOf = (storage: ReturnType<typeof memory>, id: string) => parseAccount(storage.data.get(accountKey(id)));

describe('signing in', () => {
  it('makes an account, links the Steam account from Discord and puts them on the list to get their role', async () => {
    const storage = memory();
    const result = await recordSignIn(deps(storage), { id: ME, name: 'Sarge' }, { member: true, joined: false, steamId: STEAM }, noVip);

    expect(result).toEqual({ steam: 'linked' });
    expect(accountOf(storage, ME)).toMatchObject({ name: 'Sarge', steamId: STEAM, via: 'discord', member: true });
    expect(storage.data.get(steamLinkKey(STEAM))).toEqual({ u: ME, m: true });
    expect(storage.data.get(ACCOUNT_WORK_KEY)).toEqual([ME]);
  });

  it('makes an account without Steam when Discord has none to give', async () => {
    const storage = memory();
    await expect(recordSignIn(deps(storage), { id: ME, name: 'Sarge' }, { member: false, joined: false, steamId: null }, noVip)).resolves.toEqual({ steam: 'none' });
    expect(accountOf(storage, ME)).toMatchObject({ steamId: null, member: false });
  });

  it('gives the Steam account to whoever proves it now, and unlinks the one that had it', async () => {
    const storage = memory();
    await recordSignIn(deps(storage), { id: ME, name: 'Old account' }, { member: true, joined: false, steamId: STEAM }, noVip);
    await recordSignIn(deps(storage), { id: YOU, name: 'New account' }, { member: true, joined: false, steamId: STEAM }, noVip);

    expect(accountOf(storage, YOU)).toMatchObject({ steamId: STEAM });
    expect(accountOf(storage, ME)).toMatchObject({ steamId: null });
    expect(storage.data.get(steamLinkKey(STEAM))).toEqual({ u: YOU, m: true });
    expect(storage.data.get(ACCOUNT_WORK_KEY)).toEqual(expect.arrayContaining([ME, YOU]));
  });

  it('does not take a Steam account a staff member linked', async () => {
    const storage = memory();
    storage.data.set('staffProfiles', { [YOU]: { steamId: STEAM, name: 'Mod', at: 1 } });

    await expect(recordSignIn(deps(storage), { id: ME, name: 'Sarge' }, { member: true, joined: false, steamId: STEAM }, noVip)).resolves.toEqual({ steam: 'taken' });
    expect(accountOf(storage, ME)).toMatchObject({ steamId: null });
  });

  it('lets a staff member sign in with their own linked Steam account', async () => {
    const storage = memory();
    storage.data.set('staffProfiles', { [ME]: { steamId: STEAM, name: 'Mod', at: 1 } });

    await expect(recordSignIn(deps(storage), { id: ME, name: 'Mod' }, { member: true, joined: false, steamId: STEAM }, noVip)).resolves.toEqual({ steam: 'linked' });
  });

  it('does not announce VIP they already had when they linked', async () => {
    const storage = memory();
    const discord = pretend();
    await recordSignIn(deps(storage, discord), { id: ME, name: 'Sarge' }, { member: true, joined: false, steamId: STEAM }, vipFor(STEAM));
    await syncAccounts(deps(storage, discord), vipFor(STEAM), true);

    expect(discord.calls.filter((c) => c.startsWith('dm'))).toEqual([]);
    expect(discord.calls).toEqual(['give 900 ' + ME, 'give 901 ' + ME]);
  });
});

describe('linking with Steam', () => {
  it('links the account that signed in, or says there is none', async () => {
    const storage = memory();
    await expect(linkWithProof(deps(storage), ME, STEAM, noVip)).resolves.toEqual({ problem: 'no-account' });
    await recordSignIn(deps(storage), { id: ME, name: 'Sarge' }, { member: true, joined: false, steamId: null }, noVip);

    await expect(linkWithProof(deps(storage), ME, STEAM, noVip)).resolves.toEqual({ steamId: STEAM });
    expect(accountOf(storage, ME)).toMatchObject({ steamId: STEAM, via: 'steam' });
  });

  it('forgets the Steam account it had before, so it is free for another player', async () => {
    const storage = memory();
    await recordSignIn(deps(storage), { id: ME, name: 'Sarge' }, { member: true, joined: false, steamId: STEAM }, noVip);
    await linkWithProof(deps(storage), ME, OTHER_STEAM, noVip);

    expect(storage.data.has(steamLinkKey(STEAM))).toBe(false);
    expect(storage.data.get(steamLinkKey(OTHER_STEAM))).toEqual({ u: ME, m: true });
  });
});

describe('the account page', () => {
  const show = (storage: BookStorage, userId = ME, vip = noVip, discord: Discord | null = pretend(), now = NOW) =>
    view({ ...deps(storage, discord, now), canJoin: true, playerPage: async () => 'abc123abc123', ballotOf: async () => null }, userId, vip);

  it('shows what linking gives, their VIP and where their player page is', async () => {
    const storage = memory();
    await recordSignIn(deps(storage), { id: ME, name: 'Sarge' }, { member: true, joined: false, steamId: STEAM }, noVip);

    await expect(show(storage, ME, vipFor(STEAM))).resolves.toEqual({
      user: { id: ME, name: 'Sarge' },
      member: true,
      steam: { linked: true, via: 'discord' },
      playerId: 'abc123abc123',
      vip: { until: NOW + 6 * DAY, source: 'seeding' },
      alerts: true,
      private: { on: false, byYou: false },
      ballot: null,
      perks: { role: true, vipRole: true, messages: true, join: true },
    });
  });

  it('has no page or VIP without a Steam account, and none for an account that does not exist', async () => {
    const storage = memory();
    await recordSignIn(deps(storage), { id: ME, name: 'Sarge' }, { member: false, joined: false, steamId: null }, noVip);

    await expect(show(storage)).resolves.toMatchObject({ steam: { linked: false, via: null }, playerId: null, vip: null, member: false });
    await expect(show(storage, YOU)).resolves.toBeNull();
  });

  it('asks Discord again whether they are in the server once the last answer is old', async () => {
    const storage = memory();
    await recordSignIn(deps(storage), { id: ME, name: 'Sarge' }, { member: false, joined: false, steamId: STEAM }, noVip);
    const discord = pretend({ isMember: vi.fn(async () => true) });

    await expect(show(storage, ME, noVip, discord, NOW + 60_000)).resolves.toMatchObject({ member: false });
    expect(discord.isMember).not.toHaveBeenCalled();
    await expect(show(storage, ME, noVip, discord, NOW + 10 * 60_000)).resolves.toMatchObject({ member: true });
    expect(storage.data.get(steamLinkKey(STEAM))).toEqual({ u: ME, m: true });
  });

  it('keeps the last answer when Discord cannot say', async () => {
    const storage = memory();
    await recordSignIn(deps(storage), { id: ME, name: 'Sarge' }, { member: true, joined: false, steamId: null }, noVip);
    const discord = pretend({ isMember: vi.fn(async () => { throw new Error('down'); }) });

    await expect(show(storage, ME, noVip, discord, NOW + 10 * 60_000)).resolves.toMatchObject({ member: true });
  });

  it('shows no perks of a bot that is not set up', async () => {
    const storage = memory();
    await recordSignIn(deps(storage, null), { id: ME, name: 'Sarge' }, { member: true, joined: false, steamId: null }, noVip);
    const shown = await view(
      { ...deps(storage, null, NOW, { rule: { ...rule, messages: false } }), canJoin: false, playerPage: async () => null, ballotOf: async () => null },
      ME,
      noVip,
    );

    expect(shown?.perks).toEqual({ role: false, vipRole: false, messages: false, join: false });
  });
});

describe('what a player can change', () => {
  it('turns the messages on and off', async () => {
    const storage = memory();
    await recordSignIn(deps(storage), { id: ME, name: 'Sarge' }, { member: true, joined: false, steamId: STEAM }, noVip);

    await expect(setAlerts(deps(storage), ME, false)).resolves.toEqual({ ok: true });
    expect(accountOf(storage, ME)?.alerts).toBe(false);
    await expect(setAlerts(deps(storage), YOU, false)).resolves.toEqual({ problem: 'Sign in again.' });
  });

  it('unlinks and frees the Steam account, and queues the roles to be taken back', async () => {
    const storage = memory();
    await recordSignIn(deps(storage), { id: ME, name: 'Sarge' }, { member: true, joined: false, steamId: STEAM }, noVip);
    await unlink(deps(storage), ME);

    expect(accountOf(storage, ME)).toMatchObject({ steamId: null });
    expect(storage.data.has(steamLinkKey(STEAM))).toBe(false);
  });

  it('makes their profile private and public again, but not one staff made private', async () => {
    const storage = memory();
    await recordSignIn(deps(storage), { id: ME, name: 'Sarge' }, { member: true, joined: false, steamId: STEAM }, noVip);
    const name = async () => 'InGameName';

    await expect(setPrivate(deps(storage), ME, true, name)).resolves.toEqual({ ok: true });
    expect(storage.data.get('privateProfiles')).toMatchObject({ [STEAM]: { name: 'InGameName', by: ME, byName: 'Sarge' } });
    await expect(setPrivate(deps(storage), ME, false, name)).resolves.toEqual({ ok: true });
    expect(storage.data.get('privateProfiles')).toEqual({});

    storage.data.set('privateProfiles', { [STEAM]: { name: 'InGameName', at: 1, by: YOU } });
    await expect(setPrivate(deps(storage), ME, false, name)).resolves.toEqual({
      problem: 'Staff made this profile private. Ask them in Discord to change it.',
    });
    expect(storage.data.get('privateProfiles')).toMatchObject({ [STEAM]: { by: YOU } });
  });

  it('needs a Steam account to make a profile private', async () => {
    const storage = memory();
    await recordSignIn(deps(storage), { id: ME, name: 'Sarge' }, { member: true, joined: false, steamId: null }, noVip);
    await expect(setPrivate(deps(storage), ME, true, async () => null)).resolves.toEqual({ problem: 'Link your Steam account first.' });
  });

  it('forgets an account: takes the roles the bot gave and removes every trace', async () => {
    const storage = memory();
    const discord = pretend();
    await recordSignIn(deps(storage, discord), { id: ME, name: 'Sarge' }, { member: true, joined: false, steamId: STEAM }, noVip);
    await syncAccounts(deps(storage, discord), noVip, true);
    discord.calls.length = 0;

    await expect(forget(deps(storage, discord), ME)).resolves.toEqual({ ok: true });
    expect(discord.calls).toEqual([`take 900 ${ME}`]);
    expect(storage.data.has(accountKey(ME))).toBe(false);
    expect(storage.data.has(steamLinkKey(STEAM))).toBe(false);
    expect(storage.data.get(ACCOUNT_WORK_KEY)).toEqual([]);
  });
});

describe('the roles and messages pass', () => {
  it('gives the linked role once, then has nothing more to do', async () => {
    const storage = memory();
    const discord = pretend();
    await recordSignIn(deps(storage, discord), { id: ME, name: 'Sarge' }, { member: true, joined: false, steamId: STEAM }, noVip);

    await syncAccounts(deps(storage, discord), noVip, true);
    expect(discord.calls).toEqual([`give 900 ${ME}`]);
    expect(accountOf(storage, ME)?.roles).toEqual({ linked: true, vip: false });
    expect(storage.data.get(ACCOUNT_WORK_KEY)).toEqual([]);

    await syncAccounts(deps(storage, discord), noVip, true);
    expect(discord.calls).toHaveLength(1);
  });

  it('finds a new VIP through the Steam link, gives the role and sends the message', async () => {
    const storage = memory();
    const discord = pretend();
    await recordSignIn(deps(storage, discord), { id: ME, name: 'Sarge' }, { member: true, joined: false, steamId: STEAM }, noVip);
    await syncAccounts(deps(storage, discord), noVip, true);
    discord.calls.length = 0;

    await syncAccounts(deps(storage, discord, NOW + 60_000), vipFor(STEAM, { grantedAt: NOW + 30_000, expiresAt: NOW + 7 * DAY }), false);
    expect(discord.calls).toEqual([`give 901 ${ME}`, `dm ${ME}: You earned **seeder VIP** on t`]);
    expect(accountOf(storage, ME)).toMatchObject({ roles: { linked: true, vip: true }, notified: { warned: false, ended: false } });
    expect(storage.data.get(ACCOUNT_WORK_KEY)).toEqual([ME]);
  });

  it('takes the VIP role back and says it ended when the time is up', async () => {
    const storage = memory();
    const discord = pretend();
    const grant = vipFor(STEAM, { grantedAt: NOW, expiresAt: NOW + 7 * DAY });
    await recordSignIn(deps(storage, discord), { id: ME, name: 'Sarge' }, { member: true, joined: false, steamId: STEAM }, noVip);
    await syncAccounts(deps(storage, discord, NOW + 1000), grant, true);
    discord.calls.length = 0;

    await syncAccounts(deps(storage, discord, NOW + 7 * DAY + 1), grant, true);
    expect(discord.calls).toEqual([`take 901 ${ME}`, `dm ${ME}: Your VIP on the WARDOGS server`]);
    expect(accountOf(storage, ME)?.roles).toEqual({ linked: true, vip: false });
    expect(storage.data.get(ACCOUNT_WORK_KEY)).toEqual([]);
  });

  it('tries a failed role again later, not at every check', async () => {
    const storage = memory();
    const failing = pretend({ setRole: vi.fn(async () => { throw new Error('Missing Permissions'); }) });
    await recordSignIn(deps(storage, failing), { id: ME, name: 'Sarge' }, { member: true, joined: false, steamId: STEAM }, noVip);

    await syncAccounts(deps(storage, failing), noVip, true);
    expect(accountOf(storage, ME)).toMatchObject({ roles: { linked: false }, retryAt: NOW + 15 * 60_000 });
    expect(storage.data.get(ACCOUNT_WORK_KEY)).toEqual([ME]);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Missing Permissions'));

    await syncAccounts(deps(storage, failing, NOW + 60_000), noVip, false);
    expect(failing.setRole).toHaveBeenCalledTimes(1);

    const working = pretend();
    await syncAccounts(deps(storage, working, NOW + 16 * 60_000), noVip, false);
    expect(working.calls).toEqual([`give 900 ${ME}`]);
  });

  it('stops for someone who is not in the server, until they sign in again', async () => {
    const storage = memory();
    const gone = pretend({ setRole: vi.fn(async () => 'gone' as const) });
    await recordSignIn(deps(storage, gone), { id: ME, name: 'Sarge' }, { member: true, joined: false, steamId: STEAM }, vipFor(STEAM));

    await syncAccounts(deps(storage, gone), vipFor(STEAM), true);
    expect(accountOf(storage, ME)).toMatchObject({ member: false });
    expect(storage.data.get(steamLinkKey(STEAM))).toEqual({ u: ME, m: false });
    expect(storage.data.get(ACCOUNT_WORK_KEY)).toEqual([]);
    expect(gone.direct).not.toHaveBeenCalled();
  });

  it('stops messaging someone whose private messages are closed', async () => {
    const storage = memory();
    const closed = pretend({ direct: vi.fn(async () => 'closed' as const) });
    await recordSignIn(deps(storage, closed), { id: ME, name: 'Sarge' }, { member: true, joined: false, steamId: STEAM }, noVip);
    await syncAccounts(deps(storage, closed), vipFor(STEAM, { grantedAt: NOW + 1 }), true);

    expect(accountOf(storage, ME)).toMatchObject({ dmClosed: true });
    await syncAccounts(deps(storage, closed, NOW + 60_000), vipFor(STEAM, { grantedAt: NOW + 2 }), true);
    expect(closed.direct).toHaveBeenCalledTimes(1);
  });

  it('does a message that failed once, and does not send it again', async () => {
    const storage = memory();
    const flaky = pretend({ direct: vi.fn(async () => { throw new Error('Discord down'); }) });
    await recordSignIn(deps(storage, flaky), { id: ME, name: 'Sarge' }, { member: true, joined: false, steamId: STEAM }, noVip);
    await syncAccounts(deps(storage, flaky), vipFor(STEAM, { grantedAt: NOW + 1 }), true);
    await syncAccounts(deps(storage, flaky, NOW + 60_000), vipFor(STEAM, { grantedAt: NOW + 1 }), true);

    expect(flaky.direct).toHaveBeenCalledTimes(1);
  });

  it('does nothing without a bot', async () => {
    const storage = memory();
    await recordSignIn(deps(storage, null), { id: ME, name: 'Sarge' }, { member: true, joined: false, steamId: STEAM }, noVip);
    await syncAccounts(deps(storage, null), vipFor(STEAM), true);
    expect(accountOf(storage, ME)?.roles).toEqual({ linked: false, vip: false });
    expect(storage.data.get(ACCOUNT_WORK_KEY)).toEqual([ME]);
  });

  it('looks at some accounts a pass and leaves the rest for the next', async () => {
    const storage = memory();
    const discord = pretend();
    const ids = Array.from({ length: PER_PASS + 5 }, (_, i) => String(200000000000000000n + BigInt(i)));
    for (const [i, id] of ids.entries()) {
      await recordSignIn(deps(storage, discord), { id, name: `p${i}` }, { member: true, joined: false, steamId: `7656119800000${String(1000 + i)}` }, noVip);
    }

    await syncAccounts(deps(storage, discord), noVip, true);
    expect(discord.calls).toHaveLength(PER_PASS);
    expect(storage.data.get(ACCOUNT_WORK_KEY)).toHaveLength(5);
    await syncAccounts(deps(storage, discord), noVip, true);
    expect(discord.calls).toHaveLength(PER_PASS + 5);
    expect(storage.data.get(ACCOUNT_WORK_KEY)).toEqual([]);
  });

  it('keeps within the number of calls to Discord a pass may make', async () => {
    expect(CALL_BUDGET).toBeGreaterThanOrEqual(PER_PASS);
  });
});

describe('who is in the server and linked', () => {
  it('lists the Steam accounts of linked members only', async () => {
    const storage = memory();
    await recordSignIn(deps(storage), { id: ME, name: 'In' }, { member: true, joined: false, steamId: STEAM }, noVip);
    await recordSignIn(deps(storage), { id: YOU, name: 'Out' }, { member: false, joined: false, steamId: OTHER_STEAM }, noVip);

    await expect(linkedMembers(storage)).resolves.toEqual(new Set([STEAM]));
  });
});

describe('voting on the website', () => {
  it('lets in members, checks again when the last answer is old, and keeps out others', async () => {
    const storage = memory();
    await recordSignIn(deps(storage), { id: ME, name: 'In' }, { member: true, joined: false, steamId: null }, noVip);
    await recordSignIn(deps(storage), { id: YOU, name: 'Out' }, { member: false, joined: false, steamId: null }, noVip);

    await expect(isMemberNow(deps(storage), ME)).resolves.toBe(true);
    await expect(isMemberNow(deps(storage), YOU)).resolves.toBe(true);
    await expect(isMemberNow(deps(storage, pretend({ isMember: vi.fn(async () => false) }), NOW + DAY), ME)).resolves.toBe(false);
    await expect(isMemberNow(deps(storage), '999999999999999999')).resolves.toBe(false);
  });

  it('goes by the last answer without a bot', async () => {
    const storage = memory();
    await recordSignIn(deps(storage, null), { id: ME, name: 'In' }, { member: true, joined: false, steamId: null }, noVip);
    await expect(isMemberNow(deps(storage, null, NOW + DAY), ME)).resolves.toBe(true);
  });
});

describe('the staff numbers', () => {
  it('counts accounts, never names them', async () => {
    const storage = memory();
    await recordSignIn(deps(storage), { id: ME, name: 'A' }, { member: true, joined: true, steamId: STEAM }, noVip);
    await recordSignIn(deps(storage), { id: YOU, name: 'B' }, { member: false, joined: false, steamId: null }, noVip);

    await expect(growth(storage)).resolves.toEqual({ accounts: 2, linked: 1, members: 1, joinedOnSite: 1, withVipRole: 0 });
  });
});

describe('what the review asked for', () => {
  it('does not let a claim take a Steam account a staff member has, even when they also signed in as a player', async () => {
    const storage = memory();
    storage.data.set('staffProfiles', { [ME]: { steamId: STEAM, name: 'Mod', at: 1 } });
    await recordSignIn(deps(storage), { id: ME, name: 'Mod' }, { member: true, joined: false, steamId: STEAM }, noVip);
    expect(storage.data.get(steamLinkKey(STEAM))).toEqual({ u: ME, m: true });

    await expect(recordSignIn(deps(storage), { id: YOU, name: 'Other' }, { member: true, joined: false, steamId: STEAM }, noVip)).resolves.toEqual({
      steam: 'taken',
    });
    await expect(linkWithProof(deps(storage), YOU, STEAM, noVip)).resolves.toEqual({ problem: 'steam-taken' });
    expect(accountOf(storage, ME)).toMatchObject({ steamId: STEAM });
  });

  it('keeps a Steam account linked with Steam when the Discord profile has another, and still follows Discord when it came from there', async () => {
    const storage = memory();
    await recordSignIn(deps(storage), { id: ME, name: 'Sarge' }, { member: true, joined: false, steamId: null }, noVip);
    await linkWithProof(deps(storage), ME, OTHER_STEAM, noVip);

    await recordSignIn(deps(storage), { id: ME, name: 'Sarge' }, { member: true, joined: false, steamId: STEAM }, noVip);
    expect(accountOf(storage, ME)).toMatchObject({ steamId: OTHER_STEAM, via: 'steam' });
    expect(storage.data.get(steamLinkKey(OTHER_STEAM))).toEqual({ u: ME, m: true });

    // From Discord before: a changed connection is followed.
    const again = memory();
    await recordSignIn(deps(again), { id: ME, name: 'Sarge' }, { member: true, joined: false, steamId: STEAM }, noVip);
    await recordSignIn(deps(again), { id: ME, name: 'Sarge' }, { member: true, joined: false, steamId: OTHER_STEAM }, noVip);
    expect(accountOf(again, ME)).toMatchObject({ steamId: OTHER_STEAM, via: 'discord' });
    expect(again.data.has(steamLinkKey(STEAM))).toBe(false);
  });

  it('takes the roles Discord says they have, so a member who left and came back is given them again', async () => {
    const storage = memory();
    const discord = pretend();
    await recordSignIn(deps(storage, discord), { id: ME, name: 'Sarge' }, { member: true, joined: false, steamId: STEAM, roles: [] }, noVip);
    await syncAccounts(deps(storage, discord), noVip, true);
    expect(accountOf(storage, ME)?.roles).toEqual({ linked: true, vip: false });
    discord.calls.length = 0;

    // They left (Discord took the roles) and joined with the website's button: no roles.
    await recordSignIn(deps(storage, discord), { id: ME, name: 'Sarge' }, { member: true, joined: true, steamId: STEAM, roles: [] }, noVip);
    expect(accountOf(storage, ME)?.roles).toEqual({ linked: false, vip: false });
    await syncAccounts(deps(storage, discord), noVip, true);
    expect(discord.calls).toEqual([`give 900 ${ME}`]);

    // Not in the server: none. In it with one of them: that one.
    await recordSignIn(deps(storage, discord), { id: ME, name: 'Sarge' }, { member: false, joined: false, steamId: STEAM, roles: null }, noVip);
    expect(accountOf(storage, ME)?.roles).toEqual({ linked: false, vip: false });
    await recordSignIn(deps(storage, discord), { id: ME, name: 'Sarge' }, { member: true, joined: false, steamId: STEAM, roles: ['900'] }, noVip);
    expect(accountOf(storage, ME)?.roles).toEqual({ linked: true, vip: false });
    // A role the server has no ID for is left as the bot had it.
    const noVipRole = { ...deps(storage, discord), rule: { ...rule, roles: { linked: '900' } } };
    await recordSignIn(noVipRole, { id: ME, name: 'Sarge' }, { member: true, joined: false, steamId: STEAM, roles: [] }, noVip);
    expect(accountOf(storage, ME)?.roles).toEqual({ linked: false, vip: false });
  });

  it('keeps an account whose roles could not be taken, and says so', async () => {
    const storage = memory();
    const discord = pretend();
    await recordSignIn(deps(storage, discord), { id: ME, name: 'Sarge' }, { member: true, joined: false, steamId: STEAM }, noVip);
    await syncAccounts(deps(storage, discord), noVip, true);
    const failing = pretend({ setRole: vi.fn(async () => { throw new Error('Missing Permissions'); }) });

    await expect(forget(deps(storage, failing), ME)).resolves.toEqual({
      problem: "Couldn't take your Discord roles just now, so nothing was deleted. Try again in a minute.",
    });
    expect(accountOf(storage, ME)).toMatchObject({ steamId: STEAM, roles: { linked: true } });
    expect(storage.data.get(steamLinkKey(STEAM))).toEqual({ u: ME, m: true });

    await expect(forget(deps(storage, discord), ME)).resolves.toEqual({ ok: true });
    expect(storage.data.has(accountKey(ME))).toBe(false);
  });

  it('does not ask Discord about someone it knows is not in the server, every pass', async () => {
    const storage = memory();
    const gone = pretend({ setRole: vi.fn(async () => 'gone' as const) });
    await recordSignIn(deps(storage, gone), { id: ME, name: 'Sarge' }, { member: true, joined: false, steamId: STEAM }, vipFor(STEAM));
    await syncAccounts(deps(storage, gone), vipFor(STEAM), true);
    expect(gone.setRole).toHaveBeenCalledTimes(1);

    await syncAccounts(deps(storage, gone, NOW + 5 * 60_000), vipFor(STEAM), false);
    await syncAccounts(deps(storage, gone, NOW + 10 * 60_000), vipFor(STEAM), false);
    expect(gone.setRole).toHaveBeenCalledTimes(1);
  });

  it('gets to every account in turn, even when more than a pass can look at keep needing work', async () => {
    const storage = memory();
    const discord = pretend();
    const count = PER_PASS * 2 + 3;
    const ids = Array.from({ length: count }, (_, i) => String(300000000000000000n + BigInt(i)));
    const granted: VipState['granted'] = {};
    for (const [i, id] of ids.entries()) {
      const steamId = `7656119800001${String(1000 + i)}`;
      granted[steamId] = { name: `p${i}`, grantedAt: NOW - DAY, expiresAt: NOW + 6 * DAY, source: 'seeding' };
      await recordSignIn(deps(storage, discord), { id, name: `p${i}` }, { member: true, joined: false, steamId }, { ...noVip, granted });
    }
    const vip = { ...noVip, granted };
    const seen = new Set<string>();
    // Every one of them has VIP that runs for days, so they all stay "working": each still has to be looked at.
    for (let pass = 0; pass < 4; pass++) {
      const before = discord.calls.length;
      await syncAccounts(deps(storage, discord, NOW + pass * 60_000), vip, true);
      for (const call of discord.calls.slice(before)) seen.add(call.split(' ')[2] ?? '');
    }
    expect(seen.size).toBe(count);
    // And the ones with nothing more to give them (all of it applied) do not take places from new ones.
    const late = String(399999999999999999n);
    const lateSteam = '76561198000099999';
    const withLate = { ...vip, granted: { ...granted, [lateSteam]: { name: 'late', grantedAt: NOW, expiresAt: NOW + 7 * DAY, source: 'seeding' as const } } };
    await recordSignIn(deps(storage, discord), { id: late, name: 'late' }, { member: true, joined: false, steamId: lateSteam }, withLate);
    discord.calls.length = 0;
    for (let pass = 0; pass < 4; pass++) await syncAccounts(deps(storage, discord, NOW + (10 + pass) * 60_000), withLate, true);
    expect(discord.calls.some((c) => c.includes(late))).toBe(true);
  });

  it('remembers a membership answer even when it has not changed, so votes do not each ask Discord', async () => {
    const storage = memory();
    const discord = pretend({ isMember: vi.fn(async () => true) });
    await recordSignIn(deps(storage, discord), { id: ME, name: 'In' }, { member: true, joined: false, steamId: null }, noVip);

    await expect(isMemberNow(deps(storage, discord, NOW + 10 * 60_000), ME)).resolves.toBe(true);
    await expect(isMemberNow(deps(storage, discord, NOW + 11 * 60_000), ME)).resolves.toBe(true);
    await expect(isMemberNow(deps(storage, discord, NOW + 12 * 60_000), ME)).resolves.toBe(true);
    expect(discord.isMember).toHaveBeenCalledTimes(1);
    expect(accountOf(storage, ME)?.memberAt).toBe(NOW + 10 * 60_000);

    // When Discord cannot say, the last answer stands and the time is kept, so the next vote asks again.
    const down = pretend({ isMember: vi.fn(async () => { throw new Error('down'); }) });
    await expect(isMemberNow(deps(storage, down, NOW + DAY), ME)).resolves.toBe(true);
    expect(accountOf(storage, ME)?.memberAt).toBe(NOW + 10 * 60_000);
  });

  it('lets whoever now owns the Steam account undo a profile the player made private, but not a staff one', async () => {
    const storage = memory();
    const name = async () => 'InGameName';
    await recordSignIn(deps(storage), { id: ME, name: 'Old account' }, { member: true, joined: false, steamId: STEAM }, noVip);
    await setPrivate(deps(storage), ME, true, name);
    // They lost the account and prove the Steam account from a new one.
    await recordSignIn(deps(storage), { id: YOU, name: 'New account' }, { member: true, joined: false, steamId: STEAM }, noVip);

    const shown = await view({ ...deps(storage), canJoin: false, playerPage: async () => null, ballotOf: async () => null }, YOU, noVip);
    expect(shown?.private).toEqual({ on: true, byYou: true });
    await expect(setPrivate(deps(storage), YOU, false, name)).resolves.toEqual({ ok: true });
    expect(storage.data.get('privateProfiles')).toEqual({});

    storage.data.set('privateProfiles', { [STEAM]: { name: 'InGameName', at: 1, by: ME } });
    await expect(setPrivate(deps(storage), YOU, false, name)).resolves.toEqual({
      problem: 'Staff made this profile private. Ask them in Discord to change it.',
    });
  });
});
