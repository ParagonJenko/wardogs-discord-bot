import { describe, expect, it, vi } from 'vitest';
import {
  agoText,
  alertDue,
  assess,
  checksDue,
  fetchSteamChecks,
  parseSteamCheck,
  RECHECK_MS,
  riskOf,
  STEAM_BATCH,
  steamFacts,
  steamFlags,
  steamKey,
  steamScore,
  type SteamCheck,
} from '../src/steam.ts';

const NOW = Date.UTC(2026, 9, 3, 20);
const DAY = 24 * 60 * 60_000;
const ASH = '76561198000000001';
const BO = '76561198000000002';
const KEY = '0123456789ABCDEF0123456789ABCDEF';

// An old, public, set-up account with no bans.
const clean = (overrides: Partial<SteamCheck> = {}): SteamCheck => ({
  at: NOW,
  found: true,
  vacBans: 0,
  gameBans: 0,
  lastBanAt: null,
  communityBanned: false,
  tradeBan: 'none',
  public: true,
  setUp: true,
  createdAt: NOW - 9 * 365 * DAY,
  ...overrides,
});

describe('scoring an account', () => {
  it('finds nothing risky in an old public account without bans', () => {
    expect(assess(clean(), NOW)).toEqual({ flags: [], score: 0, risk: 'low' });
  });

  it('flags bans, with a recent one apart', () => {
    expect(steamFlags(clean({ vacBans: 2, lastBanAt: NOW - 800 * DAY }), NOW)).toEqual(['vacBan']);
    expect(steamFlags(clean({ gameBans: 1, lastBanAt: NOW - 40 * DAY }), NOW)).toEqual(['gameBan', 'recentBan']);
    expect(steamFlags(clean({ communityBanned: true, tradeBan: 'banned' }), NOW)).toEqual(['communityBan', 'tradeBan']);
    expect(steamFlags(clean({ tradeBan: 'probation' }), NOW)).toEqual([]);
  });

  it('flags a new account, or else a young one, and a profile that shows nothing', () => {
    expect(steamFlags(clean({ createdAt: NOW - 12 * DAY }), NOW)).toEqual(['newAccount']);
    expect(steamFlags(clean({ createdAt: NOW - 100 * DAY }), NOW)).toEqual(['youngAccount']);
    expect(steamFlags(clean({ public: false, createdAt: null }), NOW)).toEqual(['hidden']);
    expect(steamFlags(clean({ setUp: false }), NOW)).toEqual(['hidden']);
  });

  it('adds up the points: 4 or more is high risk, 2 or more worth a look', () => {
    expect(steamScore(['vacBan', 'recentBan'])).toBe(4);
    expect(riskOf(4)).toBe('high');
    expect(riskOf(3)).toBe('medium');
    expect(riskOf(2)).toBe('medium');
    expect(riskOf(1)).toBe('low');
    // An old VAC ban alone is worth a look; hidden as well, it is high risk.
    expect(assess(clean({ vacBans: 1, lastBanAt: NOW - 3 * 365 * DAY }), NOW).risk).toBe('medium');
    expect(assess(clean({ vacBans: 1, lastBanAt: NOW - 3 * 365 * DAY, public: false, createdAt: null }), NOW).risk).toBe('high');
    // A brand new account that hides itself.
    expect(assess(clean({ createdAt: NOW - 3 * DAY, setUp: false }), NOW)).toEqual({ flags: ['newAccount', 'hidden'], score: 4, risk: 'high' });
    // Private and never set up is common, so alone it is not worth a look.
    expect(assess(clean({ public: false, setUp: false, createdAt: null }), NOW).risk).toBe('low');
  });

  it('scores an account as it is now: it ages, and a ban stops being recent', () => {
    const check = clean({ createdAt: NOW - 25 * DAY, public: false, lastBanAt: null });
    expect(assess(check, NOW).risk).toBe('high');
    expect(assess(check, NOW + 10 * DAY).flags).toEqual(['youngAccount', 'hidden']);
  });

  it('never flags an account Steam does not know', () => {
    expect(assess(clean({ found: false, public: false, setUp: false }), NOW).flags).toEqual([]);
  });
});

describe('alerts', () => {
  const risky = clean({ vacBans: 1, lastBanAt: NOW - 10 * DAY });

  it('posts a high-risk account once, and again only when it gets riskier', () => {
    expect(alertDue(risky, NOW)).toBe(true);
    expect(alertDue({ ...risky, alerted: 4 }, NOW)).toBe(false);
    expect(alertDue({ ...risky, public: false, alerted: 4 }, NOW)).toBe(true);
    expect(alertDue(clean({ vacBans: 1, lastBanAt: NOW - 800 * DAY }), NOW)).toBe(false);
  });
});

describe('who to check', () => {
  it('checks players never checked, or not for a day, and only Steam IDs, a batch at a time', () => {
    const known = new Map<string, SteamCheck | null>([
      [ASH, clean({ at: NOW - RECHECK_MS + 1 })],
      [BO, clean({ at: NOW - RECHECK_MS })],
    ]);
    const cy = '76561198000000003';
    expect(checksDue([ASH, BO, cy, cy, 'bot'], new Map([...known, [cy, null]]), NOW)).toEqual([BO, cy]);
    const many = Array.from({ length: 150 }, (_, i) => `7656119800000${String(i).padStart(4, '0')}`);
    expect(checksDue(many, new Map(), NOW)).toHaveLength(STEAM_BATCH);
  });
});

describe('describing an account', () => {
  it('says how long ago in days, months or years', () => {
    expect(agoText(NOW - 3_600_000, NOW)).toBe('today');
    expect(agoText(NOW - DAY, NOW)).toBe('1 day ago');
    expect(agoText(NOW - 45 * DAY, NOW)).toBe('45 days ago');
    expect(agoText(NOW - 400 * DAY, NOW)).toBe('13 months ago');
    expect(agoText(NOW - 3000 * DAY, NOW)).toBe('8 years ago');
  });

  it('lists the bans, the age and the profile', () => {
    expect(steamFacts(clean(), NOW)).toEqual(['No VAC or game bans', 'Account made 9 years ago', 'Public profile']);
    expect(
      steamFacts(
        clean({ vacBans: 2, gameBans: 1, lastBanAt: NOW - 10 * DAY, communityBanned: true, tradeBan: 'probation', public: false, createdAt: null }),
        NOW,
      ),
    ).toEqual(['2 VAC bans and 1 game ban, the last 10 days ago', 'Banned from the Steam Community', 'On trade probation', 'Account age hidden', 'Private profile']);
    expect(steamFacts(clean({ vacBans: 1, lastBanAt: NOW - 800 * DAY, setUp: false, tradeBan: 'banned' }), NOW)).toEqual([
      '1 VAC ban, 2 years ago',
      'Banned from trading',
      'Account made 9 years ago',
      'Profile never set up',
    ]);
    expect(steamFacts(clean({ found: false }), NOW)).toEqual(['Steam has no account with this ID']);
  });
});

describe('saved checks', () => {
  it('reads what was saved, and nothing from anything else', () => {
    expect(steamKey(ASH)).toBe(`steam:${ASH}`);
    expect(parseSteamCheck(clean({ alerted: 4 }))).toEqual(clean({ alerted: 4 }));
    expect(parseSteamCheck(undefined)).toBeNull();
    expect(parseSteamCheck({ ...clean(), tradeBan: 'maybe' })).toBeNull();
  });
});

describe('fetchSteamChecks', () => {
  const bans = (players: unknown[]) => Response.json({ players });
  const summaries = (players: unknown[]) => Response.json({ response: { players } });
  const steam = (banRows: unknown[], profileRows: unknown[]) =>
    vi.fn(async (url: string | URL | Request) => (String(url).includes('GetPlayerBans') ? bans(banRows) : summaries(profileRows)));

  it('asks for every account in one request each, and reads their bans and profiles', async () => {
    const fetchFn = steam(
      [
        { SteamId: ASH, CommunityBanned: false, VACBanned: true, NumberOfVACBans: 0, DaysSinceLastBan: 30, NumberOfGameBans: 2, EconomyBan: 'banned' },
        { SteamId: BO, CommunityBanned: true, VACBanned: false, NumberOfVACBans: 0, DaysSinceLastBan: 0, NumberOfGameBans: 0, EconomyBan: 'none' },
      ],
      [
        { steamid: ASH, communityvisibilitystate: 1, profilestate: 1, personaname: 'Ash' },
        { steamid: BO, communityvisibilitystate: 3, profilestate: 1, timecreated: 1_700_000_000 },
      ],
    );
    const checks = await fetchSteamChecks(KEY, [ASH, BO, ASH, 'bot'], NOW, fetchFn);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    const urls = fetchFn.mock.calls.map(([url]) => String(url));
    expect(urls).toContain(`https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/?key=${KEY}&steamids=${ASH},${BO}`);
    expect(urls).toContain(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${KEY}&steamids=${ASH},${BO}`);
    expect(checks.get(ASH)).toEqual({
      at: NOW,
      found: true,
      vacBans: 1,
      gameBans: 2,
      lastBanAt: Date.UTC(2026, 9, 3) - 30 * DAY,
      communityBanned: false,
      tradeBan: 'banned',
      public: false,
      setUp: true,
      createdAt: null,
    });
    expect(checks.get(BO)).toMatchObject({ vacBans: 0, lastBanAt: null, communityBanned: true, public: true, createdAt: 1_700_000_000_000 });
    expect([...checks.keys()]).toEqual([ASH, BO]);
  });

  it('marks an account Steam does not know, and one that never set up a profile', async () => {
    const fetchFn = steam([], [{ steamid: BO, communityvisibilitystate: 1 }]);
    const checks = await fetchSteamChecks(KEY, [ASH, BO], NOW, fetchFn);

    expect(checks.get(ASH)?.found).toBe(false);
    expect(checks.get(BO)).toMatchObject({ found: true, public: false, setUp: false });
  });

  it('says when Steam refuses the key, without the key, and refuses a key that is not one', async () => {
    const refused = vi.fn(async () => new Response('Forbidden', { status: 403 }));
    const error = await fetchSteamChecks(KEY, [ASH], NOW, refused).catch((e: unknown) => e);

    expect(String(error)).toMatch(/Steam refused STEAM_API_KEY \(403\)/);
    expect(String(error)).not.toContain(KEY);
    await expect(fetchSteamChecks(KEY, [ASH], NOW, async () => new Response('', { status: 500 }))).rejects.toThrow(/500/);
    await expect(fetchSteamChecks('not-a-key', [ASH], NOW, refused)).rejects.toThrow(/32-character/);
    await expect(fetchSteamChecks(KEY, [ASH], NOW, async () => Response.json({ nope: true }))).rejects.toThrow();
  });

  it('asks nothing when there is nobody to ask about', async () => {
    const fetchFn = vi.fn(async () => Response.json({}));
    expect((await fetchSteamChecks(KEY, ['bot'], NOW, fetchFn)).size).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
