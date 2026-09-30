import { z } from 'zod';
import { initialState, step, type MonitorState } from './alerts.ts';
import type { Config } from './config.ts';
import { buildMatchSummary, buildMessage, type DiscordMessage } from './discord.ts';
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
// even if a Discord post then fails, so the site never shows a reachable server as down. `matchEnded` runs before
// the summary is posted, so a Discord outage cannot lose a match. A check that fails after it can report the same
// match again, so the sink must ignore a match it already has (`startedAt` identifies it).
export type StatsSink = {
  check: (observation: Observation) => Promise<void>;
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
});

// The first release stored only the alert state; upgrade it rather than start over.
const StoredStateSchema = z.union([
  BotStateSchema,
  AlertsSchema.transform((alerts): BotState => ({ alerts, seeding: {}, match: null, unsentSummary: null })),
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
      const seeding = alerts.phase === 'seeding' ? tallySeeding({}, players) : {};
      await store.save({ alerts, seeding, match, unsentSummary: null });
      log.info(`Watching "${status.name}": ${status.players}/${status.maxPlayers} players (${alerts.phase})`);
      await report((sink) => sink.check({ at: time, status, players, phase: alerts.phase, match }));
      return;
    }

    const result = step(state.alerts, status.players, time, config.rules);
    const before = state.alerts.phase;
    const after = result.state.phase;
    const { match, finished } = observeMatch(state.match, status, players, after === 'live', time);

    // Count everyone online on each check while the server is seeding; reset once it is live or empty.
    const seeders =
      before !== 'live' && after === 'live'
        ? topSeeders(state.seeding, TOP_SEEDERS).map((s) => ({
            name: s.name,
            minutes: Math.round((s.checks * config.pollIntervalMs) / 60_000),
          }))
        : [];

    await report((sink) => sink.check({ at: time, status, players, phase: after, match }));

    if (finished !== null) await report((sink) => sink.matchEnded(finished, time));

    // If a Discord post fails, the match is still saved, so matches keep being tracked while Discord is down, and an
    // unsent summary is kept to retry. A newer summary replaces one still waiting; that match is already recorded.
    let tracked: BotState = { ...state, match, unsentSummary: finished === null ? state.unsentSummary : summarise(finished) };
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
          buildMessage(result.alert, status, { lowPop: config.rules.lowPop, roleId: config.roleId, seeders }),
        );
        log.info(`Sent ${result.alert} alert at ${status.players}/${status.maxPlayers} players`);
      }
    } catch (error) {
      await store.save(tracked);
      throw error;
    }
    // The alert state and seeding tally are only saved after a successful send, so a failed alert is retried on
    // the next check.
    const seeding = after === 'seeding' ? tallySeeding(state.seeding, players) : {};
    await store.save({ alerts: result.state, seeding, match, unsentSummary: null });
  };

  return async (): Promise<void> => {
    try {
      await check();
    } catch (error) {
      log.error(`Check failed: ${errorText(error)}`);
    }
  };
};
