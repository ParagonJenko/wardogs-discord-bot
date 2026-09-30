import { z } from 'zod';
import type { VipRule } from './config.ts';
import type { MatchState } from './tracking.ts';

// Messages broadcast in game during a match, pointing players at the website for the leaderboard, the Discord and
// seeder rewards: 10 minutes after the match goes live, when a team is halfway to winning (with a line about the team
// in front), and when the first team is close to winning. Each goes out once per match.

export type MessageRule = { siteHost: string; scoreToWin: number };

// Which match the sent messages belong to (its start time) and which were sent.
export type MatchMessages = { match: number; sent: string[] };

export const MatchMessagesSchema = z.object({ match: z.number(), sent: z.array(z.string()) });

const TEN_MINUTES = 10 * 60_000;
const NEARLY = 0.9;

// The game shows broadcasts in one line; keep them short.
const MAX_LENGTH = 200;

const fit = (text: string): string => (text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH - 1)}…` : text);

const days = (count: number): string => `${count} day${count === 1 ? '' : 's'}`;

type Milestone = { key: string; text: string };

type Score = MatchState['factionScores'][number];

// A line for the team leading at halfway, in the spirit of what players say about each faction: Lonestar is the
// default pick that usually loses, the developers say Manticore (green) wins most of the time, and Valkyra's story is
// restoring the Soviet People's Republic to greatness. Which line a match gets depends on when it started, so it
// changes from match to match.
const TEAM_LINES: Record<string, ((score: number) => string)[]> = {
  lonestar: [
    (n) => `Lonestar leads on ${n}! Screenshot it, this never happens.`,
    (n) => `Lonestar leads on ${n}! The default pick is cooking. Yeehaw.`,
  ],
  manticore: [
    (n) => `Manticore leads on ${n}. Green winning? Shocking. Truly.`,
    (n) => `Manticore leads on ${n}. The shadow army doing shadow army things.`,
  ],
  valkyra: [
    (n) => `Valkyra leads on ${n}. Not my points, OUR points, comrade.`,
    (n) => `Valkyra leads on ${n}. Restoring greatness, one point at a time.`,
  ],
};

// Only the team in front is named; when the top teams are level, nobody is.
const leaderLine = (scores: Score[], startedAt: number): string => {
  const [first, second] = [...scores].sort((a, b) => b.score - a.score);
  if (!first) return 'Halfway there!';
  if (second && second.score === first.score) return "Halfway there and it's neck and neck!";
  const lines = TEAM_LINES[first.name.trim().toLowerCase()] ?? [(n: number) => `${first.name} leads on ${n}!`];
  const line = lines[Math.floor(startedAt / 60_000) % lines.length];
  return line ? `Halfway there! ${line(first.score)}` : 'Halfway there!';
};

// Everything this match has reached so far, in the order it happens.
export const milestones = (match: MatchState, now: number, rule: MessageRule, vip: VipRule | null): Milestone[] => {
  const { siteHost, scoreToWin } = rule;
  const [leader] = [...match.factionScores].sort((a, b) => b.score - a.score);
  const top = Math.max(0, leader?.score ?? 0);
  const nearly = Math.ceil(scoreToWin * NEARLY);
  return [
    // Only when the bot saw the match start, so the time is right.
    ...(match.summarisable && match.liveAt !== null && now - match.liveAt >= TEN_MINUTES
      ? [{ key: 'ten-minutes', text: `Enjoying the match? Server rules are in our Discord. Join it and see the leaderboard at ${siteHost}` }]
      : []),
    ...(top >= scoreToWin / 2
      ? [
          {
            key: 'halfway',
            text:
              `${leaderLine(match.factionScores, match.startedAt)} ` +
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
            text: `${leader.name} has ${nearly} points! Where do you rank? Leaderboard, Discord and seeding at ${siteHost}`,
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
): { messages: MatchMessages; send: string | null } => {
  const due = milestones(match, now, rule, vip);
  if (previous === null || previous.match !== match.startedAt) {
    return { messages: { match: match.startedAt, sent: due.map((m) => m.key) }, send: null };
  }
  // Saved before "nearly" was once per match, it was one key per team ("nearly:Valkyra"); either counts as sent.
  const sent = (key: string): boolean => previous.sent.some((k) => k === key || k.startsWith(`${key}:`));
  const next = due.find((m) => !sent(m.key));
  if (next === undefined) return { messages: previous, send: null };
  return { messages: { ...previous, sent: [...previous.sent, next.key] }, send: next.text };
};
