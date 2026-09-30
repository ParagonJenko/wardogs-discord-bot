import { z } from 'zod';
import type { VipRule } from './config.ts';
import { totals, type PlayerDay } from './players.ts';
import type { ConfigResult, ServerConfig } from './rcon.ts';

// Automatic VIP: players who seed on enough days in a week get a reserved slot for a week. The bot adds them to
// the reserved list in ServerSettings.ini (live builds have no other way to change it) and takes them off again when
// their week is up, unless they have earned another. It only ever removes players it added itself, so reserved slots
// an admin gave out by hand are left alone. The server reads the list when it restarts.

export type VipGrant = { name: string; grantedAt: number; expiresAt: number };

// The players the bot put on the reserved list, by Steam ID.
// `revoked`: players staff took VIP from, by Steam ID, and until when automatic VIP must not give it back.
export type VipState = { granted: Record<string, VipGrant>; checkedAt: number; revoked: Record<string, number> };

export const VIP_CHECK_MS = 10 * 60_000;

const DAY_MS = 24 * 60 * 60_000;

const VipStateSchema = z.object({
  granted: z.record(z.string(), z.object({ name: z.string(), grantedAt: z.number(), expiresAt: z.number() })),
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

// Who has earned VIP: enough seed days in the days given (the rule's window, ending today).
export const qualified = (days: PlayerDay[], rule: VipRule): { steamId: string; name: string }[] =>
  totals(days)
    .filter((p) => p.seedDays >= rule.seedDays)
    .map(({ steamId, name }) => ({ steamId, name }));

// The reserved list lives in this section as `+DefaultReservedPlayerIds=<Steam ID>` lines.
const SECTION = '[/Script/WDGame.WDGameSession]';
const ENTRY = /^\s*[+.]?DefaultReservedPlayerIds\s*=\s*"?(.*?)"?\s*$/i;
// `-Key=` and `!Key=` remove entries; the bot does not try to work out what they leave, so it stops instead.
const OTHER_EDIT = /^\s*[-!]DefaultReservedPlayerIds\s*=/i;
const STEAM_ID = /^\d{17}$/;

const isHeader = (line: string): boolean => /^\s*\[.*\]\s*$/.test(line);
const entryId = (line: string): string | null => ENTRY.exec(line)?.[1] ?? null;

const sectionRange = (lines: string[]): { start: number; end: number } => {
  const starts = lines.flatMap((line, i) => (line.trim().toLowerCase() === SECTION.toLowerCase() ? [i] : []));
  if (starts.length > 1) throw new Error(`ServerSettings.ini has ${SECTION} more than once`);
  const start = starts[0] ?? -1;
  if (start === -1) return { start, end: -1 };
  const next = lines.findIndex((line, i) => i > start && isHeader(line));
  const end = next === -1 ? lines.length : next;
  if (lines.slice(start + 1, end).some((line) => OTHER_EDIT.test(line))) {
    throw new Error('ServerSettings.ini removes reserved players with - or ! lines; edit those by hand first');
  }
  return { start, end };
};

export const reservedIds = (text: string): string[] => {
  const lines = text.split(/\r?\n/);
  const { start, end } = sectionRange(lines);
  if (start === -1) return [];
  return lines.slice(start + 1, end).flatMap((line) => entryId(line) ?? []);
};

// Adds and removes reserved players, leaving every other line as it was.
export const editReserved = (text: string, add: string[], remove: string[]): string => {
  if (![...add, ...remove].every((id) => STEAM_ID.test(id))) throw new Error('refusing to write something that is not a Steam ID');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const { start, end } = sectionRange(lines);
  const added = add.map((id) => `+DefaultReservedPlayerIds=${id}`);
  if (start === -1) {
    const body = lines.at(-1) === '' ? lines.slice(0, -1) : lines;
    return [...body, ...(body.length > 0 ? [''] : []), SECTION, ...added, ''].join(eol);
  }
  const drop = new Set(remove);
  const section = lines.slice(start + 1, end).filter((line) => !drop.has(entryId(line) ?? ''));
  // New entries go after the last existing one, or straight under the section header.
  const last = section.findLastIndex((line) => entryId(line) !== null);
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
  const grant = (name: string): VipGrant => ({ name, grantedAt: now, expiresAt: now + rule.lengthDays * DAY_MS });

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

const refused = (result: ConfigResult): string | null => {
  if (!result.ok) return `the server refused the change: ${result.errors.join('; ') || 'no reason given'}`;
  if (result.ignored.some((item) => /DefaultReservedPlayerIds/i.test(item))) {
    return 'the server ignores DefaultReservedPlayerIds edits (it may be set by a launch argument)';
  }
  return null;
};

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
// It also lifts any block from /vip remove, even for a player who already has a reserved slot by hand.
export const addVip = async (
  { steamId, name, days, now, state, rcon }: { steamId: string; name: string; days: number; now: number; state: VipState; rcon: VipRcon },
): Promise<VipChange> => {
  const config = await rcon.fetchConfig();
  const onList = reservedIds(config.text).includes(steamId);
  const current = state.granted[steamId];
  const { [steamId]: _unblocked, ...revoked } = state.revoked;
  if (onList && current === undefined) return { state: { ...state, revoked }, outcome: 'already-reserved' };
  if (!onList) await writeReserved(rcon, config, [steamId], []);
  const expiresAt = Math.max(onList ? (current?.expiresAt ?? 0) : 0, now + days * DAY_MS);
  return {
    state: { ...state, revoked, granted: { ...state.granted, [steamId]: { name, grantedAt: current?.grantedAt ?? now, expiresAt } } },
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
