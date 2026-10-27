import { mapName } from './discord.ts';
import { isPersonalBest, milestoneText, type Milestone } from './achievements.ts';
import { DEFAULT_LINES, type Lines } from './lines.ts';
import type { LiveMatch, LivePlayer } from './live.ts';
import { sameMap } from './matchfeed.ts';
import { coinsCall, fit, fitWithCall, nameOf, ordinal, pickLine, remember, type Recent } from './messages.ts';
import type { FactionScore } from './rcon.ts';
import { byKills, matchMap, topPlayers, type MatchState } from './tracking.ts';
import { countsForLongest, weaponRole, type WeaponRole } from './weapons.ts';

// The end of a match: the moment a team wins, each of its best players in game gets a private message with what they
// earned and the website, to see their stats. The best players are the top on the scoreboard, as the match summary
// ranks them, and the winners of the match's awards from the kill feed: the best at each role, the most headshots, the
// longest kill and the best kill streak. Each player gets one message, naming all they earned.

// `count` is how many of the scoreboard's top players get one (none at 0), and `awards` whether the award winners do.
// `coins`: INITcoins are on, so the nemesis message (the only one with no link of its own) ends with a pointer to them.
export type MatchEndRule = { count: number; awards: boolean; siteHost: string; coins?: boolean };

// The most scoreboard places TOP_PLAYER_MESSAGES can ask for.
export const MAX_TOP_PLAYERS = 100;

// A message names at most this many things a player earned, so it fits the game's one line: their place first.
export const MAX_EARNED = 3;

export { ordinal };

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

// `mvp` is set for the top of the scoreboard: most kills, then fewest deaths, with players level sharing it. Their place
// is said as their kills ("31 kills"), as the MVP lines say they were top.
export type Honours = { steamId: string; name: string; earned: string[]; mvp: boolean };

// What each player earned in a match, as a message says it: a place in the top `rule.count` on the scoreboard, and
// with `rule.awards` the awards from the kill feed's match (`live`, null without one). The scoreboard first, then the
// award winners, each with their place first and at most MAX_EARNED things. A player without a kill has no place.
export const honours = (match: MatchState, live: LiveMatch | null, rule: MatchEndRule): Honours[] => {
  const earned = new Map<string, Honours>();
  const add = (steamId: string, name: string, phrase: string, mvp = false): void => {
    const known = earned.get(steamId) ?? { steamId, name, earned: [], mvp };
    earned.set(steamId, { ...known, earned: [...known.earned, phrase] });
  };
  // The whole scoreboard, so players level with the top share the MVP even past `rule.count`.
  const ranked = topPlayers(match.players, Object.keys(match.players).length);
  const [first] = ranked;
  ranked.forEach((p, index) => {
    if (p.steamId === undefined || p.kills === 0) return;
    const mvp = rule.count > 0 && first !== undefined && byKills(p, first) === 0;
    if (!mvp && index >= rule.count) return;
    add(p.steamId, p.name, mvp ? killCount(p.kills) : place(index + 1, p.kills), mvp);
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

// The MVP's {earned} at its longest: their kills first, then the two longest awards.
export const LONGEST_MVP_EARNED = listOf([
  killCount(9999),
  ...AWARDS.map((a) => a.says(9999))
    .sort((a, b) => b.length - a.length)
    .slice(0, MAX_EARNED - 1),
]);

// What each message is for: the scoreboard and the awards (`honours`), or, for a player who earned none of those, the
// first of the others they have.
export type EndKind = 'honours' | 'milestone' | 'personalBest' | 'nearly' | 'nemesis';

export type MatchEndMessage = { steamId: string; name: string; text: string; kind: EndKind };

// What the records say about the players of the match ending (see achievements.ts), by Steam ID. The Node version has
// none of it.
export type EndExtras = {
  // Their most kills in a match lately, for those with enough matches to have a personal best.
  bests: ReadonlyMap<string, number>;
  // A milestone this match took them past, that they have not been told of.
  milestones: ReadonlyMap<string, Milestone>;
  // How many more kills would put them in the leaderboard's top 10 for kills.
  nearly: ReadonlyMap<string, number>;
};

export const NO_EXTRAS: EndExtras = { bests: new Map(), milestones: new Map(), nearly: new Map() };

// A nemesis killed the player at least this many times in the match.
export const NEMESIS_LEAST = 4;

// The most kills at the end of a match, so they all go out with the rest of the check: the scoreboard and the awards
// first, then the others in the order of EndKind.
export const MAX_END_MESSAGES = 20;

// The player who killed this one most in the kill feed's match, at least NEMESIS_LEAST times, with how many. Not a private
// profile (`hidden`), whose name the bot keeps to itself. Team kills are not in the pairs.
export const nemesisOf = (live: LiveMatch | null, steamId: string, hidden: ReadonlySet<string>): { name: string; kills: number } | null => {
  if (live === null) return null;
  const victim = live.players.findIndex((p) => p.steamId === steamId);
  if (victim === -1) return null;
  let found: { name: string; kills: number } | null = null;
  for (const [pair, kills] of Object.entries(live.pairs)) {
    const [killer, killed] = pair.split(':').map(Number);
    if (killed !== victim || killer === victim || kills < NEMESIS_LEAST) continue;
    const who = live.players[killer ?? -1];
    if (who === undefined || hidden.has(who.steamId)) continue;
    if (found === null || kills > found.kills) found = { name: who.name, kills };
  }
  return found;
};

// "1 time", "6 times".
const times = (count: number): string => `${count} time${count === 1 ? '' : 's'}`;

// The phrase {earned} gets for a personal best.
export const BEST_EARNED = 'a personal best';

// The messages for a match just won, to each player in game now (`online`), by name: one each, at most MAX_END_MESSAGES.
// Those who earned a place on the scoreboard or an award are told what (the MVP with an MVP line, when there are any), and
// a personal best among it. The others get the first they have of: a milestone (`extras`), a personal best, how close they
// are to the leaderboard's top 10, and the player who killed them most (their nemesis, from the kill feed's match). A
// private profile (`hidden`) has no player page, so gets none, but keeps their place: the others are told the place the
// match summary gives them. Each line is remembered as it is picked, so players mostly get different ones. `milestones`
// are the ones told, so they are not told again.
export const matchEndMessages = (
  match: MatchState,
  live: LiveMatch | null,
  online: ReadonlySet<string>,
  hidden: ReadonlySet<string>,
  rule: MatchEndRule,
  random: () => number = Math.random,
  lines: Lines = DEFAULT_LINES,
  recent: Recent = {},
  extras: EndExtras = NO_EXTRAS,
): { messages: MatchEndMessage[]; recent: Recent; milestones: Map<string, Milestone> } => {
  let lately = recent;
  const messages: MatchEndMessage[] = [];
  const told = new Map<string, Milestone>();
  const say = (steamId: string, name: string, kind: EndKind, list: string, from: string[], values: Record<string, string>): void => {
    const pick = pickLine(list, from, { name: nameOf(name), site: rule.siteHost, ...values }, random, lately);
    lately = remember(lately, pick);
    messages.push({ steamId, name, text: kind === 'nemesis' && rule.coins ? fitWithCall(pick.text, coinsCall(rule.siteHost)) : fit(pick.text), kind });
  };
  const sendable = (steamId: string): boolean => online.has(steamId) && !hidden.has(steamId);
  const kills = (steamId: string): number => match.players[steamId]?.kills ?? 0;
  const best = (steamId: string): boolean => isPersonalBest(kills(steamId), extras.bests.get(steamId));
  const honoured = new Set<string>();
  for (const h of honours(match, live, rule)) {
    honoured.add(h.steamId);
    if (!sendable(h.steamId)) continue;
    // A personal best goes after their place.
    const earned = best(h.steamId) ? [...h.earned.slice(0, 1), BEST_EARNED, ...h.earned.slice(1)].slice(0, MAX_EARNED) : h.earned;
    const mvp = h.mvp && lines.mvp.length > 0;
    say(h.steamId, h.name, 'honours', mvp ? 'mvp' : 'matchEnd', mvp ? lines.mvp : lines.matchEnd, { earned: listOf(earned) });
  }
  // Everyone else in game who played, most kills first, so the cap leaves out those who did least.
  const others = Object.entries(match.players)
    .filter(([steamId]) => !honoured.has(steamId) && sendable(steamId))
    .sort(([, a], [, b]) => byKills(a, b));
  for (const [steamId, p] of others) {
    const milestone = extras.milestones.get(steamId);
    const short = extras.nearly.get(steamId);
    const nemesis = nemesisOf(live, steamId, hidden);
    if (milestone !== undefined && lines.milestone.length > 0) {
      say(steamId, p.name, 'milestone', 'milestone', lines.milestone, { milestone: milestoneText(milestone) });
      told.set(steamId, milestone);
    } else if (best(steamId) && lines.personalBest.length > 0) {
      say(steamId, p.name, 'personalBest', 'personalBest', lines.personalBest, { kills: killCount(p.kills) });
    } else if (short !== undefined && lines.nearlyTop.length > 0) {
      say(steamId, p.name, 'nearly', 'nearlyTop', lines.nearlyTop, { short: killCount(short) });
    } else if (nemesis !== null && lines.nemesis.length > 0) {
      say(steamId, p.name, 'nemesis', 'nemesis', lines.nemesis, { nemesis: nameOf(nemesis.name), count: times(nemesis.kills) });
    }
  }
  const order: EndKind[] = ['honours', 'milestone', 'personalBest', 'nearly', 'nemesis'];
  const kept = messages
    .map((m, i) => ({ m, i }))
    .sort((a, b) => order.indexOf(a.m.kind) - order.indexOf(b.m.kind) || a.i - b.i)
    .slice(0, MAX_END_MESSAGES)
    .sort((a, b) => a.i - b.i)
    .map(({ m }) => m);
  const sent = new Set(kept.map((m) => m.steamId));
  return { messages: kept, recent: lately, milestones: new Map([...told].filter(([steamId]) => sent.has(steamId))) };
};

// Whether a team has won: it alone has at least `least` points.
export const hasWinner = (scores: FactionScore[], least: number): boolean => {
  const [first, second] = [...scores].sort((a, b) => b.score - a.score);
  return first !== undefined && first.score >= least && second?.score !== first.score;
};
