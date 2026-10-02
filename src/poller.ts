import { z } from 'zod';
import { initialState, step, type MonitorState } from './alerts.ts';
import type { Config } from './config.ts';
import { buildMatchSummary, buildMessage, type DiscordMessage } from './discord.ts';
import {
  joinMessageDue,
  JoinWatchSchema,
  MatchMessagesSchema,
  nextMessage,
  seedingMessage,
  seedingMessageDue,
  watchJoins,
  type JoinWatch,
  type MatchMessages,
} from './messages.ts';
import type { SeedCredit } from './players.ts';
import type { Player, Snapshot } from './rcon.ts';
import type { Observation } from './stats.ts';
import {
  observeMatch,
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
  // A match summary Discord has not accepted yet; posting it is retried on each check.
  unsentSummary: MatchSummary | null;
  // Which in-game messages the current match has had.
  messages: MatchMessages | null;
  // When the last in-game seeding message went out.
  seedMessageAt: number | null;
  // Who is in game, and whether a seeding message is waiting for someone who just joined.
  joins: JoinWatch | null;
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
  // Picks which line an in-game message uses.
  random?: () => number;
};

// Feeds the website's stats and the player records. `check` runs once for every check that reached the server,
// even if a Discord post then fails, so the site never shows a reachable server as down; if it fails, only that is
// lost. `seeded` runs when the server goes live, with everyone who seeded it, and `matchEnded` when a match ends,
// both before any Discord post. If either fails, the check fails before the state moves on, so the next check reports
// the same seed or match again. The sink must ignore one it already has (a match's `startedAt` identifies it).
export type StatsSink = {
  check: (observation: Observation) => Promise<void>;
  seeded: (seeders: SeedCredit[], at: number) => Promise<void>;
  matchEnded: (match: MatchState, at: number) => Promise<void>;
};

const TOP_SEEDERS = 3;

const AlertsSchema = z.object({
  phase: z.enum(['empty', 'seeding', 'live']),
  lastAlertAt: z.partialRecord(z.enum(['seeding', 'live', 'lowPop']), z.number()),
  lowSince: z.number().optional(),
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
    })
    .nullable()
    .default(null),
  // Missing from state saved before in-game messages.
  messages: MatchMessagesSchema.nullable().default(null),
  // Missing from state saved before seeding messages.
  seedMessageAt: z.number().nullable().default(null),
  // Missing from state saved before seeding messages on joining.
  joins: JoinWatchSchema.nullable().default(null),
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

// Returns a function that runs one check. It never throws, so a bad poll does not stop the loop.
export const createPoller = ({ config, fetchSnapshot, send, now, log, store, stats, broadcast, random = Math.random }: PollerDeps) => {
  // A stats failure is logged on its own: the check itself worked, and its alerts and state are saved.
  const report = async (record: (sink: StatsSink) => Promise<void>): Promise<void> => {
    if (stats === undefined) return;
    try {
      await record(stats);
    } catch (error) {
      log.error(`Stats update failed: ${errorText(error)}`);
    }
  };

  const check = async (): Promise<void> => {
    const { status, players } = await fetchSnapshot();
    const state = await store.load();
    const time = now();

    if (state === null) {
      const alerts = initialState(status.players, config.rules);
      const { match } = observeMatch(null, status, players, alerts.phase === 'live', time);
      const seedingNow = alerts.phase === 'seeding';
      const seeding = seedingNow ? tallySeeding({}, players) : {};
      const messages =
        config.matchMessages === null ? null : nextMessage(null, match, time, config.matchMessages, config.vip).messages;
      const joins = watchJoins(null, steamIds(players), time, false);
      await store.save({ alerts, seeding, match, unsentSummary: null, messages, seedMessageAt: null, joins });
      log.info(`Watching "${status.name}": ${status.players}/${status.maxPlayers} players (${alerts.phase})`);
      await report((sink) => sink.check({ at: time, status, players, phase: alerts.phase, seeding: seedingNow, match }));
      return;
    }

    const result = step(state.alerts, status.players, time, config.rules);
    const before = state.alerts.phase;
    const after = result.state.phase;
    const { match, finished } = observeMatch(state.match, status, players, after === 'live', time);
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
    const seeders = wentLive
      ? topSeeders(state.seeding, TOP_SEEDERS).map((s) => ({ name: s.name, minutes: minutes(s.checks) }))
      : [];
    const credits = wentLive
      ? Object.entries(state.seeding).map(([steamId, s]) => ({ steamId, name: s.name, minutes: minutes(s.checks) }))
      : [];

    await report((sink) => sink.check({ at: time, status, players, phase: after, seeding: seedingNow, match }));
    // Not caught: nothing has been saved yet, so if recording fails, the next check tries again.
    if (credits.length > 0) await stats?.seeded(credits, time);
    if (finished !== null) await stats?.matchEnded(finished, time);

    // In-game messages go out whatever happens to the Discord posts. A failed one is not retried. At most one goes out
    // a check: a match message first, and a seeding message that is due then waits for the next check.
    const { messages, send: milestone } =
      config.matchMessages !== null && broadcast !== undefined && status.players > 0
        ? nextMessage(state.messages, match, time, config.matchMessages, config.vip, random)
        : { messages: state.messages, send: null };
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
    const seedingText =
      milestone === null && seedingRule !== null && broadcast !== undefined && seedingDue
        ? seedingMessage(status.players, config.rules.live, seedingRule, config.vip, random)
        : null;
    const seedMessageAt = seedingText === null ? state.seedMessageAt : time;
    const joins = seedingText === null ? watched : { ...watched, lastJoinAt: null };
    const message = milestone ?? seedingText;
    if (message !== null && broadcast !== undefined) {
      try {
        await broadcast(message);
        log.info(`Sent in game: ${message}`);
      } catch (error) {
        log.error(`In-game message failed: ${errorText(error)}`);
      }
    }

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
      unsentSummary: finished === null ? state.unsentSummary : summarise(finished),
    };
    try {
      const summary = tracked.unsentSummary;
      if (summary !== null) {
        await send(buildMatchSummary(summary, status.name, config.siteUrl));
        // So a failed alert below does not post the summary a second time.
        tracked = { ...tracked, unsentSummary: null };
        log.info(`Sent match summary for ${summary.map}`);
      }
      if (result.alert !== null) {
        await send(
          buildMessage(result.alert, status, {
            lowPop: config.rules.lowPop,
            live: config.rules.live,
            roleId: config.roleId,
            seeders,
            vip: config.vip,
            siteUrl: config.siteUrl,
          }),
        );
        log.info(`Sent ${result.alert} alert at ${status.players}/${status.maxPlayers} players`);
      }
    } catch (error) {
      await store.save(tracked);
      throw error;
    }
    // The alert state is only saved after a successful send, so a failed alert is retried on the next check.
    await store.save({ alerts: result.state, seeding: tallied ?? {}, match, unsentSummary: null, messages, seedMessageAt, joins });
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
};

// Returns a function that runs one quick join check: between the checks, while the server seeds, it reads who is in
// game, so the seeding message goes out 30 seconds after someone joins (30 seconds after the last of them, when
// several join together). It must not run at the same time as a check, as both save the state. It answers whether to
// keep running them: only while the last check found the server seeding. It never throws.
export const createJoinCheck =
  ({ config, fetchPlayers, broadcast, now, log, store, random = Math.random }: JoinCheckDeps) =>
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
      const message = seedingMessage(count, config.rules.live, rule, config.vip, random);
      try {
        await broadcast(message);
        log.info(`Sent in game: ${message}`);
      } catch (error) {
        log.error(`In-game message failed: ${errorText(error)}`);
      }
      await store.save({ ...state, joins: { ...watched, lastJoinAt: null }, seedMessageAt: time });
      return true;
    } catch (error) {
      log.error(`Join check failed: ${errorText(error)}`);
      return true;
    }
  };
