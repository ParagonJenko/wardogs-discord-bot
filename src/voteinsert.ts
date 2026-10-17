import { z } from 'zod';
import type { Rotation } from './rcon.ts';
import type { RotationEntry } from './rotations.ts';

// Putting the map vote's winner next by writing it into the server's rotation, not by queueing it (POST /v1/match/map).
// The server keeps its slot when the rotation changes and goes to the next slot in the new list (see fromTheStart in
// rotations.ts), so the list is written in the order it will be played: the winner first, then the rotation as it would
// have gone, then the map being played. Once the winner is playing, the rotation is written back as it was, from the map
// that would have come next. Live servers have been seen to say nothing of the slot they are on (no entry marked "now",
// no nowIndex): then the winner is written into every slot, so it is next whichever slot that is, and the rotation is
// written back as it was, in its own order. Nothing here touches the server: the Watcher (worker.ts) fetches, writes and
// remembers.

export const VOTE_INSERT_KEY = 'voteInsert';

// What was written for a vote, to take back out. `restore` is the rotation in play order from the map that would have
// followed the one being played, which the winner went in front of; `length` is how many maps the server's rotation has
// with the winner in it. With `asIs` (the slot was not known), `restore` is the rotation in its own order, written back
// as it is.
export type VoteInsert = { voteId: string; fromMap: string; map: string; restore: RotationEntry[]; length: number; at: number; asIs?: boolean };

const EntrySchema = z.object({
  map: z.string(),
  experiences: z.array(z.string()).optional(),
  lighting: z.string().optional(),
  zoneAlternator: z.string().optional(),
});

const VoteInsertSchema = z.object({
  voteId: z.string(),
  fromMap: z.string(),
  map: z.string(),
  restore: z.array(EntrySchema),
  length: z.number(),
  at: z.number(),
  asIs: z.boolean().optional(),
});

export const parseVoteInsert = (raw: unknown): VoteInsert | null => {
  const parsed = VoteInsertSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

// A rotation entry as it is written back: the settings, not whether it is the one playing now.
const entryOf = (entry: Rotation['entries'][number]): RotationEntry => ({
  map: entry.map,
  ...(entry.experiences ? { experiences: entry.experiences } : {}),
  ...(entry.lighting ? { lighting: entry.lighting } : {}),
  ...(entry.zoneAlternator ? { zoneAlternator: entry.zoneAlternator } : {}),
});

// `asIs`: the slot was not known, so `staged` and `restore` are written as they are (see VoteInsert).
export type InsertPlan = { staged: RotationEntry[]; restore: RotationEntry[]; asIs: boolean };

// Why the winner cannot be put in this rotation, or null when it can: the rotation is off or random (then the server does
// not go to a next slot), or has no maps.
export const whyNoInsert = (rotation: Rotation): string | null => {
  if (!rotation.enabled) return 'the server\'s rotation is off';
  if (rotation.mode.toLowerCase() === 'random') return 'the server\'s rotation is random';
  if (rotation.entries.length === 0) return 'the server\'s rotation has no maps';
  return null;
};

// What the server said about its rotation, for the logs when the winner cannot go in.
export const rotationFacts = (rotation: Rotation, status: { rotationIndex: number | null; rotationNextIndex?: number }): string => {
  const at = (marker: string): string => {
    const i = rotation.entries.findIndex((e) => e.status === marker);
    return i === -1 ? 'none' : String(i);
  };
  return (
    `rotation ${rotation.enabled ? 'on' : 'off'}, mode ${JSON.stringify(rotation.mode)}, ${rotation.entries.length} maps, ` +
    `marked now: ${at('now')}, marked next: ${at('next')}; status nowIndex: ${status.rotationIndex ?? 'none'}, nextIndex: ${status.rotationNextIndex ?? 'none'}`
  );
};

// The rotation with `winner` next, and the rotation as it was to put back. Without a slot in the rotation, the winner
// fills every slot, as long as the rotation was, and the rotation goes back as it is: the map the rotation had after the
// winner's slot is skipped once. Null when this cannot be done safely (see whyNoInsert).
export const planInsert = (rotation: Rotation, slot: number | null, winner: RotationEntry): InsertPlan | null => {
  if (whyNoInsert(rotation) !== null) return null;
  const entries = rotation.entries.map(entryOf);
  if (slot === null || slot >= entries.length) return { staged: entries.map(() => winner), restore: entries, asIs: true };
  const restore = [...entries.slice(slot + 1), ...entries.slice(0, slot + 1)];
  return { staged: [winner, ...restore], restore, asIs: false };
};

// Whether the server's rotation is still the one that was written: with the winner in it, and no one has changed it since.
export const stillInserted = (rotation: Rotation, insert: VoteInsert): boolean =>
  rotation.entries.length === insert.length && rotation.entries.some((e) => e.map === insert.map);
