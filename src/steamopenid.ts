// Proving a player owns a Steam account with Steam's own sign-in (OpenID 2.0), for those with no Steam account on their
// Discord profile. No API key is needed. The player goes to Steam, signs in there (the bot never sees a password), and
// Steam sends the browser back to the Worker with a signed claim of their Steam ID. The Worker does not trust the claim
// from the browser: it sends it back to Steam to check (check_authentication), and only a "is_valid:true" counts.

export const STEAM_OPENID = 'https://steamcommunity.com/openid/login';
const IDENTIFIER_SELECT = 'http://specs.openid.net/auth/2.0/identifier_select';
const CLAIMED = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;

// Where to send the browser: Steam asks them to sign in, then returns to `returnTo`.
export const steamLoginUrl = (returnTo: string, realm: string): string => {
  const url = new URL(STEAM_OPENID);
  url.search = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnTo,
    'openid.realm': realm,
    'openid.identity': IDENTIFIER_SELECT,
    'openid.claimed_id': IDENTIFIER_SELECT,
  }).toString();
  return url.href;
};

// The address the browser came back to, without what Steam added: it must be what the Worker asked to be returned to.
export const returnedTo = (requestUrl: string): string => {
  const url = new URL(requestUrl);
  for (const key of [...url.searchParams.keys()]) if (key.startsWith('openid.')) url.searchParams.delete(key);
  return url.href;
};

// The Steam ID Steam vouches for, or null when the claim is not Steam's, not for this return address, or not valid.
export const verifySteamClaim = async (requestUrl: string, fetchFn: typeof fetch = fetch): Promise<string | null> => {
  const url = new URL(requestUrl);
  const claim = url.searchParams;
  // A parameter given twice is read one way here and another by Steam (the first, the last): someone could put another
  // player's ID first and have Steam confirm the real one. Steam never sends one twice, so such a claim is refused.
  const names = [...claim.keys()].filter((key) => key.startsWith('openid.'));
  if (new Set(names).size !== names.length) return null;
  if (claim.get('openid.mode') !== 'id_res' || claim.get('openid.op_endpoint') !== STEAM_OPENID) return null;
  if (claim.get('openid.return_to') !== returnedTo(requestUrl)) return null;
  const claimed = claim.get('openid.claimed_id') ?? '';
  const steamId = CLAIMED.exec(claimed)?.[1];
  if (steamId === undefined || claim.get('openid.identity') !== claimed) return null;
  // Everything Steam signed goes back to it, with the mode changed.
  const body = new URLSearchParams();
  for (const [key, value] of claim) if (key.startsWith('openid.')) body.set(key, value);
  body.set('openid.mode', 'check_authentication');
  const response = await fetchFn(STEAM_OPENID, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Steam did not check the sign-in: ${response.status}`);
  return /^is_valid:true\s*$/m.test(await response.text()) ? steamId : null;
};
