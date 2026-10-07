import { z } from 'zod';
import { dayOf } from './stats.ts';

// "Checked, they're fine": a staff member looked at a player the staff page says is worth a look and found nothing to
// act on. The page then leaves them out of its "Worth a look now" list for the rest of the UTC day, for all staff, and
// says who checked them. Each check keeps what the player was flagged for then (their reasons, team kills and vehicle
// suicides today), so the page puts them back when more comes up. Only today's checks are kept ('checked').

export const CHECKED_KEY = 'checked';

// Why the page said a player was worth a look: banned, flagged for griefing or headshots today, or a risky Steam account.
export const CHECK_REASONS = ['banned', 'griefing', 'headshots', 'steam'] as const;
export type CheckReason = (typeof CHECK_REASONS)[number];

// `by`: the staff member's Discord user ID, and `byName` what they went by then.
export type Check = { by: string; byName: string; at: number; reasons: CheckReason[]; teamKills: number; vehicleSuicides: number };
export type CheckedDay = { day: string; players: Record<string, Check> };

const CheckSchema = z.object({
  by: z.string(),
  byName: z.string(),
  at: z.number(),
  reasons: z.array(z.enum(CHECK_REASONS)),
  teamKills: z.number(),
  vehicleSuicides: z.number(),
});
const CheckedDaySchema = z.object({ day: z.string(), players: z.record(z.string(), CheckSchema) });

// Today's checks, by Steam ID: none from an earlier day, or from anything else.
export const checkedToday = (raw: unknown, now: number): Record<string, Check> => {
  const parsed = CheckedDaySchema.safeParse(raw);
  return parsed.success && parsed.data.day === dayOf(now) ? parsed.data.players : {};
};

// What the staff page asks: to note that a player was checked, with what they were flagged for as the page showed it,
// or to take a check back.
export type CheckAction =
  | { action: 'check'; steamId: string; reasons: CheckReason[]; teamKills: number; vehicleSuicides: number }
  | { action: 'uncheck'; steamId: string };

const STEAM_ID = z.string().regex(/^\d{17}$/);
const COUNT = z.number().int().min(0).max(100_000);
const CheckActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('check'),
    steamId: STEAM_ID,
    reasons: z.array(z.enum(CHECK_REASONS)).max(CHECK_REASONS.length),
    teamKills: COUNT,
    vehicleSuicides: COUNT,
  }),
  z.object({ action: z.literal('uncheck'), steamId: STEAM_ID }),
]);

// Far bigger than any real request.
const CHECK_BODY_BYTES = 1_024;

export const readCheckAction = async (request: Request): Promise<CheckAction | null> => {
  if (Number(request.headers.get('content-length') ?? 0) > CHECK_BODY_BYTES) return null;
  const body = await request.arrayBuffer();
  if (body.byteLength > CHECK_BODY_BYTES) return null;
  try {
    const parsed = CheckActionSchema.safeParse(JSON.parse(new TextDecoder().decode(body)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

// Today's checks with `action` applied by `user`, to store. A check from an earlier day is dropped.
export const applyCheck = (raw: unknown, action: CheckAction, user: { id: string; name: string }, now: number): CheckedDay => {
  const { [action.steamId]: _was, ...rest } = checkedToday(raw, now);
  if (action.action === 'uncheck') return { day: dayOf(now), players: rest };
  const reasons = CHECK_REASONS.filter((r) => action.reasons.includes(r));
  const check: Check = { by: user.id, byName: user.name, at: now, reasons, teamKills: action.teamKills, vehicleSuicides: action.vehicleSuicides };
  return { day: dayOf(now), players: { ...rest, [action.steamId]: check } };
};
