import { z } from 'zod';

// What staff did to each player through the bot, for /player, and the bans the bot has to lift when their time is up.
// The server only has permanent bans, so a timed ban is a permanent one the bot removes at its end.

export type ModAction = 'warn' | 'kick' | 'ban' | 'unban' | 'switchteam' | 'vip-add' | 'vip-remove';

// `by` is the staff member's Discord user ID, "bot" for something the bot did itself (a ban running out), or "server" for
// a ban made or lifted outside the bot (in game, in ServerSettings.ini or by another tool), which the bot found on the
// server's ban list. `byName` is the staff member's Discord name at the time. `name` is the player's name at the time;
// `detail` says more, such as a ban's length or the team moved to.
export type ModEntry = {
  action: ModAction;
  at: number;
  by: string;
  byName?: string;
  name?: string;
  reason?: string;
  detail?: string;
};

export const modLogKey = (steamId: string): string => `mod:${steamId}`;

// Older entries are dropped past this, so a player's log stays small.
const MAX_ENTRIES = 50;

const ModLogSchema = z.array(
  z.object({
    action: z.enum(['warn', 'kick', 'ban', 'unban', 'switchteam', 'vip-add', 'vip-remove']),
    at: z.number(),
    by: z.string(),
    byName: z.string().optional(),
    name: z.string().optional(),
    reason: z.string().optional(),
    detail: z.string().optional(),
  }),
);

export const parseModLog = (raw: unknown): ModEntry[] => {
  const parsed = ModLogSchema.safeParse(raw);
  return parsed.success ? parsed.data : [];
};

// Newest last.
export const appendMod = (log: ModEntry[], entry: ModEntry): ModEntry[] => [...log, entry].slice(-MAX_ENTRIES);

// Bans the bot made, by Steam ID. `until` is null for a permanent ban. `serverReason` is the reason exactly as the bot
// gave it to the server, which is how the bot knows the ban there is still its own. `waiting` marks a ban the server
// does not have yet: the game only bans players who are in game, so the bot bans them when it next sees them.
// `kicking` marks one the bot put on the server that way while the kick that goes with it has not worked yet.
export type BanRecord = {
  name: string;
  until: number | null;
  reason: string;
  serverReason: string;
  by: string;
  at: number;
  waiting?: boolean;
  kicking?: boolean;
};
export type BanBook = Record<string, BanRecord>;

const BanBookSchema = z.record(
  z.string(),
  z.object({
    name: z.string(),
    until: z.number().nullable(),
    reason: z.string(),
    serverReason: z.string(),
    by: z.string(),
    at: z.number(),
    waiting: z.boolean().optional(),
    kicking: z.boolean().optional(),
  }),
);

export const parseBanBook = (raw: unknown): BanBook => {
  const parsed = BanBookSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
};

// The timed bans whose time is up.
export const expiredBans = (book: BanBook, now: number): string[] =>
  Object.entries(book)
    .filter(([, ban]) => ban.until !== null && ban.until <= now)
    .map(([steamId]) => steamId);

// What a check that sees who is in game does about bans made while the player was away: `ban` the players in game
// whose waiting ban has not run out, `kick` those in game a kick has not removed yet, and stop kicking those `gone`,
// whom their ban now keeps out.
export const joinWork = (book: BanBook, inGame: string[], now: number): { ban: string[]; kick: string[]; gone: string[] } => {
  const on = new Set(inGame);
  const entries = Object.entries(book);
  const ids = (keep: (steamId: string, ban: BanRecord) => boolean): string[] =>
    entries.filter(([steamId, ban]) => keep(steamId, ban)).map(([steamId]) => steamId);
  return {
    ban: ids((steamId, ban) => ban.waiting === true && on.has(steamId) && (ban.until === null || ban.until > now)),
    kick: ids((steamId, ban) => ban.kicking === true && on.has(steamId)),
    gone: ids((steamId, ban) => ban.kicking === true && !on.has(steamId)),
  };
};

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

// The lengths /ban offers, by the value Discord sends. null is permanent.
export const BAN_LENGTHS: { value: string; name: string; ms: number | null }[] = [
  { value: '1h', name: '1 hour', ms: HOUR },
  { value: '1d', name: '1 day', ms: DAY },
  { value: '3d', name: '3 days', ms: 3 * DAY },
  { value: '7d', name: '7 days', ms: 7 * DAY },
  { value: '30d', name: '30 days', ms: 30 * DAY },
  { value: 'permanent', name: 'Permanent', ms: null },
];

// The reason the server keeps with a ban. A timed one says when it ends, as the server itself never lifts it.
export const banReason = (reason: string, until: number | null): string =>
  until === null ? reason : `${reason} (ends ${new Date(until).toISOString().slice(0, 16).replace('T', ' ')} UTC)`;

// Whether the ban on the server is still the one the bot made: someone may have lifted it and banned the player again
// some other way. The bot only lifts, or describes, a ban whose reason is exactly the one it wrote.
export const isBotBan = (serverReason: string | null, ban: BanRecord): boolean =>
  (serverReason ?? '').trim() === ban.serverReason.trim();

// The bans on the server at the last check, by Steam ID, so a ban made or lifted outside the bot is noticed. The bot
// keeps it up to date with its own bans as it makes and lifts them, so only other changes show up.
export type ServerBan = { reason: string | null; bannedBy: string | null };
export type ServerBans = Record<string, ServerBan>;

const ServerBansSchema = z.record(z.string(), z.object({ reason: z.string().nullable(), bannedBy: z.string().nullable() }));

// Null before the bot first read the server's ban list.
export const parseServerBans = (raw: unknown): ServerBans | null => {
  const parsed = ServerBansSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

// What changed on the server's ban list since the last check.
export const banChanges = (
  before: ServerBans,
  now: { steamId: string; reason: string | null; bannedBy: string | null }[],
): { added: { steamId: string; ban: ServerBan }[]; lifted: { steamId: string; ban: ServerBan }[] } => {
  const current = new Set(now.map((b) => b.steamId));
  return {
    added: now.filter((b) => before[b.steamId] === undefined).map(({ steamId, reason, bannedBy }) => ({ steamId, ban: { reason, bannedBy } })),
    lifted: Object.entries(before)
      .filter(([steamId]) => !current.has(steamId))
      .map(([steamId, ban]) => ({ steamId, ban })),
  };
};

// The actions posted to the moderation log channel. VIP changes are not moderation.
export const POSTED_ACTIONS: readonly ModAction[] = ['warn', 'kick', 'ban', 'unban', 'switchteam'];
