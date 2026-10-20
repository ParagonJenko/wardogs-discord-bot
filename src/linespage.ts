import { z } from 'zod';
import { readJsonBody } from './body.ts';
import type { Config, VipRule } from './config.ts';
import { DEFAULT_LINES, type Lines } from './lines.ts';
import { BEST_LEAST_KILLS, BEST_LEAST_MATCHES, LONGEST_MILESTONE, NEARLY_MOST } from './achievements.ts';
import { killCount, LONGEST_EARNED, LONGEST_MVP_EARNED, MAX_END_MESSAGES, NEMESIS_LEAST } from './matchend.ts';
import {
  discordLink,
  fillLine,
  HALFWAY_START,
  halfwayCall,
  LONGEST_RANK,
  MAX_LENGTH,
  minutesText,
  morePlayers,
  NAME_LONGEST,
  nearlyCall,
  nearlyScore,
  seedingReward,
  welcomeLinks,
} from './messages.ts';

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
  // The Discord invite for the welcome ("discord.gg/abc123"), or null without one (DISCORD_INVITE).
  discord: string | null;
  vip: VipRule | null;
  // Whether the next-map vote runs each match, so the halfway and nearly messages send people to it.
  vote?: boolean;
  scoreToWin: number;
  live: number;
  // Whether the bot sends the match messages, the seeding messages, the welcomes and the end-of-match messages.
  match: boolean;
  seeding: boolean;
  welcome: boolean;
  end: boolean;
};

export const linesContext = (config: Config): LinesContext => ({
  siteHost:
    config.seedingMessages?.siteHost ??
    config.matchMessages?.siteHost ??
    config.welcomeMessages?.siteHost ??
    config.matchEndMessages?.siteHost ??
    null,
  discord: config.inviteCode ? discordLink(config.inviteCode) : null,
  vip: config.vip,
  vote: config.matchMessages?.vote ?? false,
  scoreToWin: config.scoreToWin,
  live: config.rules.live,
  match: config.matchMessages !== null,
  seeding: config.seedingMessages !== null,
  welcome: config.welcomeMessages !== null,
  end: config.matchEndMessages !== null,
});

// A list's placeholders, each with the value the preview shows (`values`) and the longest it can be when the message
// goes out (`longest`), which lines are checked against; and what goes before and after its line.
type Frame = { values: Record<string, string>; longest: Record<string, string>; before: string; after: string };

type ListDefinition = {
  id: string;
  // Lists with the same group show together. A list alone in its group has the group's name.
  group: string;
  name: string;
  // When it goes out, and what the bot adds to it.
  note: string;
  kind: 'seeding' | 'match' | 'welcome' | 'end';
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

// {team} is the name as the server spells it ("Lone Star"), and a team without a list of its own could be called
// anything, so lines are checked with it this long. A longer name is cut short with "…".
export const TEAM_LONGEST = 16;

// {team} and {score}: the team shown, and the score shown and the highest it can be when the message goes out.
const teamValues = (team: string, score: number, highest: number) => ({
  values: { team, score: String(score) },
  longest: { team: 'x'.repeat(TEAM_LONGEST), score: String(highest) },
});

// The halfway message names the leader's score as it is when the message goes out: from half the winning score up
// to the winning score. The 90-point message always names 90% of it.
const halfwayValues = (team: string, context: LinesContext) => teamValues(team, Math.ceil(context.scoreToWin / 2), context.scoreToWin);
const nearlyValues = (team: string, context: LinesContext) =>
  teamValues(team, nearlyScore(context.scoreToWin), nearlyScore(context.scoreToWin));

// {name} in the private messages: a name in the preview, checked at the longest a name is cut to.
const PREVIEW_NAME = 'Ghost';
const nameValues = { values: { name: PREVIEW_NAME }, longest: { name: 'x'.repeat(NAME_LONGEST) } };

// Placeholders whose value is the same in the preview and in game.
const exact = (values: Record<string, string>) => ({ values, longest: values });
const halfwayAfter = (context: LinesContext): string => ` ${halfwayCall(site(context), context.vote)}`;
const nearlyAfter = (context: LinesContext): string => ` ${nearlyCall(site(context), context.vote)}`;

// Every list, in the order the page shows them.
export const LISTS: ListDefinition[] = [
  {
    id: 'seeding',
    group: 'Seeding',
    name: 'Every few minutes',
    note: 'Every few minutes while the server seeds, and 30 seconds after someone joins. What seeding earns goes after it.',
    kind: 'seeding',
    get: (lines) => lines.seeding,
    set: (lines, seeding) => ({ ...lines, seeding }),
    // At most one fewer than it needs to go live, as someone is on.
    frame: (context) => ({
      ...exact({ needed: morePlayers(Math.max(1, context.live - 1)) }),
      before: '',
      after: ` ${seedingReward(context.siteHost, context.vip)}`,
    }),
  },
  {
    id: 'seederThanks',
    group: 'Seeding',
    name: 'Thanks when live',
    note: 'A private message to each seeder still in game the moment the server goes live: those on long enough for the seed to count (VIP_SEED_MINUTES), not staff, at most 15. {minutes} is how long they seeded. The line is the whole message.',
    kind: 'seeding',
    get: (lines) => lines.seederThanks,
    set: (lines, seederThanks) => ({ ...lines, seederThanks }),
    frame: () => ({
      values: { ...nameValues.values, minutes: minutesText(25) },
      longest: { ...nameValues.longest, minutes: minutesText(9999) },
      before: '',
      after: '',
    }),
  },
  {
    id: 'welcome',
    group: 'Welcome',
    name: 'Everyone',
    note: 'A private message to each player a couple of minutes after they join, and not again for 6 hours. {name} is their name in game. Say the basic rules: the Discord and the website go after it.',
    kind: 'welcome',
    get: (lines) => lines.welcome,
    set: (lines, welcome) => ({ ...lines, welcome }),
    frame: (context) => ({ ...nameValues, before: '', after: welcomeLinks(context.siteHost, context.discord) }),
  },
  {
    id: 'welcomeBack',
    group: 'Welcome',
    name: 'On the leaderboard',
    note: "In place of the welcome, for a player in the top 10 of any of the leaderboard's boards over 30 days. {rank} is their best place, such as \"3rd for kills\". The Discord and the website go after it.",
    kind: 'welcome',
    get: (lines) => lines.welcomeBack,
    set: (lines, welcomeBack) => ({ ...lines, welcomeBack }),
    frame: (context) => ({
      values: { ...nameValues.values, rank: '3rd for kills' },
      longest: { ...nameValues.longest, rank: LONGEST_RANK },
      before: '',
      after: welcomeLinks(context.siteHost, context.discord),
    }),
  },
  {
    id: 'linkNudge',
    group: 'Welcome',
    name: 'Link your account',
    note: "In place of the welcome, at most once a week, for a regular (5 or more matches in 30 days) who hasn't linked their account on the website. Only while players can sign in there. {site} is the website: send them to {site}/account. The Discord goes after it.",
    kind: 'welcome',
    get: (lines) => lines.linkNudge,
    set: (lines, linkNudge) => ({ ...lines, linkNudge }),
    frame: (context) => ({
      values: { ...nameValues.values, site: site(context) },
      longest: { ...nameValues.longest, site: site(context) },
      before: '',
      after: welcomeLinks(null, context.discord),
    }),
  },
  {
    id: 'tenMinutes',
    group: '10 minutes in',
    name: '10 minutes in',
    note: '10 minutes after the match goes live. The line is the whole message, so end it with one link to type: {site}, a page on it, or {site}/discord for the rules.',
    kind: 'match',
    get: (lines) => lines.tenMinutes,
    set: (lines, tenMinutes) => ({ ...lines, tenMinutes }),
    frame: (context) => ({ ...exact({ site: site(context) }), before: '', after: '' }),
  },
  ...FACTIONS.map(
    (faction): ListDefinition => ({
      id: `halfway.${faction.key}`,
      group: 'Halfway',
      name: faction.name,
      note: `When ${faction.name} is in front at half the winning score. "${HALFWAY_START}" goes before it, and the vote (while it runs) or the live match after it.`,
      kind: 'match',
      get: (lines) => lines.halfway[faction.key] ?? [],
      set: (lines, list) => ({ ...lines, halfway: { ...lines.halfway, [faction.key]: list } }),
      frame: (context) => ({
        ...halfwayValues(faction.name, context),
        before: `${HALFWAY_START} `,
        after: halfwayAfter(context),
      }),
    }),
  ),
  {
    id: 'halfwayLevel',
    group: 'Halfway',
    name: 'Level scores',
    note: `At half the winning score when the top teams are level. These go in place of "${HALFWAY_START}", with the vote (while it runs) or the live match after them.`,
    kind: 'match',
    get: (lines) => lines.halfwayLevel,
    set: (lines, halfwayLevel) => ({ ...lines, halfwayLevel }),
    frame: (context) => ({ ...exact({}), before: '', after: halfwayAfter(context) }),
  },
  {
    id: 'halfwayOther',
    group: 'Halfway',
    name: 'Any other team',
    note: `When a team without a list of its own is in front at half the winning score. "${HALFWAY_START}" goes before it, and the vote (while it runs) or the live match after it.`,
    kind: 'match',
    get: (lines) => lines.halfwayOther,
    set: (lines, halfwayOther) => ({ ...lines, halfwayOther }),
    frame: (context) => ({
      ...halfwayValues('Other team', context),
      before: `${HALFWAY_START} `,
      after: halfwayAfter(context),
    }),
  },
  ...FACTIONS.map(
    (faction): ListDefinition => ({
      id: `nearly.${faction.key}`,
      group: 'Nearly won',
      name: faction.name,
      note: `When ${faction.name} is the first team to reach 90% of the winning score. The vote (while it runs) or the leaderboard goes after it.`,
      kind: 'match',
      get: (lines) => lines.nearly[faction.key] ?? [],
      set: (lines, list) => ({ ...lines, nearly: { ...lines.nearly, [faction.key]: list } }),
      frame: (context) => ({
        ...nearlyValues(faction.name, context),
        before: '',
        after: nearlyAfter(context),
      }),
    }),
  ),
  {
    id: 'nearlyOther',
    group: 'Nearly won',
    name: 'Any other team',
    note: 'When a team without a list of its own is the first to reach 90% of the winning score. The vote (while it runs) or the leaderboard goes after it.',
    kind: 'match',
    get: (lines) => lines.nearlyOther,
    set: (lines, nearlyOther) => ({ ...lines, nearlyOther }),
    frame: (context) => ({
      ...nearlyValues('Other team', context),
      before: '',
      after: nearlyAfter(context),
    }),
  },
  {
    id: 'matchEnd',
    group: 'End of match',
    name: 'Top players',
    note: "A private message to each of the match's best players the moment a team wins: the top on the scoreboard (TOP_PLAYER_MESSAGES) and the award winners (AWARD_MESSAGES). {name} is their name in game. The line is the whole message, so say where the website is.",
    kind: 'end',
    get: (lines) => lines.matchEnd,
    set: (lines, matchEnd) => ({ ...lines, matchEnd }),
    // Lines are checked with {earned} at the longest it can be: a place and two awards, with more kills than any match has.
    frame: (context) => ({
      values: {
        ...nameValues.values,
        earned: listOf([`2nd on the scoreboard (${killCount(25)})`, `best demolitions (${killCount(8)})`]),
        site: site(context),
      },
      longest: { ...nameValues.longest, earned: LONGEST_EARNED, site: site(context) },
      before: '',
      after: '',
    }),
  },
  {
    id: 'mvp',
    group: 'End of match',
    name: 'MVP',
    note: 'In place of the top players line, for the top of the scoreboard (most kills, then fewest deaths; players level share it). {earned} starts with their kills, not their place. The line is the whole message, so say where the website is.',
    kind: 'end',
    get: (lines) => lines.mvp,
    set: (lines, mvp) => ({ ...lines, mvp }),
    frame: (context) => ({
      values: { ...nameValues.values, earned: listOf([killCount(31), `best demolitions (${killCount(8)})`]), site: site(context) },
      longest: { ...nameValues.longest, earned: LONGEST_MVP_EARNED, site: site(context) },
      before: '',
      after: '',
    }),
  },
  ...(
    [
      {
        id: 'milestone',
        name: 'Milestone',
        note: 'For a player who earned nothing above, at the end of a match that took them past a milestone: their 10th, 25th, 50th, 100th… match, their 100th, 250th, 500th, 1,000th… kill, or 10, 25, 50, 100… hours played. {milestone} says which. Told once each.',
        values: { milestone: 'your 100th match' },
        longest: { milestone: LONGEST_MILESTONE },
      },
      {
        id: 'personalBest',
        name: 'Personal best',
        note: `For a player who earned nothing above, nor a milestone, when they had more kills than in any match of theirs in the last 90 days (from ${BEST_LEAST_MATCHES} matches, and ${BEST_LEAST_KILLS} kills). {kills} says how many. One with a place or an award has "a personal best" in {earned} instead.`,
        values: { kills: killCount(42) },
        longest: { kills: killCount(9999) },
      },
      {
        id: 'nearlyTop',
        name: 'Nearly on the leaderboard',
        note: `For a player who earned none of the above, when ${NEARLY_MOST} or fewer more kills would put them in the leaderboard's top 10 for kills (30 days). {short} says how many.`,
        values: { short: killCount(3) },
        longest: { short: killCount(NEARLY_MOST) },
      },
      {
        id: 'nemesis',
        name: 'Nemesis',
        note: `For a player who got none of the above, when one player killed them ${NEMESIS_LEAST} times or more in the match (from the kill feed). {nemesis} is that player, {count} how many times.`,
        values: { nemesis: 'Viper', count: '6 times' },
        longest: { nemesis: 'x'.repeat(NAME_LONGEST), count: '99 times' },
      },
    ] as const
  ).map(
    (extra): ListDefinition => ({
      id: extra.id,
      group: 'End of match',
      name: extra.name,
      note: `${extra.note} {name} is their name in game. The line is the whole message. At most ${MAX_END_MESSAGES} messages go out at the end of a match, these last.`,
      kind: 'end',
      get: (lines) => lines[extra.id],
      set: (lines, list) => ({ ...lines, [extra.id]: list }),
      frame: (context) => ({
        values: { ...nameValues.values, ...extra.values, site: site(context) },
        longest: { ...nameValues.longest, ...extra.longest, site: site(context) },
        before: '',
        after: '',
      }),
    }),
  ),
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
  const over = `${frame.before}${fillLine(line, frame.longest)}${frame.after}`.length - MAX_LENGTH;
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
  welcome: 'The bot is not sending welcomes: WELCOME_MESSAGE_MINUTES is 0.',
  end: 'The bot is not sending end-of-match messages: TOP_PLAYER_MESSAGES is 0 and AWARD_MESSAGES is off, or SITE_URL is not set.',
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
