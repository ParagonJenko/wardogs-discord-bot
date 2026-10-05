import { z } from 'zod';
import type { Sql } from './killfeed.ts';
import type { Player } from './rcon.ts';

// The staff page's join log: who joined and left the server, and each player's times on it. The bot compares who is in
// game at each check with the check before, so a join or leave shows up to a minute late, and someone on for less than
// a minute between two checks is missed. While the bot cannot read the server, nothing is noted; the first check after
// notes everyone who joined or left meanwhile, and says since when (`from`).
//
// Two records. 'joinLog' (Durable Object storage) is who is in game and the latest joins and leaves, written with a
// check's other records, and only when someone joined or left. The sessions table, in the Durable Object's SQLite
// database, has a row for each time a player was on, written when they leave, for their history; it keeps
// SESSION_DAYS_KEPT days. Who is on now comes from the log.

export const JOIN_LOG_KEY = 'joinLog';
// The latest joins and leaves, up to this many, and fewer when their names are long, so the record stays well under
// storage's limit for one value (128 KiB) with everyone in game too.
export const JOINS_KEPT = 500;
export const JOINS_BYTES = 80_000;
// Checks are a minute apart: a longer gap than this means the bot could not read the server in between.
export const JOIN_GAP_MS = 3 * 60_000;
// The staff page's longest period.
export const SESSION_DAYS_KEPT = 30;
// A player's history lists at most this many of their times on the server.
export const SESSIONS_LISTED = 300;

// One join or leave. `at` is the check that noticed it. `from` is the check before, when that was over JOIN_GAP_MS
// earlier: it happened somewhere between the two. On a leave, `joinedAt` is when the bot first saw them in game, or null
// when they were already on when the log started, and `joinedFrom` the join's `from`.
export type JoinEvent = {
  at: number;
  kind: 'joined' | 'left';
  steamId: string;
  name: string;
  from?: number;
  joinedAt?: number | null;
  joinedFrom?: number;
};

// When someone in game joined: the check that noticed it (null for those on when the log started), and its `from`.
export type OnSince = { name: string; since: number | null; from?: number };

// Who was in game at the last check, by Steam ID; and the latest joins and leaves, oldest first.
export type JoinLog = {
  inGame: Record<string, OnSince>;
  events: JoinEvent[];
};

const JoinLogSchema = z.object({
  inGame: z.record(z.string(), z.object({ name: z.string(), since: z.number().nullable(), from: z.number().optional() })),
  events: z.array(
    z.object({
      at: z.number(),
      kind: z.enum(['joined', 'left']),
      steamId: z.string(),
      name: z.string(),
      from: z.number().optional(),
      joinedAt: z.number().nullable().optional(),
      joinedFrom: z.number().optional(),
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

// The log after a check at `at` that found `players` in game, of the `count` the server said it had, and the joins and
// leaves it `added`. `lastCheckAt` is when the check before reached the server, or null if none has. Gives back `log`
// itself when nobody joined or left, so the caller can skip the write. The first time, everyone in game is noted without
// a join, as the bot cannot tell when they came on. A reading that lists nobody while the server says it has players is
// not trusted, so a bad reading never shows everyone leaving and joining again.
export const recordJoins = (
  log: JoinLog | null,
  players: Player[],
  count: number,
  at: number,
  lastCheckAt: number | null,
): { log: JoinLog; added: JoinEvent[] } => {
  const now = new Map<string, string>();
  for (const p of players) if (!now.has(p.steamId)) now.set(p.steamId, p.name);
  if (log === null) {
    return { log: { inGame: Object.fromEntries([...now].map(([steamId, name]) => [steamId, { name, since: null }])), events: [] }, added: [] };
  }
  if (players.length === 0 && count > 0) return { log, added: [] };
  const gap = lastCheckAt !== null && at - lastCheckAt > JOIN_GAP_MS ? { from: lastCheckAt } : {};
  const added: JoinEvent[] = [];
  for (const [steamId, was] of Object.entries(log.inGame)) {
    if (now.has(steamId)) continue;
    added.push({
      at,
      kind: 'left',
      steamId,
      name: was.name,
      ...gap,
      joinedAt: was.since,
      ...(was.from === undefined ? {} : { joinedFrom: was.from }),
    });
  }
  const inGame: JoinLog['inGame'] = {};
  for (const [steamId, name] of now) {
    const was = log.inGame[steamId];
    if (was === undefined) added.push({ at, kind: 'joined', steamId, name, ...gap });
    inGame[steamId] = was ?? { name, since: at, ...gap };
  }
  return added.length === 0 ? { log, added } : { log: { inGame, events: latest([...log.events, ...added]) }, added };
};

// Minutes from `joinedAt` to `lastSeen`, or null when the bot did not see them join.
const span = (joinedAt: number | null | undefined, lastSeen: number): number | null =>
  joinedAt == null ? null : Math.max(0, Math.round((lastSeen - joinedAt) / 60_000));

// How long a player who left had been on, in minutes, as the checks saw it: from the check that noticed them join to the
// one that noticed them gone, or after a gap, to the last check before it, the last to see them. Null for a join, and
// for a leave by someone who was on when the log started.
export const minutesOn = (e: JoinEvent): number | null => (e.kind === 'left' ? span(e.joinedAt, e.from ?? e.at) : null);

// The table, made the first time. A row is one time on the server, as its join and leave were noted (see JoinEvent).
export const createSessions = (sql: Sql): void => {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS sessions (
      steam_id TEXT NOT NULL,
      name TEXT NOT NULL,
      joined_at INTEGER,
      joined_from INTEGER,
      left_at INTEGER NOT NULL,
      left_from INTEGER
    )`,
  );
  sql.exec('CREATE INDEX IF NOT EXISTS sessions_player ON sessions (steam_id, left_at)');
};

// A row for each leave among `events`.
export const writeSessions = (sql: Sql, events: JoinEvent[]): void => {
  for (const e of events) {
    if (e.kind !== 'left') continue;
    sql.exec(
      'INSERT INTO sessions (steam_id, name, joined_at, joined_from, left_at, left_from) VALUES (?, ?, ?, ?, ?, ?)',
      e.steamId,
      e.name,
      e.joinedAt ?? null,
      e.joinedFrom ?? null,
      e.at,
      e.from ?? null,
    );
  }
};

// Deletes the times on the server that ended before `before`.
export const pruneSessions = (sql: Sql, before: number): void => {
  sql.exec('DELETE FROM sessions WHERE left_at < ?', before);
};

// One time on the server, for a player's history. `joinedAt`: the check that noticed them join, or null when they were
// on when the log started. `leftAt`: the one that noticed them gone, or null while they are in game. `joinedFrom` and
// `leftFrom`: after a gap in the checks, the check before, as it happened between the two. `minutes`: how long they were
// on, as `minutesOn`, and so far for someone in game.
export type AdminSession = {
  joinedAt: number | null;
  joinedFrom: number | null;
  leftAt: number | null;
  leftFrom: number | null;
  minutes: number | null;
};

const time = z.number().nullable();
const SessionRowSchema = z.object({ joined_at: time, joined_from: time, left_at: z.number(), left_from: time });

// A player's times on the server that ended at `from` or later, newest first, up to SESSIONS_LISTED, after the one they
// are on now. `current` is their entry in the log while they are in game, and `seenAt` when the last check saw them.
export const playerSessions = (sql: Sql, steamId: string, from: number, current: OnSince | null, seenAt: number): AdminSession[] => {
  const past = sql
    .exec(
      'SELECT joined_at, joined_from, left_at, left_from FROM sessions WHERE steam_id = ? AND left_at >= ? ORDER BY left_at DESC LIMIT ?',
      steamId,
      from,
      SESSIONS_LISTED,
    )
    .toArray()
    .flatMap((row): AdminSession[] => {
      const parsed = SessionRowSchema.safeParse(row);
      if (!parsed.success) return [];
      const { joined_at: joinedAt, joined_from: joinedFrom, left_at: leftAt, left_from: leftFrom } = parsed.data;
      return [{ joinedAt, joinedFrom, leftAt, leftFrom, minutes: span(joinedAt, leftFrom ?? leftAt) }];
    });
  if (current === null) return past;
  const now: AdminSession = { joinedAt: current.since, joinedFrom: current.from ?? null, leftAt: null, leftFrom: null, minutes: span(current.since, seenAt) };
  return [now, ...past].slice(0, SESSIONS_LISTED);
};
