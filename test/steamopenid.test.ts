import { describe, expect, it, vi } from 'vitest';
import { returnedTo, STEAM_OPENID, steamLoginUrl, verifySteamClaim } from '../src/steamopenid.ts';

const BOT = 'https://bot.example.workers.dev';
const RETURN = `${BOT}/auth/steam/callback?return=${encodeURIComponent('https://gaminginit.com/account')}`;
const STEAM = '76561198000000001';

const claimUrl = (over: Record<string, string> = {}): string => {
  const url = new URL(RETURN);
  for (const [key, value] of Object.entries({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'id_res',
    'openid.op_endpoint': STEAM_OPENID,
    'openid.claimed_id': `https://steamcommunity.com/openid/id/${STEAM}`,
    'openid.identity': `https://steamcommunity.com/openid/id/${STEAM}`,
    'openid.return_to': RETURN,
    'openid.response_nonce': '2026-10-17T12:00:00Zabc',
    'openid.assoc_handle': '1234',
    'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle',
    'openid.sig': 'c2ln',
    ...over,
  })) {
    url.searchParams.set(key, value);
  }
  return url.href;
};

describe('the Steam sign-in address', () => {
  it('asks Steam to return to the Worker and for any identity', () => {
    const url = new URL(steamLoginUrl(RETURN, BOT));
    expect(url.origin + url.pathname).toBe(STEAM_OPENID);
    expect(url.searchParams.get('openid.mode')).toBe('checkid_setup');
    expect(url.searchParams.get('openid.return_to')).toBe(RETURN);
    expect(url.searchParams.get('openid.realm')).toBe(BOT);
    expect(url.searchParams.get('openid.identity')).toBe('http://specs.openid.net/auth/2.0/identifier_select');
  });

  it('works out where the browser came back to, without what Steam added', () => {
    expect(returnedTo(claimUrl())).toBe(RETURN);
  });
});

describe('checking what Steam says', () => {
  const steamSays = (text: string, status = 200) => vi.fn(async () => new Response(text, { status }));

  it('gives the Steam ID when Steam confirms its own claim, sending everything back with the mode changed', async () => {
    const fetchFn = steamSays('ns:http://specs.openid.net/auth/2.0\nis_valid:true\n');

    await expect(verifySteamClaim(claimUrl(), fetchFn)).resolves.toBe(STEAM);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    const body = new URLSearchParams(String(init.body));
    expect(url).toBe(STEAM_OPENID);
    expect(init.method).toBe('POST');
    expect(body.get('openid.mode')).toBe('check_authentication');
    expect(body.get('openid.sig')).toBe('c2ln');
    expect(body.get('openid.signed')).toContain('claimed_id');
    // Only what Steam sent, nothing of the Worker's own query.
    expect([...body.keys()].every((key) => key.startsWith('openid.'))).toBe(true);
  });

  it('refuses a claim Steam says is not valid', async () => {
    await expect(verifySteamClaim(claimUrl(), steamSays('ns:http://specs.openid.net/auth/2.0\nis_valid:false\n'))).resolves.toBeNull();
  });

  it('refuses a claim made for another return address, from another provider, or for a made-up identity, without asking Steam', async () => {
    const fetchFn = steamSays('is_valid:true');
    await expect(verifySteamClaim(claimUrl({ 'openid.return_to': 'https://evil.example/' }), fetchFn)).resolves.toBeNull();
    await expect(verifySteamClaim(claimUrl({ 'openid.op_endpoint': 'https://evil.example/openid/login' }), fetchFn)).resolves.toBeNull();
    await expect(verifySteamClaim(claimUrl({ 'openid.claimed_id': 'https://evil.example/id/76561198000000001' }), fetchFn)).resolves.toBeNull();
    await expect(verifySteamClaim(claimUrl({ 'openid.identity': 'https://steamcommunity.com/openid/id/76561198000000002' }), fetchFn)).resolves.toBeNull();
    await expect(verifySteamClaim(claimUrl({ 'openid.mode': 'cancel' }), fetchFn)).resolves.toBeNull();
    await expect(verifySteamClaim(RETURN, fetchFn)).resolves.toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refuses a claim with a parameter given twice, which this and Steam would read differently', async () => {
    const fetchFn = steamSays('is_valid:true');
    // Another player's ID put first, in front of a real assertion for the Steam ID that follows.
    const victim = '76561198000000099';
    const doubled = new URL(claimUrl());
    const first = new URLSearchParams([
      ['openid.claimed_id', `https://steamcommunity.com/openid/id/${victim}`],
      ['openid.identity', `https://steamcommunity.com/openid/id/${victim}`],
    ]);
    doubled.search = `${first.toString()}&${doubled.searchParams.toString()}`;

    await expect(verifySteamClaim(doubled.href, fetchFn)).resolves.toBeNull();
    const twice = new URL(claimUrl());
    twice.searchParams.append('openid.sig', 'other');
    await expect(verifySteamClaim(twice.href, fetchFn)).resolves.toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('fails when Steam cannot be asked', async () => {
    await expect(verifySteamClaim(claimUrl(), steamSays('down', 503))).rejects.toThrow('Steam did not check the sign-in: 503');
  });
});
