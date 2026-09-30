import { z } from 'zod';
import { initialState, step, type MonitorState } from './alerts.ts';
import type { Config } from './config.ts';
import { buildMatchSummary, buildMessage, type DiscordMessage } from './discord.ts';
import type { SeedCredit } from './players.ts';
import type { Snapshot } from './rcon.ts';
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
  // Whether the server has been live since it last emptied. Until it has, time online counts as seeding.
  liveSinceEmpty: boolean;
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
};

// Feeds the website's stats and the player records. `check` runs once for every check that reached the server,
// even if a Discord post then fails, so the site never shows a reachable server as down. `seeded` runs when the
// server goes live, with everyone who seeded it. `matchEnded` runs before the summary is posted, so a Discord outage
// cannot lose a match. A check that fails after these can report the same seed or match again, so the sink must
// ignore one it already has (a match's `startedAt` identifies it).
export type StatsSink = {
  check: (observation: Observation) => Promise<void>;
  seeded: (seeders: SeedCredit[], at: number) => Promise<void>;
  matchEnded: (match: MatchState, at: number) => Promise<void>;
};

const TOP_SEEDERS = 3;

const AlertsSchema = z.object({
  phase: z.enum(['empty', 'seeding', 'live']),
  lastAlertAt: z.partialRecord(z.enum(['seeding', 'live', 'lowPop']), z.number()),
});

const Scores = z.array(z.object({ name: z.string(), score: z.number() }));

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
      players: z.record(z.string(), z.object({ name: z.string(), kills: z.number(), deaths: z.number() })),
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
  // Missing from state saved before seeding stopped at the first live.
  liveSinceEmpty: z.boolean().default(false),
});

// The first release stored only the alert state; upgrade it rather than start over.
const StoredStateSchema = z.union([
  BotStateSchema,
  AlertsSchema.transform(
    (alerts): BotState => ({ alerts, seeding: {}, match: null, unsentSummary: null, liveSinceEmpty: alerts.phase === 'live' }),
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

// Returns a function that runs one check. It never throws, so a bad poll does not stop the loop.
export const createPoller = ({ config, fetchSnapshot, send, now, log, store, stats }: PollerDeps) => {
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
      const liveSinceEmpty = alerts.phase === 'live';
      await store.save({ alerts, seeding, match, unsentSummary: null, liveSinceEmpty });
      log.info(`Watching "${status.name}": ${status.players}/${status.maxPlayers} players (${alerts.phase})`);
      await report((sink) => sink.check({ at: time, status, players, phase: alerts.phase, seeding: seedingNow, match }));
      return;
    }

    const result = step(state.alerts, status.players, time, config.rules);
    const before = state.alerts.phase;
    const after = result.state.phase;
    const { match, finished } = observeMatch(state.match, status, players, after === 'live', time);
    // Seeding is the time from empty until the server first goes live. A live server that drops below the low-pop
    // threshold is not seeding again until it has emptied.
    const liveSinceEmpty = after !== 'empty' && (state.liveSinceEmpty || before === 'live' || after === 'live');
    const seedingNow = after === 'seeding' && !liveSinceEmpty;
    const tallied = seedingNow ? tallySeeding(state.seeding, players) : null;
    const minutes = (checks: number): number => Math.round((checks * config.pollIntervalMs) / 60_000);

    // Count everyone online on each check while the server is seeding; reset once it is live or empty.
    const wentLive = before !== 'live' && after === 'live';
    const seeders = wentLive
      ? topSeeders(state.seeding, TOP_SEEDERS).map((s) => ({ name: s.name, minutes: minutes(s.checks) }))
      : [];
    const credits = wentLive
      ? Object.entries(state.seeding).map(([steamId, s]) => ({ steamId, name: s.name, minutes: minutes(s.checks) }))
      : [];

    await report((sink) => sink.check({ at: time, status, players, phase: after, seeding: seedingNow, match }));
    if (credits.length > 0) await report((sink) => sink.seeded(credits, time));

    if (finished !== null) await report((sink) => sink.matchEnded(finished, time));

    // If a Discord post fails, the match and the seeding count are still saved, so they keep being tracked while
    // Discord is down, and an unsent summary is kept to retry. A newer summary replaces one still waiting; that match
    // is already recorded. While live, the seeding count is kept so a retried live alert can still name the seeders.
    let tracked: BotState = {
      ...state,
      seeding: tallied ?? (after === 'live' ? state.seeding : {}),
      match,
      liveSinceEmpty,
      unsentSummary: finished === null ? state.unsentSummary : summarise(finished),
    };
    try {
      const summary = tracked.unsentSummary;
      if (summary !== null) {
        await send(buildMatchSummary(summary, status.name));
        // So a failed alert below does not post the summary a second time.
        tracked = { ...tracked, unsentSummary: null };
        log.info(`Sent match summary for ${summary.map}`);
      }
      if (result.alert !== null) {
        await send(
          buildMessage(result.alert, status, { lowPop: config.rules.lowPop, roleId: config.roleId, seeders, vip: config.vip }),
        );
        log.info(`Sent ${result.alert} alert at ${status.players}/${status.maxPlayers} players`);
      }
    } catch (error) {
      await store.save(tracked);
      throw error;
    }
    // The alert state is only saved after a successful send, so a failed alert is retried on the next check.
    await store.save({ alerts: result.state, seeding: tallied ?? {}, match, unsentSummary: null, liveSinceEmpty });
  };

  return async (): Promise<void> => {
    try {
      await check();
    } catch (error) {
      log.error(`Check failed: ${errorText(error)}`);
    }
  };
};
