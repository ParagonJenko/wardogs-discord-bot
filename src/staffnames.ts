import { z } from 'zod';

// Who staff are on Discord, by user ID, for the staff page. The bot's records name staff by Discord user ID: its bans
// only ever do, and so do staff history entries from before it kept names. It learns names as staff sign in to the
// staff page and use staff commands, and, with DISCORD_BOT_TOKEN, asks Discord for anyone it has not seen
// ('staffNames').

// `name` is the name they go by in the server (or on Discord, from a lookup); `username` their Discord username.
export type StaffName = { name: string; username: string | null; at: number };
export type StaffNames = Record<string, StaffName>;

export const STAFF_NAMES_KEY = 'staffNames';

// A name from a lookup is looked up again after this long, in case it changed.
export const STAFF_NAME_MS = 30 * 24 * 60 * 60_000;
// At most this many lookups for one staff page answer, one at a time, so a long history fills in over a few loads
// rather than in a burst Discord would rate limit.
export const LOOKUPS_PER_LOAD = 10;

// Discord user IDs (snowflakes). Anything else, such as "bot" or "server", is never looked up.
export const DISCORD_ID = /^\d{17,20}$/;

const StaffNamesSchema = z.record(z.string(), z.object({ name: z.string(), username: z.string().nullable(), at: z.number() }));

export const parseStaffNames = (raw: unknown): StaffNames => {
  const parsed = StaffNamesSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
};

// The directory with a name seen now, or null when it already had that name, so nothing needs writing.
export const noteStaffName = (names: StaffNames, id: string, name: string, username: string | null, at: number): StaffNames | null => {
  if (!DISCORD_ID.test(id) || name.trim() === '') return null;
  const known = names[id];
  // A name staff were seen with is kept fresh by seeing them again; it only needs writing when it changed, or is old.
  if (known !== undefined && known.name === name && known.username === username && at - known.at < STAFF_NAME_MS / 2) return null;
  return { ...names, [id]: { name, username, at } };
};

// The IDs to ask Discord about: never seen, or seen too long ago.
export const lookupsDue = (names: StaffNames, ids: Iterable<string>, now: number): string[] =>
  [...new Set(ids)].filter((id) => DISCORD_ID.test(id) && (names[id] === undefined || now - names[id].at >= STAFF_NAME_MS)).slice(0, LOOKUPS_PER_LOAD);

const UserSchema = z.object({ id: z.string(), username: z.string(), global_name: z.string().nullish() });

// A Discord user, by ID, with the bot's token. Null for an ID Discord does not know.
export const fetchDiscordUser = async (
  token: string,
  id: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ name: string; username: string } | null> => {
  if (!DISCORD_ID.test(id)) return null;
  const response = await fetchFn(`https://discord.com/api/v10/users/${id}`, {
    headers: { authorization: `Bot ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Discord did not say who user ${id} is: ${response.status}`);
  const user = UserSchema.parse(await response.json());
  return { name: user.global_name || user.username, username: user.username };
};
