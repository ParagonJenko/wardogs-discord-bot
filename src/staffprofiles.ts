import { z } from 'zod';
import { DISCORD_ID } from './staffnames.ts';

// Staff profiles: each staff member links their Steam account to their Discord sign-in on the staff page, so the bot
// knows them in game. Their time on the server then counts as playing, never seeding (see withoutStaffSeeding in
// players.ts): seeder VIP and the top seeders lists are for the players who seed, not for staff. Kept by Discord user
// ID ('staffProfiles').

// `name`: what they went by on Discord when they last linked it.
export type StaffProfile = { steamId: string; name: string; at: number };
export type StaffProfiles = Record<string, StaffProfile>;

export const STAFF_PROFILES_KEY = 'staffProfiles';

const StaffProfilesSchema = z.record(z.string(), z.object({ steamId: z.string(), name: z.string(), at: z.number() }));

export const parseStaffProfiles = (raw: unknown): StaffProfiles => {
  const parsed = StaffProfilesSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
};

// Every linked staff member's Steam ID.
export const staffSteamIds = (profiles: StaffProfiles): Set<string> => new Set(Object.values(profiles).map((p) => p.steamId));

// The same, with the name each goes by on Discord, for their staff spots (see vip.ts).
export const staffBySteam = (profiles: StaffProfiles): Map<string, string> =>
  new Map(Object.values(profiles).map((p) => [p.steamId, p.name]));

// A Steam64 ID: 17 digits, starting 7656119.
const STEAM64 = /^7656119\d{10}$/;
const PROFILE_LINK = /^(?:https?:\/\/)?(?:www\.)?steamcommunity\.com\/profiles\/(\d+)\/?(?:[?#].*)?$/i;

// The Steam ID staff typed or pasted: the ID itself, or their profile's link (steamcommunity.com/profiles/<ID>). Null
// for anything else, such as a custom link (steamcommunity.com/id/<name>), which does not have the ID in it.
export const readSteamId = (input: string): string | null => {
  const text = input.trim();
  const id = PROFILE_LINK.exec(text)?.[1] ?? text;
  return STEAM64.test(id) ? id : null;
};

export const NOT_A_STEAM_ID =
  'That is not a Steam64 ID. It is 17 digits and starts with 7656119. A link like steamcommunity.com/id/name does not have it in it: see "How to find it".';

// Links a staff member's Steam account, or changes the one they linked. A Steam account is linked to one staff member at
// a time, so a typo cannot take someone else's.
export const linkSteam = (
  profiles: StaffProfiles,
  user: { id: string; name: string },
  input: string,
  now: number,
): { profiles: StaffProfiles; steamId: string } | { problem: string } => {
  const steamId = readSteamId(input);
  if (steamId === null) return { problem: NOT_A_STEAM_ID };
  const owner = Object.entries(profiles).find(([id, p]) => id !== user.id && p.steamId === steamId)?.[1];
  if (owner !== undefined) return { problem: `That Steam account is already linked to ${owner.name}. They can unlink it on the staff page.` };
  return { profiles: { ...profiles, [user.id]: { steamId, name: user.name, at: now } }, steamId };
};

// Takes a staff member's link off, so their time counts as seeding again: for someone who linked the wrong account, or
// is no longer staff.
export const unlinkSteam = (profiles: StaffProfiles, userId: string): StaffProfiles => {
  const { [userId]: _unlinked, ...rest } = profiles;
  return rest;
};

// What the staff page asks: to link the signed-in staff member's Steam account, or to unlink theirs (no `userId`) or
// another staff member's.
export type ProfileAction = { action: 'link'; steamId: string } | { action: 'unlink'; userId?: string };

const ProfileActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('link'), steamId: z.string().max(200) }),
  z.object({ action: z.literal('unlink'), userId: z.string().regex(DISCORD_ID).optional() }),
]);

// Far bigger than any real request.
const PROFILE_BODY_BYTES = 1_024;

export const readProfileAction = async (request: Request): Promise<ProfileAction | null> => {
  if (Number(request.headers.get('content-length') ?? 0) > PROFILE_BODY_BYTES) return null;
  const body = await request.arrayBuffer();
  if (body.byteLength > PROFILE_BODY_BYTES) return null;
  try {
    const parsed = ProfileActionSchema.safeParse(JSON.parse(new TextDecoder().decode(body)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};
