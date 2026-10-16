import { z } from 'zod';
import { readJsonBody } from './body.ts';

// "Dealt with": a staff member looked at a player on the staff page's Queue (everyone the bot flagged in the period for
// headshots, a risky Steam account or possible griefing) and did what was needed, or found there was nothing to do. The
// page then leaves them off the Queue for all staff, in game or not, and says who dealt with them, until the bot flags
// them for something new. Each keeps what the page showed then: the reasons, the latest day flagged for headshots and
// for griefing, and the Steam account's risk score. So the page puts them back when a later day is flagged, a new reason
// comes up or the account gets riskier. Unlike "Checked, they're fine" (see checked.ts), it lasts beyond the day: each
// is kept for DEALT_DAYS, the page's longest period ('dealt').

export const DEALT_KEY = 'dealt';
export const DEALT_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;
// Far more than staff deal with in a month, and small enough to keep as one value. The oldest go first past it.
const MAX_DEALT = 300;

export const QUEUE_REASONS = ['headshots', 'steam', 'griefing'] as const;
export type QueueReason = (typeof QUEUE_REASONS)[number];

// `by`: the staff member's Discord user ID, and `byName` what they went by then. `headshotDay` and `griefDay` are the
// latest UTC day ('2026-10-16') the page showed them flagged on for each, or null; `steamScore` their account's risk
// score then, or null when it was not risky.
export type Dealt = {
  by: string;
  byName: string;
  at: number;
  reasons: QueueReason[];
  headshotDay: string | null;
  griefDay: string | null;
  steamScore: number | null;
};

const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const SCORE = z.number().int().min(0).max(1_000);

const DealtSchema = z.object({
  by: z.string(),
  byName: z.string(),
  at: z.number(),
  reasons: z.array(z.enum(QUEUE_REASONS)),
  headshotDay: DAY.nullable(),
  griefDay: DAY.nullable(),
  steamScore: SCORE.nullable(),
});
const DealtBookSchema = z.record(z.string(), DealtSchema);

// Those dealt with in the last DEALT_DAYS, by Steam ID: nothing from anything else.
export const dealtLately = (raw: unknown, now: number): Record<string, Dealt> => {
  const parsed = DealtBookSchema.safeParse(raw);
  if (!parsed.success) return {};
  return Object.fromEntries(Object.entries(parsed.data).filter(([, d]) => now - d.at < DEALT_DAYS * DAY_MS));
};

// What the staff page asks: to note that a player was dealt with, with what the Queue showed for them, or to undo it.
export type DealtAction =
  | { action: 'deal'; steamId: string; reasons: QueueReason[]; headshotDay: string | null; griefDay: string | null; steamScore: number | null }
  | { action: 'undo'; steamId: string };

const STEAM_ID = z.string().regex(/^\d{17}$/);
const DealtActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('deal'),
    steamId: STEAM_ID,
    reasons: z.array(z.enum(QUEUE_REASONS)).max(QUEUE_REASONS.length),
    headshotDay: DAY.nullable(),
    griefDay: DAY.nullable(),
    steamScore: SCORE.nullable(),
  }),
  z.object({ action: z.literal('undo'), steamId: STEAM_ID }),
]);

// Far bigger than any real request.
const DEALT_BODY_BYTES = 1_024;

// Read in chunks and dropped once it is too big, so a body sent without a length can't fill the Worker's memory first.
export const readDealtAction = async (request: Request): Promise<DealtAction | null> => {
  const parsed = DealtActionSchema.safeParse(await readJsonBody(request, DEALT_BODY_BYTES));
  return parsed.success ? parsed.data : null;
};

// The last DEALT_DAYS of them with `action` applied by `user`, to store: the newest MAX_DEALT.
export const applyDealt = (raw: unknown, action: DealtAction, user: { id: string; name: string }, now: number): Record<string, Dealt> => {
  const { [action.steamId]: _was, ...rest } = dealtLately(raw, now);
  if (action.action === 'undo') return rest;
  const { headshotDay, griefDay, steamScore } = action;
  const reasons = QUEUE_REASONS.filter((r) => action.reasons.includes(r));
  const dealt: Dealt = { by: user.id, byName: user.name, at: now, reasons, headshotDay, griefDay, steamScore };
  const kept = Object.entries(rest)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, MAX_DEALT - 1);
  return Object.fromEntries([[action.steamId, dealt], ...kept]);
};
