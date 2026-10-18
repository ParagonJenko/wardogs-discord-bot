import { z } from 'zod';
import { currentExperience, MODIFIERS } from './matchsetup.ts';
import type { MatchSetup, Rotation } from './rcon.ts';
import type { MapChoice } from './rotationspage.ts';

// A game server that cold starts (a restart, the daily one included) has been seen to load a Bakurani match that is not
// infantry only, whatever its rotation says, and the server's API does not say which modifiers the match on now has. The
// server is meant to play infantry only, so the bot notices a server come back from not answering and, while its new match
// has no points yet, changes to an infantry only map, as /changemap does. Nothing here touches the server or storage: the
// Watcher (worker.ts) fetches, changes the map and remembers.

export const RESTART_WATCH_KEY = 'restartWatch';

// How long after a restart is seen the bot keeps trying to change the map (the server may not answer for a moment). Later
// than that, the match on now is left alone.
export const RESTART_WINDOW_MS = 10 * 60_000;

// `downSince`: when the server last stopped answering, until it answers again. `pendingSince`: when it came back, until the
// map has been checked (and changed, if it needed it).
export type RestartWatch = { downSince: number | null; pendingSince: number | null };

export const NO_RESTART: RestartWatch = { downSince: null, pendingSince: null };

const RestartWatchSchema = z.object({ downSince: z.number().nullable(), pendingSince: z.number().nullable() });

export const parseRestartWatch = (raw: unknown): RestartWatch => {
  const parsed = RestartWatchSchema.safeParse(raw);
  return parsed.success ? parsed.data : NO_RESTART;
};

// One check: `answered` is whether the server answered. A server that stops answering and then answers again has
// restarted. `due` is whether its map should be looked at now.
export const watchRestart = (watch: RestartWatch, answered: boolean, now: number): { watch: RestartWatch; due: boolean } => {
  if (!answered) return { watch: { ...watch, downSince: watch.downSince ?? now }, due: false };
  const pendingSince = watch.downSince === null ? watch.pendingSince : now;
  const pending = pendingSince !== null && now - pendingSince <= RESTART_WINDOW_MS ? pendingSince : null;
  return { watch: { downSince: null, pendingSince: pending }, due: pending !== null };
};

// The watch once the map has been looked at: nothing more to do until the next restart.
export const settled = (watch: RestartWatch): RestartWatch => ({ ...watch, pendingSince: null });

const INFANTRY_ONLY = MODIFIERS[0].pattern;

export const isInfantryOnly = (experiences: readonly string[] | undefined): boolean =>
  (experiences ?? []).some((id) => INFANTRY_ONLY.test(id));

export type InfantryMap = { map: string; setup: MatchSetup };

// The first entry of the rotation, from `from` on and going round, that is played infantry only, with the setup the rotation
// gives it (a retired experience swapped for its replacement, as /changemap does). A restart starts from where the list
// starts, so that is where the search starts. Null when the rotation has none.
export const infantryFromRotation = (rotation: Rotation, from = 0): InfantryMap | null => {
  const n = rotation.entries.length;
  for (let step = 0; step < n; step += 1) {
    const entry = rotation.entries[(from + step) % n];
    if (entry === undefined || !isInfantryOnly(entry.experiences)) continue;
    return {
      map: entry.map,
      setup: {
        experiences: (entry.experiences ?? []).map(currentExperience),
        ...(entry.lighting ? { lighting: entry.lighting } : {}),
        ...(entry.zoneAlternator ? { zoneAlternator: entry.zoneAlternator } : {}),
      },
    };
  }
  return null;
};

// Whether the match on now has only just started: a restart is not told from a failed check by the server answering again,
// so a match with points on the board (or with no scores to read) is left to finish.
export const justStarted = (scores: readonly { score: number }[]): boolean => scores.length > 0 && scores.every((s) => s.score === 0);

// The maps that can be played infantry only (as the map vote offers them), other than the one playing, or the one playing
// when it is the only one: it is then loaded again with infantry only.
export const infantryMaps = (maps: readonly MapChoice[], playing: string): MapChoice[] => {
  const eligible = maps.filter((m) => m.modes.length > 0 && m.modifiers.some((x) => x.key === 'infantry_only'));
  const others = eligible.filter((m) => m.id !== playing);
  return others.length > 0 ? others : eligible;
};
