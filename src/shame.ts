import { TEAM_KILL_WARNING } from './griefing.ts';
import type { ModEntry } from './moderation.ts';

// The hall of shame on the website: GET /api/shame. Who has been warned most for team killing, and who has been kicked
// or banned. It is public, so it only has what the page needs to be funny and fair: names, counts, dates and what came
// of it. Never the reasons, who did it, or a Steam ID, and nobody who has a private profile (see privacy.ts). Staff are on it like anyone else.
// It reads the moderation log, which keeps each player's latest 50 entries, so a count never goes past that.

// The bot warns whoever team kills (see warnTeamKillers), and staff warn by hand: both count when the warning is about
// team killing.
const TEAM_KILL_REASON = /\bteam[\s-]?kill|\bteamkill|\btks?\b/i;

export const isTeamKillWarning = (entry: ModEntry): boolean =>
  entry.action === 'warn' && (entry.reason === TEAM_KILL_WARNING || entry.detail === 'Team kill' || TEAM_KILL_REASON.test(entry.reason ?? ''));

// A player must have been warned this many times to be on the team killers' list, and the list is this long at most.
export const TEAM_KILLER_MIN = 3;
export const TEAM_KILLERS_SHOWN = 15;
// The removed list is this long at most, newest first.
export const REMOVED_SHOWN = 60;

// How it went for them, worst last: kicked only, banned without a kick before it, or kicked and then banned.
export type Outcome = 'kicked' | 'banned' | 'kicked-then-banned';

export type TeamKiller = { id?: string; name: string; warnings: number; lastAt: number };

export type Removed = {
  id?: string;
  name: string;
  outcome: Outcome;
  kicks: number;
  bans: number;
  // Their latest kick or ban.
  lastAt: number;
  // Their latest ban has been lifted since.
  unbanned: boolean;
  // They were warned for team killing before it.
  teamKillWarnings: number;
};

export type Shame = {
  generatedAt: number;
  totals: { teamKillWarnings: number; warned: number; kicked: number; banned: number };
  teamKillers: TeamKiller[];
  removed: Removed[];
};

export type ShameSources = {
  now: number;
  // Each player's moderation log by Steam ID, oldest entry first.
  logs: ReadonlyMap<string, ModEntry[]>;
  // Private profiles: left out of everything.
  hidden: ReadonlySet<string>;
  nameOf: (steamId: string) => string | undefined;
  // The id of their player page, for those who have one.
  idOf: (steamId: string) => string | undefined;
};

export const buildShame = ({ now, logs, hidden, nameOf, idOf }: ShameSources): Shame => {
  const teamKillers: TeamKiller[] = [];
  const removed: Removed[] = [];
  const totals = { teamKillWarnings: 0, warned: 0, kicked: 0, banned: 0 };
  for (const [steamId, log] of logs) {
    if (hidden.has(steamId)) continue;
    const name = nameOf(steamId) ?? log.findLast((e) => e.name !== undefined && e.name !== steamId)?.name;
    // Nothing to call them, so nothing to show.
    if (name === undefined || name === '') continue;
    const id = idOf(steamId);
    const who = id === undefined ? { name } : { id, name };
    const warnings = log.filter(isTeamKillWarning);
    totals.teamKillWarnings += warnings.length;
    if (warnings.length > 0) totals.warned += 1;
    if (warnings.length >= TEAM_KILLER_MIN) teamKillers.push({ ...who, warnings: warnings.length, lastAt: warnings[warnings.length - 1]!.at });

    const kicks = log.filter((e) => e.action === 'kick');
    const bans = log.filter((e) => e.action === 'ban');
    if (kicks.length > 0) totals.kicked += 1;
    if (bans.length > 0) totals.banned += 1;
    if (kicks.length === 0 && bans.length === 0) continue;
    const lastBan = bans[bans.length - 1];
    const firstKick = kicks[0];
    const kickedFirst = firstKick !== undefined && bans.some((b) => b.at > firstKick.at);
    removed.push({
      ...who,
      outcome: bans.length === 0 ? 'kicked' : kickedFirst ? 'kicked-then-banned' : 'banned',
      kicks: kicks.length,
      bans: bans.length,
      lastAt: Math.max(...[...kicks, ...bans].map((e) => e.at)),
      unbanned: lastBan !== undefined && log.some((e) => e.action === 'unban' && e.at >= lastBan.at),
      teamKillWarnings: warnings.length,
    });
  }
  return {
    generatedAt: now,
    totals,
    teamKillers: teamKillers.sort((a, b) => b.warnings - a.warnings || b.lastAt - a.lastAt || a.name.localeCompare(b.name)).slice(0, TEAM_KILLERS_SHOWN),
    removed: removed.sort((a, b) => b.lastAt - a.lastAt || a.name.localeCompare(b.name)).slice(0, REMOVED_SHOWN),
  };
};
