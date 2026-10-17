import { z } from 'zod';
import { mapName } from './discord.ts';
import type { MapChoice } from './rotationspage.ts';

// The next-map vote on the website. While a match is live the bot opens a vote between a few maps; anyone on the site
// can vote once; when it closes the winning map is staged on the server, the same as staff's /setnextmap, and plays when
// this match ends. Nothing here touches the server or storage: the Watcher opens, closes and applies the vote (see
// updateMapVote in worker.ts), and the Worker's /api/vote routes read and cast it.
//
// One vote per person without a sign-in: a ballot is tied to the browser (a random token the page keeps) and to the
// network (a hash of the IP, salted for this vote so it can't be linked to any other). A new ballot from a browser or a
// network that already voted replaces that ballot, so a refresh, a private window or another device on the same network
// changes the vote and never adds one. People sharing a network share a vote; that is what it costs not to sign in.

export const MAP_VOTE_KEY = 'mapVote';

// A vote closes at the first of its time running out and the leading team reaching this share of the winning score, so
// it is always over while the match can still be told where to go next.
export const CLOSE_SCORE_SHARE = 0.75;

// Ballots kept per vote, so a flood of requests from many networks can't fill storage.
export const MAX_BALLOTS = 5000;

// How every winner is set up: infantry only (see MODIFIERS in matchsetup.ts), whatever the rotation plays that map with.
export const VOTE_SETUP_OPTIONS = { infantry_only: 'true' };

export type MapVoteRule = { options: number; minutes: number };

export type VoteOption = { map: string; name: string };

// `ip` is the salted hash, `token` the browser's own random one.
export type Ballot = { ip: string; token: string; map: string; at: number };

// How a vote ended: the map the server was told to play next, or why it was not told.
export type VoteOutcome = {
  at: number;
  // Null when nobody voted, or the server could not be told.
  winner: string | null;
  // True while the winner could not be put on the server yet and each check tries again.
  pending: boolean;
  // Why nothing was staged, in words for the page.
  note?: string;
};

export type MapVote = {
  // The match it is for: when the match started, which is also its id.
  id: string;
  matchStartedAt: number;
  // The map being played when it opened: the vote is about what comes after.
  fromMap: string;
  openedAt: number;
  closesAt: number;
  options: VoteOption[];
  ballots: Ballot[];
  // Random for this vote, kept to hash networks with. Never sent to the page.
  salt: string;
  outcome: VoteOutcome | null;
};

const MapVoteSchema = z.object({
  id: z.string(),
  matchStartedAt: z.number(),
  fromMap: z.string(),
  openedAt: z.number(),
  closesAt: z.number(),
  options: z.array(z.object({ map: z.string(), name: z.string() })),
  ballots: z.array(z.object({ ip: z.string(), token: z.string(), map: z.string(), at: z.number() })),
  salt: z.string(),
  outcome: z
    .object({ at: z.number(), winner: z.string().nullable(), pending: z.boolean(), note: z.string().optional() })
    .nullable()
    .default(null),
});

export const parseMapVote = (raw: unknown): MapVote | null => {
  const parsed = MapVoteSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

export const isOpen = (vote: MapVote, now: number): boolean => vote.outcome === null && now < vote.closesAt;

// A shuffle that takes the first `count`: `random` is Math.random, passed in so tests can fix it.
const sample = <T>(items: readonly T[], count: number, random: () => number): T[] => {
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, count);
};

// The maps a vote can offer: ones the server can play (with a game mode), other than the one being played. Fewer than two
// is no vote.
export const pickOptions = (maps: readonly MapChoice[], playing: string, count: number, random: () => number): VoteOption[] => {
  const playable = maps.filter((m) => m.id !== playing && m.modes.length > 0);
  if (playable.length < 2) return [];
  return sample(playable, count, random).map((m) => ({ map: m.id, name: m.name }));
};

const randomHex = (bytes: number): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');

export const openVote = (
  match: { startedAt: number },
  fromMap: string,
  options: VoteOption[],
  rule: MapVoteRule,
  now: number,
): MapVote => ({
  id: String(match.startedAt),
  matchStartedAt: match.startedAt,
  fromMap,
  openedAt: now,
  closesAt: now + rule.minutes * 60_000,
  options,
  ballots: [],
  salt: randomHex(16),
  outcome: null,
});

// A network's mark for this vote only: the first 16 hex characters of SHA-256(salt + IP).
export const networkMark = async (vote: MapVote, ip: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${vote.salt}:${ip}`));
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
};

export type CastResult = { vote: MapVote; result: 'counted' | 'changed' } | { result: 'closed' | 'unknown-map' | 'full' };

// One ballot per browser and per network: a vote from either one already seen replaces that ballot.
export const castVote = (vote: MapVote, ballot: { ip: string; token: string; map: string }, now: number): CastResult => {
  if (!isOpen(vote, now)) return { result: 'closed' };
  if (!vote.options.some((o) => o.map === ballot.map)) return { result: 'unknown-map' };
  const own = (b: Ballot): boolean => b.token === ballot.token || b.ip === ballot.ip;
  const replaced = vote.ballots.some(own);
  if (!replaced && vote.ballots.length >= MAX_BALLOTS) return { result: 'full' };
  // A browser that voted from two networks, or a network with two browsers, keeps one ballot: the newest.
  const others = vote.ballots.filter((b) => !own(b));
  return { vote: { ...vote, ballots: [...others, { ...ballot, at: now }] }, result: replaced ? 'changed' : 'counted' };
};

// Votes for each option, in the order they were offered.
export const tally = (vote: MapVote): { map: string; name: string; votes: number }[] =>
  vote.options.map((o) => ({ ...o, votes: vote.ballots.filter((b) => b.map === o.map).length }));

// The map with the most votes; a tie is settled by chance. Null when nobody voted.
export const chooseWinner = (vote: MapVote, random: () => number): string | null => {
  const counts = tally(vote);
  const top = Math.max(0, ...counts.map((c) => c.votes));
  if (top === 0) return null;
  return sample(
    counts.filter((c) => c.votes === top),
    1,
    random,
  )[0]!.map;
};

// Whether an open vote should close now: its time is up, or a team is close to winning the match.
export const closeDue = (vote: MapVote, now: number, leadingScore: number, scoreToWin: number): boolean =>
  vote.outcome === null && (now >= vote.closesAt || leadingScore >= scoreToWin * CLOSE_SCORE_SHARE);

// What the website gets: the options with their votes, never the ballots or the salt.
export type PublicVote = {
  id: string;
  open: boolean;
  fromMap: string;
  fromName: string;
  closesAt: number;
  options: { map: string; name: string; votes: number }[];
  total: number;
  // The map that won and is on its way to the server, when the vote ended with one.
  winner: { map: string; name: string } | null;
  // Every winner is played infantry only; the page says so.
  infantryOnly: true;
  // Words for the page when the vote ended without one.
  note: string | null;
  pending: boolean;
};

export const publicVote = (vote: MapVote, now: number): PublicVote => {
  const options = tally(vote);
  const winner = vote.outcome?.winner ?? null;
  return {
    id: vote.id,
    open: isOpen(vote, now),
    fromMap: vote.fromMap,
    fromName: mapName(vote.fromMap),
    closesAt: vote.closesAt,
    options,
    total: options.reduce((sum, o) => sum + o.votes, 0),
    winner: winner === null ? null : { map: winner, name: options.find((o) => o.map === winner)?.name ?? mapName(winner) },
    infantryOnly: true,
    note: vote.outcome?.note ?? null,
    pending: vote.outcome?.pending ?? false,
  };
};

// The reasons a vote ended without staging a map, as the page and the logs say them.
export const NOTE = {
  nobody: 'Nobody voted, so the rotation carries on.',
  staff: 'Staff picked the next map while the vote was open, so their pick stands.',
  late: 'The match ended before the winner could be put on the server.',
  failed: 'The winner could not be put on the server.',
} as const;
