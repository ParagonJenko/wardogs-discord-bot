import { z } from 'zod';

// Outages, for the moderation log channel and the review (see review.ts). Two kinds:
// - a crash: a live server lost more than three quarters of its players from one reading to the next, and was not back
//   to half of them CRASH_CONFIRM_MS later. A map change that empties the server for a minute or two never gets that
//   far.
// - unreachable: the bot could not reach a server that had players for DOWN_AFTER_MS. It may still be running: RCON may
//   be down on its own.
// Staff hear about one once it is confirmed, and again when the players are back (BACK_SHARE of what it had), or after
// GIVE_UP_MS when they never come back. An outage that is over before it is confirmed is forgotten.

export const CRASH_SHARE = 0.25;
export const CRASH_CONFIRM_MS = 3 * 60_000;
export const DOWN_AFTER_MS = 5 * 60_000;
// Back to this share of the players it had: refilled.
export const BACK_SHARE = 0.9;
// Back to this share before it is confirmed: it was a blip, such as a map change.
const BLIP_SHARE = 0.5;
export const GIVE_UP_MS = 3 * 60 * 60_000;

// A check that reached the server.
export type Reading = { at: number; players: number; map: string };

export type Outage = {
  kind: 'crash' | 'unreachable';
  // When it started: the reading that lost the players, or for unreachable, the last reading before.
  at: number;
  // The players, and the map, at the reading before it.
  before: number;
  map: string;
  // The fewest players a reading has seen since; null while no reading has.
  lowest: number | null;
  // Since when the bot cannot reach the server, while it cannot; and for how long it could not before that.
  unreachableSince: number | null;
  unreachableMs: number;
  // When staff were told; null until it is confirmed.
  confirmedAt: number | null;
};

// `players` and `map`: the reading that confirmed it or ended it; null when the bot could not reach the server.
export type OutageEvent =
  | { type: 'down'; at: number; outage: Outage; players: number | null; map: string | null }
  | { type: 'back'; at: number; outage: Outage; players: number; map: string; refilled: boolean };

export const OutageSchema = z.object({
  kind: z.enum(['crash', 'unreachable']),
  at: z.number(),
  before: z.number(),
  map: z.string(),
  lowest: z.number().nullable(),
  unreachableSince: z.number().nullable(),
  unreachableMs: z.number(),
  confirmedAt: z.number().nullable(),
});

export const ReadingSchema = z.object({ at: z.number(), players: z.number(), map: z.string() });

// Whether the community alerts should treat the server as crashed: a confirmed crash that is not over. Unreachable on
// its own says nothing about the players, who may all still be in game. With the drop grace (DROP_GRACE_MINUTES) longer
// than CRASH_CONFIRM_MS, as by default, a crash is confirmed before any community alert could go out for it.
export const crashed = (outage: Outage | null): boolean => outage?.kind === 'crash' && outage.confirmedAt !== null;

// How long the bot could not reach the server, up to `at`.
export const unreachableFor = (outage: Outage, at: number): number =>
  outage.unreachableMs + (outage.unreachableSince === null ? 0 : at - outage.unreachableSince);

type Observed = { outage: Outage | null; event: OutageEvent | null };

// Confirms an outage that has lasted long enough. `reading` is the check's, or null when it could not reach the server.
const confirm = (open: Outage, at: number, reading: Reading | null): Observed => {
  if (open.confirmedAt !== null) return { outage: open, event: null };
  if (at - open.at < (open.kind === 'crash' ? CRASH_CONFIRM_MS : DOWN_AFTER_MS)) return { outage: open, event: null };
  const confirmed = { ...open, confirmedAt: at };
  return {
    outage: confirmed,
    event: { type: 'down', at, outage: confirmed, players: reading?.players ?? null, map: reading?.map ?? null },
  };
};

// A check that reached the server. `last` is the reading before it, and `live` LIVE_THRESHOLD: only a live server can
// crash.
export const observeReading = (outage: Outage | null, last: Reading | null, reading: Reading, live: number): Observed => {
  const { at, players } = reading;
  if (outage === null) {
    if (last === null || last.players < live || players >= last.players * CRASH_SHARE) return { outage: null, event: null };
    const fell: Outage = {
      kind: 'crash',
      at,
      before: last.players,
      map: last.map,
      lowest: players,
      unreachableSince: null,
      unreachableMs: 0,
      confirmedAt: null,
    };
    return { outage: fell, event: null };
  }
  const seen: Outage = {
    ...outage,
    // Back without half its players: it crashed, whatever kept the bot from reaching it.
    kind: outage.kind === 'crash' || players < outage.before * BLIP_SHARE ? 'crash' : 'unreachable',
    lowest: Math.min(outage.lowest ?? players, players),
    unreachableSince: null,
    unreachableMs: unreachableFor(outage, at),
  };
  if (seen.confirmedAt === null) {
    return players >= seen.before * BLIP_SHARE ? { outage: null, event: null } : confirm(seen, at, reading);
  }
  const refilled = players >= Math.ceil(seen.before * BACK_SHARE);
  if (!refilled && at - seen.at < GIVE_UP_MS) return { outage: seen, event: null };
  return { outage: null, event: { type: 'back', at, outage: seen, players, map: reading.map, refilled } };
};

// A check that could not reach the server. `last` is the last reading that did. A server nobody was on is not watched:
// nobody is missing it.
export const observeFailure = (outage: Outage | null, last: Reading | null, at: number): Observed => {
  if (outage !== null) return confirm({ ...outage, unreachableSince: outage.unreachableSince ?? at }, at, null);
  if (last === null || last.players === 0) return { outage: null, event: null };
  const lost: Outage = {
    kind: 'unreachable',
    at: last.at,
    before: last.players,
    map: last.map,
    lowest: null,
    unreachableSince: at,
    unreachableMs: 0,
    confirmedAt: null,
  };
  return confirm(lost, at, null);
};
