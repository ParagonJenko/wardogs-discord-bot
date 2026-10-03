import { z } from 'zod';
import { factionKey, mapName } from './discord.ts';
import type { CurrentMatch, IdOf, Public, ServerSnapshot } from './stats.ts';
import type { RankedStats } from './tracking.ts';
import { isKill, weaponKind, weaponName, type FeedEvent, type WeaponKind } from './weapons.ts';

// The match going on now, from the game's kill feed, for the website's live page: every death as it happens, each
// player's kills, deaths and streaks, and the match's highlights. Kept in storage ('live') and sent to the page as
// it changes. The feed has no "match ended": a new match is the match clock starting again, the game restarting, the
// map changing, or a long quiet spell.

// The kill feed keeps this many deaths, and the page shows them all.
export const LIVE_FEED_KEPT = 40;
// Kills by one player this close together, in seconds of the match clock, are one multi-kill.
export const MULTI_KILL_SECONDS = 8;
// Kills without dying from which a player is on fire.
export const ON_FIRE = 5;
// A rivalry needs this many kills of one player by another.
export const RIVALRY_KILLS = 3;
const LIVE_PLAYERS_SHOWN = 10;
const LIVE_WEAPONS_SHOWN = 5;
// Kills this far apart are not the same match, however the clock reads.
const QUIET_MS = 20 * 60_000;
// The batches come in clock order, but a clock this little behind the last one is not a new match.
const CLOCK_SLACK = 30;

// A player in this match. `chain` is their kills in a row each within MULTI_KILL_SECONDS of the last, the last at
// `chainTime`; `longest` is their longest kill in metres, with `longestCause`.
export type LivePlayer = {
  steamId: string;
  name: string;
  faction: string | null;
  kills: number;
  deaths: number;
  headshots: number;
  teamKills: number;
  streak: number;
  bestStreak: number;
  chain: number;
  chainTime: number | null;
  bestChain: number;
  longest: number | null;
  longestCause: string | null;
  weapons: Record<string, number>;
};

// One death, with its killer and victim as places in `players`. `streak` and `chain` are the killer's after it.
export type LiveDeath = {
  eventId: string;
  at: number;
  killer: number | null;
  victim: number;
  cause: string | null;
  distance: number | null;
  headshot: boolean;
  tags: string[];
  teamKill: boolean;
  streak: number;
  chain: number;
};

export type LiveMatch = {
  matchId: string;
  map: string;
  // When the bot got the match's first and latest deaths, and the match clock at the latest.
  startedAt: number;
  lastAt: number;
  lastTime: number;
  players: LivePlayer[];
  // Kills of one player by another, by "<killer>:<victim>" places in `players`. Team kills are left out.
  pairs: Record<string, number>;
  firstBlood: LiveDeath | null;
  // Oldest first.
  feed: LiveDeath[];
  kills: number;
  headshots: number;
  teamKills: number;
  // Deaths no other player made: suicides, falls, the world.
  otherDeaths: number;
};

const count = z.number().int().nonnegative();

const DeathSchema = z.object({
  eventId: z.string(),
  at: z.number(),
  killer: count.nullable(),
  victim: count,
  cause: z.string().nullable(),
  distance: z.number().nullable(),
  headshot: z.boolean(),
  tags: z.array(z.string()),
  teamKill: z.boolean(),
  streak: count,
  chain: count,
});

const LiveMatchSchema = z.object({
  matchId: z.string(),
  map: z.string(),
  startedAt: z.number(),
  lastAt: z.number(),
  lastTime: z.number(),
  players: z.array(
    z.object({
      steamId: z.string(),
      name: z.string(),
      faction: z.string().nullable(),
      kills: count,
      deaths: count,
      headshots: count,
      teamKills: count,
      streak: count,
      bestStreak: count,
      chain: count,
      chainTime: z.number().nullable(),
      bestChain: count,
      longest: z.number().nullable(),
      longestCause: z.string().nullable(),
      weapons: z.record(z.string(), count),
    }),
  ),
  pairs: z.record(z.string(), count),
  firstBlood: DeathSchema.nullable(),
  feed: z.array(DeathSchema),
  kills: count,
  headshots: count,
  teamKills: count,
  otherDeaths: count,
});

// Null when nothing was saved yet, or it is unrecognisable.
export const parseLiveMatch = (raw: unknown): LiveMatch | null => {
  const parsed = LiveMatchSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

const fresh = (e: FeedEvent, at: number): LiveMatch => ({
  matchId: e.matchId,
  map: e.map,
  startedAt: at,
  lastAt: at,
  lastTime: e.time,
  players: [],
  pairs: {},
  firstBlood: null,
  feed: [],
  kills: 0,
  headshots: 0,
  teamKills: 0,
  otherDeaths: 0,
});

// Whether a death belongs to a match after `match`.
const isNewMatch = (match: LiveMatch, e: FeedEvent, at: number): boolean =>
  (e.matchId !== '' && match.matchId !== '' && e.matchId !== match.matchId) ||
  (e.map !== '' && match.map !== '' && e.map !== match.map) ||
  e.time < match.lastTime - CLOCK_SLACK ||
  at - match.lastAt > QUIET_MS;

// Adds a batch's deaths, in the order the game sent them. `factionOf` is the side the bot last saw a player on,
// as the feed does not say: two players on the same side make a team kill.
export const recordLive = (
  match: LiveMatch | null,
  events: FeedEvent[],
  at: number,
  factionOf: (steamId: string) => string | null,
): LiveMatch | null => {
  let m = match === null ? null : { ...match, players: match.players.map((p) => ({ ...p, weapons: { ...p.weapons } })), pairs: { ...match.pairs }, feed: [...match.feed] };
  for (const e of events) {
    if (m === null || isNewMatch(m, e, at)) m = fresh(e, at);
    const live = m;
    const place = (steamId: string, name: string): number => {
      let index = live.players.findIndex((p) => p.steamId === steamId);
      if (index === -1) {
        index = live.players.length;
        live.players.push({
          steamId,
          name,
          faction: null,
          kills: 0,
          deaths: 0,
          headshots: 0,
          teamKills: 0,
          streak: 0,
          bestStreak: 0,
          chain: 0,
          chainTime: null,
          bestChain: 0,
          longest: null,
          longestCause: null,
          weapons: {},
        });
      }
      const p = live.players[index]!;
      if (name !== '') p.name = name;
      p.faction = factionOf(steamId) ?? p.faction;
      return index;
    };
    const victim = place(e.victimSteamId, e.victimName);
    const death: LiveDeath = {
      eventId: e.eventId,
      at,
      killer: null,
      victim,
      cause: e.cause,
      distance: e.distance,
      headshot: e.headshot,
      tags: e.tags,
      teamKill: false,
      streak: 0,
      chain: 0,
    };
    if (isKill(e)) {
      const killer = place(e.killerSteamId, e.killerName);
      const k = live.players[killer]!;
      const v = live.players[victim]!;
      const teamKill = k.faction !== null && v.faction !== null && factionKey(k.faction) === factionKey(v.faction);
      if (teamKill) {
        k.teamKills += 1;
        live.teamKills += 1;
      } else {
        k.kills += 1;
        k.headshots += e.headshot ? 1 : 0;
        k.streak += 1;
        k.bestStreak = Math.max(k.bestStreak, k.streak);
        const chained = k.chainTime !== null && e.time >= k.chainTime && e.time - k.chainTime <= MULTI_KILL_SECONDS;
        k.chain = chained ? k.chain + 1 : 1;
        k.chainTime = e.time;
        k.bestChain = Math.max(k.bestChain, k.chain);
        if (e.distance !== null && (k.longest === null || e.distance > k.longest)) {
          k.longest = e.distance;
          k.longestCause = e.cause;
        }
        k.weapons[e.cause] = (k.weapons[e.cause] ?? 0) + 1;
        live.pairs[`${killer}:${victim}`] = (live.pairs[`${killer}:${victim}`] ?? 0) + 1;
        live.kills += 1;
        live.headshots += e.headshot ? 1 : 0;
      }
      Object.assign(death, { killer, teamKill, streak: teamKill ? 0 : k.streak, chain: teamKill ? 0 : k.chain });
      if (!teamKill) live.firstBlood ??= death;
    } else {
      live.otherDeaths += 1;
    }
    const v = live.players[victim]!;
    v.deaths += 1;
    v.streak = 0;
    v.chain = 0;
    v.chainTime = null;
    live.feed.push(death);
    if (live.feed.length > LIVE_FEED_KEPT) live.feed.splice(0, live.feed.length - LIVE_FEED_KEPT);
    live.lastAt = at;
    live.lastTime = e.time;
    if (e.map !== '') live.map = e.map;
    if (e.matchId !== '') live.matchId = e.matchId;
  }
  return m;
};

// Everyone a live match names, so their public ids can be worked out first.
export const liveSteamIds = (match: LiveMatch | null): string[] => match?.players.map((p) => p.steamId) ?? [];

// A player as the live page names them: never a Steam ID.
export type LivePlayerRef = { name: string; id?: string; faction?: string };

export type LiveFeedEntry = {
  id: string;
  at: number;
  // Null when no other player made it: a suicide, a fall, the world.
  killer: LivePlayerRef | null;
  victim: LivePlayerRef;
  weapon: string | null;
  kind: WeaponKind | null;
  distance: number | null;
  headshot: boolean;
  teamKill: boolean;
  tags: string[];
  // The killer's kills without dying, and kills in a row close together, after this one.
  streak: number;
  chain: number;
};

export type LiveRow = LivePlayerRef & {
  kills: number;
  deaths: number;
  headshots: number;
  teamKills: number;
  streak: number;
  bestStreak: number;
  // The weapon they have the most kills with.
  weapon: string | null;
};

export type LiveStats = {
  map: string;
  startedAt: number;
  lastKillAt: number;
  kills: number;
  headshots: number;
  teamKills: number;
  otherDeaths: number;
  // Newest first.
  feed: LiveFeedEntry[];
  // Most kills first, then fewest deaths.
  players: LiveRow[];
  weapons: { name: string; kind: WeaponKind; kills: number }[];
  highlights: {
    firstBlood: { killer: LivePlayerRef; victim: LivePlayerRef; weapon: string | null } | null;
    longest: { player: LivePlayerRef; weapon: string | null; distance: number } | null;
    bestStreak: { player: LivePlayerRef; streak: number } | null;
    // Players on ON_FIRE kills or more without dying now, longest streak first.
    onFire: { player: LivePlayerRef; streak: number }[];
    bestMultiKill: { player: LivePlayerRef; kills: number } | null;
    mostHeadshots: { player: LivePlayerRef; headshots: number } | null;
    rivalry: { killer: LivePlayerRef; victim: LivePlayerRef; kills: number } | null;
  };
};

const tenths = (metres: number): number => Math.round(metres * 10) / 10;

// The top player by `value`, when it is at least `least`. Ties go to whoever got there first.
const best = (players: LivePlayer[], value: (p: LivePlayer) => number, least: number): LivePlayer | null =>
  players.reduce<LivePlayer | null>((top, p) => (value(p) >= least && (top === null || value(p) > value(top)) ? p : top), null);

export const liveStats = (match: LiveMatch, idOf: IdOf): LiveStats => {
  const ref = (index: number): LivePlayerRef => {
    const p = match.players[index]!;
    const id = idOf(p.steamId);
    return { name: p.name, ...(id === undefined ? {} : { id }), ...(p.faction === null ? {} : { faction: p.faction }) };
  };
  const refOf = (p: LivePlayer): LivePlayerRef => ref(match.players.indexOf(p));
  const favourite = (p: LivePlayer): string | null =>
    Object.entries(p.weapons).reduce<[string, number] | null>((top, w) => (top === null || w[1] > top[1] ? w : top), null)?.[0] ?? null;
  const weapons = new Map<string, { name: string; kind: WeaponKind; kills: number }>();
  for (const p of match.players) {
    for (const [cause, kills] of Object.entries(p.weapons)) {
      const name = weaponName(cause);
      const known = weapons.get(name) ?? { name, kind: weaponKind(cause), kills: 0 };
      weapons.set(name, { ...known, kills: known.kills + kills });
    }
  }
  const longest = best(match.players, (p) => p.longest ?? -1, 0);
  const multi = best(match.players, (p) => p.bestChain, 2);
  const streak = best(match.players, (p) => p.bestStreak, 3);
  const headshots = best(match.players, (p) => p.headshots, 1);
  const rivalry = Object.entries(match.pairs).reduce<[string, number] | null>(
    (top, pair) => (pair[1] >= RIVALRY_KILLS && (top === null || pair[1] > top[1]) ? pair : top),
    null,
  );
  const first = match.firstBlood;
  const firstKiller = first?.killer ?? null;
  return {
    map: mapName(match.map),
    startedAt: match.startedAt,
    lastKillAt: match.lastAt,
    kills: match.kills,
    headshots: match.headshots,
    teamKills: match.teamKills,
    otherDeaths: match.otherDeaths,
    feed: [...match.feed].reverse().map((d) => ({
      id: d.eventId,
      at: d.at,
      killer: d.killer === null ? null : ref(d.killer),
      victim: ref(d.victim),
      weapon: d.cause === null ? null : weaponName(d.cause),
      kind: d.cause === null ? null : weaponKind(d.cause),
      distance: d.distance === null ? null : tenths(d.distance),
      headshot: d.headshot,
      teamKill: d.teamKill,
      tags: d.tags,
      streak: d.streak,
      chain: d.chain,
    })),
    players: [...match.players]
      .filter((p) => p.kills + p.deaths + p.teamKills > 0)
      .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.name.localeCompare(b.name))
      .slice(0, LIVE_PLAYERS_SHOWN)
      .map((p) => {
        const weapon = favourite(p);
        return {
          ...refOf(p),
          kills: p.kills,
          deaths: p.deaths,
          headshots: p.headshots,
          teamKills: p.teamKills,
          streak: p.streak,
          bestStreak: p.bestStreak,
          weapon: weapon === null ? null : weaponName(weapon),
        };
      }),
    weapons: [...weapons.values()].sort((a, b) => b.kills - a.kills || a.name.localeCompare(b.name)).slice(0, LIVE_WEAPONS_SHOWN),
    highlights: {
      firstBlood:
        first === null || firstKiller === null
          ? null
          : { killer: ref(firstKiller), victim: ref(first.victim), weapon: first.cause === null ? null : weaponName(first.cause) },
      longest:
        longest === null || longest.longest === null
          ? null
          : { player: refOf(longest), weapon: longest.longestCause === null ? null : weaponName(longest.longestCause), distance: tenths(longest.longest) },
      bestStreak: streak === null ? null : { player: refOf(streak), streak: streak.bestStreak },
      onFire: match.players
        .filter((p) => p.streak >= ON_FIRE)
        .sort((a, b) => b.streak - a.streak)
        .slice(0, 3)
        .map((p) => ({ player: refOf(p), streak: p.streak })),
      bestMultiKill: multi === null ? null : { player: refOf(multi), kills: multi.bestChain },
      mostHeadshots: headshots === null ? null : { player: refOf(headshots), headshots: headshots.headshots },
      rivalry:
        rivalry === null
          ? null
          : (() => {
              const [killer, victim] = rivalry[0].split(':').map(Number);
              return { killer: ref(killer ?? 0), victim: ref(victim ?? 0), kills: rivalry[1] };
            })(),
    },
  };
};

// What the live page shows: the server and its match from the bot's checks, and the kill feed's match.
export type LiveSnapshot = {
  generatedAt: number;
  // Whether the bot has ever had the kill feed.
  feed: boolean;
  server: ServerSnapshot | null;
  currentMatch: (Omit<CurrentMatch, 'top'> & { top: Public<RankedStats>[] }) | null;
  // Null before the match on now has a death in the feed.
  match: LiveStats | null;
};

// The bot sees a new match at the check after it starts, up to a minute late, and the feed's first kills can come
// before that. A feed match whose last death is this long before the check's match started is an older match.
const MATCH_SLACK_MS = 2 * 60_000;
// With no match on the server, the feed's match stays up this long after its last death.
const AFTER_MATCH_MS = 10 * 60_000;

// Whether the feed's match is the one on the server now: on the same map, and not over before it started. `onServer`
// is the match the bot's checks see, null when the server is empty or not answering.
export const isCurrent = (match: LiveMatch, onServer: { map: string; startedAt: number } | null, now: number): boolean => {
  if (onServer === null) return now - match.lastAt <= AFTER_MATCH_MS;
  const sameMap = onServer.map === '' || match.map === '' || onServer.map === mapName(match.map);
  return sameMap && match.lastAt >= onServer.startedAt - MATCH_SLACK_MS;
};
