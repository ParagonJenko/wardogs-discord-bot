import { z } from 'zod';
import { mapEmoji, mapName, type Embed } from './discord.ts';
import type { MapChoice } from './rotationspage.ts';

// The next-map vote. While a match is live the bot posts a message with a button for each of a few maps in one Discord
// channel; members vote by pressing one. When the vote closes the winning map is staged on the server, the same as staff's
// /setnextmap, and plays when this match ends. The website's /vote page shows the same counts and sends people to the
// channel. Nothing here touches the server or storage: the Watcher opens, closes and applies the vote (see updateMapVote
// in worker.ts), and the interaction handler passes in the button presses.
//
// One vote per person is one per Discord account: a ballot is the voter's Discord user ID, and pressing a button again
// moves it. Only members of the server can press the buttons (checked in interactions.ts).

export const MAP_VOTE_KEY = 'mapVote';

// A vote closes at the first of its time running out and the leading team reaching this share of the winning score, so
// it is always over while the match can still be told where to go next.
export const CLOSE_SCORE_SHARE = 0.75;

// How every winner is set up: infantry only (see MODIFIERS in matchsetup.ts), whatever the rotation plays that map with.
export const VOTE_SETUP_OPTIONS = { infantry_only: 'true' };

// `channelId` is where the vote is posted and `botToken` the bot's, which posting and editing a message with buttons need
// (a webhook can't carry them). The vote does not run without both.
export type MapVoteRule = { options: number; minutes: number; channelId: string | undefined; botToken: string | undefined };

export type VoteOption = { map: string; name: string };

// `user` is the voter's Discord user ID. It is never sent to the website.
export type Ballot = { user: string; map: string; at: number };

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
  // The Discord message the vote is in, to update as votes come and when it ends.
  message: { channelId: string; messageId: string } | null;
  outcome: VoteOutcome | null;
};

const MapVoteSchema = z.object({
  id: z.string(),
  matchStartedAt: z.number(),
  fromMap: z.string(),
  openedAt: z.number(),
  closesAt: z.number(),
  options: z.array(z.object({ map: z.string(), name: z.string() })),
  ballots: z.array(z.object({ user: z.string(), map: z.string(), at: z.number() })),
  message: z.object({ channelId: z.string(), messageId: z.string() }).nullable().default(null),
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

// Maps played lately that a vote does not offer again: the one being played and the ones before it.
export const RECENT_MAPS = 4;
export const RECENT_MAPS_KEY = 'mapVoteRecent';

export const parseRecentMaps = (raw: unknown): string[] => {
  const parsed = z.array(z.string()).safeParse(raw);
  return parsed.success ? parsed.data.slice(-RECENT_MAPS) : [];
};

// The recent maps with this one last, once each.
export const withPlayed = (recent: readonly string[], playing: string): string[] =>
  [...recent.filter((m) => m !== playing), playing].slice(-RECENT_MAPS);

// The maps a vote can offer: ones the server can play (with a game mode) that were not played lately, and never the one
// being played, so the same map is not played twice in a row. When that leaves fewer than two, the older recent maps are
// offered again before the vote is given up on. Fewer than two even then is no vote.
export const pickOptions = (
  maps: readonly MapChoice[],
  playing: string,
  recent: readonly string[],
  count: number,
  random: () => number,
): VoteOption[] => {
  const playable = maps.filter((m) => m.id !== playing && m.modes.length > 0);
  // Most recent first, so the oldest are the first let back in.
  const newestFirst = [...recent].reverse();
  const fresh = playable.filter((m) => !recent.includes(m.id));
  const pool = [...fresh];
  if (pool.length < Math.min(count, 2)) {
    // Not enough maps that were not played lately: let back in the ones played longest ago, to make up two.
    const back = playable.filter((m) => recent.includes(m.id)).sort((a, b) => newestFirst.indexOf(b.id) - newestFirst.indexOf(a.id));
    pool.push(...back.slice(0, 2 - pool.length));
  }
  if (pool.length < 2) return [];
  return sample(pool, count, random).map((m) => ({ map: m.id, name: m.name }));
};

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
  message: null,
  outcome: null,
});

export type CastResult = { vote: MapVote; result: 'counted' | 'changed' } | { result: 'closed' | 'unknown-map' };

// One ballot per Discord user: voting again moves their vote. A vote for the map they already chose changes nothing.
export const castVote = (vote: MapVote, ballot: { user: string; map: string }, now: number): CastResult => {
  if (!isOpen(vote, now)) return { result: 'closed' };
  if (!vote.options.some((o) => o.map === ballot.map)) return { result: 'unknown-map' };
  const had = vote.ballots.find((b) => b.user === ballot.user);
  const others = vote.ballots.filter((b) => b.user !== ballot.user);
  return { vote: { ...vote, ballots: [...others, { ...ballot, at: now }] }, result: had === undefined ? 'counted' : 'changed' };
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

// What the website gets: the options with their votes, never the ballots or who cast them.
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

// The Discord message for a vote: the counts as bars, and a button per map while it is open. Buttons are in rows of five,
// the most Discord allows.
export const VOTE_ID_PREFIX = 'mapvote';
const BAR_WIDTH = 12;
const barOf = (votes: number, total: number): string => {
  const filled = total === 0 ? 0 : Math.round((votes / total) * BAR_WIDTH);
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
};
const BUTTONS_PER_ROW = 5;
const SECONDARY = 2;
const OPEN_COLOUR = 0x4fd6cc;
const WON_COLOUR = 0x2ecc71;
const OVER_COLOUR = 0x8a94a3;

export type VoteMessage = { embeds: Embed[]; components: unknown[]; allowed_mentions: { parse: never[] } };

export const voteMessage = (vote: MapVote, now: number, siteUrl?: string): VoteMessage => {
  const shown = publicVote(vote, now);
  const where = siteUrl === undefined ? '' : ` Results also on ${siteUrl.replace(/\/$/, '')}/vote.`;
  const description = shown.open
    ? `Vote for the map after **${mapEmoji(vote.fromMap)}${shown.fromName}**. One vote each: press another map to change yours. ` +
      `Closes <t:${Math.floor(vote.closesAt / 1000)}:R>. The winner plays next, **infantry only**.${where}`
    : shown.winner !== null
      ? shown.pending
        ? `**${shown.winner.name}** won. Putting it on the server…`
        : `**${shown.winner.name}** won and plays next, **infantry only**.`
      : (shown.note ?? 'The vote has closed. Counting the votes…');
  const embed: Embed = {
    title: '🗺️ Vote for the next map',
    description,
    color: shown.open ? OPEN_COLOUR : shown.winner !== null ? WON_COLOUR : OVER_COLOUR,
    fields: shown.options.map((o) => ({
      name: `${mapEmoji(o.map)}${o.name}${shown.winner?.map === o.map ? ' ✅' : ''}`,
      value: `${barOf(o.votes, shown.total)} ${o.votes} ${o.votes === 1 ? 'vote' : 'votes'}`,
    })),
  };
  const buttons = shown.open
    ? shown.options.map((o) => ({
        type: 2,
        style: SECONDARY,
        label: o.name.slice(0, 80),
        custom_id: `${VOTE_ID_PREFIX}:${vote.id}:${o.map}`,
      }))
    : [];
  const components = Array.from({ length: Math.ceil(buttons.length / BUTTONS_PER_ROW) }, (_, i) => ({
    type: 1,
    components: buttons.slice(i * BUTTONS_PER_ROW, (i + 1) * BUTTONS_PER_ROW),
  }));
  return { embeds: [embed], components, allowed_mentions: { parse: [] } };
};

// A button's custom_id: "mapvote:<vote id>:<map id>". Null for anything else.
export const parseVoteButton = (customId: string | undefined): { poll: string; map: string } | null => {
  const found = /^mapvote:(\d{1,20}):([A-Za-z0-9_]{1,64})$/.exec(customId ?? '');
  return found === null ? null : { poll: found[1]!, map: found[2]! };
};

const DISCORD_API = 'https://discord.com/api/v10';

// Posts the vote to its channel, and answers the message's ID.
export const postVoteMessage = async (
  botToken: string,
  channelId: string,
  message: VoteMessage,
  fetchFn: typeof fetch = fetch,
): Promise<string> => {
  const response = await fetchFn(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bot ${botToken}` },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Discord refused the vote message: ${response.status} ${await response.text()}`);
  return z.object({ id: z.string() }).parse(await response.json()).id;
};

export const editVoteMessage = async (
  botToken: string,
  channelId: string,
  messageId: string,
  message: VoteMessage,
  fetchFn: typeof fetch = fetch,
): Promise<void> => {
  const response = await fetchFn(`${DISCORD_API}/channels/${channelId}/messages/${messageId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bot ${botToken}` },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(8_000),
  });
  // A message staff deleted has nothing to update.
  if (!response.ok && response.status !== 404) throw new Error(`Discord refused the vote update: ${response.status} ${await response.text()}`);
};
