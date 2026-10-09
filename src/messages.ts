import { z } from 'zod';
import type { VipRule } from './config.ts';
import { factionKey } from './discord.ts';
import { DEFAULT_LINES, type Lines } from './lines.ts';
import type { MatchState } from './tracking.ts';

// Messages broadcast in game during a match, pointing players at the website for the leaderboard, the Discord and
// seeder rewards: 10 minutes after the match goes live, when a team is halfway to winning (with a line about the team
// in front), and when the first team is close to winning. Each goes out once per match. While the server seeds, a
// seeding message goes out every few minutes too, and 30 seconds after someone joins. And each player who joins gets
// a welcome of their own, a private message with the basic rules, the Discord and the website.

export type MessageRule = { siteHost: string; scoreToWin: number };

// The seeding message goes out every `everyMs`, and points at the website when there is one.
export type SeedingMessageRule = { everyMs: number; siteHost: string | null };

// The welcome goes to each player `afterMs` after they join, with the Discord invite ("discord.gg/abc123") and the
// website when there are.
export type WelcomeRule = { afterMs: number; siteHost: string | null; discord: string | null };

// Which match the sent messages belong to (its start time) and which were sent.
export type MatchMessages = { match: number; sent: string[] };

export const MatchMessagesSchema = z.object({ match: z.number(), sent: z.array(z.string()) });

const TEN_MINUTES = 10 * 60_000;
const NEARLY = 0.9;

// The game shows broadcasts in one line; keep them short.
export const MAX_LENGTH = 200;

const fit = (text: string): string => (text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH - 1)}…` : text);

const days = (count: number): string => `${count} day${count === 1 ? '' : 's'}`;
export const morePlayers = (count: number): string => `${count} more player${count === 1 ? '' : 's'}`;

// The score a team has when the 90-point message goes out: 90% of the winning score.
export const nearlyScore = (scoreToWin: number): number => Math.ceil(scoreToWin * NEARLY);

// What the bot puts around the lines (see lines.ts). The staff page shows them too, so staff see the whole message.
export const HALFWAY_START = 'Halfway there!';
export const halfwayCall = (siteHost: string, vip: VipRule | null): string =>
  vip ? `Seed on ${days(vip.seedDays)} in a week and get a reserved slot. How at ${siteHost}` : `Check the leaderboard and join our Discord at ${siteHost}`;
export const nearlyCall = (siteHost: string): string => `Where do you rank? Leaderboard, Discord and seeding at ${siteHost}`;

// A line the bot chose: its message, which list it came from and the line as written (before placeholders).
export type Picked = { text: string; list: string; line: string };

type Milestone = { key: string; text: string };

type Reached = Milestone & { pick: Picked };

type Score = MatchState['factionScores'][number];

// A line with its placeholders filled in. One it has no value for is left as it is.
export const fillLine = (line: string, values: Record<string, string | number>): string =>
  line.replace(/\{(\w+)\}/g, (whole, name: string) => (Object.hasOwn(values, name) ? String(values[name]) : whole));

// The lines each list used lately, newest last, by list. Saved with the bot's state, so the next message avoids them.
export type Recent = Record<string, string[]>;

export const RecentSchema = z.record(z.string(), z.array(z.string()));

// How many lines a list remembers.
const RECENT_KEPT = 10;

// Adds a chosen line to what is remembered.
export const remember = (recent: Recent, picked: Picked): Recent => ({
  ...recent,
  [picked.list]: [...(recent[picked.list] ?? []).filter((line) => line !== picked.line), picked.line].slice(-RECENT_KEPT),
});

// A random line from a list, with its placeholders filled in. A line used lately is passed over while the list has
// others, so a list is gone through before any line comes round again: up to half the list, so even a short one varies.
const pickLine = (
  id: string,
  list: string[],
  values: Record<string, string | number>,
  random: () => number,
  recent: Recent,
): Picked => {
  const avoid = new Set((recent[id] ?? []).slice(-Math.min(RECENT_KEPT, Math.floor(list.length / 2))));
  const fresh = list.filter((line) => !avoid.has(line));
  const from = fresh.length > 0 ? fresh : list;
  const line = from[Math.floor(random() * from.length)] ?? from[0] ?? '';
  return { text: fillLine(line, values), list: id, line };
};

// The team in front's line: from its own list, or the plain one for a faction without a list.
const teamLine = (
  id: string,
  lists: Record<string, string[]>,
  other: string[],
  team: Score,
  score: number,
  random: () => number,
  recent: Recent,
): Picked => {
  const key = factionKey(team.name);
  return key in lists
    ? pickLine(`${id}:${key}`, lists[key] ?? other, { team: team.name, score }, random, recent)
    : pickLine(`${id}Other`, other, { team: team.name, score }, random, recent);
};

// Only the team in front is named; when the top teams are level, nobody is.
const halfwayLine = (scores: Score[], lines: Lines, random: () => number, recent: Recent): { text: string; pick: Picked | null } => {
  const [first, second] = [...scores].sort((a, b) => b.score - a.score);
  if (!first) return { text: HALFWAY_START, pick: null };
  if (second && second.score === first.score) {
    const pick = pickLine('halfwayLevel', lines.halfwayLevel, {}, random, recent);
    return { text: pick.text, pick };
  }
  const pick = teamLine('halfway', lines.halfway, lines.halfwayOther, first, first.score, random, recent);
  return { text: `${HALFWAY_START} ${pick.text}`, pick };
};

// Everything this match has reached so far, in the order it happens.
// `random` picks the lines; each message's line is chosen when it is sent. `lines` are staff's, or the bot's own.
const reached = (
  match: MatchState,
  now: number,
  rule: MessageRule,
  vip: VipRule | null,
  random: () => number = Math.random,
  lines: Lines = DEFAULT_LINES,
  recent: Recent,
): Reached[] => {
  const { siteHost, scoreToWin } = rule;
  const [leader] = [...match.factionScores].sort((a, b) => b.score - a.score);
  const top = Math.max(0, leader?.score ?? 0);
  const nearly = nearlyScore(scoreToWin);
  const out: Reached[] = [];
  // Only when the bot saw the match start, so the time is right.
  if (match.summarisable && match.liveAt !== null && now - match.liveAt >= TEN_MINUTES) {
    const pick = pickLine('tenMinutes', lines.tenMinutes, { site: siteHost }, random, recent);
    out.push({ key: 'ten-minutes', text: pick.text, pick });
  }
  if (top >= scoreToWin / 2) {
    const { text, pick } = halfwayLine(match.factionScores, lines, random, recent);
    out.push({ key: 'halfway', text: `${text} ${halfwayCall(siteHost, vip)}`, pick: pick ?? { text, list: 'halfway', line: text } });
  }
  // Once per match, for the first team to get there.
  if (leader && leader.score >= nearly) {
    const pick = teamLine('nearly', lines.nearly, lines.nearlyOther, leader, nearly, random, recent);
    out.push({ key: 'nearly', text: `${pick.text} ${nearlyCall(siteHost)}`, pick });
  }
  return out.map((m) => ({ ...m, text: fit(m.text) }));
};

export const milestones = (
  match: MatchState,
  now: number,
  rule: MessageRule,
  vip: VipRule | null,
  random: () => number = Math.random,
  lines: Lines = DEFAULT_LINES,
  recent: Recent = {},
): Milestone[] => reached(match, now, rule, vip, random, lines, recent).map(({ key, text }) => ({ key, text }));

// The message to send now, if any, and what to remember. `used` is the line it chose, for `remember`. At most one per check, so they never arrive in a burst.
// The first time a match is seen, what it has already reached is marked as sent without sending: a match seen from
// its start has reached nothing, and one first seen part-way (after the bot restarts) is not announced late.
export const nextMessage = (
  previous: MatchMessages | null,
  match: MatchState,
  now: number,
  rule: MessageRule,
  vip: VipRule | null,
  random: () => number = Math.random,
  lines: Lines = DEFAULT_LINES,
  recent: Recent = {},
): { messages: MatchMessages; send: string | null; used: Picked | null } => {
  const due = reached(match, now, rule, vip, random, lines, recent);
  if (previous === null || previous.match !== match.startedAt) {
    return { messages: { match: match.startedAt, sent: due.map((m) => m.key) }, send: null, used: null };
  }
  // Saved before "nearly" was once per match, it was one key per team ("nearly:Valkyra"); either counts as sent.
  const sent = (key: string): boolean => previous.sent.some((k) => k === key || k.startsWith(`${key}:`));
  const next = due.find((m) => !sent(m.key));
  if (next === undefined) return { messages: previous, send: null, used: null };
  return { messages: { ...previous, sent: [...previous.sent, next.key] }, send: next.text, used: next.pick };
};

// What seeding earns, after the seeding line: a reserved slot when automatic VIP is on, otherwise a place on the
// website's top seeders board.
export const seedingReward = (siteHost: string | null, vip: VipRule | null): string => {
  if (vip) {
    const offer = `Seed for over ${vip.seedMinutes} min on ${days(vip.seedDays)} in a week and get a reserved slot.`;
    return siteHost ? `${offer} How at ${siteHost}` : offer;
  }
  return siteHost ? `Top seeders make the leaderboard at ${siteHost}` : 'Thanks for helping get it live!';
};

// "We're seeding! 5 more players and we go live. Seed for over 10 min on 3 days in a week and get a reserved slot. How
// at gaminginit.com"
export const seedingPick = (
  players: number,
  live: number,
  rule: SeedingMessageRule,
  vip: VipRule | null,
  random: () => number = Math.random,
  lines: Lines = DEFAULT_LINES,
  recent: Recent = {},
): Picked => {
  const pick = pickLine('seeding', lines.seeding, { needed: morePlayers(Math.max(1, live - players)) }, random, recent);
  return { ...pick, text: fit(`${pick.text} ${seedingReward(rule.siteHost, vip)}`) };
};

export const seedingMessage = (
  players: number,
  live: number,
  rule: SeedingMessageRule,
  vip: VipRule | null,
  random: () => number = Math.random,
  lines: Lines = DEFAULT_LINES,
  recent: Recent = {},
): string => seedingPick(players, live, rule, vip, random, lines, recent).text;

// Whether the seeding message is due. Checks land a little early or late, so one within half a check of the time
// counts: every 5 minutes stays every 5 minutes, not 6.
export const seedingMessageDue = (lastAt: number | null, now: number, rule: SeedingMessageRule, checkMs: number): boolean =>
  lastAt === null || now - lastAt >= rule.everyMs - checkMs / 2;

// The seeding message goes out this long after someone joins while the server seeds, so they have loaded in to see it.
// When several join close together, it waits until this long after the last of them, and goes out once.
export const JOIN_WAIT_MS = 30_000;

// Who was in game at the last reading (Steam IDs), and when the latest of them joined while their seeding message is
// still waiting.
export type JoinWatch = { online: string[]; lastJoinAt: number | null };

export const JoinWatchSchema = z.object({ online: z.array(z.string()), lastJoinAt: z.number().nullable() });

// Notes who joined since the last reading. `seeding` is whether a seeding message can go out now: the server is
// seeding with fewer players than it needs to go live. When it cannot, a waiting message is dropped, so a join that
// takes the server live, or that happens while it is live, never sends one later. The first reading only notes who
// is on: they did not just join.
export const watchJoins = (previous: JoinWatch | null, steamIds: string[], now: number, seeding: boolean): JoinWatch => {
  if (previous === null) return { online: steamIds, lastJoinAt: null };
  const known = new Set(previous.online);
  const joined = steamIds.some((id) => !known.has(id));
  return { online: steamIds, lastJoinAt: !seeding ? null : joined ? now : previous.lastJoinAt };
};

export const joinMessageDue = (watch: JoinWatch, now: number): boolean =>
  watch.lastJoinAt !== null && now - watch.lastJoinAt >= JOIN_WAIT_MS;

// A player who joins again this soon after their welcome, as everyone does after a map change or a crash, is not
// welcomed again.
export const WELCOME_AGAIN_MS = 6 * 60 * 60_000;

// A Discord invite code as players type it in: "discord.gg/abc123".
export const discordLink = (inviteCode: string): string => `discord.gg/${inviteCode}`;

// What the bot puts after the welcome line: " Discord: discord.gg/abc123 | Website: gaminginit.com", or whichever of
// the two there is.
export const welcomeLinks = (siteHost: string | null, discord: string | null): string => {
  const links = [...(discord ? [`Discord: ${discord}`] : []), ...(siteHost ? [`Website: ${siteHost}`] : [])];
  return links.length === 0 ? '' : ` ${links.join(' | ')}`;
};

export const welcomePick = (rule: WelcomeRule, random: () => number = Math.random, lines: Lines = DEFAULT_LINES, recent: Recent = {}): Picked => {
  const pick = pickLine('welcome', lines.welcome, {}, random, recent);
  return { ...pick, text: fit(`${pick.text}${welcomeLinks(rule.siteHost, rule.discord)}`) };
};

export const welcomeMessage = (rule: WelcomeRule, random: () => number = Math.random, lines: Lines = DEFAULT_LINES, recent: Recent = {}): string =>
  welcomePick(rule, random, lines, recent).text;

// Who was in game at the last reading (Steam IDs); who joined and is still waiting for their welcome, with when the bot
// first saw them; and who was welcomed in the last WELCOME_AGAIN_MS, or was on when the bot started watching, with when.
export type WelcomeWatch = { online: string[]; waiting: Record<string, number>; welcomed: Record<string, number> };

export const WelcomeWatchSchema = z.object({
  online: z.array(z.string()),
  waiting: z.record(z.string(), z.number()),
  welcomed: z.record(z.string(), z.number()),
});

// Notes who joined since the last reading, of the `count` players the server says it has. Someone who leaves before
// their welcome goes out is dropped, and waits again if they come back. Those on at the first reading did not just
// join, and count as welcomed, so they are not welcomed when they reconnect after the next map change either. A reading
// that lists nobody while the server says it has players is not trusted, so a bad reading never has everyone join again;
// before the first reading it trusts, it gives back null.
export const watchWelcomes = (
  previous: WelcomeWatch | null,
  steamIds: string[],
  count: number,
  now: number,
): WelcomeWatch | null => {
  if (steamIds.length === 0 && count > 0) return previous;
  if (previous === null) return { online: steamIds, waiting: {}, welcomed: Object.fromEntries(steamIds.map((id) => [id, now])) };
  const known = new Set(previous.online);
  const welcomed = Object.fromEntries(Object.entries(previous.welcomed).filter(([, at]) => now - at < WELCOME_AGAIN_MS));
  const waiting: Record<string, number> = {};
  for (const id of steamIds) {
    const since = previous.waiting[id] ?? (known.has(id) || Object.hasOwn(welcomed, id) ? undefined : now);
    if (since !== undefined) waiting[id] = since;
  }
  return { online: steamIds, waiting, welcomed };
};

// Who is due their welcome now. Checks land a little early or late, so one within half a check of the time counts.
export const welcomesDue = (watch: WelcomeWatch, now: number, rule: WelcomeRule, checkMs: number): string[] =>
  Object.entries(watch.waiting)
    .filter(([, since]) => now - since >= rule.afterMs - checkMs / 2)
    .map(([id]) => id);

// After the welcomes to `steamIds` went out (or failed: they are not tried again).
export const markWelcomed = (watch: WelcomeWatch, steamIds: string[], now: number): WelcomeWatch => {
  if (steamIds.length === 0) return watch;
  const sent = new Set(steamIds);
  return {
    online: watch.online,
    waiting: Object.fromEntries(Object.entries(watch.waiting).filter(([id]) => !sent.has(id))),
    welcomed: { ...watch.welcomed, ...Object.fromEntries(steamIds.map((id) => [id, now])) },
  };
};
