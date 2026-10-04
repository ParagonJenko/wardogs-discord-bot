import { z } from 'zod';
import { readJsonBody } from './body.ts';
import type { Config, VipRule } from './config.ts';
import { DEFAULT_LINES, type Lines } from './lines.ts';
import { fillLine, HALFWAY_START, halfwayCall, MAX_LENGTH, morePlayers, nearlyCall, nearlyScore, seedingReward } from './messages.ts';

// The staff page's Lines tab: staff put their own lines in place of any of the bot's lists (see lines.ts), and can go
// back to the bot's. Each list staff changed is kept in 'lines', by list id, with who changed it last; every other list
// is the bot's own, so a line reworded in lines.ts reaches it on the next deploy.

export const LINES_KEY = 'lines';

// The most lines a list can have.
export const MAX_LINES = 50;

// What the bot says around a list's lines, from its settings, so staff see whole messages and every line is checked to
// fit the game with them.
export type LinesContext = {
  // The website (SITE_URL), or null without one.
  siteHost: string | null;
  vip: VipRule | null;
  scoreToWin: number;
  live: number;
  // Whether the bot sends the match messages and the seeding messages.
  match: boolean;
  seeding: boolean;
};

export const linesContext = (config: Config): LinesContext => ({
  siteHost: config.seedingMessages?.siteHost ?? config.matchMessages?.siteHost ?? null,
  vip: config.vip,
  scoreToWin: config.scoreToWin,
  live: config.rules.live,
  match: config.matchMessages !== null,
  seeding: config.seedingMessages !== null,
});

// A list's placeholders, each with the value checked against (the longest it is likely to be) and shown in the
// preview, and what goes before and after its line.
type Frame = { values: Record<string, string>; before: string; after: string };

type ListDefinition = {
  id: string;
  // Lists with the same group show together. A list alone in its group has the group's name.
  group: string;
  name: string;
  // When it goes out, and what the bot adds to it.
  note: string;
  kind: 'seeding' | 'match';
  get: (lines: Lines) => string[];
  set: (lines: Lines, list: string[]) => Lines;
  frame: (context: LinesContext) => Frame;
};

const FACTIONS = [
  { key: 'lonestar', name: 'Lonestar' },
  { key: 'manticore', name: 'Manticore' },
  { key: 'valkyra', name: 'Valkyra' },
] as const;

// The match messages only go out with a website, so a list's preview without one stands in for it.
const site = (context: LinesContext): string => context.siteHost ?? 'your website';
const halfwayScore = (context: LinesContext): string => String(Math.ceil(context.scoreToWin / 2));
const halfwayAfter = (context: LinesContext): string => ` ${halfwayCall(site(context), context.vip)}`;
const nearlyAfter = (context: LinesContext): string => ` ${nearlyCall(site(context))}`;

// Every list, in the order the page shows them.
export const LISTS: ListDefinition[] = [
  {
    id: 'seeding',
    group: 'Seeding',
    name: 'Seeding',
    note: 'Every few minutes while the server seeds, and 30 seconds after someone joins. What seeding earns goes after it.',
    kind: 'seeding',
    get: (lines) => lines.seeding,
    set: (lines, seeding) => ({ ...lines, seeding }),
    frame: (context) => ({
      values: { needed: morePlayers(Math.max(1, context.live - 1)) },
      before: '',
      after: ` ${seedingReward(context.siteHost, context.vip)}`,
    }),
  },
  {
    id: 'tenMinutes',
    group: '10 minutes in',
    name: '10 minutes in',
    note: '10 minutes after the match goes live. The line is the whole message, so say where the rules and the website are.',
    kind: 'match',
    get: (lines) => lines.tenMinutes,
    set: (lines, tenMinutes) => ({ ...lines, tenMinutes }),
    frame: (context) => ({ values: { site: site(context) }, before: '', after: '' }),
  },
  ...FACTIONS.map(
    (faction): ListDefinition => ({
      id: `halfway.${faction.key}`,
      group: 'Halfway',
      name: faction.name,
      note: `When ${faction.name} is in front at half the winning score. "${HALFWAY_START}" goes before it, and seeding or the Discord after it.`,
      kind: 'match',
      get: (lines) => lines.halfway[faction.key] ?? [],
      set: (lines, list) => ({ ...lines, halfway: { ...lines.halfway, [faction.key]: list } }),
      frame: (context) => ({
        values: { team: faction.name, score: halfwayScore(context) },
        before: `${HALFWAY_START} `,
        after: halfwayAfter(context),
      }),
    }),
  ),
  {
    id: 'halfwayLevel',
    group: 'Halfway',
    name: 'Level scores',
    note: `At half the winning score when the top teams are level. These go in place of "${HALFWAY_START}", with seeding or the Discord after them.`,
    kind: 'match',
    get: (lines) => lines.halfwayLevel,
    set: (lines, halfwayLevel) => ({ ...lines, halfwayLevel }),
    frame: (context) => ({ values: {}, before: '', after: halfwayAfter(context) }),
  },
  {
    id: 'halfwayOther',
    group: 'Halfway',
    name: 'Any other team',
    note: `When a team without a list of its own is in front at half the winning score. "${HALFWAY_START}" goes before it, and seeding or the Discord after it.`,
    kind: 'match',
    get: (lines) => lines.halfwayOther,
    set: (lines, halfwayOther) => ({ ...lines, halfwayOther }),
    frame: (context) => ({
      values: { team: 'Other team', score: halfwayScore(context) },
      before: `${HALFWAY_START} `,
      after: halfwayAfter(context),
    }),
  },
  ...FACTIONS.map(
    (faction): ListDefinition => ({
      id: `nearly.${faction.key}`,
      group: 'Nearly won',
      name: faction.name,
      note: `When ${faction.name} is the first team to reach 90% of the winning score. The leaderboard goes after it.`,
      kind: 'match',
      get: (lines) => lines.nearly[faction.key] ?? [],
      set: (lines, list) => ({ ...lines, nearly: { ...lines.nearly, [faction.key]: list } }),
      frame: (context) => ({
        values: { team: faction.name, score: String(nearlyScore(context.scoreToWin)) },
        before: '',
        after: nearlyAfter(context),
      }),
    }),
  ),
  {
    id: 'nearlyOther',
    group: 'Nearly won',
    name: 'Any other team',
    note: 'When a team without a list of its own is the first to reach 90% of the winning score. The leaderboard goes after it.',
    kind: 'match',
    get: (lines) => lines.nearlyOther,
    set: (lines, nearlyOther) => ({ ...lines, nearlyOther }),
    frame: (context) => ({
      values: { team: 'Other team', score: String(nearlyScore(context.scoreToWin)) },
      before: '',
      after: nearlyAfter(context),
    }),
  },
];

// A list staff changed: its lines, when, and who by (Discord user ID and name).
export type SavedList = { lines: string[]; at: number; by: string; byName: string };
export type SavedLines = Record<string, SavedList>;

const SavedListSchema = z.object({ lines: z.array(z.string()).min(1), at: z.number(), by: z.string(), byName: z.string() });

// One list that can't be read is dropped on its own, so the rest stay staff's.
export const parseSavedLines = (raw: unknown): SavedLines => {
  const parsed = z.record(z.string(), z.unknown()).safeParse(raw);
  if (!parsed.success) return {};
  return Object.fromEntries(
    Object.entries(parsed.data).flatMap(([id, list]) => {
      const read = SavedListSchema.safeParse(list);
      return read.success ? [[id, read.data]] : [];
    }),
  );
};

// The lines the bot says: staff's lists in place of its own.
export const resolveLines = (saved: SavedLines): Lines =>
  LISTS.reduce((lines, list) => {
    const own = saved[list.id];
    return own === undefined ? lines : list.set(lines, own.lines);
  }, DEFAULT_LINES);

// The game shows a message on one line.
export const tidyLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

const PLACEHOLDER = /\{(\w+)\}/g;

const listOf = (items: string[]): string =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

// What is wrong with a line, to follow "Line 3", or null when nothing is.
const lineProblem = (line: string, frame: Frame): string | null => {
  const unknown = [...line.matchAll(PLACEHOLDER)].map((m) => m[1] ?? '').find((name) => !Object.hasOwn(frame.values, name));
  if (unknown !== undefined) {
    const known = Object.keys(frame.values).map((name) => `{${name}}`);
    return `has {${unknown}}, which the bot can't fill in. ${known.length === 0 ? 'These lines have nothing to fill in' : `It can fill in ${listOf(known)}`}`;
  }
  const over = `${frame.before}${fillLine(line, frame.values)}${frame.after}`.length - MAX_LENGTH;
  return over > 0 ? `is ${over} character${over === 1 ? '' : 's'} too long for the game, with what the bot adds to it` : null;
};

// What the page sends: a list's new lines, or to go back to the bot's.
export type LinesAction = { action: 'save'; list: string; lines: string[] } | { action: 'reset'; list: string };

const LinesActionSchema = z.discriminatedUnion('action', [
  // Blank lines are dropped, so a few more than the most are taken.
  z.object({ action: z.literal('save'), list: z.string().max(40), lines: z.array(z.string().max(500)).max(MAX_LINES * 2) }),
  z.object({ action: z.literal('reset'), list: z.string().max(40) }),
]);

// Staff's lists after a change, or why it can't be made. Lines are tidied and blank ones dropped. A list saved the same
// as the bot's goes back to being the bot's, so it follows lines.ts again.
export const editLines = (
  saved: SavedLines,
  action: LinesAction,
  context: LinesContext,
  who: { by: string; byName: string; now: number },
): { saved: SavedLines } | { problem: string } => {
  const list = LISTS.find((l) => l.id === action.list);
  if (list === undefined) return { problem: 'There is no list of lines by that name. Reload the page.' };
  const { [list.id]: _old, ...others } = saved;
  if (action.action === 'reset') return { saved: others };
  const lines = action.lines.map(tidyLine).filter((line) => line !== '');
  if (lines.length === 0) return { problem: "Keep at least one line. To go back to the bot's own lines, use \"Use the bot's lines\"." };
  if (lines.length > MAX_LINES) return { problem: `A list can have at most ${MAX_LINES} lines.` };
  const frame = list.frame(context);
  for (const [index, line] of lines.entries()) {
    const problem = lineProblem(line, frame);
    if (problem !== null) return { problem: `Line ${index + 1} ${problem}.` };
  }
  const own = list.get(DEFAULT_LINES);
  if (lines.length === own.length && lines.every((line, i) => line === own[i])) return { saved: others };
  return { saved: { ...others, [list.id]: { lines, at: who.now, by: who.by, byName: who.byName } } };
};

export type LinesPage = {
  // The longest message the game shows.
  max: number;
  maxLines: number;
  lists: (Frame & {
    id: string;
    group: string;
    name: string;
    note: string;
    // Why the bot isn't sending these now, or null when it is.
    off: string | null;
    lines: string[];
    // Null for the bot's own lines.
    changed: { at: number; by: string; byName: string } | null;
  })[];
};

const OFF = {
  seeding: 'The bot is not sending seeding messages: SEEDING_MESSAGE_MINUTES is 0.',
  match: 'The bot is not sending match messages: MATCH_MESSAGES is off, or SITE_URL is not set.',
};

export const buildLinesPage = (saved: SavedLines, context: LinesContext): LinesPage => {
  const lines = resolveLines(saved);
  return {
    max: MAX_LENGTH,
    maxLines: MAX_LINES,
    lists: LISTS.map((list) => {
      const own = saved[list.id];
      return {
        id: list.id,
        group: list.group,
        name: list.name,
        note: list.note,
        off: context[list.kind] ? null : OFF[list.kind],
        ...list.frame(context),
        lines: list.get(lines),
        changed: own === undefined ? null : { at: own.at, by: own.by, byName: own.byName },
      };
    }),
  };
};

export type LinesActionResult = { problem: string } | LinesPage;

// 50 lines of a few hundred characters are well under this.
export const LINES_BODY_BYTES = 65_536;

// A change from the page, or null when it is not one.
export const readLinesAction = async (request: Request, limit = LINES_BODY_BYTES): Promise<LinesAction | null> => {
  const parsed = LinesActionSchema.safeParse(await readJsonBody(request, limit));
  return parsed.success ? parsed.data : null;
};
