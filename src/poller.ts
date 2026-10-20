import { z } from 'zod';
import { initialState, isQuiet, step, type AlertKind, type MonitorState } from './alerts.ts';
import type { Config } from './config.ts';
import { buildMatchSummary, buildMessage, type DiscordMessage } from './discord.ts';
import { DEFAULT_LINES, type Lines } from './lines.ts';
import type { LiveMatch } from './live.ts';
import type { Milestone } from './achievements.ts';
import { hasWinner, matchEndMessages, NO_EXTRAS, type EndExtras, type MatchEndRule } from './matchend.ts';
import { sameMap, type MatchFeed } from './matchfeed.ts';
import {
  JOIN_WAIT_MS,
  joinMessageDue,
  JoinWatchSchema,
  markWelcomed,
  MatchMessagesSchema,
  nextMessage,
  RecentSchema,
  remember,
  seedingMessageDue,
  seedingPick,
  watchJoins,
  watchWelcomes,
  seederThanks,
  welcomePick,
  welcomesDue,
  WelcomeWatchSchema,
  type JoinWatch,
  type MatchMessages,
  type Recent,
  type WelcomeWatch,
} from './messages.ts';
import {
  crashed,
  observeFailure,
  observeReading,
  OutageSchema,
  ReadingSchema,
  type Outage,
  type OutageEvent,
  type Reading,
} from './outages.ts';
import type { SeedCredit } from './players.ts';
import { publicNames, publicNamesBySteamId } from './privacy.ts';
import type { Player, Snapshot } from './rcon.ts';
import type { Observation } from './stats.ts';
import type { FeedPresence } from './weapons.ts';
import {
  matchMap,
  observeMatch,
  settleWin,
  summarise,
  tallySeeding,
  topSeeders,
  type MatchState,
  type MatchSummary,
  type SeedingTally,
} from './tracking.ts';

type Logger = { info: (message: string) => void; error: (message: string) => void };

export type BotState = {
  alerts: MonitorState;
  seeding: SeedingTally;
  match: MatchState | null;
  // A match summary Discord has not accepted yet; posting it is retried on each check. `endedAt` is when the stats
  // recorded the match as ended, which the post links to; null when they did not (the Node version keeps none).
  unsentSummary: (MatchSummary & { endedAt: number | null }) | null;
  // Which in-game messages the current match has had.
  messages: MatchMessages | null;
  // When the last in-game seeding message went out.
  seedMessageAt: number | null;
  // Who is in game, and whether a seeding message is waiting for someone who just joined.
  joins: JoinWatch | null;
  // Who is waiting for their welcome, and who had one lately. Null while welcomes are off, and until a reading the bot
  // trusts.
  welcomes: WelcomeWatch | null;
  // The last check that reached the server, and the outage going on, if any (see outages.ts).
  last: Reading | null;
  outage: Outage | null;
  // The lines each list used lately, so the next message does not repeat one (see messages.ts).
  recent: Recent;
  // The last match that had its end-of-match messages (its start time, see matchend.ts), so it has them once.
  endMessages: number | null;
};

export type StateStore = {
  load: () => Promise<BotState | null>;
  save: (state: BotState) => Promise<void>;
};

type PollerDeps = {
  config: Config;
  fetchSnapshot: () => Promise<Snapshot>;
  send: (message: DiscordMessage) => Promise<void>;
  now: () => number;
  log: Logger;
  store: StateStore;
  stats?: StatsSink;
  // Sends a message to everyone in game.
  broadcast?: (message: string) => Promise<void>;
  // Sends a private message to one player in game, by Steam ID.
  messagePlayer?: (steamId: string, text: string) => Promise<void>;
  // Picks which line an in-game message uses.
  random?: () => number;
  // The in-game lines, when staff can change them (see linespage.ts); the bot's own otherwise.
  lines?: () => Promise<Lines>;
  // Staff's Steam IDs: they are never named as top seeders (see staffprofiles.ts). Only asked when the server goes live.
  staff?: () => Promise<ReadonlySet<string>>;
  // Steam IDs of players who linked their Discord account on the website: their welcome leaves the Discord invite out.
  linked?: () => Promise<ReadonlySet<string>>;
  // Each player's best place on the website's leaderboard ("3rd for kills"), by Steam ID: they get the welcome back. Only
  // asked when a welcome is due.
  ranks?: () => Promise<ReadonlyMap<string, string>>;
  // Steam IDs of regulars who have not linked their account on the website and were not asked to lately: their welcome asks
  // them to. Only asked when a welcome is due. `nudged` is told who was asked, so they are not asked again for a while.
  nudges?: () => Promise<ReadonlySet<string>>;
  nudged?: (steamIds: string[]) => Promise<void>;
  // The Steam IDs of private profiles, named PRIVATE_NAME in the posts (see privacy.ts). Only asked when a post may name
  // players: the live alert's top seeders and the match summary; and when the end-of-match messages go out, as private
  // profiles get none.
  privateProfiles?: () => Promise<ReadonlySet<string>>;
  // The kill feed's record of a match, for its awards and nemeses (see matchend.ts), or null when it has none of that match.
  liveMatch?: (match: MatchState) => Promise<LiveMatch | null>;
  // What the records say about the players of a match ending: milestones, personal bests, how close they are to the
  // leaderboard (see achievements.ts). Only asked when the end-of-match messages go out.
  endExtras?: (match: MatchState) => Promise<EndExtras>;
  // The milestones players were told of, so they are not told again.
  milestonesTold?: (told: ReadonlyMap<string, Milestone>) => Promise<void>;
  // The kill feed's word on the match: its state and latest result (see matchfeed.ts), or null while the feed is not
  // heard from. With it, a match ends when the game says, with the game's scores, and nothing is worked out from the
  // scores the checks see.
  matchFeed?: () => Promise<MatchFeed | null>;
  // Whether people can vote for the next map in this match right now (see votingNow). The halfway and 90-point messages only
  // send people to the vote while they can, and say the usual thing after.
  voting?: (match: MatchState) => Promise<boolean>;
  // An outage confirmed or over, for the moderation log. Told once: one that fails is logged, not retried.
  outage?: (event: OutageEvent) => Promise<void>;
};

// Feeds the website's stats and the player records. `check` runs once for every check that reached the server,
// even if a Discord post then fails, so the site never shows a reachable server as down; if it fails, only that is
// lost. `seeded` runs when the server goes live, with everyone who seeded it, and `matchEnded` when a match ends,
// both before any Discord post. If either fails, the check fails before the state moves on, so the next check reports
// the same seed or match again. The sink must ignore one it already has (a match's `startedAt` identifies it).
// `matchEnded` answers with the time the match is recorded as ending, which is `at` unless it already had the match,
// or null if it cannot say. The match summary links to that time, so it must be the one the website is given.
// `alerted` runs after each alert Discord took, for the review's counts (see review.ts).
export type StatsSink = {
  check: (observation: Observation) => Promise<void>;
  seeded: (seeders: SeedCredit[], at: number) => Promise<void>;
  matchEnded: (match: MatchState, at: number) => Promise<number | null>;
  alerted?: (kind: AlertKind, at: number) => Promise<void>;
};

const TOP_SEEDERS = 3;

const AlertsSchema = z.object({
  phase: z.enum(['empty', 'seeding', 'live']),
  lastAlertAt: z.partialRecord(z.enum(['seeding', 'live', 'lowPop', 'back']), z.number()),
  lowSince: z.number().optional(),
  seedingSince: z.number().optional(),
  afterCrash: z.boolean().optional(),
});

const Scores = z.array(z.object({ name: z.string(), score: z.number(), colorHex: z.string().optional() }));

const BotStateSchema = z.object({
  alerts: AlertsSchema,
  seeding: z.record(z.string(), z.object({ name: z.string(), checks: z.number() })),
  match: z
    .object({
      key: z.string(),
      startedAt: z.number(),
      lastSeenAt: z.number(),
      liveAt: z.number().nullable(),
      summarisable: z.boolean(),
      peakPlayers: z.number(),
      players: z.record(
        z.string(),
        z
          .object({
            name: z.string(),
            kills: z.number(),
            deaths: z.number(),
            // Missing from state saved before rejoining players were tracked: their counters were their totals.
            lastKills: z.number().optional(),
            lastDeaths: z.number().optional(),
            // Missing from state saved before sides were tracked, and for players the server gave no faction for.
            faction: z.string().optional(),
          })
          .transform((p) => ({ ...p, lastKills: p.lastKills ?? p.kills, lastDeaths: p.lastDeaths ?? p.deaths })),
      ),
      factionScores: Scores,
      endedAt: z.number().optional(),
    })
    .nullable(),
  // Missing from state saved before summaries were retried this way.
  unsentSummary: z
    .object({
      map: z.string(),
      durationMs: z.number(),
      peakPlayers: z.number(),
      factionScores: Scores,
      top: z.array(z.object({ name: z.string(), kills: z.number(), deaths: z.number() })),
      // Missing from state saved before summaries linked to their match.
      endedAt: z.number().nullable().default(null),
    })
    .nullable()
    .default(null),
  // Missing from state saved before in-game messages.
  messages: MatchMessagesSchema.nullable().default(null),
  // Missing from state saved before seeding messages.
  seedMessageAt: z.number().nullable().default(null),
  // Missing from state saved before seeding messages on joining.
  joins: JoinWatchSchema.nullable().default(null),
  // Missing from state saved before welcomes.
  welcomes: WelcomeWatchSchema.nullable().default(null),
  // Missing from state saved before outages.
  last: ReadingSchema.nullable().default(null),
  outage: OutageSchema.nullable().default(null),
  // Missing from state saved before lines avoided repeats.
  recent: RecentSchema.default({}),
  // Missing from state saved before end-of-match messages.
  endMessages: z.number().nullable().default(null),
});

// The first release stored only the alert state; upgrade it rather than start over.
const StoredStateSchema = z.union([
  BotStateSchema,
  AlertsSchema.transform(
    (alerts): BotState => ({
      alerts,
      seeding: {},
      match: null,
      unsentSummary: null,
      messages: null,
      seedMessageAt: null,
      joins: null,
      welcomes: null,
      last: null,
      outage: null,
      recent: {},
      endMessages: null,
    }),
  ),
]);

// Reads what a store saved. Anything unrecognisable starts fresh instead of failing every check.
export const parseState = (raw: unknown): BotState | null => {
  const parsed = StoredStateSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

export const memoryStore = (initial: BotState | null = null): StateStore => {
  let state = initial;
  return {
    load: async () => state,
    save: async (next) => {
      state = next;
    },
  };
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const steamIds = (players: Player[]): string[] => players.map((p) => p.steamId);

// How often the quick join checks read who is in game while the server seeds.
export const JOIN_CHECK_MS = 5_000;

// A seeding message only ever goes out while the server seeds with fewer players than it needs to go live
// (LIVE_THRESHOLD): never once it has that many, even before the next check marks it live.
const canSeedMessage = (seeding: boolean, players: number, live: number): boolean => seeding && players > 0 && players < live;

// The in-game lines. If staff's can't be read, the bot's own go out, so a message is never lost to it.
const readLines = async (lines: (() => Promise<Lines>) | undefined, log: Logger): Promise<Lines> => {
  if (lines === undefined) return DEFAULT_LINES;
  try {
    return await lines();
  } catch (error) {
    log.error(`Reading the in-game lines failed, so the bot's own are used: ${errorText(error)}`);
    return DEFAULT_LINES;
  }
};

// The kill feed's word on the match. If it can't be read, the check goes on as without the feed.
const readFeed = async (matchFeed: (() => Promise<MatchFeed | null>) | undefined, log: Logger): Promise<MatchFeed | null> => {
  if (matchFeed === undefined) return null;
  try {
    return await matchFeed();
  } catch (error) {
    log.error(`Reading the kill feed's match failed, so the check goes on without it: ${errorText(error)}`);
    return null;
  }
};

type EndDeps = Pick<PollerDeps, 'messagePlayer' | 'log' | 'liveMatch' | 'endExtras' | 'milestonesTold'> & { random: () => number };

// The end-of-match messages for a match just won, privately to each of its best players in game (see matchend.ts). One
// that fails is not tried again. Without the kill feed's record of the match, the scoreboard's top players still get
// theirs. Gives back the lines used lately.
const congratulate = async (
  { messagePlayer, log, liveMatch, endExtras, milestonesTold, random }: EndDeps,
  rule: MatchEndRule,
  match: MatchState,
  players: Player[],
  hidden: ReadonlySet<string>,
  wording: Lines,
  recent: Recent,
): Promise<Recent> => {
  if (messagePlayer === undefined) return recent;
  let live: LiveMatch | null = null;
  if (liveMatch !== undefined) {
    try {
      live = await liveMatch(match);
    } catch (error) {
      log.error(`Reading the kill feed's match failed, so its awards are left out: ${errorText(error)}`);
    }
  }
  let extras = NO_EXTRAS;
  if (endExtras !== undefined) {
    try {
      extras = await endExtras(match);
    } catch (error) {
      log.error(`Reading the records for the end of the match failed, so milestones and personal bests are left out: ${errorText(error)}`);
    }
  }
  const sent = matchEndMessages(match, live, new Set(steamIds(players)), hidden, rule, random, wording, recent, extras);
  if (sent.milestones.size > 0 && milestonesTold !== undefined) {
    // Before they go out: one that fails is not tried again, like the rest.
    try {
      await milestonesTold(sent.milestones);
    } catch (error) {
      log.error(`Saving the milestones told failed: ${errorText(error)}`);
    }
  }
  for (const { steamId, name, text } of sent.messages) {
    const who = `${JSON.stringify(name)} (${steamId})`;
    try {
      await messagePlayer(steamId, text);
      log.info(`Sent end-of-match message to ${who}: ${text}`);
    } catch (error) {
      log.error(`End-of-match message to ${who} failed: ${errorText(error)}`);
    }
  }
  return sent.recent;
};

// A match the bot saw go live and start, so its scoreboard is whole, and that has not had its end-of-match messages.
const unthanked = (match: MatchState | null, state: BotState): match is MatchState =>
  match !== null && match.summarisable && match.liveAt !== null && match.startedAt !== state.endMessages;

// Returns a function that runs one check. It never throws, so a bad poll does not stop the loop.
export const createPoller = ({
  config,
  fetchSnapshot,
  send,
  now,
  log,
  store,
  stats,
  broadcast,
  messagePlayer,
  random = Math.random,
  lines,
  staff,
  privateProfiles,
  liveMatch,
  matchFeed,
  voting,
  outage: tellOutage,
  linked,
  ranks,
  nudges,
  nudged,
  endExtras,
  milestonesTold,
}: PollerDeps) => {
  // A stats failure is logged on its own: the check itself worked, and its alerts and state are saved.
  const report = async (record: (sink: StatsSink) => Promise<void>): Promise<void> => {
    if (stats === undefined) return;
    try {
      await record(stats);
    } catch (error) {
      log.error(`Stats update failed: ${errorText(error)}`);
    }
  };

  const welcoming = config.welcomeMessages !== null && messagePlayer !== undefined;

  // Each player's welcome, privately, a couple of minutes after they join. One that fails is not tried again. Gives
  // back what to remember: null while welcomes are off, and until a reading the bot trusts.
  const welcome = async (previous: WelcomeWatch | null, players: Player[], count: number, time: number, wording: Lines, recent: Recent) => {
    const rule = config.welcomeMessages;
    if (rule === null || messagePlayer === undefined) return { watch: null, recent };
    const watched = watchWelcomes(previous, steamIds(players), count, time);
    if (watched === null) return { watch: null, recent };
    const due = welcomesDue(watched, time, rule, config.pollIntervalMs);
    let lately = recent;
    // Someone who linked their Discord account is in the server: the invite is not for them. Read only when a welcome is due.
    let linkedIds: ReadonlySet<string> = new Set();
    if (due.length > 0 && linked !== undefined) {
      try {
        linkedIds = await linked();
      } catch (error) {
        log.error(`Reading who linked their Discord account failed, so welcomes still give the invite: ${errorText(error)}`);
      }
    }
    // Players on the leaderboard are welcomed back with their place.
    let places: ReadonlyMap<string, string> = new Map();
    if (due.length > 0 && ranks !== undefined) {
      try {
        places = await ranks();
      } catch (error) {
        log.error(`Reading the leaderboard failed, so welcomes leave it out: ${errorText(error)}`);
      }
    }
    // Regulars who have not linked their account are asked to.
    let nudging: ReadonlySet<string> = new Set();
    if (due.length > 0 && nudges !== undefined) {
      try {
        nudging = await nudges();
      } catch (error) {
        log.error(`Reading who to ask to link their account failed, so welcomes leave it out: ${errorText(error)}`);
      }
    }
    const asked: string[] = [];
    for (const steamId of due) {
      const name = players.find((p) => p.steamId === steamId)?.name ?? '';
      const pick = welcomePick(linkedIds.has(steamId) ? { ...rule, discord: null } : rule, random, wording, lately, {
        name,
        rank: places.get(steamId) ?? null,
        nudge: nudging.has(steamId),
      });
      const text = pick.text;
      lately = remember(lately, pick);
      if (pick.list === 'linkNudge') asked.push(steamId);
      const who = `${JSON.stringify(name)} (${steamId})`;
      try {
        await messagePlayer(steamId, text);
        log.info(`Sent welcome to ${who}: ${text}`);
      } catch (error) {
        log.error(`Welcome to ${who} failed: ${errorText(error)}`);
      }
    }
    if (asked.length > 0 && nudged !== undefined) {
      try {
        await nudged(asked);
      } catch (error) {
        log.error(`Saving who was asked to link their account failed: ${errorText(error)}`);
      }
    }
    return { watch: markWelcomed(watched, due, time), recent: lately };
  };

  // The seeders still in game are thanked privately the moment the server goes live, when the seeding messages are on.
  // One that fails is not tried again. Gives back the lines used lately.
  const thankSeeders = async (credits: SeedCredit[], players: Player[], staffIds: ReadonlySet<string>, wording: Lines, recent: Recent) => {
    if (credits.length === 0 || config.seedingMessages === null || messagePlayer === undefined) return recent;
    const sent = seederThanks(credits, new Set(steamIds(players)), staffIds, config.seedMinutes, random, wording, recent);
    for (const { steamId, name, text } of sent.messages) {
      const who = `${JSON.stringify(name)} (${steamId})`;
      try {
        await messagePlayer(steamId, text);
        log.info(`Sent seeding thanks to ${who}: ${text}`);
      } catch (error) {
        log.error(`Seeding thanks to ${who} failed: ${errorText(error)}`);
      }
    }
    return sent.recent;
  };

  // An outage confirmed or over goes to staff once it is saved, so a check that fails after it never tells them twice.
  const tell = async (event: OutageEvent | null): Promise<void> => {
    if (event === null || tellOutage === undefined) return;
    try {
      await tellOutage(event);
    } catch (error) {
      log.error(`Outage post failed: ${errorText(error)}`);
    }
  };

  // A check that could not reach the server: an outage once it has lasted long enough.
  const unreachable = async (): Promise<void> => {
    const state = await store.load();
    if (state === null) return;
    const { outage, event } = observeFailure(state.outage, state.last, now());
    if (outage === state.outage) return;
    await store.save({ ...state, outage });
    await tell(event);
  };

  const check = async (): Promise<void> => {
    let snapshot: Snapshot;
    try {
      snapshot = await fetchSnapshot();
    } catch (error) {
      try {
        await unreachable();
      } catch (failure) {
        log.error(`Outage check failed: ${errorText(failure)}`);
      }
      throw error;
    }
    const { status, players } = snapshot;
    const state = await store.load();
    const time = now();
    const reading: Reading = { at: time, players: status.players, map: status.map };

    if (state === null) {
      const alerts = initialState(status.players, config.rules);
      const { match } = observeMatch(null, status, players, alerts.phase === 'live', time);
      const seedingNow = alerts.phase === 'seeding';
      const seeding = seedingNow ? tallySeeding({}, players) : {};
      const messages =
        config.matchMessages === null ? null : nextMessage(null, match, time, config.matchMessages, config.vip).messages;
      const joins = watchJoins(null, steamIds(players), time, false);
      const welcomes = welcoming ? watchWelcomes(null, steamIds(players), status.players, time) : null;
      await store.save({
        alerts,
        seeding,
        match,
        unsentSummary: null,
        messages,
        seedMessageAt: null,
        joins,
        welcomes,
        last: reading,
        outage: null,
        recent: {},
        endMessages: null,
      });
      log.info(`Watching "${status.name}": ${status.players}/${status.maxPlayers} players (${alerts.phase})`);
      await report((sink) => sink.check({ at: time, status, players, phase: alerts.phase, seeding: seedingNow, match }));
      return;
    }

    const { outage, event: outageEvent } = observeReading(state.outage, state.last, reading, config.rules.live);
    if (outageEvent !== null) {
      await store.save({ ...state, last: reading, outage });
      await tell(outageEvent);
    }
    const result = step(state.alerts, status.players, time, config.rules, crashed(outage));
    const before = state.alerts.phase;
    const after = result.state.phase;
    const feed = await readFeed(matchFeed, log);
    const { match, finished: ended } = observeMatch(state.match, status, players, after === 'live', time, feed);
    // Without the game's result, a side the last check saw one point short won (see settleWin).
    const finished = ended === null || feed !== null ? ended : { ...ended, factionScores: settleWin(ended.factionScores, config.scoreToWin) };
    // Seeding is time on the server while it is in the seeding phase: filling up from empty, or building back up
    // after a drop from live (a crash, or players leaving) that outlasted the grace time. A shorter drop keeps the
    // server live, so a quick restart is not seeding.
    const seedingNow = after === 'seeding';
    const tallied = seedingNow ? tallySeeding(state.seeding, players) : null;
    const minutes = (checks: number): number => Math.round((checks * config.pollIntervalMs) / 60_000);

    // Count everyone online on each check while the server is seeding; reset once it is live or empty.
    // Seeding is over when the server goes live. A seeding count carried into a live check means that too: when the
    // low-pop alert that starts a re-seed cannot be posted, the phase stays live (so the alert is retried) while the
    // re-seed is already being counted.
    const wentLive = after === 'live' && (before !== 'live' || Object.keys(state.seeding).length > 0);
    const credits = wentLive
      ? Object.entries(state.seeding).map(([steamId, s]) => ({ steamId, name: s.name, minutes: minutes(s.checks) }))
      : [];

    await report((sink) => sink.check({ at: time, status, players, phase: after, seeding: seedingNow, match }));
    // Not caught, like the seed below: nothing has been saved yet, so the next check tries again.
    const staffIds = wentLive && staff !== undefined ? await staff() : new Set<string>();
    // The end-of-match messages go out the moment the kill feed says a match ended (see createMatchEndCheck), or else at
    // the check that sees it end. Without the feed, that is the first check that sees a team on the winning score, or the
    // one that sees the match end (the map changing, or the server emptying).
    const endRule = messagePlayer === undefined ? null : config.matchEndMessages;
    const won = feed === null && match !== null && hasWinner(status.factionScores, config.scoreToWin) ? match : null;
    const ending = endRule === null ? null : ([finished, won].find((m) => unthanked(m, state)) ?? null);
    const naming = wentLive || finished !== null || state.unsentSummary !== null || ending !== null;
    const hidden = naming && privateProfiles !== undefined ? await privateProfiles() : new Set<string>();
    const seeders = wentLive
      ? topSeeders(publicNamesBySteamId(state.seeding, hidden), TOP_SEEDERS, staffIds).map((s) => ({
          name: s.name,
          minutes: minutes(s.checks),
        }))
      : [];
    // Not caught: nothing has been saved yet, so if recording fails, the next check tries again.
    if (credits.length > 0) await stats?.seeded(credits, time);
    const thanking = credits.length > 0 && config.seedingMessages !== null && messagePlayer !== undefined;
    // A match the game ended is recorded as ending when it did.
    const endedAt = finished === null ? null : ((await stats?.matchEnded(finished, finished.endedAt ?? time)) ?? null);

    // In-game messages go out whatever happens to the Discord posts. A failed one is not retried. At most one goes out
    // a check: a match message first, and a seeding message that is due then waits for the next check.
    const wording = broadcast === undefined && !welcoming && ending === null && !thanking ? DEFAULT_LINES : await readLines(lines, log);
    // The vote wording only while there is a vote to send people to.
    const matchRule =
      config.matchMessages !== null && config.matchMessages.vote === true && !((await voting?.(match)) ?? false)
        ? { ...config.matchMessages, vote: false }
        : config.matchMessages;
    const { messages, send: milestone, used: milestoneLine } =
      matchRule !== null && broadcast !== undefined && status.players > 0
        ? nextMessage(state.messages, match, time, matchRule, config.vip, random, wording, state.recent)
        : { messages: state.messages, send: null, used: null };
    const seedingRule = config.seedingMessages;
    const watched = watchJoins(state.joins, steamIds(players), time, canSeedMessage(seedingNow, status.players, config.rules.live));
    // Someone joined 30 seconds ago (the quick join checks usually send this first), or it is time for the next one.
    // While a message for someone who just joined is waiting, the timed one waits for it.
    const seedingDue =
      joinMessageDue(watched, time) ||
      (canSeedMessage(seedingNow, status.players, config.rules.live) &&
        watched.lastJoinAt === null &&
        seedingRule !== null &&
        seedingMessageDue(state.seedMessageAt, time, seedingRule, config.pollIntervalMs));
    const seedingLine =
      milestone === null && seedingRule !== null && broadcast !== undefined && seedingDue
        ? seedingPick(status.players, config.rules.live, seedingRule, config.vip, random, wording, state.recent)
        : null;
    const seedingText = seedingLine?.text ?? null;
    const seedMessageAt = seedingText === null ? state.seedMessageAt : time;
    const joins = seedingText === null ? watched : { ...watched, lastJoinAt: null };
    const message = milestone ?? seedingText;
    const chosen = milestoneLine ?? seedingLine;
    const used = chosen === null ? state.recent : remember(state.recent, chosen);
    if (message !== null && broadcast !== undefined) {
      try {
        await broadcast(message);
        log.info(`Sent in game: ${message}`);
      } catch (error) {
        log.error(`In-game message failed: ${errorText(error)}`);
      }
    }

    const thanked = await thankSeeders(credits, players, staffIds, wording, used);
    const { watch: welcomes, recent: welcomed } = await welcome(state.welcomes, players, status.players, time, wording, thanked);
    const recent =
      ending === null || endRule === null
        ? welcomed
        : await congratulate({ messagePlayer, log, liveMatch, endExtras, milestonesTold, random }, endRule, ending, players, hidden, wording, welcomed);
    const endMessages = ending?.startedAt ?? state.endMessages;

    // If a Discord post fails, the match and the seeding count are still saved, so they keep being tracked while
    // Discord is down, and an unsent summary is kept to retry. A newer summary replaces one still waiting; that match
    // is already recorded. While live, the seeding count is kept so a retried live alert can still name the seeders.
    let tracked: BotState = {
      ...state,
      seeding: tallied ?? (after === 'live' ? state.seeding : {}),
      match,
      messages,
      seedMessageAt,
      joins,
      welcomes,
      unsentSummary: finished === null ? state.unsentSummary : { ...summarise(finished), endedAt },
      last: reading,
      outage,
      recent,
      endMessages,
    };
    try {
      const summary = tracked.unsentSummary;
      if (summary !== null) {
        await send(buildMatchSummary({ ...summary, top: publicNames(summary.top, hidden) }, status.name, config.siteUrl));
        // So a failed alert below does not post the summary a second time.
        tracked = { ...tracked, unsentSummary: null };
        log.info(`Sent match summary for ${summary.map}`);
      }
      if (result.alert !== null) {
        // At night the seeding and low-pop alerts ping nobody: the server dying down then is everyone going to bed, and
        // someone joining an empty server is no reason to wake the seeders. A live alert still pings.
        const quiet = result.alert !== 'live' && isQuiet(time, config.quietHours);
        await send(
          buildMessage(result.alert, status, {
            lowPop: config.rules.lowPop,
            live: config.rules.live,
            roleId: quiet ? undefined : config.roleId,
            seeders,
            vip: config.vip,
            siteUrl: config.siteUrl,
            serverId: config.serverId,
          }),
        );
        log.info(`Sent ${result.alert} alert at ${status.players}/${status.maxPlayers} players${quiet ? ' (night: no ping)' : ''}`);
        const kind = result.alert;
        await report(async (sink) => sink.alerted?.(kind, time));
      }
    } catch (error) {
      await store.save(tracked);
      throw error;
    }
    // The alert state is only saved after a successful send, so a failed alert is retried on the next check.
    await store.save({
      alerts: result.state,
      seeding: tallied ?? {},
      match,
      unsentSummary: null,
      messages,
      seedMessageAt,
      joins,
      welcomes,
      last: reading,
      outage,
      recent,
      endMessages,
    });
  };

  return async (): Promise<void> => {
    try {
      await check();
    } catch (error) {
      log.error(`Check failed: ${errorText(error)}`);
    }
  };
};

type JoinCheckDeps = {
  config: Config;
  fetchPlayers: () => Promise<Player[]>;
  broadcast: (message: string) => Promise<void>;
  now: () => number;
  log: Logger;
  store: StateStore;
  random?: () => number;
  lines?: () => Promise<Lines>;
};

// Returns a function that runs one quick join check: between the checks, while the server seeds, it reads who is in
// game, so the seeding message goes out 30 seconds after someone joins (30 seconds after the last of them, when
// several join together). It must not run at the same time as a check, as both save the state. It answers whether to
// keep running them: only while the last check found the server seeding. It never throws.
export const createJoinCheck =
  ({ config, fetchPlayers, broadcast, now, log, store, random = Math.random, lines }: JoinCheckDeps) =>
  async (): Promise<boolean> => {
    try {
      const rule = config.seedingMessages;
      const state = await store.load();
      if (rule === null || state === null || state.alerts.phase !== 'seeding') return false;
      const players = await fetchPlayers();
      const time = now();
      const count = players.length;
      const watched = watchJoins(state.joins, steamIds(players), time, canSeedMessage(true, count, config.rules.live));
      if (!joinMessageDue(watched, time)) {
        await store.save({ ...state, joins: watched });
        return true;
      }
      const pick = seedingPick(count, config.rules.live, rule, config.vip, random, await readLines(lines, log), state.recent);
      const message = pick.text;
      try {
        await broadcast(message);
        log.info(`Sent in game: ${message}`);
      } catch (error) {
        log.error(`In-game message failed: ${errorText(error)}`);
      }
      await store.save({ ...state, joins: { ...watched, lastJoinAt: null }, seedMessageAt: time, recent: remember(state.recent, pick) });
      return true;
    } catch (error) {
      log.error(`Join check failed: ${errorText(error)}`);
      return true;
    }
  };

type FeedJoinsDeps = Pick<PollerDeps, 'config' | 'log' | 'store'>;

// Returns a function that notes the kill feed's joins and leaves while the server seeds, so the seeding message goes out
// 30 seconds after someone joins (see createJoinCheck, which sends it) without reading who is in game every few seconds.
// `players` is how many the game said were on after the last of them. It answers when the message will be due, or null
// when none is waiting. It must not run at the same time as a check, as both save the state. It never throws.
export const createFeedJoins =
  ({ config, log, store }: FeedJoinsDeps) =>
  async (presence: FeedPresence[], players: number | null, at: number): Promise<number | null> => {
    try {
      const state = await store.load();
      if (config.seedingMessages === null || state === null || state.joins === null || state.alerts.phase !== 'seeding') return null;
      // In the order the game sent them, so someone who leaves and comes back has joined, and one who joins and leaves is gone.
      let online = state.joins.online;
      const joiners = new Set<string>();
      for (const p of presence) {
        if (p.type === 'left') online = online.filter((id) => id !== p.steamId);
        else if (!online.includes(p.steamId)) {
          online = [...online, p.steamId];
          joiners.add(p.steamId);
        }
      }
      const joined = online.some((id) => joiners.has(id));
      const seeding = canSeedMessage(true, players ?? online.length, config.rules.live);
      const watched: JoinWatch = { online, lastJoinAt: !seeding ? null : joined ? at : state.joins.lastJoinAt };
      const changed = online !== state.joins.online || watched.lastJoinAt !== state.joins.lastJoinAt;
      if (changed) await store.save({ ...state, joins: watched });
      return watched.lastJoinAt === null ? null : watched.lastJoinAt + JOIN_WAIT_MS;
    } catch (error) {
      log.error(`Noting the kill feed's joins failed: ${errorText(error)}`);
      return null;
    }
  };

type MatchEndCheckDeps = Pick<
  PollerDeps,
  'config' | 'fetchSnapshot' | 'now' | 'log' | 'store' | 'random' | 'lines' | 'privateProfiles' | 'liveMatch' | 'matchFeed' | 'endExtras' | 'milestonesTold'
> & { messagePlayer: (steamId: string, text: string) => Promise<void> };

// Returns a function that sends the end-of-match messages the moment the kill feed says a match ended, while everyone is
// still on the scoreboard, rather than at the next check. It reads the server once, for the scoreboard, and goes ahead
// for the match the game's result is for: the one on now, if it started before the result came and is on its map, or
// the one the reading shows just ended. A match that had them already gets none, so after a check that sent them, or
// for word of a match long over, it sends nothing. The match it read is saved, so the match summary has the same
// scoreboard as the messages; the next check ends it with the game's result (see observeMatch). It must not run at the
// same time as a check, as both save the state. It never throws.
export const createMatchEndCheck =
  ({
    config,
    fetchSnapshot,
    messagePlayer,
    now,
    log,
    store,
    random = Math.random,
    lines,
    privateProfiles,
    liveMatch,
    matchFeed,
    endExtras,
    milestonesTold,
  }: MatchEndCheckDeps) =>
  async (): Promise<void> => {
    try {
      const rule = config.matchEndMessages;
      const state = await store.load();
      if (rule === null || state === null) return;
      const result = (await readFeed(matchFeed, log))?.result ?? null;
      if (result === null) return;
      const { status, players } = await fetchSnapshot();
      const { match, finished } = observeMatch(state.match, status, players, state.alerts.phase === 'live', now());
      const resulted = result.at > match.startedAt && sameMap(result.map, matchMap(match)) ? match : null;
      const ending = [finished, resulted].find((m) => unthanked(m, state)) ?? null;
      if (ending === null) return;
      const hidden = privateProfiles === undefined ? new Set<string>() : await privateProfiles();
      const wording = await readLines(lines, log);
      const recent = await congratulate(
        { messagePlayer, log, liveMatch, endExtras, milestonesTold, random },
        rule,
        ending,
        players,
        hidden,
        wording,
        state.recent,
      );
      await store.save({ ...state, ...(finished === null ? { match } : {}), endMessages: ending.startedAt, recent });
    } catch (error) {
      log.error(`Match end check failed: ${errorText(error)}`);
    }
  };
