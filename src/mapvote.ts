import { z } from 'zod';
import { mapEmoji, mapName, type DiscordMessage, type Embed } from './discord.ts';
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
// Two more rows of buttons vote on the conditions: the time of day (Morning, Day, Afternoon, Dusk, Night) and the weather
// (Clear, Fog, Rain, Snow), each with Random, as groups of what the server lists. Each person has one vote on the map, one
// on the time of day and one on the weather. The winning time and weather give a lighting that has both; with no such
// lighting the weather wins, and the time nearest the one chosen is used. With no votes on a row, that part is left as the
// rotation has it. The circles (the control-zone layout) are not voted on: the winning map gets one of its layouts by chance,
// never the one the vote last gave that map (see randomZone). It is all part of the same message.

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

// The map button that picks a map at random, from `pool` (every map the vote could have offered).
export const RANDOM_MAP = 'random';

// One of a map's control-zone layouts, by its id and the name to show.
export type ZoneChoice = { id: string; name: string };

// One of the server's lightings (times of day and weather, such as DayClear), by id and the name to show.
export type Lighting = { id: string; name: string };

// A choice on the time of day or the weather row: the lightings it covers (a group such as Dusk or Rain, or every one for
// Random).
export type ConditionOption = { key: string; label: string; lightings: Lighting[] };

// `user` is the voter's Discord user ID. It is never sent to the website. `map`, `light` (the time of day; the name is from
// when it was the only conditions vote) and `weather` are what they picked, each null until they vote.
export type Ballot = { user: string; map: string | null; light: string | null; weather: string | null; at: number };

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
  // The circles (control-zone layout) chosen by chance for the winner, with its name, when the map has a choice of them.
  zone?: string | null;
  zoneName?: string | null;
};

// What this vote does about rain: `all` when the match being played is in the rain, so no rain is chosen; and `skipped`, the map
// (an id) that last had rain, which is not offered.
export type RainRule = { all: boolean; skipped: string | null };

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
  // The time of day row: empty when the server's lightings give fewer than two groups to choose between.
  conditions: ConditionOption[];
  // The weather row, likewise.
  weather: ConditionOption[];
  // Every map the vote could have offered, for the Random map button (which is in `options` when there is one).
  pool: VoteOption[];
  ballots: Ballot[];
  // The Discord message the vote is in, to update as votes come and when it ends.
  message: { channelId: string; messageId: string } | null;
  outcome: VoteOutcome | null;
  rain: RainRule;
};

const OptionSchema = z.object({ key: z.string(), label: z.string(), lightings: z.array(z.object({ id: z.string(), name: z.string() })) });

const MapVoteSchema = z.object({
  id: z.string(),
  matchStartedAt: z.number(),
  fromMap: z.string(),
  openedAt: z.number(),
  closesAt: z.number(),
  closeScore: z.number().default(0),
  options: z.array(z.object({ map: z.string(), name: z.string() })),
  conditions: z.array(OptionSchema).default([]),
  weather: z.array(OptionSchema).default([]),
  pool: z.array(z.object({ map: z.string(), name: z.string() })).default([]),
  ballots: z.array(
    z.object({
      user: z.string(),
      map: z.string().nullable().default(null),
      light: z.string().nullable().default(null),
      weather: z.string().nullable().default(null),
      at: z.number(),
    }),
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
      zone: z.string().nullable().optional(),
      zoneName: z.string().nullable().optional(),
    })
    .nullable()
    .default(null),
  rain: z.object({ all: z.boolean(), skipped: z.string().nullable() }).default({ all: false, skipped: null }),
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

// The id of a map the server reports by name or id: the status says "Ozeti" where the catalogue says "Europe". An unknown map
// stays as it was. The never-twice-in-a-row and played-lately rules below compare ids, so they need this.
export const mapIdOf = (maps: readonly MapChoice[], map: string): string => {
  const lower = map.trim().toLowerCase();
  return (maps.find((m) => m.id.toLowerCase() === lower) ?? maps.find((m) => m.name.toLowerCase() === lower))?.id ?? map;
};

// The maps a vote can offer: ones the server can play (with a game mode and infantry only) that were not played lately, and never the one
// being played, so the same map is not played twice in a row. When that leaves fewer than two (a server with few maps),
// the maps played longest ago are offered again, oldest first, rather than no vote at all. Fewer than two even then is none.
export const votePool = (
  maps: readonly MapChoice[],
  playing: string,
  recent: readonly string[],
  count: number,
  avoid: readonly string[] = [],
): MapChoice[] => {
  // Only maps that list infantry only themselves: every winner is played with it, and the id sent must be one that map has
  // (see applyVoteWinner), never one found on another map.
  const playable = maps.filter((m) => m.id !== playing && m.modes.length > 0 && m.modifiers.some((x) => x.key === 'infantry_only'));
  // Most recent first, so the oldest are the first let back in.
  const newestFirst = [...recent].reverse();
  const poolOf = (from: readonly MapChoice[]): MapChoice[] => {
    const pool = from.filter((m) => !recent.includes(m.id));
    if (pool.length < Math.min(count, 2)) {
      // Not enough maps that were not played lately: let back in the ones played longest ago, to make up two.
      const back = from.filter((m) => recent.includes(m.id)).sort((a, b) => newestFirst.indexOf(b.id) - newestFirst.indexOf(a.id));
      pool.push(...back.slice(0, 2 - pool.length));
    }
    return pool.length < 2 ? [] : pool;
  };
  // The maps to avoid (the one that last had rain) are left out, unless that leaves no vote.
  const without = poolOf(playable.filter((m) => !avoid.includes(m.id)));
  return without.length > 0 || avoid.length === 0 ? without : poolOf(playable);
};

// The maps on the buttons: `count` of the pool, chosen at random.
export const pickOptions = (
  maps: readonly MapChoice[],
  playing: string,
  recent: readonly string[],
  count: number,
  random: () => number,
  avoid: readonly string[] = [],
): VoteOption[] => sample(votePool(maps, playing, recent, count, avoid), count, random).map((m) => ({ map: m.id, name: m.name }));

// The circles (control-zone layout) each map last had from a vote, by map id, so the next time it wins it gets another.
export const LAST_ZONES_KEY = 'mapVoteZones';

export const parseLastZones = (raw: unknown): Record<string, string> => {
  const parsed = z.record(z.string(), z.string()).safeParse(raw);
  return parsed.success ? parsed.data : {};
};

// The circles for the winning map: one of its layouts by chance, never `last` (the one a vote last gave this map) nor one of
// the `blocked` ones (the ids staff blocked, see circles.ts). Null when the map has fewer than two layouts to choose between (a
// "None" layout is not one), or every layout is blocked, and then the rotation's stays. A map left with one layout that is not
// blocked gets it each time.
export const randomZone = (zones: readonly ZoneChoice[], last: string | undefined, random: () => number, blocked: readonly string[] = []): ZoneChoice | null => {
  const layouts = zones.filter((zone) => zone.name.trim() !== '' && zone.name.trim().toLowerCase() !== 'none');
  if (layouts.length < 2) return null;
  const allowed = layouts.filter((zone) => !blocked.includes(zone.id));
  if (allowed.length === 0) return null;
  const others = allowed.filter((zone) => zone.id !== last);
  return sample(others.length > 0 ? others : allowed, 1, random)[0] ?? null;
};

// The circles for the winner on this try: the layout an earlier try of this vote drew, when the map still lists it and it has not
// been blocked since, so the server, the history and what is announced agree across retries; otherwise a new draw (see randomZone).
export const zoneForTry = (
  outcome: VoteOutcome | null,
  zones: readonly ZoneChoice[],
  last: string | undefined,
  random: () => number,
  blocked: readonly string[] = [],
): ZoneChoice | null => zones.find((zone) => zone.id === outcome?.zone && !blocked.includes(zone.id)) ?? randomZone(zones, last, random, blocked);

// The outcome saying the layout that is (or will be) put on: `picked` is the draw, null when the map has no choice (no
// layout is reported, even if a vote saved before this one did), or undefined when none was made yet (it stays as it was).
export const outcomeWithZone = (outcome: VoteOutcome, picked: ZoneChoice | null | undefined): VoteOutcome => {
  const { zone, zoneName, ...rest } = outcome;
  if (picked === undefined) return outcome;
  return picked === null ? rest : { ...rest, zone: picked.id, zoneName: picked.name };
};

// The time of day and the weather of a lighting, from its id and name. The server's ids all begin with Day and say the time
// after it (DayStartClear, DayEarlyFog, DayClear, DayLateGray, DayLateRain, DayEndClear): Start is dawn and Early the
// morning, so both are Morning; Late is the afternoon and End is dusk. The weather is Clear, Fog, Rain or Snow, and Gray
// (overcast) counts as Clear. The names are matched, not listed, as the server's catalogue decides what lightings there are.
const TIMES = [
  { key: 'morning', label: 'Morning', pattern: /dawn|sunrise|morning|daystart|dayearly/i },
  { key: 'day', label: 'Day', pattern: /day|noon/i },
  { key: 'afternoon', label: 'Afternoon', pattern: /afternoon|daylate/i },
  { key: 'dusk', label: 'Dusk', pattern: /dusk|sunset|evening|dayend/i },
  { key: 'night', label: 'Night', pattern: /night/i },
] as const;
// What decides a lighting's time when its text fits more than one of the above (DayEndClear has "day" and "dayend").
const TIME_CHECKS = ['night', 'dusk', 'morning', 'afternoon', 'day'] as const;
// Which times are kept when there are more than fit on the row (five buttons, and Random is one).
const TIME_PRIORITY = ['day', 'night', 'dusk', 'morning', 'afternoon'] as const;

const WEATHERS = [
  { key: 'clear', label: 'Clear', pattern: /^$/ },
  { key: 'fog', label: 'Fog', pattern: /fog|mist/i },
  { key: 'rain', label: 'Rain', pattern: /rain|storm|thunder|shower/i },
  { key: 'snow', label: 'Snow', pattern: /snow/i },
] as const;
// Rain comes before fog when a lighting has both. Each of these is kept, as there are only four.
const WEATHER_CHECKS = ['rain', 'fog', 'snow'] as const;

const MAX_CONDITION_GROUPS = 4;
export const RANDOM_CONDITION = 'random';

const textOf = (l: Lighting): string => `${l.id} ${l.name}`;

// The key of a lighting's time of day, or null when its id and name say none.
export const timeOf = (l: Lighting): string | null =>
  TIME_CHECKS.find((key) => TIMES.find((t) => t.key === key)!.pattern.test(textOf(l))) ?? null;

// The key of a lighting's weather: clear unless it says otherwise.
export const weatherOf = (l: Lighting): string => WEATHER_CHECKS.find((key) => WEATHERS.find((w) => w.key === key)!.pattern.test(textOf(l))) ?? 'clear';

export const isRain = (l: Lighting): boolean => weatherOf(l) === 'rain';

// What is kept between matches to tell if rain was last: the match it is for (when it started), the map being played (as the
// status names it), whether its lighting has rain, the map that last had rain before it and the map that last had rain up to
// and including it (`lastRain`, which the next match starts from).
export const RAIN_KEY = 'mapVoteRain';
export type RainRecord = { matchStartedAt: number; map: string; rain: boolean; ban: string | null; lastRain: string | null };

export const parseRainRecord = (raw: unknown): RainRecord | null => {
  const parsed = z
    .object({ matchStartedAt: z.number(), map: z.string(), rain: z.boolean(), ban: z.string().nullable(), lastRain: z.string().nullable() })
    .safeParse(raw);
  return parsed.success ? parsed.data : null;
};

// The record for a match that began, from the one before it and the lighting its map is being played with (undefined when the
// rotation does not say, and then it counts as no rain).
export const rainRecordFor = (previous: RainRecord | null, matchStartedAt: number, map: string, lighting: string | undefined): RainRecord => {
  if (previous?.matchStartedAt === matchStartedAt) return previous;
  const rain = lighting !== undefined && isRain({ id: lighting, name: lighting });
  const lastRain = previous?.lastRain ?? null;
  return { matchStartedAt, map, rain, ban: rain ? null : lastRain, lastRain: rain ? map : lastRain };
};

// A row for some groups of the server's lightings: the groups it has in the order shown, at most four kept by `priority`,
// and Random across all the lightings. Nothing (no row) when there are fewer than two groups to choose between.
const groupRow = (
  lightings: readonly Lighting[],
  groups: readonly { key: string; label: string }[],
  priority: readonly string[],
  keyOf: (l: Lighting) => string | null,
): ConditionOption[] => {
  const present = groups.flatMap((g) => {
    const own = lightings.filter((l) => keyOf(l) === g.key);
    return own.length > 0 ? [{ key: g.key, label: g.label, lightings: own }] : [];
  });
  const kept = new Set(priority.filter((key) => present.some((g) => g.key === key)).slice(0, MAX_CONDITION_GROUPS));
  const shown = present.filter((g) => kept.has(g.key));
  return shown.length < 2 ? [] : [...shown, { key: RANDOM_CONDITION, label: 'Random', lightings: [...lightings] }];
};

// The time of day row for a server's lightings (Morning, Day, Afternoon, Dusk, Night, and Random).
export const conditionOptions = (lightings: readonly Lighting[]): ConditionOption[] => groupRow(lightings, TIMES, TIME_PRIORITY, timeOf);

// The weather row (Clear, Fog, Rain, Snow, and Random).
export const weatherOptions = (lightings: readonly Lighting[]): ConditionOption[] =>
  groupRow(lightings, WEATHERS, ['clear', 'rain', 'fog', 'snow'], weatherOf);

export const openVote = (
  match: { startedAt: number },
  fromMap: string,
  options: VoteOption[],
  rule: MapVoteRule,
  now: number,
  closeScore: number,
  conditions: ConditionOption[] = [],
  weather: ConditionOption[] = [],
  more: { pool?: VoteOption[]; rain?: RainRule } = {},
): MapVote => ({
  id: String(match.startedAt),
  matchStartedAt: match.startedAt,
  fromMap,
  openedAt: now,
  closesAt: now + rule.minutes * 60_000,
  closeScore,
  // A Random map button comes with the pool it picks from.
  options: (more.pool?.length ?? 0) > 0 ? [...options, { map: RANDOM_MAP, name: '🎲 Random' }] : options,
  conditions,
  weather,
  pool: more.pool ?? [],
  ballots: [],
  message: null,
  outcome: null,
  rain: more.rain ?? { all: false, skipped: null },
});

export type CastResult = { vote: MapVote; result: 'counted' | 'changed' } | { result: 'closed' | 'unknown-map' };

// One ballot per Discord user, with a vote on the map, one on the time of day and one on the weather: voting again moves
// that vote, and the others stay. A vote for what they already chose changes nothing. `ballot` has one.
export const castVote = (
  vote: MapVote,
  ballot: { user: string; map?: string; light?: string; weather?: string },
  now: number,
): CastResult => {
  if (!isOpen(vote, now)) return { result: 'closed' };
  const { map, light, weather } = ballot;
  if ([map, light, weather].filter((v) => v !== undefined).length !== 1) return { result: 'unknown-map' };
  if (map !== undefined && !vote.options.some((o) => o.map === map)) return { result: 'unknown-map' };
  if (light !== undefined && !vote.conditions.some((c) => c.key === light)) return { result: 'unknown-map' };
  if (weather !== undefined && !vote.weather.some((c) => c.key === weather)) return { result: 'unknown-map' };
  const had = vote.ballots.find((b) => b.user === ballot.user);
  const others = vote.ballots.filter((b) => b.user !== ballot.user);
  const next: Ballot = {
    user: ballot.user,
    map: map ?? had?.map ?? null,
    light: light ?? had?.light ?? null,
    weather: weather ?? had?.weather ?? null,
    at: now,
  };
  const before = map !== undefined ? had?.map : light !== undefined ? had?.light : had?.weather;
  return { vote: { ...vote, ballots: [...others, next] }, result: before == null ? 'counted' : 'changed' };
};

// Votes for each option, in the order they were offered.
export const tally = (vote: MapVote): { map: string; name: string; votes: number }[] =>
  vote.options.map((o) => ({ ...o, votes: vote.ballots.filter((b) => b.map === o.map).length }));

// The map with the most votes; a tie is settled by chance. Null when nobody voted. When Random has the most votes, the map is
// one of the pool (or of the other buttons when there is no pool) chosen by chance.
export const chooseWinner = (vote: MapVote, random: () => number): string | null => {
  const counts = tally(vote);
  const top = Math.max(0, ...counts.map((c) => c.votes));
  if (top === 0) return null;
  const won = sample(
    counts.filter((c) => c.votes === top),
    1,
    random,
  )[0]!.map;
  if (won !== RANDOM_MAP) return won;
  const among = vote.pool.length > 0 ? vote.pool : vote.options.filter((o) => o.map !== RANDOM_MAP);
  return sample(among, 1, random)[0]?.map ?? null;
};

// Votes for each choice on the time of day row, in the order they were offered.
export const tallyConditions = (vote: MapVote): { key: string; label: string; votes: number }[] =>
  vote.conditions.map((c) => ({ key: c.key, label: c.label, votes: vote.ballots.filter((b) => b.light === c.key).length }));

// Votes for each choice on the weather row.
export const tallyWeather = (vote: MapVote): { key: string; label: string; votes: number }[] =>
  vote.weather.map((c) => ({ key: c.key, label: c.label, votes: vote.ballots.filter((b) => b.weather === c.key).length }));

// The choice on a row with the most votes, or null when nobody voted on it. A tie is settled by chance, or with `safest` for
// the choice that comes first on the row (the row lists the safest weather first, so rain never wins a tie on luck).
const leader = <T extends { key: string }>(
  options: readonly T[],
  votes: readonly { key: string; votes: number }[],
  random: () => number,
  safest = false,
): T | null => {
  const top = Math.max(0, ...votes.map((v) => v.votes));
  if (top === 0) return null;
  const tied = votes.filter((v) => v.votes === top);
  const won = safest ? tied[0]! : sample(tied, 1, random)[0]!;
  return options.find((o) => o.key === won.key) ?? null;
};

// Of the lightings, those whose time of day is nearest `time` (all of them when it has no place, as Random has none).
const nearestTime = (lightings: readonly Lighting[], time: string): Lighting[] => {
  const at = TIMES.findIndex((t) => t.key === time);
  const distance = (l: Lighting): number => {
    const key = timeOf(l);
    return at < 0 || key === null ? Infinity : Math.abs(TIMES.findIndex((t) => t.key === key) - at);
  };
  const best = Math.min(...lightings.map(distance));
  return best === Infinity ? [...lightings] : lightings.filter((l) => distance(l) === best);
};

// The lighting the time of day and weather votes chose, or null when nobody voted on either, and then the lighting stays as
// the rotation has it. The winning time and weather give a lighting that has both. When none does the weather wins, with the
// time nearest the one chosen. With only a time, the lighting is a clear one when that time has one; with only weather, any
// time. Rain is liked by some and hated by others, so it wins only by having the most votes: a tie in the weather goes to the
// safest (Clear, then Fog, then Rain), not to chance.
export const chooseConditions = (vote: MapVote, random: () => number, noRain = false): Lighting | null => {
  // Without rain, no lighting with rain is chosen, and a vote for rain counts for nothing: a group left with no lighting is gone.
  const without = (rows: ConditionOption[]): ConditionOption[] =>
    noRain ? rows.map((r) => ({ ...r, lightings: r.lightings.filter((l) => !isRain(l)) })).filter((r) => r.lightings.length > 0) : rows;
  const open = noRain ? { ...vote, conditions: without(vote.conditions), weather: without(vote.weather) } : vote;
  const time = leader(open.conditions, tallyConditions(open), random);
  const weather = leader(open.weather, tallyWeather(open), random, true);
  const pick = (lightings: readonly Lighting[]): Lighting | null => sample(lightings, 1, random)[0] ?? null;
  if (time !== null && weather !== null) {
    const ids = new Set(weather.lightings.map((l) => l.id));
    const both = time.lightings.filter((l) => ids.has(l.id));
    return pick(both.length > 0 ? both : nearestTime(weather.lightings, time.key));
  }
  if (weather !== null) return pick(weather.lightings);
  if (time === null) return null;
  const clear = time.key === RANDOM_CONDITION ? [] : time.lightings.filter((l) => weatherOf(l) === 'clear');
  return pick(clear.length > 0 ? clear : time.lightings);
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
  // The time of day row with its votes; empty when there is none.
  conditions: { key: string; label: string; votes: number }[];
  // The weather row with its votes, likewise.
  weather: { key: string; label: string; votes: number }[];
  // The lighting the conditions vote chose, once it has, such as "Night, rain", and the circles the winner got, such as "Circle".
  lightingName: string | null;
  zoneName: string | null;
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
    weather: tallyWeather(vote),
    lightingName: vote.outcome?.lightingName ?? null,
    zoneName: vote.outcome?.zoneName ?? null,
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
export const WEATHER_ID_PREFIX = 'mapweather';
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

// What the description asks people to vote on besides the map: " and the time of day and the weather".
const conditionsAsked = (shown: PublicVote): string => {
  const asked = [
    ...(shown.conditions.length > 0 ? ['the time of day'] : []),
    ...(shown.weather.length > 0 ? ['the weather'] : []),
  ];
  if (asked.length === 0) return '';
  return asked.length === 1 ? ` and ${asked[0]}` : `, ${asked.slice(0, -1).join(', ')} and ${asked.at(-1)}`;
};

// Why there may be no rain, or a map missing, when that is so: it was last match, or one map had it last.
const rainNote = (vote: MapVote): string => {
  const left = vote.rain.skipped === null ? '' : ` ${mapName(vote.rain.skipped)} is not in the vote: it had rain last.`;
  return (vote.rain.all ? ' No rain this time: the last match was in the rain.' : '') + left;
};

export const voteMessage = (vote: MapVote, now: number, siteUrl?: string): VoteMessage => {
  const shown = publicVote(vote, now);
  const at = `<t:${Math.floor(vote.closesAt / 1000)}:R>`;
  const closing = vote.closeScore > 0 ? `when a team reaches ${vote.closeScore} points, or ${at}, whichever is first.` : `${at}.`;
  const where = siteUrl === undefined ? '' : ` Results also on ${siteUrl.replace(/\/$/, '')}/vote.`;
  const description = shown.open
    ? `Vote for the map after **${mapEmoji(vote.fromMap)}${shown.fromName}**${conditionsAsked(shown)}. ` +
      `One vote each: press another to change yours. Closes ${closing} The winner plays next, **infantry only**.${rainNote(vote)}${where}`
    : shown.winner !== null
      ? shown.pending
        ? `**${shown.winner.name}** won. Putting it on the server…`
        : `**${shown.winner.name}** won and plays next, **infantry only**${shown.lightingName ? `, **${shown.lightingName}**` : ''}${shown.zoneName ? `, **${shown.zoneName}** circles` : ''}.`
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
  // The time of day and the weather as a line each, so a row adds one field and not a field per button.
  if (shown.open || shown.winner !== null) {
    const line = (rows: { label: string; votes: number }[]): string => rows.map((c) => `**${c.label}** ${c.votes}`).join(' · ');
    embed.fields = [
      ...(embed.fields ?? []),
      ...(shown.conditions.length > 0 ? [{ name: '🕒 Time of day', value: line(shown.conditions) }] : []),
      ...(shown.weather.length > 0 ? [{ name: '🌦️ Weather', value: line(shown.weather) }] : []),
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
  // The time of day and weather rows: a row each, so it is clear they are votes of their own.
  const conditionRow = (options: { key: string; label: string }[], prefix: string) =>
    shown.open && options.length > 0
      ? [
          {
            type: 1,
            components: options.map((c) => ({
              type: 2,
              style: SECONDARY,
              label: c.key === RANDOM_CONDITION ? '🎲 Random' : c.label,
              custom_id: `${prefix}:${vote.id}:${c.key}`,
            })),
          },
        ]
      : [];
  const components = [
    ...rows,
    ...conditionRow(vote.conditions, LIGHT_ID_PREFIX),
    ...conditionRow(vote.weather, WEATHER_ID_PREFIX),
  ];
  return { embeds: [embed], components, allowed_mentions: { parse: [] } };
};

// The log line for a counted vote: who (the Discord user ID, and their name when it is known), what they voted for, and what
// it replaced. The logs are the only place who voted for what is kept apart from the vote itself, which the website never gets.
export const voteLogLine = (
  vote: MapVote,
  press: { userId: string; map?: string; light?: string; weather?: string; userName?: string | undefined; via?: string | undefined },
  before: Ballot | undefined,
): string => {
  const label = (key: string | null | undefined, rows: readonly { key: string; label: string }[]): string | null =>
    key == null ? null : (rows.find((r) => r.key === key)?.label ?? key);
  const [what, now, was] =
    press.map !== undefined
      ? ['map', vote.options.find((o) => o.map === press.map)?.name ?? press.map, vote.options.find((o) => o.map === before?.map)?.name ?? before?.map]
      : press.weather !== undefined
        ? ['weather', label(press.weather, vote.weather), label(before?.weather, vote.weather)]
        : ['time of day', label(press.light, vote.conditions), label(before?.light, vote.conditions)];
  // JSON.stringify keeps a name with quotes or line breaks on one line.
  const who = press.userName ? `${JSON.stringify(press.userName.slice(0, 40))} (${press.userId})` : press.userId;
  return `Map vote ${vote.id}: ${who} voted ${what} ${now}${was ? ` (was ${was})` : ''} via ${press.via ?? 'discord'}`;
};

// One message for the moderation log with every ballot of a vote that closed: for the map, the time of day and the weather, each
// choice with the people who voted for it, as mentions (Discord shows their names; nobody is pinged). Choices nobody voted for
// are left out. Cut short, with a note, when it would not fit in one embed; the log of each vote has them all.
const VOTE_LOG_CHARS = 3800;

export const voteLogMessage = (vote: MapVote): DiscordMessage => {
  const outcome = vote.outcome;
  const winner = outcome?.winner ?? null;
  const rows = (
    title: string,
    choices: readonly { key: string; label: string }[],
    chosen: (b: Ballot) => string | null,
  ): string[] => {
    const lines = choices.flatMap((c) => {
      const users = vote.ballots.filter((b) => chosen(b) === c.key).map((b) => `<@${b.user}>`);
      return users.length === 0 ? [] : [`${c.label} (${users.length}): ${users.join(' ')}`];
    });
    return lines.length === 0 ? [] : [`**${title}**`, ...lines];
  };
  const lines = [
    ...rows(
      '🗺️ Map',
      vote.options.map((o) => ({ key: o.map, label: `${mapEmoji(o.map)}${o.name}${o.map === winner ? ' ✅' : ''}` })),
      (b) => b.map,
    ),
    ...rows('🕒 Time of day', vote.conditions, (b) => b.light),
    ...rows('🌦️ Weather', vote.weather, (b) => b.weather),
  ];
  let text = '';
  let shown = 0;
  for (const line of lines) {
    if (text.length + line.length + 1 > VOTE_LOG_CHARS) break;
    text += `${line}\n`;
    shown += 1;
  }
  const cut = lines.length - shown;
  const result =
    winner === null
      ? 'No map won.'
      : `**${mapEmoji(winner)}${vote.options.find((o) => o.map === winner)?.name ?? mapName(winner)}** won${outcome?.lightingName ? `, **${outcome.lightingName}**` : ''}.`;
  return {
    embeds: [
      {
        title: `🗳️ Map vote closed · after ${mapName(vote.fromMap)}`,
        description: `${result} ${vote.ballots.length} ${vote.ballots.length === 1 ? 'person' : 'people'} voted.\n\n${text}${cut > 0 ? `…${cut} more lines cut: see the logs.` : ''}`.trim(),
        color: winner === null ? OVER_COLOUR : WON_COLOUR,
        footer: { text: `Vote ${vote.id}` },
        timestamp: new Date(outcome?.at ?? vote.closesAt).toISOString(),
      },
    ],
    allowed_mentions: { parse: [], roles: [] },
  };
};

// A button's custom_id: "mapvote:<vote id>:<map id>". Null for anything else.
export const parseVoteButton = (customId: string | undefined): { poll: string; map: string } | null => {
  const found = /^mapvote:(\d{1,20}):([A-Za-z0-9_]{1,64})$/.exec(customId ?? '');
  return found === null ? null : { poll: found[1]!, map: found[2]! };
};

// A time of day button's custom_id: "maplight:<vote id>:<group>". Null for anything else.
export const parseLightButton = (customId: string | undefined): { poll: string; light: string } | null => {
  const found = /^maplight:(\d{1,20}):([a-z]{1,16})$/.exec(customId ?? '');
  return found === null ? null : { poll: found[1]!, light: found[2]! };
};

// A weather button's custom_id: "mapweather:<vote id>:<group>". Null for anything else.
export const parseWeatherButton = (customId: string | undefined): { poll: string; weather: string } | null => {
  const found = /^mapweather:(\d{1,20}):([a-z]{1,16})$/.exec(customId ?? '');
  return found === null ? null : { poll: found[1]!, weather: found[2]! };
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

// Deletes a vote's message, such as the last match's when the next vote opens. One that is gone already is fine.
export const deleteVoteMessage = async (botToken: string, channelId: string, messageId: string, fetchFn: typeof fetch = fetch): Promise<void> => {
  const response = await fetchFn(`${DISCORD_API}/channels/${channelId}/messages/${messageId}`, {
    method: 'DELETE',
    headers: { authorization: `Bot ${botToken}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok && response.status !== 404) throw new Error(`Discord refused to delete the old vote message: ${response.status} ${await response.text()}`);
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
