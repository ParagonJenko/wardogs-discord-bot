import { z } from 'zod';

// What staff switched off for map votes with /voteoptions: rain (no vote offers or chooses a rain lighting) and maps (never
// offered, and never picked by the Random map). Kept as 'mapVoteOptions'. It applies from the next vote that opens; a vote
// that is open keeps the options it was posted with. /setnextmap and rotations can still use what is switched off.

export const VOTE_OPTIONS_KEY = 'mapVoteOptions';

// When it was switched off, and by whom: `by` is the Discord user ID, with `byName`, the name they go by in the server.
export type VoteChange = { at: number; by: string; byName?: string };

// `noRain` is set while rain is off; `offMaps` has the id of each map that is off.
export type VoteOptions = { noRain: VoteChange | null; offMaps: Record<string, VoteChange> };

const ChangeSchema = z.object({ at: z.number(), by: z.string(), byName: z.string().optional() });
const VoteOptionsSchema = z.object({
  noRain: ChangeSchema.nullable().default(null),
  offMaps: z.record(z.string(), ChangeSchema).default({}),
});

export const parseVoteOptions = (raw: unknown): VoteOptions => {
  const parsed = VoteOptionsSchema.safeParse(raw);
  return parsed.success ? parsed.data : { noRain: null, offMaps: {} };
};

export const offMapIds = (options: VoteOptions): string[] => Object.keys(options.offMaps);

const change = (by: string, byName: string | undefined, now: number): VoteChange => ({ at: now, by, ...(byName === undefined ? {} : { byName }) });

// Turns rain on or off. Null when it already was, so it stays as it was.
export const withRain = (options: VoteOptions, on: boolean, by: string, byName: string | undefined, now: number): VoteOptions | null => {
  if (on === (options.noRain === null)) return null;
  return { ...options, noRain: on ? null : change(by, byName, now) };
};

// Turns a map on or off. Null when it already was.
export const withMap = (options: VoteOptions, map: string, on: boolean, by: string, byName: string | undefined, now: number): VoteOptions | null => {
  if (on === (options.offMaps[map] === undefined)) return null;
  if (on) {
    const { [map]: _on, ...rest } = options.offMaps;
    return { ...options, offMaps: rest };
  }
  return { ...options, offMaps: { ...options.offMaps, [map]: change(by, byName, now) } };
};
