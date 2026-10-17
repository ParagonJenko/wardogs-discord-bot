import { describe, expect, it } from 'vitest';
import {
  adopt,
  applied,
  dmText,
  linkSteam,
  parseAccount,
  planAccount,
  readAccountAction,
  readWebVote,
  signedIn,
  unlinkSteam,
  WARN_MS,
  type Account,
  type AccountRule,
} from '../src/accounts.ts';

const NOW = Date.UTC(2026, 9, 17, 12);
const DAY = 24 * 60 * 60_000;
const STEAM = '76561198000000001';
const rule: AccountRule = { roles: { linked: '900', vip: '901' }, messages: true, siteUrl: 'https://gaminginit.com', vip: { seedDays: 3, seedMinutes: 10, windowDays: 7, lengthDays: 7 } };

const fresh = (): Account => signedIn(null, { name: 'Sarge' }, { member: true, joined: false }, NOW);
const linked = (): Account => {
  const result = linkSteam(fresh(), '42', STEAM, 'discord', null, NOW);
  if ('problem' in result) throw new Error(result.problem);
  return result;
};

describe('signing in', () => {
  it('starts an account with VIP messages on, and keeps a Steam account across sign-ins', () => {
    const first = fresh();
    expect(first).toMatchObject({ name: 'Sarge', steamId: null, alerts: true, member: true, joined: null, roles: { linked: false, vip: false } });

    const again = signedIn(linked(), { name: 'Sergeant' }, { member: false, joined: false }, NOW + DAY);
    expect(again).toMatchObject({ name: 'Sergeant', steamId: STEAM, member: false, createdAt: NOW, signedInAt: NOW + DAY });
  });

  it('notes that they joined with the website, and does not forget it later', () => {
    const joined = signedIn(null, { name: 'Sarge' }, { member: true, joined: true }, NOW);
    expect(joined.joined).toBe('site');
    expect(signedIn(joined, { name: 'Sarge' }, { member: true, joined: false }, NOW + DAY).joined).toBe('site');
  });

  it('gives a closed message box and a failed role another chance', () => {
    const stuck = { ...linked(), dmClosed: true, retryAt: NOW + DAY };
    expect(signedIn(stuck, { name: 'Sarge' }, { member: true, joined: false }, NOW)).toMatchObject({ dmClosed: false, retryAt: 0 });
  });
});

describe('linking a Steam account', () => {
  it('links a Steam64 ID and replaces what was told about an earlier account', () => {
    const next = linkSteam({ ...linked(), notified: { grantedAt: 1, expiresAt: 2, warned: false, ended: false } }, '42', '76561198000000002', 'steam', null, NOW + 5);
    expect(next).toMatchObject({ steamId: '76561198000000002', via: 'steam', linkedAt: NOW + 5, notified: null });
  });

  it('keeps the account as it is when the same one is linked again', () => {
    const before = linked();
    expect(linkSteam(before, '42', STEAM, 'steam', null, NOW + 5)).toEqual({ ...before, via: 'steam' });
  });

  it('refuses what is not a Steam64 ID, and one a staff member has', () => {
    expect(linkSteam(fresh(), '42', 'myname', 'discord', null, NOW)).toEqual({ problem: 'not-a-steam-id' });
    expect(linkSteam(fresh(), '42', '12345678901234567', 'discord', null, NOW)).toEqual({ problem: 'not-a-steam-id' });
    expect(linkSteam(fresh(), '42', STEAM, 'discord', '77', NOW)).toEqual({ problem: 'steam-taken' });
    expect(linkSteam(fresh(), '42', STEAM, 'discord', '42', NOW)).toMatchObject({ steamId: STEAM });
  });

  it('unlinks, so nothing is told about it any more', () => {
    expect(unlinkSteam(linked())).toMatchObject({ steamId: null, via: null, linkedAt: null, notified: null });
  });
});

describe('the roles', () => {
  it('gives the linked role to a linked account and not to one without Steam', () => {
    expect(planAccount(fresh(), undefined, NOW, rule)).toMatchObject({ add: [], remove: [] });
    expect(planAccount(linked(), undefined, NOW, rule)).toMatchObject({ add: ['linked'], remove: [] });
  });

  it('gives the VIP role while they have VIP, and takes it back when it ends', () => {
    const grant = { grantedAt: NOW - DAY, expiresAt: NOW + 6 * DAY, source: 'seeding' as const };
    const withVip = adopt(applied(linked(), ['linked'], []), grant, NOW);

    expect(planAccount(withVip, grant, NOW, rule)).toMatchObject({ add: ['vip'], remove: [] });
    const roles = applied(withVip, ['vip'], []);
    expect(planAccount(roles, grant, NOW, rule).add).toEqual([]);
    expect(planAccount(roles, grant, NOW + 7 * DAY, rule)).toMatchObject({ remove: ['vip'] });
  });

  it('takes both roles off when the Steam account is unlinked', () => {
    const had = applied(linked(), ['linked', 'vip'], []);
    expect(planAccount(unlinkSteam(had), undefined, NOW, rule)).toMatchObject({ add: [], remove: ['linked', 'vip'] });
  });

  it('leaves out a role the server has no ID for', () => {
    const only = { ...rule, roles: { vip: '901' } };
    expect(planAccount(linked(), undefined, NOW, only)).toMatchObject({ add: [], remove: [] });
  });

  it('records only the roles that were changed', () => {
    const next = applied(linked(), ['linked'], []);
    expect(next.roles).toEqual({ linked: true, vip: false });
    expect(applied(next, ['vip'], ['linked']).roles).toEqual({ linked: false, vip: true });
  });
});

describe('the VIP messages', () => {
  const grant = { grantedAt: NOW, expiresAt: NOW + 7 * DAY, source: 'seeding' as const };

  it('tells them once when they earn it', () => {
    const plan = planAccount(linked(), grant, NOW, rule);
    expect(plan.dms).toEqual(['earned']);
    expect(plan.next.notified).toEqual({ grantedAt: NOW, expiresAt: NOW + 7 * DAY, warned: false, ended: false });
    expect(planAccount(plan.next, grant, NOW + 60_000, rule).dms).toEqual([]);
  });

  it('says staff gave it when staff did', () => {
    expect(planAccount(linked(), { ...grant, source: 'staff' }, NOW, rule).dms).toEqual(['staff']);
  });

  it('warns a day before it ends, once, and again for a longer end', () => {
    const earned = planAccount(linked(), grant, NOW, rule).next;
    const nearly = NOW + 7 * DAY - WARN_MS + 60_000;
    const warned = planAccount(earned, grant, nearly, rule);
    expect(warned.dms).toEqual(['expiring']);
    expect(planAccount(warned.next, grant, nearly + 60_000, rule).dms).toEqual([]);

    const longer = { ...grant, expiresAt: NOW + 14 * DAY };
    const extended = planAccount(warned.next, longer, nearly + 120_000, rule);
    expect(extended.dms).toEqual([]);
    expect(extended.next.notified).toMatchObject({ expiresAt: NOW + 14 * DAY, warned: false });
  });

  it('does not warn about a grant so short the warning would come straight after it', () => {
    const short = { grantedAt: NOW, expiresAt: NOW + 30 * 60_000 * 2, source: 'staff' as const };
    expect(planAccount(linked(), short, NOW, rule).dms).toEqual(['staff']);
  });

  it('says when it ended, once, and says nothing for VIP taken away early', () => {
    const earned = planAccount(linked(), grant, NOW, rule).next;
    const ended = planAccount(earned, grant, NOW + 7 * DAY, rule);
    expect(ended.dms).toEqual(['ended']);
    expect(planAccount(ended.next, undefined, NOW + 8 * DAY, rule).dms).toEqual([]);
    expect(ended.next.notified?.ended).toBe(true);

    const taken = planAccount(earned, undefined, NOW + 2 * DAY, rule);
    expect(taken.dms).toEqual([]);
    expect(taken.next.notified).toBeNull();
  });

  it('calls a new week that starts as the old one ends a renewal', () => {
    const earned = planAccount(linked(), grant, NOW, rule).next;
    const renewed = { grantedAt: NOW + 7 * DAY + 5 * 60_000, expiresAt: NOW + 14 * DAY + 5 * 60_000, source: 'seeding' as const };
    expect(planAccount(earned, renewed, NOW + 7 * DAY + 5 * 60_000, rule).dms).toEqual(['renewed']);
  });

  it('sends nothing to someone who turned the messages off, closed them, or is not in the server', () => {
    for (const change of [{ alerts: false }, { dmClosed: true }, { member: false }]) {
      const plan = planAccount({ ...linked(), ...change }, grant, NOW, rule);
      expect(plan.dms).toEqual([]);
      // What they would have been told is still recorded, so turning messages back on does not send old news.
      expect(plan.next.notified?.grantedAt).toBe(NOW);
    }
    expect(planAccount(linked(), grant, NOW, { ...rule, messages: false }).dms).toEqual([]);
  });

  it('does not announce a VIP they already had when they linked', () => {
    const had = { grantedAt: NOW - 2 * DAY, expiresAt: NOW + 5 * DAY, source: 'seeding' as const };
    const plan = planAccount(adopt(linked(), had, NOW), had, NOW, rule);
    expect(plan.dms).toEqual([]);
  });

  it('has work while VIP is on its way out, and none once it is over', () => {
    const earned = planAccount(applied(linked(), ['linked'], []), grant, NOW, rule);
    expect(earned.working).toBe(true);
    const ended = planAccount(applied(earned.next, ['vip'], ['linked']), undefined, NOW + 8 * DAY, rule).next;
    expect(planAccount(applied(ended, [], ['vip']), undefined, NOW + 9 * DAY, rule).working).toBe(true);
    expect(planAccount(applied(applied(ended, [], ['vip']), ['linked'], []), undefined, NOW + 9 * DAY, rule).working).toBe(false);
  });
});

describe('the messages', () => {
  it('words each one, with when it ends in Discord time and a way to turn them off', () => {
    const until = NOW + 7 * DAY;
    const unix = Math.floor(until / 1000);
    expect(dmText('earned', until, rule)).toContain(`<t:${unix}:f>`);
    expect(dmText('earned', until, rule)).toContain('Seed on 3 days in a week to keep it.');
    expect(dmText('expiring', until, rule)).toContain(`<t:${unix}:R>`);
    expect(dmText('expiring', until, rule)).toContain('https://gaminginit.com/seeding');
    expect(dmText('ended', until, rule)).toContain('has ended');
    expect(dmText('staff', until, rule)).toContain('Staff gave you');
    expect(dmText('renewed', until, rule)).toContain('renewed');
    expect(dmText('earned', until, rule)).toContain('Turn these messages off at https://gaminginit.com/account');
  });

  it('leaves out the links without a website and the advice without a VIP rule', () => {
    const bare = dmText('ended', null, { siteUrl: undefined, vip: null });
    expect(bare).toBe('Your VIP on the WARDOGS server has ended.');
  });
});

describe('parsing', () => {
  it('reads an account with the fields it has, and refuses nonsense', () => {
    expect(parseAccount({ name: 'x', createdAt: 1, signedInAt: 2 })).toMatchObject({ steamId: null, alerts: true, roles: { linked: false, vip: false } });
    expect(parseAccount({ name: 5 })).toBeNull();
    expect(parseAccount(null)).toBeNull();
  });

  it('reads the website’s requests, and refuses others', async () => {
    const post = (body: unknown) => new Request('https://x.test/api/account', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
    await expect(readAccountAction(post({ action: 'alerts', on: false }))).resolves.toEqual({ action: 'alerts', on: false });
    await expect(readAccountAction(post({ action: 'steam', proof: 'abc' }))).resolves.toEqual({ action: 'steam', proof: 'abc' });
    await expect(readAccountAction(post({ action: 'forget' }))).resolves.toEqual({ action: 'forget' });
    await expect(readAccountAction(post({ action: 'alerts', on: 'yes' }))).resolves.toBeNull();
    await expect(readAccountAction(post({ action: 'nope' }))).resolves.toBeNull();
    await expect(readAccountAction(post('not json'))).resolves.toBeNull();
    await expect(readAccountAction(post({ action: 'steam', proof: 'x'.repeat(5000) }))).resolves.toBeNull();
  });

  it('reads a vote for a map or for the conditions, not both and not neither', async () => {
    const post = (body: unknown) => new Request('https://x.test/api/account/vote', { method: 'POST', body: JSON.stringify(body) });
    await expect(readWebVote(post({ poll: '1759300000000', map: 'Foy' }))).resolves.toEqual({ poll: '1759300000000', map: 'Foy' });
    await expect(readWebVote(post({ poll: '1759300000000', light: 'night' }))).resolves.toEqual({ poll: '1759300000000', light: 'night' });
    await expect(readWebVote(post({ poll: '1759300000000', map: 'Foy', light: 'night' }))).resolves.toBeNull();
    await expect(readWebVote(post({ poll: '1759300000000' }))).resolves.toBeNull();
    await expect(readWebVote(post({ poll: 'abc', map: 'Foy' }))).resolves.toBeNull();
  });
});
