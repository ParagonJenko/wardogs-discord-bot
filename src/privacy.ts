import { z } from 'zod';

// Private profiles: players staff made private with /private add. Everywhere the public sees, on the website and in
// the bot's public Discord posts and commands, they go by PRIVATE_NAME, with no player page and no place on the
// players list. Staff still see them as they are: the staff page, the staff commands and the moderation log. Kept by
// Steam ID ('privateProfiles').

export const PRIVATE_NAME = '[private profile]';

// `name`: what they went by when they were made private. `by`: the Discord user ID of who did it, with `byName`, the
// name they go by in the server.
export type PrivateProfile = { name: string; at: number; by: string; byName?: string };
export type PrivateProfiles = Record<string, PrivateProfile>;

export const PRIVATE_PROFILES_KEY = 'privateProfiles';

const PrivateProfilesSchema = z.record(
  z.string(),
  z.object({ name: z.string(), at: z.number(), by: z.string(), byName: z.string().optional() }),
);

export const parsePrivateProfiles = (raw: unknown): PrivateProfiles => {
  const parsed = PrivateProfilesSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
};

export const privateSteamIds = (profiles: PrivateProfiles): Set<string> => new Set(Object.keys(profiles));

// Makes a profile private. Null when it already was, so it stays as it was.
export const makePrivate = (
  profiles: PrivateProfiles,
  player: { steamId: string; name: string },
  by: string,
  byName: string | undefined,
  now: number,
): PrivateProfiles | null => {
  if (profiles[player.steamId] !== undefined) return null;
  return { ...profiles, [player.steamId]: { name: player.name, at: now, by, ...(byName === undefined ? {} : { byName }) } };
};

// Makes a profile public again. Null when it was not private.
export const makePublic = (profiles: PrivateProfiles, steamId: string): PrivateProfiles | null => {
  if (profiles[steamId] === undefined) return null;
  const { [steamId]: _public, ...rest } = profiles;
  return rest;
};

// How the public sees a player, by Steam ID: the id of their player page; null for a private profile, which has no
// page; undefined when there is no id for them.
export type PublicIdOf = (steamId: string) => string | null | undefined;

// The public's lookup: the ids `idOf` has, but none for a private profile.
export const publicIdOf =
  (hidden: ReadonlySet<string>, idOf: (steamId: string) => string | undefined): PublicIdOf =>
  (steamId) =>
    hidden.has(steamId) ? null : idOf(steamId);

// A player as the public sees them: their name, with their page's id when they have one, or PRIVATE_NAME and no page.
export const publicPlayer = (steamId: string | undefined, name: string, idOf: PublicIdOf): { name: string; id?: string } => {
  const id = steamId === undefined ? undefined : idOf(steamId);
  if (id === null) return { name: PRIVATE_NAME };
  return id === undefined ? { name } : { name, id };
};

// Rows for a public Discord post, with a private profile's name as PRIVATE_NAME.
export const publicNames = <T extends { steamId?: string | undefined; name: string }>(rows: readonly T[], hidden: ReadonlySet<string>): T[] =>
  rows.map((row) => (row.steamId !== undefined && hidden.has(row.steamId) ? { ...row, name: PRIVATE_NAME } : row));

// The same, for players kept by Steam ID.
export const publicNamesBySteamId = <T extends { name: string }>(players: Record<string, T>, hidden: ReadonlySet<string>): Record<string, T> =>
  Object.fromEntries(Object.entries(players).map(([steamId, p]) => [steamId, hidden.has(steamId) ? { ...p, name: PRIVATE_NAME } : p]));
