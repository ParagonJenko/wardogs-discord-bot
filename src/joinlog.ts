import { z } from 'zod';
import type { Player } from './rcon.ts';

// The staff page's join log: who joined and left the server. The bot compares who is in game at each check with the
// check before, so a join or leave shows up to a minute late, and someone on for less than a minute between two checks
// is missed. While the bot cannot read the server, nothing is noted; the first check after notes everyone who joined or
// left meanwhile, and says since when (`from`).
//
// Stored as 'joinLog' in Durable Object storage, written with a check's other records, and only when someone joined or
// left.

export const JOIN_LOG_KEY = 'joinLog';
// The latest joins and leaves, up to this many, and fewer when their names are long, so the record stays well under
// storage's limit for one value (128 KiB) with everyone in game too.
export const JOINS_KEPT = 500;
export const JOINS_BYTES = 80_000;
// Checks are a minute apart: a longer gap than this means the bot could not read the server in between.
export const JOIN_GAP_MS = 3 * 60_000;

// One join or leave. `at` is the check that noticed it. `from` is the check before, when that was over JOIN_GAP_MS
// earlier: it happened somewhere between the two. `joinedAt`, on a leave, is when the bot first saw them in game, or
// null when they were already on when the log started.
export type JoinEvent = {
  at: number;
  kind: 'joined' | 'left';
  steamId: string;
  name: string;
  from?: number;
  joinedAt?: number | null;
};

// Who was in game at the last check, by Steam ID, with their name and when the bot first saw them there (null for those
// on when the log started); and the latest joins and leaves, oldest first.
export type JoinLog = {
  inGame: Record<string, { name: string; since: number | null }>;
  events: JoinEvent[];
};

const JoinLogSchema = z.object({
  inGame: z.record(z.string(), z.object({ name: z.string(), since: z.number().nullable() })),
  events: z.array(
    z.object({
      at: z.number(),
      kind: z.enum(['joined', 'left']),
      steamId: z.string(),
      name: z.string(),
      from: z.number().optional(),
      joinedAt: z.number().nullable().optional(),
    }),
  ),
});

// Null when nothing was saved yet, or it is unrecognisable: the log then starts again from who is in game.
export const parseJoinLog = (raw: unknown): JoinLog | null => {
  const parsed = JoinLogSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

const encoder = new TextEncoder();

// The latest JOINS_KEPT events, and fewer while they come to more than JOINS_BYTES.
const latest = (events: JoinEvent[]): JoinEvent[] => {
  const kept = events.slice(-JOINS_KEPT);
  let bytes = 2;
  let first = kept.length;
  while (first > 0) {
    bytes += encoder.encode(JSON.stringify(kept[first - 1])).length + 1;
    if (bytes > JOINS_BYTES) break;
    first -= 1;
  }
  return kept.slice(first);
};

// The log after a check at `at` that found `players` in game, of the `count` the server said it had. `lastCheckAt` is
// when the check before reached the server, or null if none has. Gives back `log` itself when nobody joined or left, so
// the caller can skip the write. The first time, everyone in game is noted without a join, as the bot cannot tell when
// they came on. A reading that lists nobody while the server says it has players is not trusted, so a bad reading never
// shows everyone leaving and joining again.
export const recordJoins = (log: JoinLog | null, players: Player[], count: number, at: number, lastCheckAt: number | null): JoinLog => {
  if (players.length === 0 && count > 0 && log !== null) return log;
  const now = new Map<string, string>();
  for (const p of players) if (!now.has(p.steamId)) now.set(p.steamId, p.name);
  if (log === null) {
    return { inGame: Object.fromEntries([...now].map(([steamId, name]) => [steamId, { name, since: null }])), events: [] };
  }
  const gap = lastCheckAt !== null && at - lastCheckAt > JOIN_GAP_MS ? { from: lastCheckAt } : {};
  const events: JoinEvent[] = [];
  for (const [steamId, was] of Object.entries(log.inGame)) {
    if (!now.has(steamId)) events.push({ at, kind: 'left', steamId, name: was.name, ...gap, joinedAt: was.since });
  }
  const inGame: JoinLog['inGame'] = {};
  for (const [steamId, name] of now) {
    const was = log.inGame[steamId];
    if (was === undefined) events.push({ at, kind: 'joined', steamId, name, ...gap });
    inGame[steamId] = was ?? { name, since: at };
  }
  return events.length === 0 ? log : { inGame, events: latest([...log.events, ...events]) };
};

// How long a player who left had been on, in minutes, as the checks saw it: from the check that noticed them join to the
// one that noticed them gone, or after a gap, to the last check before it, the last to see them. Null for a join, and
// for a leave by someone who was on when the log started.
export const minutesOn = (e: JoinEvent): number | null =>
  e.kind !== 'left' || e.joinedAt == null ? null : Math.max(0, Math.round(((e.from ?? e.at) - e.joinedAt) / 60_000));
