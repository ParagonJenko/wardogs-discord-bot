import { z } from 'zod';

// What staff did to each player through the bot, for /player, and the bans the bot has to lift when their time is up.
// The server only has permanent bans, so a timed ban is a permanent one the bot removes at its end.

export type ModAction = 'warn' | 'kick' | 'ban' | 'unban' | 'switchteam' | 'vip-add' | 'vip-remove';

// `by` is the staff member's Discord user ID, or "bot" for something the bot did itself (a ban running out).
// `name` is the player's name at the time; `detail` says more, such as a ban's length or the team moved to.
export type ModEntry = { action: ModAction; at: number; by: string; name?: string; reason?: string; detail?: string };

export const modLogKey = (steamId: string): string => `mod:${steamId}`;

// Older entries are dropped past this, so a player's log stays small.
const MAX_ENTRIES = 50;

const ModLogSchema = z.array(
  z.object({
    action: z.enum(['warn', 'kick', 'ban', 'unban', 'switchteam', 'vip-add', 'vip-remove']),
    at: z.number(),
    by: z.string(),
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

// Bans the bot made, by Steam ID. `until` is null for a permanent ban.
export type BanRecord = { name: string; until: number | null; reason: string; by: string; at: number };
export type BanBook = Record<string, BanRecord>;

const BanBookSchema = z.record(
  z.string(),
  z.object({ name: z.string(), until: z.number().nullable(), reason: z.string(), by: z.string(), at: z.number() }),
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
