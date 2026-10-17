import { z } from 'zod';
import type { Rotation } from './rcon.ts';
import type { RotationEntry } from './rotations.ts';

// Putting the map vote's winner next by writing it into the server's rotation, not by queueing it (POST /v1/match/map).
// The server keeps its slot when the rotation changes and goes to the next slot in the new list (see fromTheStart in
// rotations.ts), so the list is written in the order it will be played: the winner first, then the rotation as it would
// have gone, then the map being played. Once the winner is playing, the rotation is written back as it was, from the map
// that would have come next. Nothing here touches the server: the Watcher (worker.ts) fetches, writes and remembers.

export const VOTE_INSERT_KEY = 'voteInsert';

// What was written for a vote, to take back out. `restore` is the rotation in play order from the map that would have
// followed the one being played, which the winner went in front of; `length` is how many maps the server's rotation has
// with the winner in it.
export type VoteInsert = { voteId: string; fromMap: string; map: string; restore: RotationEntry[]; length: number; at: number };

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

export type InsertPlan = { staged: RotationEntry[]; restore: RotationEntry[] };

// Why the winner cannot be put in this rotation, or null when it can: the rotation is off or random (then the server does
// not go to a next slot), has no maps, or the slot it is on is not known.
export const whyNoInsert = (rotation: Rotation, slot: number | null): string | null => {
  if (!rotation.enabled) return 'the server\'s rotation is off';
  if (rotation.mode.toLowerCase() === 'random') return 'the server\'s rotation is random';
  if (rotation.entries.length === 0) return 'the server\'s rotation has no maps';
  if (slot === null) return 'the server did not say which rotation slot it is on';
  if (slot >= rotation.entries.length) return `the server's slot ${slot} is not in its rotation of ${rotation.entries.length} maps`;
  return null;
};

// The rotation with `winner` next, and the rotation as it was to put back. Null when this cannot be done safely (see
// whyNoInsert).
export const planInsert = (rotation: Rotation, slot: number | null, winner: RotationEntry): InsertPlan | null => {
  if (slot === null || whyNoInsert(rotation, slot) !== null) return null;
  const entries = rotation.entries.map(entryOf);
  const restore = [...entries.slice(slot + 1), ...entries.slice(0, slot + 1)];
  return { staged: [winner, ...restore], restore };
};

// Whether the server's rotation is still the one that was written: with the winner in it, and no one has changed it since.
export const stillInserted = (rotation: Rotation, insert: VoteInsert): boolean =>
  rotation.entries.length === insert.length && rotation.entries.some((e) => e.map === insert.map);
