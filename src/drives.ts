import { z } from 'zod';
import { factionKey, playerName, type DiscordMessage } from './discord.ts';
import { totals, type MatchRecord, type PlayerDay } from './players.ts';
import { PRIVATE_NAME } from './privacy.ts';
import type { FactionScore } from './rcon.ts';
import { byKills } from './tracking.ts';

// Two drives that go out after the roundups (see roundup.ts), to the same channel: the player of the month, who topped the
// scoreboard of the most matches in the month, and the weekly challenge, a different board each week, announced on the
// Monday it starts and won by whoever tops it by the next Monday. Each winner gets a Discord role (when one is set) on
// their linked account until the next winner, so it moves from one to the next.

const WEEK_MS = 7 * 24 * 60 * 60_000;

// What the boards count up. Matches count in the period they ended in.
export type DriveSources = { days: PlayerDay[]; matches: MatchRecord[] };

export type Winner = { steamId: string; name: string; says: string };

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

// The winning side's key, or null without a result, as the roundups count wins.
const winningSide = (scores: FactionScore[]): string | null => {
  const [first, second] = [...scores].sort((a, b) => b.score - a.score);
  if (first === undefined || second === undefined || first.score === second.score) return null;
  return factionKey(first.name);
};

// Tallies a count per player over the matches, oldest first so each keeps their latest name.
const tally = (matches: MatchRecord[], count: (m: MatchRecord) => { steamId: string; name: string }[]) => {
  const counts = new Map<string, { name: string; count: number }>();
  for (const m of [...matches].sort((a, b) => a.endedAt - b.endedAt)) {
    for (const p of count(m)) counts.set(p.steamId, { name: p.name, count: (counts.get(p.steamId)?.count ?? 0) + 1 });
  }
  return [...counts].map(([steamId, c]) => ({ steamId, ...c }));
};

// The top of a list by `score` (highest first, then by name), when it scores above 0.
const top = <T extends { steamId: string; name: string }>(rows: T[], score: (r: T) => number, says: (r: T) => string): Winner | null => {
  const [first] = rows.filter((r) => score(r) > 0).sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
  return first === undefined ? null : { steamId: first.steamId, name: first.name, says: says(first) };
};

// Everyone level with the top of a match's scoreboard, once they have a kill: the roundups' MVPs.
const mvpsOf = (m: MatchRecord) => {
  const [first] = [...m.players].sort(byKills);
  return first === undefined || first.kills === 0 ? [] : m.players.filter((p) => byKills(p, first) === 0);
};

export const mostMvps = ({ matches }: DriveSources): Winner | null =>
  top(tally(matches, mvpsOf), (r) => r.count, (r) => plural(r.count, 'MVP'));

export type ChallengeId = 'kills' | 'bestMatch' | 'wins' | 'mvps' | 'seeding' | 'playtime';

export type Challenge = { id: ChallengeId; title: string; winner: (sources: DriveSources) => Winner | null };

// The challenges, one a week in this order, then round again.
export const CHALLENGES: Challenge[] = [
  {
    id: 'kills',
    title: 'Most kills',
    winner: ({ days }) => {
      const [first] = totals(days)
        .filter((p) => p.kills > 0)
        .sort(byKills);
      return first === undefined ? null : { steamId: first.steamId, name: first.name, says: plural(first.kills, 'kill') };
    },
  },
  {
    id: 'bestMatch',
    title: 'Most kills in one match',
    winner: ({ matches }) => {
      const best = matches.flatMap((m) => m.players.map((p) => ({ ...p, map: m.map })));
      return top(best, (p) => p.kills, (p) => `${plural(p.kills, 'kill')} on ${p.map}`);
    },
  },
  {
    id: 'wins',
    title: 'Most wins',
    winner: ({ matches }) =>
      top(
        tally(matches, (m) => {
          const won = winningSide(m.factionScores);
          return won === null ? [] : m.players.filter((p) => p.faction !== undefined && factionKey(p.faction) === won);
        }),
        (r) => r.count,
        (r) => plural(r.count, 'win'),
      ),
  },
  { id: 'mvps', title: 'Most MVPs', winner: mostMvps },
  {
    id: 'seeding',
    title: 'Most seed days',
    winner: ({ days }) => {
      const [first] = totals(days)
        .filter((p) => p.seedDays > 0)
        .sort((a, b) => b.seedDays - a.seedDays || b.seedingMinutes - a.seedingMinutes || a.name.localeCompare(b.name));
      return first === undefined ? null : { steamId: first.steamId, name: first.name, says: plural(first.seedDays, 'seed day') };
    },
  },
  {
    id: 'playtime',
    title: 'Most time played',
    winner: ({ days }) =>
      top(
        totals(days),
        (p) => p.seedingMinutes + p.liveMinutes,
        (p) => plural(Math.floor((p.seedingMinutes + p.liveMinutes) / 60), 'hour'),
      ),
  },
];

// The challenge of the week that starts at `weekStart` (a Monday, 00:00 UTC).
export const challengeFor = (weekStart: number): Challenge =>
  CHALLENGES[((Math.floor(weekStart / WEEK_MS) % CHALLENGES.length) + CHALLENGES.length) % CHALLENGES.length] as Challenge;

// Who holds each drive's role, and the week whose challenge was announced, so a winner is only named for a challenge
// people were told of.
export type Holder = { steamId: string; userId: string | null };
export type DrivesState = { month: Holder | null; challenge: Holder | null; announced: string | null };

export const DRIVES_KEY = 'drives';

const HolderSchema = z.object({ steamId: z.string(), userId: z.string().nullable() }).nullable().default(null);
const DrivesSchema = z.object({ month: HolderSchema, challenge: HolderSchema, announced: z.string().nullable().default(null) });

export const parseDrives = (raw: unknown): DrivesState => {
  const parsed = DrivesSchema.safeParse(raw);
  return parsed.success ? parsed.data : { month: null, challenge: null, announced: null };
};

// How a winner's role went: given, they have no linked account in the server, or no role is set.
export type RoleOutcome = 'given' | 'unlinked' | 'none';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// A winner as the public sees them: a private profile by PRIVATE_NAME.
const shown = (w: Winner, hidden: ReadonlySet<string>): string => (hidden.has(w.steamId) ? PRIVATE_NAME : `**${playerName(w.name)}**`);

const roleLine = (outcome: RoleOutcome, roleId: string | undefined, account: string | null, until: string): string =>
  outcome === 'given' && roleId !== undefined
    ? ` They have the <@&${roleId}> role ${until}.`
    : outcome === 'unlinked' && roleId !== undefined && account !== null
      ? ` Link your account at ${account} to get the role next time.`
      : '';

const PLAYER_OF_MONTH_COLOR = 0xf1c40f;
const CHALLENGE_COLOR = 0x5865f2;
const NO_PINGS = { parse: [] as never[], roles: [] as string[] };

// The account page, for the role line. Null without a website.
export const accountPage = (siteUrl: string | undefined): string | null => (siteUrl === undefined ? null : `${siteUrl.replace(/\/+$/, '')}/account`);

export const buildPlayerOfMonthMessage = (
  monthStart: number,
  winner: Winner,
  hidden: ReadonlySet<string>,
  outcome: RoleOutcome,
  roleId: string | undefined,
  siteUrl: string | undefined,
): DiscordMessage => {
  const date = new Date(monthStart);
  return {
    embeds: [
      {
        title: `👑 Player of the month · ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`,
        description:
          `${shown(winner, hidden)} topped the scoreboard the most times: ${winner.says}.` +
          roleLine(outcome, roleId, accountPage(siteUrl), 'for the month'),
        color: PLAYER_OF_MONTH_COLOR,
        footer: { text: 'MVP: top of a match\'s scoreboard (most kills, then fewest deaths).' },
      },
    ],
    allowed_mentions: NO_PINGS,
  };
};

// Last week's challenge and its winner (null when nobody was told of it, or nobody scored), and this week's.
export const buildChallengeMessage = (
  last: { challenge: Challenge; winner: Winner | null } | null,
  next: Challenge,
  hidden: ReadonlySet<string>,
  outcome: RoleOutcome,
  roleId: string | undefined,
  siteUrl: string | undefined,
): DiscordMessage => {
  const prize = roleId === undefined ? 'a shout-out here' : `a shout-out here and the <@&${roleId}> role for the week`;
  return {
    embeds: [
      {
        title: '🎯 Weekly challenge',
        color: CHALLENGE_COLOR,
        fields: [
          ...(last === null
            ? []
            : [
                {
                  name: `Last week: ${last.challenge.title}`,
                  value:
                    last.winner === null
                      ? 'Nobody took it.'
                      : `${shown(last.winner, hidden)} won with ${last.winner.says}.` +
                        roleLine(outcome, roleId, accountPage(siteUrl), 'for the week'),
                },
              ]),
          { name: `This week: ${next.title}`, value: `Top it by Monday (UTC) for ${prize}.` },
        ],
      },
    ],
    allowed_mentions: NO_PINGS,
  };
};
