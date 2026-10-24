import { z } from 'zod';
import { zoneLayoutName } from './names.ts';
import { rotationSlot } from './rotations.ts';
import type { Rotation } from './rcon.ts';

// The circles (control-zone layout) the match on now is played on, kept while it goes on so the match is recorded with them
// when it ends: the server does not say which layout is live, only the rotation's entry for the slot it is on does. `key` is
// the match's key (its map and slot, see tracking.ts) and `zone` the layout's name, missing when the entry has none.
export const MATCH_ZONE_KEY = 'matchZone';

export type MatchZone = { key: string; zone?: string };

const MatchZoneSchema = z.object({ key: z.string(), zone: z.string().optional() });

export const parseMatchZone = (raw: unknown): MatchZone | null => {
  const parsed = MatchZoneSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

// The name of the layout the rotation has in the slot the server is on, when the entry sets one. A map played with its own
// layout has none to name.
export const zoneOfSlot = (rotation: Rotation, status: { rotationIndex: number | null; rotationNextIndex?: number }): string | undefined => {
  const slot = rotationSlot(rotation, status);
  const id = slot === null ? undefined : rotation.entries[slot]?.zoneAlternator;
  return id ? zoneLayoutName(id) : undefined;
};

// The layout noted for the match with this key; nothing when it was noted for another match.
export const zoneOfMatch = (noted: MatchZone | null, key: string): string | undefined => (noted?.key === key ? noted.zone : undefined);
