import { z } from 'zod';
import type { VipRule } from './config.ts';
import { factionKey } from './discord.ts';
import * as lines from './lines.ts';
import type { MatchState } from './tracking.ts';

// Messages broadcast in game during a match, pointing players at the website for the leaderboard, the Discord and
// seeder rewards: 10 minutes after the match goes live, when a team is halfway to winning (with a line about the team
// in front), and when the first team is close to winning. Each goes out once per match. While the server seeds, a
// seeding message goes out every few minutes too, and 30 seconds after someone joins.

export type MessageRule = { siteHost: string; scoreToWin: number };

// The seeding message goes out every `everyMs`, and points at the website when there is one.
export type SeedingMessageRule = { everyMs: number; siteHost: string | null };

// Which match the sent messages belong to (its start time) and which were sent.
export type MatchMessages = { match: number; sent: string[] };

export const MatchMessagesSchema = z.object({ match: z.number(), sent: z.array(z.string()) });

const TEN_MINUTES = 10 * 60_000;
const NEARLY = 0.9;

// The game shows broadcasts in one line; keep them short.
const MAX_LENGTH = 200;

const fit = (text: string): string => (text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH - 1)}…` : text);

const days = (count: number): string => `${count} day${count === 1 ? '' : 's'}`;
const morePlayers = (count: number): string => `${count} more player${count === 1 ? '' : 's'}`;

type Milestone = { key: string; text: string };

type Score = MatchState['factionScores'][number];

// A random line from a list, with its placeholders filled in.
const pickLine = (list: string[], values: Record<string, string | number>, random: () => number): string => {
  const line = list[Math.floor(random() * list.length)] ?? list[0] ?? '';
  return line.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole));
};

// The team in front's line: from its own list, or the plain one for a faction without a list.
const teamLine = (lists: Record<string, string[]>, other: string[], team: Score, score: number, random: () => number): string =>
  pickLine(lists[factionKey(team.name)] ?? other, { team: team.name, score }, random);

// Only the team in front is named; when the top teams are level, nobody is.
const halfwayLine = (scores: Score[], random: () => number): string => {
  const [first, second] = [...scores].sort((a, b) => b.score - a.score);
  if (!first) return 'Halfway there!';
  if (second && second.score === first.score) return pickLine(lines.HALFWAY_LEVEL, {}, random);
  return `Halfway there! ${teamLine(lines.HALFWAY, lines.HALFWAY_OTHER, first, first.score, random)}`;
};

// Everything this match has reached so far, in the order it happens.
// `random` picks the lines; each message's line is chosen when it is sent.
export const milestones = (
  match: MatchState,
  now: number,
  rule: MessageRule,
  vip: VipRule | null,
  random: () => number = Math.random,
): Milestone[] => {
  const { siteHost, scoreToWin } = rule;
  const [leader] = [...match.factionScores].sort((a, b) => b.score - a.score);
  const top = Math.max(0, leader?.score ?? 0);
  const nearly = Math.ceil(scoreToWin * NEARLY);
  return [
    // Only when the bot saw the match start, so the time is right.
    ...(match.summarisable && match.liveAt !== null && now - match.liveAt >= TEN_MINUTES
      ? [{ key: 'ten-minutes', text: pickLine(lines.TEN_MINUTES, { site: siteHost }, random) }]
      : []),
    ...(top >= scoreToWin / 2
      ? [
          {
            key: 'halfway',
            text:
              `${halfwayLine(match.factionScores, random)} ` +
              (vip
                ? `Seed on ${days(vip.seedDays)} in a week and get a reserved slot. How at ${siteHost}`
                : `Check the leaderboard and join our Discord at ${siteHost}`),
          },
        ]
      : []),
    // Once per match, for the first team to get there.
    ...(leader && leader.score >= nearly
      ? [
          {
            key: 'nearly',
            text: `${teamLine(lines.NEARLY, lines.NEARLY_OTHER, leader, nearly, random)} Where do you rank? Leaderboard, Discord and seeding at ${siteHost}`,
          },
        ]
      : []),
  ].map((m) => ({ ...m, text: fit(m.text) }));
};

// The message to send now, if any, and what to remember. At most one per check, so they never arrive in a burst.
// The first time a match is seen, what it has already reached is marked as sent without sending: a match seen from
// its start has reached nothing, and one first seen part-way (after the bot restarts) is not announced late.
export const nextMessage = (
  previous: MatchMessages | null,
  match: MatchState,
  now: number,
  rule: MessageRule,
  vip: VipRule | null,
  random: () => number = Math.random,
): { messages: MatchMessages; send: string | null } => {
  const due = milestones(match, now, rule, vip, random);
  if (previous === null || previous.match !== match.startedAt) {
    return { messages: { match: match.startedAt, sent: due.map((m) => m.key) }, send: null };
  }
  // Saved before "nearly" was once per match, it was one key per team ("nearly:Valkyra"); either counts as sent.
  const sent = (key: string): boolean => previous.sent.some((k) => k === key || k.startsWith(`${key}:`));
  const next = due.find((m) => !sent(m.key));
  if (next === undefined) return { messages: previous, send: null };
  return { messages: { ...previous, sent: [...previous.sent, next.key] }, send: next.text };
};

// What seeding earns, after the seeding line: a reserved slot when automatic VIP is on, otherwise a place on the
// website's top seeders board.
const seedingReward = (siteHost: string | null, vip: VipRule | null): string => {
  if (vip) {
    const offer = `Seed for over ${vip.seedMinutes} min on ${days(vip.seedDays)} in a week and get a reserved slot.`;
    return siteHost ? `${offer} How at ${siteHost}` : offer;
  }
  return siteHost ? `Top seeders make the leaderboard at ${siteHost}` : 'Thanks for helping get it live!';
};

// "We're seeding! 5 more players and we go live. Seed for over 10 min on 3 days in a week and get a reserved slot. How
// at gaminginit.com"
export const seedingMessage = (
  players: number,
  live: number,
  rule: SeedingMessageRule,
  vip: VipRule | null,
  random: () => number = Math.random,
): string =>
  fit(`${pickLine(lines.SEEDING, { needed: morePlayers(Math.max(1, live - players)) }, random)} ${seedingReward(rule.siteHost, vip)}`);

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
