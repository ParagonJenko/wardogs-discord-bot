import { z } from 'zod';
import type { VipRule } from './config.ts';
import type { MatchState } from './tracking.ts';

// Messages broadcast in game during a match, pointing players at the website for the leaderboard, the Discord and
// seeder rewards: 10 minutes after the match goes live, when a team is halfway to winning (saying who is ahead), and
// when each team is close to winning. Each goes out once per match.

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

// Who is winning at halfway: "Valkyra leads Kharr 52 to 40.", "Valkyra leads on 52, Kharr 40, Haldor 20." or, when
// the top teams are level, "It's level: Valkyra 50, Kharr 50."
const standing = (scores: Score[]): string => {
  const [first, ...others] = [...scores].sort((a, b) => b.score - a.score);
  const [second] = others;
  const list = (teams: Score[]): string => teams.map((s) => `${s.name} ${s.score}`).join(', ');
  if (!first) return '';
  if (!second) return ` ${first.name} is on ${first.score}.`;
  if (first.score === second.score) return ` It's level: ${list([first, ...others])}.`;
  if (others.length === 1) return ` ${first.name} leads ${second.name} ${first.score} to ${second.score}.`;
  return ` ${first.name} leads on ${first.score}, ${list(others)}.`;
};

// Everything this match has reached so far, in the order it happens.
export const milestones = (match: MatchState, now: number, rule: MessageRule, vip: VipRule | null): Milestone[] => {
  const { siteHost, scoreToWin } = rule;
  const top = Math.max(0, ...match.factionScores.map((s) => s.score));
  const nearly = Math.ceil(scoreToWin * NEARLY);
  return [
    // Only when the bot saw the match start, so the time is right.
    ...(match.summarisable && match.liveAt !== null && now - match.liveAt >= TEN_MINUTES
      ? [{ key: 'ten-minutes', text: `Enjoying the match? Join our Discord and see the leaderboard at ${siteHost}` }]
      : []),
    ...(top >= scoreToWin / 2
      ? [
          {
            key: 'halfway',
            text:
              `Halfway there!${standing(match.factionScores)} ` +
              (vip
                ? `Seed on ${days(vip.seedDays)} in a week and get a reserved slot. How at ${siteHost}`
                : `Check the leaderboard and join our Discord at ${siteHost}`),
          },
        ]
      : []),
    ...match.factionScores
      .filter((s) => s.score >= nearly)
      .map((s) => ({
        key: `nearly:${s.name}`,
        text: `${s.name} has ${nearly} points! Where do you rank? Leaderboard, Discord and seeding at ${siteHost}`,
      })),
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
  const next = due.find((m) => !previous.sent.includes(m.key));
  if (next === undefined) return { messages: previous, send: null };
  return { messages: { ...previous, sent: [...previous.sent, next.key] }, send: next.text };
};
