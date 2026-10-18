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
// remembers. (Builds with the live edit routes add the winner to the end and move it into place instead; the same is remembered
// for it, so it is taken out in the same way.)

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

// How long the match after the vote's has run before the rotation is put back. Writing the rotation as a map loads changes the
// entry the server is on, so the map was right and its lighting was the old entry's (17 October, a clear vote played in rain).
export const RESTORE_DELAY_MS = 10 * 60_000;

// Whether the rotation can be put back: the server is on another map than the vote's, and the match it is playing, which began
// after the insert was written (an earlier match's record is not it), has run RESTORE_DELAY_MS. Going by the match, not by when
// the map was first seen, the wait starts again with each map change, restart or emptied server.
export const restoreDue = (insert: VoteInsert, playing: string, matchStartedAt: number | null, now: number): boolean =>
  playing !== insert.fromMap && matchStartedAt !== null && matchStartedAt > insert.at && now - matchStartedAt >= RESTORE_DELAY_MS;

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

// The live edit routes, which builds that have them use for "Set as next map" in the server's own console.
export const MOVE_ROUTES = ['POST /v1/rotation/entries', 'POST /v1/rotation/entries/*/move'];
export const canMoveEntries = (routes: string[]): boolean => MOVE_ROUTES.every((route) => routes.includes(route));

// What to remember about a winner added to the end of the live rotation and moved into place (see planMove), so it is taken out
// again once it has played, as the config document path does: the rotation otherwise gains an entry with every vote, and plays
// them all again as it comes round. Null when the rotation cannot be planned. `length` counts the winner's entry.
export const moveInsert = (
  vote: { id: string; fromMap: string },
  rotation: Rotation,
  slot: number | null,
  winner: RotationEntry,
  now: number,
): VoteInsert | null => {
  const plan = planInsert(rotation, slot, winner);
  if (plan === null) return null;
  return {
    voteId: vote.id,
    fromMap: vote.fromMap,
    map: winner.map,
    restore: plan.restore,
    length: rotation.entries.length + 1,
    at: now,
    ...(plan.asIs ? { asIs: true } : {}),
  };
};

// Two entries are played the same: map, the same experiences in any order, lighting and zones ("None" is no zones).
const sameSetup = (entry: Rotation['entries'][number], winner: RotationEntry): boolean => {
  const key = (v: string | undefined): string => (!v || v === 'None' ? '' : v);
  const set = (ids: string[] | undefined): string => [...(ids ?? [])].sort().join('+');
  return (
    entry.map === winner.map &&
    set(entry.experiences) === set(winner.experiences) &&
    key(entry.lighting) === key(winner.lighting) &&
    key(entry.zoneAlternator) === key(winner.zoneAlternator)
  );
};

// With the live edit routes, as the server's own console does "Set as next map": the entry the rotation already has with
// the winner's setup (not the one playing), or else one added at the end, moved one slot at a time into the slot after
// the one playing. With that the last, or the slot not known, the top. `from` is where the winner is before the moves.
export type MovePlan = { add: boolean; from: number; to: number };

export const planMove = (rotation: Rotation, now: number | null, winner: RotationEntry): MovePlan => {
  const n = rotation.entries.length;
  const at = now ?? -1;
  const found = rotation.entries.findIndex((e, i) => i !== at && sameSetup(e, winner));
  // Taking the winner out from in front of the one playing moves that one up a slot.
  const nowAfter = found !== -1 && at > found ? at - 1 : at;
  const restLast = found === -1 ? n - 1 : n - 2;
  const to = nowAfter < 0 || nowAfter >= restLast ? 0 : nowAfter + 1;
  return { add: found === -1, from: found === -1 ? n : found, to };
};

// Whether the server's rotation is still the one that was written: with the winner in it, and no one has changed it since.
export const stillInserted = (rotation: Rotation, insert: VoteInsert): boolean =>
  rotation.entries.length === insert.length && rotation.entries.some((e) => e.map === insert.map);
