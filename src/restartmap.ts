import { z } from 'zod';
import { MODIFIERS } from './matchsetup.ts';
import type { MatchSetup, Rotation } from './rcon.ts';
import type { MapChoice } from './rotationspage.ts';

// When the game server restarts it starts from the first map of its rotation, which can be any map, infantry only or not.
// The server is meant to play infantry only after a restart, so the bot notices it come back and, if it is playing a map
// that is not infantry only, changes to one that is, as /changemap does. Nothing here touches the server or storage: the
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

// The map of the rotation the server is playing now, as the rotation marks it or the slot says.
export const playingEntry = (rotation: Rotation, slot: number | null): Rotation['entries'][number] | null =>
  slot === null ? null : (rotation.entries[slot] ?? null);

export type InfantryMap = { map: string; setup: MatchSetup };

// The next map in the rotation after `slot` that is played infantry only, other than the one playing, with the setup the
// rotation gives it. Null when the rotation has none.
export const infantryFromRotation = (rotation: Rotation, slot: number, playing: string): InfantryMap | null => {
  const n = rotation.entries.length;
  for (let step = 1; step <= n; step += 1) {
    const entry = rotation.entries[(slot + step) % n];
    if (entry === undefined || entry.map === playing || !isInfantryOnly(entry.experiences)) continue;
    return {
      map: entry.map,
      setup: {
        experiences: entry.experiences ?? [],
        ...(entry.lighting ? { lighting: entry.lighting } : {}),
        ...(entry.zoneAlternator ? { zoneAlternator: entry.zoneAlternator } : {}),
      },
    };
  }
  return null;
};

// The maps that can be played infantry only (as the map vote offers them), other than the one playing.
export const infantryMaps = (maps: readonly MapChoice[], playing: string): MapChoice[] =>
  maps.filter((m) => m.id !== playing && m.modes.length > 0 && m.modifiers.some((x) => x.key === 'infantry_only'));
