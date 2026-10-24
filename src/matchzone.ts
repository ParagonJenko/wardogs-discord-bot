import { z } from 'zod';
import { zoneLayoutName } from './names.ts';
import { rotationSlot } from './rotations.ts';
import type { Rotation } from './rcon.ts';

// The circles (control-zone layout) each recent match is played on, kept while it goes on so the match is recorded with them
// when it ends: the server does not say which layout is live, only the rotation's entry for the slot it is on does. A note is
// for one match (by when it started), so a retried match end finds its own and a later match never reuses it. `zone` is the
// layout's name, missing when the entry sets none.
export const MATCH_ZONE_KEY = 'matchZones';

export type MatchZone = { startedAt: number; zone?: string };

const MatchZonesSchema = z.array(z.object({ startedAt: z.number(), zone: z.string().optional() }));

// More than a match end can still be waiting on.
const KEPT = 5;

export const parseMatchZones = (raw: unknown): MatchZone[] => {
  const parsed = MatchZonesSchema.safeParse(raw);
  return parsed.success ? parsed.data : [];
};

// The notes with one more for the match, the oldest dropped. The same notes when the match already has one.
export const withMatchZone = (notes: readonly MatchZone[], note: MatchZone): MatchZone[] =>
  notes.some((n) => n.startedAt === note.startedAt) ? [...notes] : [...notes, note].slice(-KEPT);

// The name of the layout the rotation has in the slot the server is on, when the entry sets one. A map played with its own
// layout has none to name.
export const zoneOfSlot = (rotation: Rotation, status: { rotationIndex: number | null; rotationNextIndex?: number }): string | undefined => {
  const slot = rotationSlot(rotation, status);
  const id = slot === null ? undefined : rotation.entries[slot]?.zoneAlternator;
  return id ? zoneLayoutName(id) : undefined;
};

// The layout noted for the match that started at `startedAt`; nothing when none was.
export const zoneOfMatch = (notes: readonly MatchZone[], startedAt: number): string | undefined => notes.find((n) => n.startedAt === startedAt)?.zone;
