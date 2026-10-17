import { mapName } from './discord.ts';
import { DEFAULT_LINES, type Lines } from './lines.ts';
import type { LiveMatch, LivePlayer } from './live.ts';
import { sameMap } from './matchfeed.ts';
import { fit, pickLine, remember, type Recent } from './messages.ts';
import type { FactionScore } from './rcon.ts';
import { matchMap, topPlayers, type MatchState } from './tracking.ts';
import { countsForLongest, weaponRole, type WeaponRole } from './weapons.ts';

// The end of a match: the moment a team wins, each of its best players in game gets a private message with what they
// earned and the website, to see their stats. The best players are the top on the scoreboard, as the match summary
// ranks them, and the winners of the match's awards from the kill feed: the best at each role, the most headshots, the
// longest kill and the best kill streak. Each player gets one message, naming all they earned.

// `count` is how many of the scoreboard's top players get one (none at 0), and `awards` whether the award winners do.
export type MatchEndRule = { count: number; awards: boolean; siteHost: string };

// The most scoreboard places TOP_PLAYER_MESSAGES can ask for.
export const MAX_TOP_PLAYERS = 100;

// A message names at most this many things a player earned, so it fits the game's one line: their place first.
export const MAX_EARNED = 3;

// "1st", "2nd", "3rd", "4th", "11th", "21st".
export const ordinal = (n: number): string => {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  return `${n}${teen ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`;
};

export const killCount = (count: number): string => `${count} kill${count === 1 ? '' : 's'}`;

const place = (n: number, kills: number): string => `${ordinal(n)} on the scoreboard (${killCount(kills)})`;

type Award = { value: (p: LivePlayer) => number; least: number; says: (value: number) => string };

// A player's kills with one role's weapons (see weaponRole). The feed's match keeps no team kills among them.
const roleKills =
  (role: WeaponRole) =>
  (p: LivePlayer): number =>
    Object.entries(p.weapons).reduce((sum, [cause, kills]) => sum + (weaponRole(cause) === role ? kills : 0), 0);

// One kill is not the best of anything: a role's award needs this many kills with its weapons.
const ROLE_LEAST = 3;

const role = (r: WeaponRole, title: string): Award => ({ value: roleKills(r), least: ROLE_LEAST, says: (n) => `${title} (${killCount(n)})` });

// The awards, in the order a message names them. The roles are the roundups' (see ROLE_AWARDS in roundup.ts): assault rifles,
// SMGs and shotguns; mortars and emplacements; machine guns; marksman and sniper rifles; launchers, grenades, mines and C4; and a
// vehicle's guns. The longest kill is with a hand-held weapon that does not lock on (see countsForLongest).
export const AWARDS: Award[] = [
  role('assault', 'best assaulter'),
  role('support', 'best support'),
  role('machine-gun', 'best machine gunner'),
  role('marksman', 'best marksman'),
  role('demolition', 'best demolitions'),
  role('vehicle-gun', 'best vehicle crew'),
  { value: (p) => p.headshots, least: 3, says: (n) => `most headshots (${n})` },
  {
    value: (p) => (p.longestCause !== null && countsForLongest(p.longestCause) ? (p.longest ?? -1) : -1),
    least: 0,
    says: (metres) => `longest kill (${Math.round(metres)} m)`,
  },
  { value: (p) => p.bestStreak, least: 5, says: (n) => `best kill streak (${n})` },
];

// An award's winner, when someone has at least its least. Ties go to whoever the feed named first.
const winnerOf = (players: LivePlayer[], award: Award): LivePlayer | null =>
  players.reduce<LivePlayer | null>(
    (best, p) => (award.value(p) >= award.least && (best === null || award.value(p) > award.value(best)) ? p : best),
    null,
  );

// The kill feed's record of the match on now (`live`, as saved) when it is this match's, for its awards: with a death
// after the checks saw the match start, none after it ended (or they last saw it), and on its map. Not the round
// before, as after a restart on the same map while the feed was down.
export const feedRecordOf = (live: LiveMatch | null, match: MatchState): LiveMatch | null =>
  live !== null &&
  live.lastAt >= match.startedAt &&
  live.startedAt <= (match.endedAt ?? match.lastSeenAt) &&
  (live.map === '' || sameMap(mapName(live.map), mapName(matchMap(match))))
    ? live
    : null;

export type Honours = { steamId: string; name: string; earned: string[] };

// What each player earned in a match, as a message says it: a place in the top `rule.count` on the scoreboard, and
// with `rule.awards` the awards from the kill feed's match (`live`, null without one). The scoreboard first, then the
// award winners, each with their place first and at most MAX_EARNED things. A player without a kill has no place.
export const honours = (match: MatchState, live: LiveMatch | null, rule: MatchEndRule): Honours[] => {
  const earned = new Map<string, Honours>();
  const add = (steamId: string, name: string, phrase: string): void => {
    const known = earned.get(steamId) ?? { steamId, name, earned: [] };
    earned.set(steamId, { ...known, earned: [...known.earned, phrase] });
  };
  topPlayers(match.players, rule.count).forEach((p, index) => {
    if (p.steamId !== undefined && p.kills > 0) add(p.steamId, p.name, place(index + 1, p.kills));
  });
  if (rule.awards && live !== null) {
    for (const award of AWARDS) {
      const best = winnerOf(live.players, award);
      if (best !== null) add(best.steamId, best.name, award.says(award.value(best)));
    }
  }
  return [...earned.values()].map((h) => ({ ...h, earned: h.earned.slice(0, MAX_EARNED) }));
};

// "a", "a and b", "a, b and c".
export const listOf = (items: string[]): string =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

// {earned} at its longest, for the Lines tab: the longest things a player can earn, with more kills than any match has.
export const LONGEST_EARNED = listOf(
  [place(MAX_TOP_PLAYERS, 9999), ...AWARDS.map((a) => a.says(9999))].sort((a, b) => b.length - a.length).slice(0, MAX_EARNED),
);

export type MatchEndMessage = { steamId: string; name: string; text: string };

// The messages for a match just won, to each player who earned something and is in game now (`online`). A private
// profile (`hidden`) has no player page, so gets none, but keeps their place: the others are told the place the match
// summary gives them. Each line is remembered as it is picked, so players mostly get different ones.
export const matchEndMessages = (
  match: MatchState,
  live: LiveMatch | null,
  online: ReadonlySet<string>,
  hidden: ReadonlySet<string>,
  rule: MatchEndRule,
  random: () => number = Math.random,
  lines: Lines = DEFAULT_LINES,
  recent: Recent = {},
): { messages: MatchEndMessage[]; recent: Recent } => {
  let lately = recent;
  const messages: MatchEndMessage[] = [];
  for (const h of honours(match, live, rule)) {
    if (!online.has(h.steamId) || hidden.has(h.steamId)) continue;
    const pick = pickLine('matchEnd', lines.matchEnd, { earned: listOf(h.earned), site: rule.siteHost }, random, lately);
    lately = remember(lately, pick);
    messages.push({ steamId: h.steamId, name: h.name, text: fit(pick.text) });
  }
  return { messages, recent: lately };
};

// Whether a team has won: it alone has at least `least` points.
export const hasWinner = (scores: FactionScore[], least: number): boolean => {
  const [first, second] = [...scores].sort((a, b) => b.score - a.score);
  return first !== undefined && first.score >= least && second?.score !== first.score;
};
