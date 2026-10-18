import { z } from 'zod';

// Blocked circles (control-zone layouts): ones staff don't like, which a map vote never gives a winning map. Set with /circles
// block. Kept by the layout's id ('blockedCircles'). Staff can still set one with /setnextmap or in a rotation, and a map left
// with no layout that is not blocked keeps the layout its rotation has.

export const BLOCKED_CIRCLES_KEY = 'blockedCircles';

// `map` is the map's id and `name` the layout's name when it was blocked. `by` is the Discord user ID of who did it, with
// `byName`, the name they go by in the server.
export type BlockedCircle = { map: string; name: string; at: number; by: string; byName?: string };
export type BlockedCircles = Record<string, BlockedCircle>;

const BlockedCirclesSchema = z.record(
  z.string(),
  z.object({ map: z.string(), name: z.string(), at: z.number(), by: z.string(), byName: z.string().optional() }),
);

export const parseBlockedCircles = (raw: unknown): BlockedCircles => {
  const parsed = BlockedCirclesSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
};

export const blockedCircleIds = (circles: BlockedCircles): string[] => Object.keys(circles);

// Blocks a layout. Null when it already was, so it stays as it was.
export const blockCircle = (
  circles: BlockedCircles,
  circle: { id: string; map: string; name: string },
  by: string,
  byName: string | undefined,
  now: number,
): BlockedCircles | null => {
  if (circles[circle.id] !== undefined) return null;
  return { ...circles, [circle.id]: { map: circle.map, name: circle.name, at: now, by, ...(byName === undefined ? {} : { byName }) } };
};

// Unblocks a layout. Null when it was not blocked.
export const unblockCircle = (circles: BlockedCircles, id: string): BlockedCircles | null => {
  if (circles[id] === undefined) return null;
  const { [id]: _unblocked, ...rest } = circles;
  return rest;
};
