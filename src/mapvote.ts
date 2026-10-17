import { z } from 'zod';
import { mapEmoji, mapName, type Embed } from './discord.ts';
import type { MatchFeed } from './matchfeed.ts';
import type { MapChoice } from './rotationspage.ts';

// The next-map vote. While a match is live the bot posts a message with a button for each of a few maps in one Discord
// channel; members vote by pressing one. When the vote closes the winning map is staged on the server, the same as staff's
// /setnextmap, and plays when this match ends. The website's /vote page shows the same counts and sends people to the
// channel. Nothing here touches the server or storage: the Watcher opens, closes and applies the vote (see updateMapVote
// in worker.ts), and the interaction handler passes in the button presses.
//
// One vote per person is one per Discord account: a ballot is the voter's Discord user ID, and pressing a button again
// moves it. Only members of the server can press the buttons (checked in interactions.ts).
//
// A second row of buttons votes on the conditions (time of day and weather): groups of the server's lightings such as Day,
// Night and Rain, and Random. Each person has one vote on the map and one on the conditions. The winning group gives a
// random lighting from it; with no votes on it, the lighting is left as the rotation has it. It is part of the same
// message, so it adds nothing for people to read.

export const MAP_VOTE_KEY = 'mapVote';

// A vote closes at the first of its time running out and the leading team reaching its close score (MAP_VOTE_CLOSE_PERCENT
// of the winning score, 95% by default), so people stop voting before the match ends. The time is only a backstop: a match
// lasts about 50 minutes, so the score is what normally closes it. Closing only picks the winner: it is put on the server
// once the match is over (see matchIsOver), as staging it mid-round was followed by the match ending early.
// Always at least a point short of the winning score, however small SCORE_TO_WIN or high the percent: rounding up must not
// leave the vote open until the match is won.
export const closeScoreFor = (scoreToWin: number, percent: number): number =>
  Math.max(1, Math.min(scoreToWin - 1, Math.ceil((scoreToWin * percent) / 100)));

// How every winner is set up: infantry only (see MODIFIERS in matchsetup.ts), whatever the rotation plays that map with.
export const VOTE_SETUP_OPTIONS = { infantry_only: 'true' };

// `channelId` is where the vote is posted and `botToken` the bot's, which posting and editing a message with buttons need
// (a webhook can't carry them). The vote does not run without both.
export type MapVoteRule = {
  options: number;
  minutes: number;
  closePercent: number;
  channelId: string | undefined;
  botToken: string | undefined;
  // How the winner is put on the server (see MAP_VOTE_STAGING in config.ts).
  staging: 'rotation' | 'queue';
};

export type VoteOption = { map: string; name: string };

// One of the server's lightings (times of day and weather, such as DayClear), by id and the name to show.
export type Lighting = { id: string; name: string };

// A choice on the conditions row: the lightings it covers (a group such as Night, or every one for Random).
export type ConditionOption = { key: string; label: string; lightings: Lighting[] };

// `user` is the voter's Discord user ID. It is never sent to the website. `map` and `light` are what they picked, each null
// until they vote on it.
export type Ballot = { user: string; map: string | null; light: string | null; at: number };

// How a vote ended: the map the server was told to play next, or why it was not told.
export type VoteOutcome = {
  at: number;
  // Null when nobody voted, or the server could not be told.
  winner: string | null;
  // True while the winner could not be put on the server yet and each check tries again.
  pending: boolean;
  // Why nothing was staged, in words for the page.
  note?: string;
  // The lighting the conditions vote chose, with its name, when it chose one.
  lighting?: string | null;
  lightingName?: string | null;
};

export type MapVote = {
  // The match it is for: when the match started, which is also its id.
  id: string;
  matchStartedAt: number;
  // The map being played when it opened: the vote is about what comes after.
  fromMap: string;
  openedAt: number;
  closesAt: number;
  // The score a team reaching closes the vote. 0 when unknown (a vote saved before this was kept): then only time closes it.
  closeScore: number;
  options: VoteOption[];
  // The conditions row: empty when the server's lightings give fewer than two groups to choose between.
  conditions: ConditionOption[];
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
  closeScore: z.number().default(0),
  options: z.array(z.object({ map: z.string(), name: z.string() })),
  conditions: z
    .array(z.object({ key: z.string(), label: z.string(), lightings: z.array(z.object({ id: z.string(), name: z.string() })) }))
    .default([]),
  ballots: z.array(
    z.object({ user: z.string(), map: z.string().nullable().default(null), light: z.string().nullable().default(null), at: z.number() }),
  ),
  message: z.object({ channelId: z.string(), messageId: z.string() }).nullable().default(null),
  outcome: z
    .object({
      at: z.number(),
      winner: z.string().nullable(),
      pending: z.boolean(),
      note: z.string().optional(),
      lighting: z.string().nullable().optional(),
      lightingName: z.string().nullable().optional(),
    })
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

// Maps played lately that a vote does not offer again: the one being played and the four before it.
export const RECENT_MAPS = 5;
export const RECENT_MAPS_KEY = 'mapVoteRecent';

export const parseRecentMaps = (raw: unknown): string[] => {
  const parsed = z.array(z.string()).safeParse(raw);
  return parsed.success ? parsed.data.slice(-RECENT_MAPS) : [];
};

// The recent maps with this one last, once each.
export const withPlayed = (recent: readonly string[], playing: string): string[] =>
  [...recent.filter((m) => m !== playing), playing].slice(-RECENT_MAPS);

// The maps a vote can offer: ones the server can play (with a game mode and infantry only) that were not played lately, and never the one
// being played, so the same map is not played twice in a row. When that leaves fewer than two (a server with few maps),
// the maps played longest ago are offered again, oldest first, rather than no vote at all. Fewer than two even then is no vote.
export const pickOptions = (
  maps: readonly MapChoice[],
  playing: string,
  recent: readonly string[],
  count: number,
  random: () => number,
): VoteOption[] => {
  // Only maps that list infantry only themselves: every winner is played with it, and the id sent must be one that map has
  // (see applyVoteWinner), never one found on another map.
  const playable = maps.filter((m) => m.id !== playing && m.modes.length > 0 && m.modifiers.some((x) => x.key === 'infantry_only'));
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

// The groups the conditions row can offer, in the order they are kept when there are more than fit (a row holds five
// buttons and Random is one). A lighting is in every group its id or name fits, so Night covers a rainy night too. The
// names are matched, not listed, as the server's catalogue decides what lightings there are.
const CONDITION_GROUPS = [
  { key: 'day', label: 'Day', pattern: /day|noon|morning/i },
  { key: 'night', label: 'Night', pattern: /night/i },
  { key: 'rain', label: 'Rain', pattern: /rain|storm|thunder|shower/i },
  { key: 'dusk', label: 'Dusk', pattern: /dusk|sunset|evening/i },
  { key: 'dawn', label: 'Dawn', pattern: /dawn|sunrise/i },
  { key: 'fog', label: 'Fog', pattern: /fog|mist/i },
  { key: 'snow', label: 'Snow', pattern: /snow/i },
  { key: 'overcast', label: 'Overcast', pattern: /overcast|cloud/i },
] as const;
const MAX_CONDITION_GROUPS = 4;
export const RANDOM_CONDITION = 'random';

// The conditions row for a server's lightings: the groups it has, and Random across all of them. Nothing (no row) when
// there are fewer than two groups to choose between.
export const conditionOptions = (lightings: readonly Lighting[]): ConditionOption[] => {
  const groups = CONDITION_GROUPS.flatMap((g) => {
    const own = lightings.filter((l) => g.pattern.test(`${l.id} ${l.name}`));
    return own.length > 0 ? [{ key: g.key, label: g.label, lightings: own }] : [];
  }).slice(0, MAX_CONDITION_GROUPS);
  return groups.length < 2 ? [] : [...groups, { key: RANDOM_CONDITION, label: 'Random', lightings: [...lightings] }];
};

export const openVote = (
  match: { startedAt: number },
  fromMap: string,
  options: VoteOption[],
  rule: MapVoteRule,
  now: number,
  closeScore: number,
  conditions: ConditionOption[] = [],
): MapVote => ({
  id: String(match.startedAt),
  matchStartedAt: match.startedAt,
  fromMap,
  openedAt: now,
  closesAt: now + rule.minutes * 60_000,
  closeScore,
  options,
  conditions,
  ballots: [],
  message: null,
  outcome: null,
});

export type CastResult = { vote: MapVote; result: 'counted' | 'changed' } | { result: 'closed' | 'unknown-map' };

// One ballot per Discord user, with a vote on the map and one on the conditions: voting again moves that vote, and the
// other stays. A vote for what they already chose changes nothing. `ballot` has the map or the conditions, not both.
export const castVote = (vote: MapVote, ballot: { user: string; map?: string; light?: string }, now: number): CastResult => {
  if (!isOpen(vote, now)) return { result: 'closed' };
  const { map, light } = ballot;
  if ((map === undefined) === (light === undefined)) return { result: 'unknown-map' };
  if (map !== undefined && !vote.options.some((o) => o.map === map)) return { result: 'unknown-map' };
  if (light !== undefined && !vote.conditions.some((c) => c.key === light)) return { result: 'unknown-map' };
  const had = vote.ballots.find((b) => b.user === ballot.user);
  const others = vote.ballots.filter((b) => b.user !== ballot.user);
  const next: Ballot = { user: ballot.user, map: map ?? had?.map ?? null, light: light ?? had?.light ?? null, at: now };
  const before = map !== undefined ? had?.map : had?.light;
  return { vote: { ...vote, ballots: [...others, next] }, result: before == null ? 'counted' : 'changed' };
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

// Votes for each choice on the conditions row, in the order they were offered.
export const tallyConditions = (vote: MapVote): { key: string; label: string; votes: number }[] =>
  vote.conditions.map((c) => ({ key: c.key, label: c.label, votes: vote.ballots.filter((b) => b.light === c.key).length }));

// The lighting the conditions vote chose: a random one from the group with the most votes (a tie is settled by chance), or
// null when nobody voted on it, and then the lighting stays as the rotation has it.
export const chooseConditions = (vote: MapVote, random: () => number): Lighting | null => {
  const counts = tallyConditions(vote);
  const top = Math.max(0, ...counts.map((c) => c.votes));
  if (top === 0) return null;
  const group = sample(
    counts.filter((c) => c.votes === top),
    1,
    random,
  )[0]!;
  return sample(vote.conditions.find((c) => c.key === group.key)?.lightings ?? [], 1, random)[0] ?? null;
};

// Whether people can vote on this match right now: the vote is for this match, which has not ended, its time has not run out
// and no team has reached the close score (the check that closes it comes later in the same pass). What points people at the
// vote, in game and on the live status, goes by this, so neither sends them to a vote that is closed or about to be.
export const votingNow = (
  vote: MapVote | null,
  match: { startedAt: number; endedAt?: number | undefined; factionScores: readonly { score: number }[] } | null,
  now: number,
): boolean => {
  if (vote === null || match === null) return false;
  if (vote.matchStartedAt !== match.startedAt || match.endedAt !== undefined || !isOpen(vote, now)) return false;
  const leading = Math.max(0, ...match.factionScores.map((f) => f.score));
  return !(vote.closeScore > 0 && leading >= vote.closeScore);
};

// Whether an open vote should close now: its time is up, or a team has reached its close score.
export const closeDue = (vote: MapVote, now: number, leadingScore: number): boolean =>
  vote.outcome === null && (now >= vote.closesAt || (vote.closeScore > 0 && leadingScore >= vote.closeScore));

// Whether the match the vote is for is over, so its winner can be put on the server without cutting the round short: the game
// said the match went to its end screen (MatchState.PostMatch) or sent its result, since the vote opened (`feed`, null
// without the kill feed), or a team has the winning score on the bot's own reading (`leadingScore`).
export const matchIsOver = (vote: MapVote, feed: MatchFeed | null, leadingScore: number, scoreToWin: number): boolean => {
  const endScreen = feed?.state?.startsWith('MatchState.PostMatch') === true && (feed.stateAt ?? 0) >= vote.openedAt;
  const resulted = feed?.result != null && feed.result.at >= vote.openedAt;
  return endScreen || resulted || leadingScore >= scoreToWin;
};

// What the website gets: the options with their votes, never the ballots or who cast them.
export type PublicVote = {
  id: string;
  open: boolean;
  fromMap: string;
  fromName: string;
  closesAt: number;
  // The score a team reaching closes the vote, or 0 when only time does.
  closeScore: number;
  // When it ended, once it has, so the website shows the result for a while after.
  closedAt: number | null;
  options: { map: string; name: string; votes: number }[];
  total: number;
  // The conditions row with its votes; empty when there is none.
  conditions: { key: string; label: string; votes: number }[];
  // The lighting the conditions vote chose, once it has, such as "Night, rain".
  lightingName: string | null;
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
    closeScore: vote.closeScore,
    closedAt: vote.outcome?.at ?? null,
    options,
    total: options.reduce((sum, o) => sum + o.votes, 0),
    conditions: tallyConditions(vote),
    lightingName: vote.outcome?.lightingName ?? null,
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
export const LIGHT_ID_PREFIX = 'maplight';
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
  const at = `<t:${Math.floor(vote.closesAt / 1000)}:R>`;
  const closing = vote.closeScore > 0 ? `when a team reaches ${vote.closeScore} points, or ${at}, whichever is first.` : `${at}.`;
  const where = siteUrl === undefined ? '' : ` Results also on ${siteUrl.replace(/\/$/, '')}/vote.`;
  const description = shown.open
    ? `Vote for the map after **${mapEmoji(vote.fromMap)}${shown.fromName}**${shown.conditions.length > 0 ? ' and the conditions' : ''}. ` +
      `One vote each: press another to change yours. Closes ${closing} The winner plays next, **infantry only**.${where}`
    : shown.winner !== null
      ? shown.pending
        ? `**${shown.winner.name}** won. It goes on the server when the match ends…`
        : `**${shown.winner.name}** won and plays next, **infantry only**${shown.lightingName ? `, **${shown.lightingName}**` : ''}.`
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
  // The conditions as one line, so the row adds a field and not a field each.
  if (shown.conditions.length > 0 && (shown.open || shown.winner !== null)) {
    embed.fields = [
      ...(embed.fields ?? []),
      { name: '🌤️ Conditions', value: shown.conditions.map((c) => `**${c.label}** ${c.votes}`).join(' · ') },
    ];
  }
  const buttons = shown.open
    ? shown.options.map((o) => ({
        type: 2,
        style: SECONDARY,
        label: o.name.slice(0, 80),
        custom_id: `${VOTE_ID_PREFIX}:${vote.id}:${o.map}`,
      }))
    : [];
  const rows = Array.from({ length: Math.ceil(buttons.length / BUTTONS_PER_ROW) }, (_, i) => ({
    type: 1,
    components: buttons.slice(i * BUTTONS_PER_ROW, (i + 1) * BUTTONS_PER_ROW),
  }));
  // The conditions row: its own row, so it is clear it is a second vote.
  const conditionButtons =
    shown.open && vote.conditions.length > 0
      ? [
          {
            type: 1,
            components: vote.conditions.map((c) => ({
              type: 2,
              style: SECONDARY,
              label: c.key === RANDOM_CONDITION ? '🎲 Random' : c.label,
              custom_id: `${LIGHT_ID_PREFIX}:${vote.id}:${c.key}`,
            })),
          },
        ]
      : [];
  const components = [...rows, ...conditionButtons];
  return { embeds: [embed], components, allowed_mentions: { parse: [] } };
};

// A button's custom_id: "mapvote:<vote id>:<map id>". Null for anything else.
export const parseVoteButton = (customId: string | undefined): { poll: string; map: string } | null => {
  const found = /^mapvote:(\d{1,20}):([A-Za-z0-9_]{1,64})$/.exec(customId ?? '');
  return found === null ? null : { poll: found[1]!, map: found[2]! };
};

// A conditions button's custom_id: "maplight:<vote id>:<group>". Null for anything else.
export const parseLightButton = (customId: string | undefined): { poll: string; light: string } | null => {
  const found = /^maplight:(\d{1,20}):([a-z]{1,16})$/.exec(customId ?? '');
  return found === null ? null : { poll: found[1]!, light: found[2]! };
};

// The link to the vote's message in Discord, while it is open and was posted.
export const voteLink = (vote: MapVote | null, guildId: string | undefined, now: number): string | null =>
  vote !== null && vote.message !== null && guildId && isOpen(vote, now)
    ? `https://discord.com/channels/${guildId}/${vote.message.channelId}/${vote.message.messageId}`
    : null;

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
