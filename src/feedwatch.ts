import { z } from 'zod';

// The kill feed going quiet, for the moderation log channel. The game posts its kills, joins, leaves and the match's
// states a second or two after they happen, so a live server with no batch for FEED_QUIET_MS means the feed has
// stopped: most often a game update that changed how the server is told where to send it (Season 2 did, on 15 October
// 2026), a token that no longer matches, or the lines gone from ServerSettings.ini. Staff hear about it once, and again
// when events arrive. The same mark says when the bot stops taking the feed's word on matches (see matchfeed.ts).

export const FEED_WATCH_KEY = 'feedWatch';
// Long enough for a map change, short enough that a match is not lost to it.
export const FEED_QUIET_MS = 10 * 60_000;

export type FeedWatch = {
  // When a check first found the server live, while it stays live; null while it is not.
  liveSince: number | null;
  // Since when the feed was quiet, and when staff were told; both null until then.
  quietFrom: number | null;
  toldAt: number | null;
};

export type FeedWatchEvent =
  // `heardAt`: the last batch before it went quiet, or null when the bot has none on record.
  | { type: 'quiet'; at: number; quietFrom: number; heardAt: number | null; players: number }
  | { type: 'back'; at: number; quietFrom: number; heardAt: number };

const WATCHING: FeedWatch = { liveSince: null, quietFrom: null, toldAt: null };

const FeedWatchSchema = z.object({
  liveSince: z.number().nullable(),
  quietFrom: z.number().nullable(),
  toldAt: z.number().nullable(),
});

export const parseFeedWatch = (raw: unknown): FeedWatch => {
  const parsed = FeedWatchSchema.safeParse(raw);
  return parsed.success ? parsed.data : WATCHING;
};

export type FeedCheck = {
  at: number;
  // The players the check found, or null when it could not reach the server.
  players: number | null;
  // LIVE_THRESHOLD.
  live: number;
  // When the last kill feed batch with something new in it came, or null when the bot has none on record.
  heardAt: number | null;
};

// One check. A check that could not reach the server changes nothing: it says nothing about the feed.
export const observeFeed = (
  watch: FeedWatch,
  { at, players, live, heardAt }: FeedCheck,
): { watch: FeedWatch; event: FeedWatchEvent | null } => {
  if (watch.toldAt !== null && watch.quietFrom !== null) {
    if (heardAt === null || heardAt <= watch.toldAt) return { watch, event: null };
    return { watch: WATCHING, event: { type: 'back', at, quietFrom: watch.quietFrom, heardAt } };
  }
  if (players === null) return { watch, event: null };
  if (players < live) return { watch: watch.liveSince === null ? watch : WATCHING, event: null };
  const liveSince = watch.liveSince ?? at;
  const quietFrom = Math.max(liveSince, heardAt ?? liveSince);
  if (at - quietFrom < FEED_QUIET_MS) return { watch: watch.liveSince === null ? { ...WATCHING, liveSince } : watch, event: null };
  return { watch: { liveSince, quietFrom, toldAt: at }, event: { type: 'quiet', at, quietFrom, heardAt, players } };
};
