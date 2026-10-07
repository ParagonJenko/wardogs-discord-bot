import { z } from 'zod';
import { readJsonBody } from './body.ts';
import { MAX_LENGTH } from './messages.ts';
import { dayOf } from './stats.ts';
import { namedTag, namedWeapons, weaponName, type FeedKill, type NamedWeapon } from './weapons.ts';

// Weapon rules: weapons the server does not allow, such as the Humvee's gun, and what the bot does when someone kills
// with one. Staff set them on the staff page's Weapon rules tab: for each rule, the weapons, whether the bot warns the
// player in game, warns and then kicks, or kicks straight away, and the messages it sends. The bot sees each kill in
// the game's kill feed a second or two after it happens, so it acts then. Kept in 'weaponRules' once staff change
// anything; until then the rules are the presets below, all off.

export const RULES_KEY = 'weaponRules';

// What the bot does about a kill with a rule's weapon: nothing, a private warning in game, warnings and then a kick
// once the player has had `warnings` of them that day, or a kick straight away.
export const MODES = ['off', 'warn', 'warn-kick', 'kick'] as const;
export type RuleMode = (typeof MODES)[number];

export const MAX_RULES = 20;
export const MAX_RULE_WEAPONS = 20;
export const MAX_RULE_NAME = 40;
// With warn-kick: the most warnings before the kick.
export const MAX_WARNINGS = 5;

// Kills within this long of the bot acting on a rule are the same offence: one burst from a gun, or kills before the
// player could read the warning, get one warning or one kick, not one for each kill.
export const SAME_OFFENCE_MS = 30_000;

export type WeaponRule = {
  id: string;
  name: string;
  // The kill feed's tags, as weapons.ts spells them.
  weapons: string[];
  mode: RuleMode;
  // With warn-kick: how many warnings before the kick, 1 to MAX_WARNINGS.
  warnings: number;
  // The warning, and the kick's reason. Each may be blank when the mode does not use it.
  warning: string;
  kick: string;
  // Who changed it last, and when (Discord user ID and name). Null for a preset staff never changed.
  changed: { at: number; by: string; byName: string } | null;
};

const HUMVEE_GUNS = ['Id.Vehicle.WeaponExtension.WHL_05.RingTurret', 'Id.Vehicle.WeaponExtension.WHL_05.RingMinigun'];
const KODIAK_GUNS = ['Id.Vehicle.WeaponExtension.WHL_02.SUV.RingTurret'];
const MGL = ['Id.Item.MMGL'];

// The rules before staff change anything: all off, with messages ready to use.
export const PRESET_RULES: WeaponRule[] = [
  {
    id: 'humvee-gunner',
    name: 'Humvee gunner',
    weapons: HUMVEE_GUNS,
    mode: 'off',
    warnings: 1,
    warning: 'No kills from the Humvee gun. It is not allowed on this server.',
    kick: 'Kills from the Humvee gun, which is not allowed on this server',
    changed: null,
  },
  {
    id: 'kodiak-gunner',
    name: 'Kodiak gunner',
    weapons: KODIAK_GUNS,
    mode: 'off',
    warnings: 1,
    warning: 'No kills from the Kodiak gun. It is not allowed on this server.',
    kick: 'Kills from the Kodiak gun, which is not allowed on this server',
    changed: null,
  },
  {
    id: 'mgl',
    name: 'MGL',
    weapons: MGL,
    mode: 'off',
    warnings: 1,
    warning: 'The MGL is not allowed on this server. Switch weapon.',
    kick: 'Using the MGL, which is not allowed on this server',
    changed: null,
  },
];

const RuleSchema = z.object({
  id: z.string().min(1).max(40),
  name: z.string().min(1),
  weapons: z.array(z.string()).min(1),
  mode: z.enum(MODES),
  warnings: z.number().int().min(1).max(MAX_WARNINGS),
  warning: z.string(),
  kick: z.string(),
  changed: z.object({ at: z.number(), by: z.string(), byName: z.string() }).nullable(),
});

// Nothing saved yet is the presets. A rule that can't be read is dropped on its own, so the rest still work.
export const parseRules = (raw: unknown): WeaponRule[] => {
  const parsed = z.array(z.unknown()).safeParse(raw);
  if (!parsed.success) return PRESET_RULES;
  return parsed.data.flatMap((rule) => {
    const read = RuleSchema.safeParse(rule);
    return read.success ? [read.data] : [];
  });
};

// What the bot says around a rule's messages: where the rules are, after each of them.
export type RulesContext = {
  // "Rules: our Discord at gaminginit.com", as /warn and /kick add it.
  rulesNote: string;
  // Whether the bot takes the kill feed (KILL_FEED_TOKEN), without which it sees no kills.
  feed: boolean;
};

// The warning as it goes out. With warn-kick it says which warning it is, and the last says so.
export const warningPrefix = (mode: RuleMode, offence: number, warnings: number): string => {
  if (mode !== 'warn-kick') return 'Warning: ';
  return offence >= warnings ? 'Last warning: ' : `Warning ${offence} of ${warnings}: `;
};

// The longest the prefix can be, which every warning is checked with.
const LONGEST_PREFIX = Math.max(warningPrefix('warn', 1, 1).length, warningPrefix('warn-kick', MAX_WARNINGS - 1, MAX_WARNINGS).length);

const after = (context: Pick<RulesContext, 'rulesNote'>): string => ` | ${context.rulesNote}`;

export const warningText = (rule: WeaponRule, offence: number, context: Pick<RulesContext, 'rulesNote'>): string =>
  `${warningPrefix(rule.mode, offence, rule.warnings)}${rule.warning}${after(context)}`;

export const kickText = (rule: WeaponRule, context: Pick<RulesContext, 'rulesNote'>): string => `${rule.kick}${after(context)}`;

// The longest each message can be, so the whole of it fits on the game's one line.
export const messageLimits = (context: Pick<RulesContext, 'rulesNote'>): { warning: number; kick: number } => ({
  warning: MAX_LENGTH - LONGEST_PREFIX - after(context).length,
  kick: MAX_LENGTH - after(context).length,
});

// --- Changes from the staff page ---

const tidy = (text: string): string => text.replace(/\s+/g, ' ').trim();

// A rule as the page sends it: `id` null for a new one.
export type RuleDraft = {
  id: string | null;
  name: string;
  weapons: string[];
  mode: RuleMode;
  warnings: number;
  warning: string;
  kick: string;
};

export type RulesAction = ({ action: 'save' } & RuleDraft) | { action: 'remove'; id: string };

const RulesActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('save'),
    id: z.string().max(40).nullable(),
    name: z.string().max(200),
    weapons: z.array(z.string().max(200)).max(MAX_RULE_WEAPONS * 3),
    mode: z.enum(MODES),
    warnings: z.number().int(),
    warning: z.string().max(1_000),
    kick: z.string().max(1_000),
  }),
  z.object({ action: z.literal('remove'), id: z.string().max(40) }),
]);

const listOf = (items: string[]): string =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

// Staff's rules after a change, or why it can't be made. `newId` names a new rule.
export const editRules = (
  rules: WeaponRule[],
  action: RulesAction,
  context: Pick<RulesContext, 'rulesNote'>,
  who: { by: string; byName: string; now: number; newId: () => string },
): { rules: WeaponRule[] } | { problem: string } => {
  if (action.action === 'remove') {
    if (!rules.some((r) => r.id === action.id)) return { problem: 'That rule is gone already. Reload the page.' };
    return { rules: rules.filter((r) => r.id !== action.id) };
  }
  const old = action.id === null ? null : (rules.find((r) => r.id === action.id) ?? null);
  if (action.id !== null && old === null) return { problem: 'That rule is gone: someone took it out. Reload the page.' };
  if (old === null && rules.length >= MAX_RULES) return { problem: `There can be at most ${MAX_RULES} rules.` };
  const name = tidy(action.name);
  if (name === '') return { problem: 'Give the rule a name, such as "Humvee gunner".' };
  if (name.length > MAX_RULE_NAME) return { problem: `A rule's name can be at most ${MAX_RULE_NAME} characters.` };
  const others = rules.filter((r) => r.id !== old?.id);
  if (others.some((r) => r.name.toLowerCase() === name.toLowerCase())) return { problem: `There is a rule called "${name}" already.` };
  const weapons = [...new Set(action.weapons.map(namedTag))];
  if (weapons.includes(null)) return { problem: "The bot doesn't know one of those weapons. Reload the page." };
  const tags = weapons.filter((tag) => tag !== null);
  if (tags.length === 0) return { problem: 'Pick at least one weapon.' };
  if (tags.length > MAX_RULE_WEAPONS) return { problem: `A rule can have at most ${MAX_RULE_WEAPONS} weapons.` };
  for (const other of others) {
    const shared = [...new Set(tags.filter((tag) => other.weapons.includes(tag)).map(weaponName))];
    if (shared.length > 0) return { problem: `${listOf(shared)} ${shared.length === 1 ? 'is' : 'are'} in the "${other.name}" rule already.` };
  }
  if (action.warnings < 1 || action.warnings > MAX_WARNINGS) return { problem: `Warnings before the kick: 1 to ${MAX_WARNINGS}.` };
  const warning = tidy(action.warning);
  const kick = tidy(action.kick);
  const limits = messageLimits(context);
  const warns = action.mode === 'warn' || action.mode === 'warn-kick';
  const kicks = action.mode === 'kick' || action.mode === 'warn-kick';
  if (warns && warning === '') return { problem: 'Write the warning the bot sends.' };
  if (kicks && kick === '') return { problem: 'Write the reason the bot gives with the kick.' };
  if (warning.length > limits.warning) return { problem: `The warning is ${warning.length - limits.warning} characters too long for the game.` };
  if (kick.length > limits.kick) return { problem: `The kick reason is ${kick.length - limits.kick} characters too long for the game.` };
  const rule: WeaponRule = {
    id: old?.id ?? who.newId(),
    name,
    weapons: tags,
    mode: action.mode,
    warnings: action.warnings,
    warning,
    kick,
    changed: { at: who.now, by: who.by, byName: who.byName },
  };
  return { rules: old === null ? [...rules, rule] : rules.map((r) => (r.id === old.id ? rule : r)) };
};

// --- Offences ---

export const RULE_BREAKS_KEY = 'ruleBreaks';

// Today's offences (UTC): by Steam ID and rule, how many and when the bot last acted on one; and by rule, what the bot
// did. A new day starts from nothing, so a warning from yesterday never leads to a kick today.
export type RuleBreaks = {
  day: string;
  players: Record<string, Record<string, { offences: number; at: number }>>;
  done: Record<string, { warned: number; kicked: number }>;
};

const count = z.number().int().nonnegative();

const RuleBreaksSchema = z.object({
  day: z.string(),
  players: z.record(z.string(), z.record(z.string(), z.object({ offences: count, at: z.number() }))),
  done: z.record(z.string(), z.object({ warned: count, kicked: count })),
});

const emptyBreaks = (day: string): RuleBreaks => ({ day, players: {}, done: {} });

// Today's offences, from nothing on a new day or when nothing can be read.
export const parseRuleBreaks = (raw: unknown, now: number): RuleBreaks => {
  const parsed = RuleBreaksSchema.safeParse(raw);
  return parsed.success && parsed.data.day === dayOf(now) ? parsed.data : emptyBreaks(dayOf(now));
};

// What the bot does about one player and one rule: `offence` is their offences against it today, this one included.
// `weapon` names what the latest of `kills` was with.
export type RuleCall = {
  steamId: string;
  name: string;
  rule: WeaponRule;
  act: 'warn' | 'kick';
  offence: number;
  kills: number;
  weapon: string;
};

// A batch's kills against the rules that are on. Null when none is a new offence, so nothing is saved. Kicks come first,
// and a player being kicked gets no warning with it.
export const judgeKills = (breaks: RuleBreaks, rules: WeaponRule[], kills: FeedKill[], now: number): { breaks: RuleBreaks; calls: RuleCall[] } | null => {
  const on = rules.filter((r) => r.mode !== 'off');
  const ruleOf = new Map(on.flatMap((r) => r.weapons.map((tag): [string, WeaponRule] => [tag.toLowerCase(), r])));
  const broken = new Map<string, { steamId: string; rule: WeaponRule; kills: FeedKill[] }>();
  for (const kill of kills) {
    const rule = ruleOf.get(kill.cause.toLowerCase());
    if (rule === undefined) continue;
    const key = `${kill.killerSteamId} ${rule.id}`;
    const known = broken.get(key) ?? { steamId: kill.killerSteamId, rule, kills: [] };
    known.kills.push(kill);
    broken.set(key, known);
  }
  if (broken.size === 0) return null;
  const players = Object.fromEntries(Object.entries(breaks.players).map(([steamId, theirs]) => [steamId, { ...theirs }]));
  const done = { ...breaks.done };
  const calls: RuleCall[] = [];
  for (const { steamId, rule, kills: theirs } of broken.values()) {
    const record = (players[steamId] ??= {});
    const before = record[rule.id] ?? { offences: 0, at: 0 };
    if (before.offences > 0 && now - before.at < SAME_OFFENCE_MS) continue;
    const offence = before.offences + 1;
    record[rule.id] = { offences: offence, at: now };
    const act = rule.mode === 'warn' || (rule.mode === 'warn-kick' && offence <= rule.warnings) ? 'warn' : 'kick';
    const tally = done[rule.id] ?? { warned: 0, kicked: 0 };
    done[rule.id] = act === 'warn' ? { ...tally, warned: tally.warned + 1 } : { ...tally, kicked: tally.kicked + 1 };
    const latest = theirs[theirs.length - 1];
    calls.push({
      steamId,
      name: latest?.killerName ?? '',
      rule,
      act,
      offence,
      kills: theirs.length,
      weapon: latest === undefined ? '' : weaponName(latest.cause),
    });
  }
  if (calls.length === 0) return null;
  const kicked = new Set(calls.filter((c) => c.act === 'kick').map((c) => c.steamId));
  const ordered = [...calls.filter((c) => c.act === 'kick'), ...calls.filter((c) => c.act === 'warn' && !kicked.has(c.steamId))];
  return { breaks: { day: breaks.day, players, done }, calls: ordered };
};

// What goes in the player's history and the moderation log.
export const callDetail = (call: RuleCall): string => {
  const which =
    call.act === 'kick'
      ? call.rule.mode === 'warn-kick'
        ? `kicked after ${call.rule.warnings === 1 ? 'a warning' : `${call.rule.warnings} warnings`}`
        : 'kicked'
      : call.rule.mode === 'warn-kick'
        ? `warning ${call.offence} of ${call.rule.warnings}`
        : 'warned';
  return `Weapon rule "${call.rule.name}": ${call.kills === 1 ? 'a kill' : `${call.kills} kills`} with the ${call.weapon}, ${which}`;
};

// --- The page ---

export type RulesPage = {
  feed: boolean;
  // What the bot puts after each message, and the longest each message can be.
  after: string;
  limits: { warning: number; kick: number };
  maxRules: number;
  maxWeapons: number;
  maxWarnings: number;
  maxName: number;
  // Every weapon the bot has a name for.
  weapons: NamedWeapon[];
  rules: (WeaponRule & { today: { warned: number; kicked: number } })[];
};

export const buildRulesPage = (rules: WeaponRule[], breaks: RuleBreaks, context: RulesContext): RulesPage => ({
  feed: context.feed,
  after: after(context),
  limits: messageLimits(context),
  maxRules: MAX_RULES,
  maxWeapons: MAX_RULE_WEAPONS,
  maxWarnings: MAX_WARNINGS,
  maxName: MAX_RULE_NAME,
  weapons: namedWeapons(),
  rules: rules.map((rule) => ({ ...rule, today: breaks.done[rule.id] ?? { warned: 0, kicked: 0 } })),
});

export type RulesActionResult = { problem: string } | RulesPage;

// 20 rules' worth of weapons and messages are well under this.
export const RULES_BODY_BYTES = 16_384;

// A change from the page, or null when it is not one.
export const readRulesAction = async (request: Request, limit = RULES_BODY_BYTES): Promise<RulesAction | null> => {
  const parsed = RulesActionSchema.safeParse(await readJsonBody(request, limit));
  return parsed.success ? parsed.data : null;
};
