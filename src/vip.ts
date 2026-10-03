import { z } from 'zod';
import type { VipRule } from './config.ts';
import { appendSection, refusal, sectionLines, sectionRange } from './ini.ts';
import { totals, type PlayerDay } from './players.ts';
import type { ConfigResult, ServerConfig } from './rcon.ts';

// Automatic VIP: players who seed on enough days in a week get a reserved slot for a week. The bot adds them to
// the reserved list in ServerSettings.ini (live builds have no other way to change it) and takes them off again when
// their week is up, unless they have earned another. It only ever removes players it added itself, so reserved slots
// an admin gave out by hand are left alone. The server reads the list when it restarts.

// `source`: how they got it, by seeding or from staff with /vip add. Grants saved before the bot kept track have none,
// and count as seeding, as nearly all of them were; a staff grant among them is gone once its time is up.
export type VipGrant = { name: string; grantedAt: number; expiresAt: number; source?: 'seeding' | 'staff' };

// The players the bot put on the reserved list, by Steam ID.
// `revoked`: players staff took VIP from, by Steam ID, and until when automatic VIP must not give it back.
export type VipState = { granted: Record<string, VipGrant>; checkedAt: number; revoked: Record<string, number> };

export const VIP_CHECK_MS = 10 * 60_000;

const DAY_MS = 24 * 60 * 60_000;

const VipStateSchema = z.object({
  granted: z.record(
    z.string(),
    z.object({ name: z.string(), grantedAt: z.number(), expiresAt: z.number(), source: z.enum(['seeding', 'staff']).optional() }),
  ),
  checkedAt: z.number(),
  // Missing from state saved before staff could remove VIP.
  revoked: z.record(z.string(), z.number()).default({}),
});

// Reads what a store saved. Nothing saved yet means nobody has been given VIP.
export const parseVipState = (raw: unknown): VipState => {
  const parsed = VipStateSchema.safeParse(raw);
  return parsed.success ? parsed.data : { granted: {}, checkedAt: 0, revoked: {} };
};

export const vipDue = (state: VipState, now: number): boolean => now - state.checkedAt >= VIP_CHECK_MS;

export type SeederVip = { steamId: string; name: string; until: number };

// Who has VIP from seeding now, for the website: the latest to earn it first. By when they earned it, not when it
// ends, since staff can extend a seeder's VIP. Staff (`staff`, by Steam ID) are left off: one who earned it before
// linking their Steam account keeps it until it runs out, but it is not shown as a seeder's.
export const seederVip = (state: VipState, now: number, staff: ReadonlySet<string> = new Set()): SeederVip[] =>
  Object.entries(state.granted)
    .filter(([steamId, g]) => g.source !== 'staff' && g.expiresAt > now && !staff.has(steamId))
    .sort(([, a], [, b]) => b.grantedAt - a.grantedAt)
    .map(([steamId, g]) => ({ steamId, name: g.name, until: g.expiresAt }));

// Who has earned VIP: enough seed days in the days given (the rule's window, ending today).
export const qualified = (days: PlayerDay[], rule: VipRule): { steamId: string; name: string }[] =>
  totals(days)
    .filter((p) => p.seedDays >= rule.seedDays)
    .map(({ steamId, name }) => ({ steamId, name }));

// The reserved list lives in this section as `+DefaultReservedPlayerIds=<Steam ID>` lines.
const SECTION = '[/Script/WDGame.WDGameSession]';
// The game reads the list's lines in order, as Unreal does: `+` adds a player (once), `.` or no prefix adds them too,
// `-` takes one off, and `!` (as in `!DefaultReservedPlayerIds=ClearArray`) empties the list so far.
const LIST_LINE = /^\s*([+.!-]?)DefaultReservedPlayerIds\s*=\s*"?(.*?)"?\s*$/i;
const STEAM_ID = /^\d{17}$/;

type ListLine = { op: 'add' | 'remove' | 'clear'; id: string };

const listLine = (line: string): ListLine | null => {
  const match = LIST_LINE.exec(line);
  if (match === null) return null;
  return { op: match[1] === '!' ? 'clear' : match[1] === '-' ? 'remove' : 'add', id: match[2] ?? '' };
};
const addsId = (line: string): string | null => {
  const parsed = listLine(line);
  return parsed?.op === 'add' ? parsed.id : null;
};

// Who the lines leave on the list.
const applyLines = (lines: string[]): string[] =>
  lines.reduce<string[]>((ids, line) => {
    const parsed = listLine(line);
    if (parsed === null) return ids;
    if (parsed.op === 'clear') return [];
    if (parsed.op === 'remove') return ids.filter((id) => id !== parsed.id);
    return ids.includes(parsed.id) ? ids : [...ids, parsed.id];
  }, []);

export const reservedIds = (text: string): string[] => applyLines(sectionLines(text, SECTION));

// The reserved list for the staff page to show: everyone on it, and how many slots are held back for them
// (MaxReservedSlots, null when the file does not say).
export type ReservedListing = { ids: string[]; maxSlots: number | null };

const MAX_SLOTS = /^\s*MaxReservedSlots\s*=\s*"?(\d+)"?\s*$/i;

export const reservedListing = (text: string): ReservedListing => {
  const lines = sectionLines(text, SECTION);
  const slots = lines.flatMap((line) => MAX_SLOTS.exec(line)?.[1] ?? []).at(-1);
  return { ids: applyLines(lines), maxSlots: slots === undefined ? null : Number(slots) };
};

// Adds and removes reserved players, leaving every other line as it was. A player is removed by deleting the lines
// that add them; one is added by a line after the list's last line, so no `-` or `!` line before it takes them off.
export const editReserved = (text: string, add: string[], remove: string[]): string => {
  if (![...add, ...remove].every((id) => STEAM_ID.test(id))) throw new Error('refusing to write something that is not a Steam ID');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const { start, end } = sectionRange(lines, SECTION);
  const added = add.map((id) => `+DefaultReservedPlayerIds=${id}`);
  if (start === -1) return appendSection(text, SECTION, added);
  const drop = new Set(remove);
  const section = lines.slice(start + 1, end).filter((line) => !drop.has(addsId(line) ?? ''));
  // New entries go after the list's last line, or straight under the section header.
  const last = section.findLastIndex((line) => listLine(line) !== null);
  section.splice(last + 1, 0, ...added);
  return [...lines.slice(0, start + 1), ...section, ...lines.slice(end)].join(eol);
};

type Named = { steamId: string; name: string };

// `renewed` are players whose week was up but who earned it again, so they keep it for another week.
export type VipPlan = { add: Named[]; remove: string[]; renewed: Named[]; granted: Record<string, VipGrant> };

export const planVip = (
  earned: { steamId: string; name: string }[],
  reserved: string[],
  granted: Record<string, VipGrant>,
  now: number,
  rule: Pick<VipRule, 'lengthDays'>,
  revoked: Record<string, number> = {},
): VipPlan => {
  const onList = new Set(reserved);
  // Players staff took VIP from do not earn it again until their block runs out.
  const blocked = (id: string): boolean => (revoked[id] ?? 0) > now;
  const earners = new Map(
    earned.filter((p) => STEAM_ID.test(p.steamId) && !blocked(p.steamId)).map((p) => [p.steamId, p.name]),
  );
  const grant = (name: string): VipGrant => ({ name, grantedAt: now, expiresAt: now + rule.lengthDays * DAY_MS, source: 'seeding' });

  // Someone an admin took off the list is forgotten; if they have earned VIP, they are added again below.
  const current = Object.entries(granted).filter(([id]) => onList.has(id));
  const renewed: Named[] = [];
  const stays = current.flatMap(([id, g]): [string, VipGrant][] => {
    if (now < g.expiresAt) return [[id, g]];
    const name = earners.get(id);
    if (name === undefined) return [];
    renewed.push({ steamId: id, name });
    return [[id, grant(name)]];
  });
  const kept = new Set(stays.map(([id]) => id));
  const remove = current.map(([id]) => id).filter((id) => !kept.has(id));
  // Players already on the list without the bot's help (an admin's VIPs) are never touched.
  const add = [...earners].filter(([id]) => !onList.has(id)).map(([steamId, name]) => ({ steamId, name }));

  return {
    add,
    remove,
    renewed,
    granted: Object.fromEntries([...stays, ...add.map((p): [string, VipGrant] => [p.steamId, grant(p.name)])]),
  };
};

type VipDeps = {
  // Null when automatic VIP is off: nobody earns it, but VIP staff gave still ends on time.
  rule: VipRule | null;
  // The rule's window of days, ending today.
  days: PlayerDay[];
  state: VipState;
  now: number;
  rcon: {
    fetchConfig: () => Promise<ServerConfig>;
    validate: (text: string) => Promise<ConfigResult>;
    put: (config: ServerConfig) => Promise<ConfigResult>;
  };
  log: { info: (message: string) => void };
};

const refused = (result: ConfigResult): string | null => refusal(result, 'DefaultReservedPlayerIds');

const names = (players: Named[]): string => players.map((p) => `${p.name} (${p.steamId})`).join(', ');

type VipRcon = VipDeps['rcon'];

// Writes the reserved list, checking the result first. Throws with the reason when the server would refuse or ignore it.
const writeReserved = async (rcon: VipRcon, config: ServerConfig, add: string[], remove: string[]): Promise<void> => {
  if (!config.writable) throw new Error('the server settings are read-only over RCON');
  const text = editReserved(config.text, add, remove);
  const problem = refused(await rcon.validate(text)) ?? refused(await rcon.put({ ...config, text }));
  if (problem !== null) throw new Error(problem);
};

const unexpired = (revoked: Record<string, number>, now: number): Record<string, number> =>
  Object.fromEntries(Object.entries(revoked).filter(([, until]) => until > now));

// The new state to save, and who got VIP or kept it for another week, to announce.
export type VipSync = { state: VipState; added: Named[]; renewed: Named[] };

// Brings the reserved list in line with who has earned VIP. Throws if the server cannot be read or refuses the
// change; nothing is recorded then, so the next check tries again.
export const syncVip = async ({ rule, days, state, now, rcon, log }: VipDeps): Promise<VipSync> => {
  const config = await rcon.fetchConfig();
  const earned = rule === null ? [] : qualified(days, rule);
  const plan = planVip(earned, reservedIds(config.text), state.granted, now, rule ?? { lengthDays: 0 }, state.revoked);
  const done = (): VipSync => ({
    state: { granted: plan.granted, checkedAt: now, revoked: unexpired(state.revoked, now) },
    added: plan.add,
    renewed: plan.renewed,
  });
  if (plan.renewed.length > 0) log.info(`VIP renewed for another week: ${names(plan.renewed)}.`);
  if (plan.add.length === 0 && plan.remove.length === 0) return done();

  await writeReserved(rcon, config, plan.add.map((p) => p.steamId), plan.remove);

  const removed = plan.remove.map((steamId) => ({ steamId, name: state.granted[steamId]?.name ?? 'unknown' }));
  log.info(
    [
      ...(plan.add.length > 0 ? [`VIP added: ${names(plan.add)}.`] : []),
      ...(removed.length > 0 ? [`VIP ended: ${names(removed)}.`] : []),
      'The server uses the new reserved list after its next restart.',
    ].join(' '),
  );
  return done();
};

// What staff asked for, and what happened: `already-reserved` is a player on the list without the bot's help, who keeps
// what they have; `not-reserved` is a player who was not on the list.
export type VipChange = {
  state: VipState;
  outcome: 'added' | 'extended' | 'already-reserved' | 'removed' | 'not-reserved';
  until?: number;
};

// Gives a player VIP for `days`, as staff asked. It ends like any other: when the time is up, unless they earned it.
// It also lifts any block from /vip remove, even for a player who already has a reserved slot by hand. Longer VIP for
// a seeder still counts as theirs from seeding. `days` null makes it permanent: the bot puts them on the list and
// forgets any end it had for them, so, like a slot added by hand, it stays until staff remove it.
export const addVip = async (
  { steamId, name, days, now, state, rcon }: { steamId: string; name: string; days: number | null; now: number; state: VipState; rcon: VipRcon },
): Promise<VipChange> => {
  const config = await rcon.fetchConfig();
  const onList = reservedIds(config.text).includes(steamId);
  const current = state.granted[steamId];
  const { [steamId]: _unblocked, ...revoked } = state.revoked;
  if (onList && current === undefined) return { state: { ...state, revoked }, outcome: 'already-reserved' };
  if (!onList) await writeReserved(rcon, config, [steamId], []);
  if (days === null) {
    const { [steamId]: _forgotten, ...granted } = state.granted;
    return { state: { ...state, revoked, granted }, outcome: onList ? 'extended' : 'added' };
  }
  const expiresAt = Math.max(onList ? (current?.expiresAt ?? 0) : 0, now + days * DAY_MS);
  const source = onList ? (current?.source ?? 'seeding') : 'staff';
  return {
    state: { ...state, revoked, granted: { ...state.granted, [steamId]: { name, grantedAt: current?.grantedAt ?? now, expiresAt, source } } },
    outcome: onList ? 'extended' : 'added',
    until: expiresAt,
  };
};

// Takes a player off the reserved list, whoever put them there, and keeps automatic VIP from giving it back for a week.
export const removeVip = async (
  { steamId, now, state, rcon }: { steamId: string; now: number; state: VipState; rcon: VipRcon },
): Promise<VipChange> => {
  const config = await rcon.fetchConfig();
  const onList = reservedIds(config.text).includes(steamId);
  if (onList) await writeReserved(rcon, config, [], [steamId]);
  const { [steamId]: _removed, ...granted } = state.granted;
  return {
    state: { ...state, granted, revoked: { ...state.revoked, [steamId]: now + VIP_BLOCK_DAYS * DAY_MS } },
    outcome: onList ? 'removed' : 'not-reserved',
  };
};

const VIP_BLOCK_DAYS = 7;
