import { z } from 'zod';

// Steam accounts that look risky for cheating, for staff. From the Steam Web API: the bans on each player's account (VAC
// bans, game bans from other games' anti-cheat or developers, and Steam Community and trading bans), and whether the
// account is new or shows nothing. The bot checks players when they join, and again once a day while they play
// ('steam:<Steam ID>'). Keyed by Steam ID and only for staff: /player, the staff page and the moderation log channel.

export const steamKey = (steamId: string): string => `steam:${steamId}`;

const DAY_MS = 24 * 60 * 60_000;

// A player in game is checked again once their last check is this old, so a new ban shows within a day.
export const RECHECK_MS = DAY_MS;
// Steam answers for up to 100 accounts at a time.
export const STEAM_BATCH = 100;
// After Steam fails or refuses, the bot waits this long before asking again.
export const STEAM_RETRY_MS = 10 * 60_000;

export const STEAM_ID = /^\d{17}$/;
// A Steam Web API key, from steamcommunity.com/dev/apikey.
export const STEAM_API_KEY = /^[0-9A-Fa-f]{32}$/;

export type TradeBan = 'none' | 'probation' | 'banned';

// What Steam said about one account at `at`. `found` is false when Steam has no such account. `lastBanAt` is when its
// latest VAC or game ban was, to the day, or null without either. The profile: `public` when anyone can see it, `setUp`
// when the player made a Steam Community profile, and `createdAt` when the account was made, which Steam only shows for a
// public profile. `alerted` is the risk score last posted to the moderation log channel, so each rise is posted once.
export type SteamCheck = {
  at: number;
  found: boolean;
  vacBans: number;
  gameBans: number;
  lastBanAt: number | null;
  communityBanned: boolean;
  tradeBan: TradeBan;
  public: boolean;
  setUp: boolean;
  createdAt: number | null;
  alerted?: number;
};

const count = z.number().int().nonnegative();

const SteamCheckSchema = z.object({
  at: z.number(),
  found: z.boolean(),
  vacBans: count,
  gameBans: count,
  lastBanAt: z.number().nullable(),
  communityBanned: z.boolean(),
  tradeBan: z.enum(['none', 'probation', 'banned']),
  public: z.boolean(),
  setUp: z.boolean(),
  createdAt: z.number().nullable(),
  alerted: z.number().optional(),
});

// Null when nothing was saved yet, or it is unrecognisable: then the player is checked again.
export const parseSteamCheck = (raw: unknown): SteamCheck | null => {
  const parsed = SteamCheckSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

// Each flag adds its points to an account's risk score.
export const STEAM_FLAGS = {
  // VAC bans on record, in any game.
  vacBan: 3,
  // Game bans on record: another game's anti-cheat or developer banned them.
  gameBan: 3,
  // The latest VAC or game ban was within `recentBanDays`.
  recentBan: 1,
  // Banned from the Steam Community.
  communityBan: 2,
  // Banned from trading on Steam.
  tradeBan: 1,
  // Made less than `newAccountDays` ago.
  newAccount: 3,
  // Made less than `youngAccountDays` ago, but not new.
  youngAccount: 1,
  // A private profile, or one never set up: Steam shows nothing about them, not even how old the account is.
  hidden: 1,
} as const;

export type SteamFlag = keyof typeof STEAM_FLAGS;

export const STEAM_MARKS = { recentBanDays: 365, newAccountDays: 30, youngAccountDays: 180 } as const;

// From `high` points an account is high risk, and posted to the moderation log channel. From `medium` it is worth a look,
// and listed on the staff page.
export const RISK = { high: 4, medium: 2 } as const;

export type Risk = 'high' | 'medium' | 'low';

export const steamFlags = (c: SteamCheck, now: number): SteamFlag[] => {
  if (!c.found) return [];
  const age = c.createdAt === null ? null : now - c.createdAt;
  const flags: SteamFlag[] = [];
  if (c.vacBans > 0) flags.push('vacBan');
  if (c.gameBans > 0) flags.push('gameBan');
  if (c.lastBanAt !== null && now - c.lastBanAt < STEAM_MARKS.recentBanDays * DAY_MS) flags.push('recentBan');
  if (c.communityBanned) flags.push('communityBan');
  if (c.tradeBan === 'banned') flags.push('tradeBan');
  if (age !== null && age < STEAM_MARKS.newAccountDays * DAY_MS) flags.push('newAccount');
  else if (age !== null && age < STEAM_MARKS.youngAccountDays * DAY_MS) flags.push('youngAccount');
  if (!c.public || !c.setUp) flags.push('hidden');
  return flags;
};

export const steamScore = (flags: SteamFlag[]): number => flags.reduce((sum, flag) => sum + STEAM_FLAGS[flag], 0);

export const riskOf = (score: number): Risk => (score >= RISK.high ? 'high' : score >= RISK.medium ? 'medium' : 'low');

// An account's flags, score and risk now: an account ages, and a ban stops being recent.
export const assess = (c: SteamCheck, now: number): { flags: SteamFlag[]; score: number; risk: Risk } => {
  const flags = steamFlags(c, now);
  const score = steamScore(flags);
  return { flags, score, risk: riskOf(score) };
};

// Whether to post the account to the moderation log channel: high risk, and riskier than when it was last posted.
export const alertDue = (c: SteamCheck, now: number): boolean => {
  const { score, risk } = assess(c, now);
  return risk === 'high' && score > (c.alerted ?? 0);
};

// The players in game to ask Steam about: never checked, or not for a day. At most a batch.
export const checksDue = (steamIds: string[], known: Map<string, SteamCheck | null>, now: number): string[] =>
  [...new Set(steamIds)]
    .filter((steamId) => STEAM_ID.test(steamId))
    .filter((steamId) => {
      const check = known.get(steamId);
      return check === undefined || check === null || now - check.at >= RECHECK_MS;
    })
    .slice(0, STEAM_BATCH);

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

// "12 days ago", "4 months ago", "9 years ago".
export const agoText = (at: number, now: number): string => {
  const days = Math.max(0, Math.floor((now - at) / DAY_MS));
  if (days === 0) return 'today';
  if (days < 60) return `${plural(days, 'day')} ago`;
  if (days < 730) return `${plural(Math.floor(days / 30), 'month')} ago`;
  return `${plural(Math.floor(days / 365), 'year')} ago`;
};

// What Steam says about the account, in words, for /player and the moderation log: its bans, its age and its profile.
export const steamFacts = (c: SteamCheck, now: number): string[] => {
  if (!c.found) return ['Steam has no account with this ID'];
  const bans = [...(c.vacBans > 0 ? [plural(c.vacBans, 'VAC ban')] : []), ...(c.gameBans > 0 ? [plural(c.gameBans, 'game ban')] : [])];
  const last = c.lastBanAt === null ? '' : `, ${c.vacBans + c.gameBans > 1 ? 'the last ' : ''}${agoText(c.lastBanAt, now)}`;
  return [
    bans.length === 0 ? 'No VAC or game bans' : `${bans.join(' and ')}${last}`,
    ...(c.communityBanned ? ['Banned from the Steam Community'] : []),
    ...(c.tradeBan === 'banned' ? ['Banned from trading'] : c.tradeBan === 'probation' ? ['On trade probation'] : []),
    c.createdAt !== null ? `Account made ${agoText(c.createdAt, now)}` : 'Account age hidden',
    !c.setUp ? 'Profile never set up' : c.public ? 'Public profile' : 'Private profile',
  ];
};

export const RISK_LABELS: Record<Risk, string> = { high: 'High risk', medium: 'Worth a look', low: 'Nothing risky' };

// What /player shows: the check, 'failed' when Steam could not be asked and none is saved, or 'off' without STEAM_API_KEY.
export type SteamLookup = SteamCheck | 'failed' | 'off';

// A player in game with a high-risk account, for the moderation log channel.
export type SteamAlert = { steamId: string; name: string; check: SteamCheck };

const BansSchema = z.object({
  players: z.array(
    z.object({
      SteamId: z.string(),
      CommunityBanned: z.boolean(),
      VACBanned: z.boolean(),
      NumberOfVACBans: count,
      DaysSinceLastBan: count,
      NumberOfGameBans: count,
      EconomyBan: z.string(),
    }),
  ),
});

const SummariesSchema = z.object({
  response: z.object({
    players: z.array(
      z.object({
        steamid: z.string(),
        // 3 is public. Anything else, Steam does not show to the bot.
        communityvisibilitystate: z.number(),
        // 1 once the player has set up a Steam Community profile.
        profilestate: z.number().optional(),
        // Unix seconds. Only for a public profile.
        timecreated: z.number().optional(),
      }),
    ),
  }),
});

const tradeBan = (value: string): TradeBan => (value === 'none' ? 'none' : value === 'probation' ? 'probation' : 'banned');

const startOfDay = (at: number): number => Math.floor(at / DAY_MS) * DAY_MS;

// The key goes in the address, so errors never include it.
const steamGet = async (url: string, what: string, fetchFn: typeof fetch): Promise<unknown> => {
  const response = await fetchFn(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8_000) });
  if (response.status === 401 || response.status === 403) {
    throw new Error(`Steam refused STEAM_API_KEY (${response.status}). Check the key at steamcommunity.com/dev/apikey`);
  }
  if (!response.ok) throw new Error(`Steam ${what} failed: ${response.status}`);
  return response.json();
};

// Asks Steam about up to a batch of accounts at once: their bans and their profiles, one request each. Every Steam ID
// asked about gets a check; one Steam does not know is not found.
export const fetchSteamChecks = async (
  apiKey: string,
  steamIds: string[],
  now: number,
  fetchFn: typeof fetch = fetch,
): Promise<Map<string, SteamCheck>> => {
  if (!STEAM_API_KEY.test(apiKey)) throw new Error('STEAM_API_KEY must be the 32-character key from steamcommunity.com/dev/apikey');
  const ids = [...new Set(steamIds)].filter((steamId) => STEAM_ID.test(steamId)).slice(0, STEAM_BATCH);
  if (ids.length === 0) return new Map();
  const query = `key=${apiKey}&steamids=${ids.join(',')}`;
  const [bansBody, summariesBody] = await Promise.all([
    steamGet(`https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/?${query}`, 'ban lookup', fetchFn),
    steamGet(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?${query}`, 'profile lookup', fetchFn),
  ]);
  const bans = new Map(BansSchema.parse(bansBody).players.map((b) => [b.SteamId, b]));
  const profiles = new Map(SummariesSchema.parse(summariesBody).response.players.map((p) => [p.steamid, p]));
  return new Map(
    ids.map((steamId): [string, SteamCheck] => {
      const ban = bans.get(steamId);
      const profile = profiles.get(steamId);
      const vacBans = ban === undefined ? 0 : Math.max(ban.NumberOfVACBans, ban.VACBanned ? 1 : 0);
      const gameBans = ban?.NumberOfGameBans ?? 0;
      return [
        steamId,
        {
          at: now,
          found: ban !== undefined || profile !== undefined,
          vacBans,
          gameBans,
          lastBanAt: ban !== undefined && vacBans + gameBans > 0 ? startOfDay(now) - ban.DaysSinceLastBan * DAY_MS : null,
          communityBanned: ban?.CommunityBanned ?? false,
          tradeBan: ban === undefined ? 'none' : tradeBan(ban.EconomyBan),
          public: profile?.communityvisibilitystate === 3,
          setUp: profile?.profilestate === 1,
          createdAt: profile?.timecreated === undefined ? null : profile.timecreated * 1000,
        },
      ];
    }),
  );
};
