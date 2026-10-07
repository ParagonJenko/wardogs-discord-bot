import { z } from 'zod';
import type { AlertRules, QuietHours } from './alerts.ts';
import { dayFlags, FLAGS, vehicleDeath, type Flag, type GriefDay, type VehicleDeath } from './griefing.ts';
import { flaggedDay, HEADSHOT_FLAG, headshotOdds, tally, type KillDaySummary } from './killfeed.ts';
import {
  BACK_SHARE,
  CRASH_CONFIRM_MS,
  CRASH_SHARE,
  DOWN_AFTER_MS,
  GIVE_UP_MS,
  OutageSchema,
  type Outage,
  type OutageEvent,
} from './outages.ts';
import { dayOf } from './stats.ts';
import { assess, RISK, type SteamCheck } from './steam.ts';

// The alert review: GET /api/review, with the REVIEW_TOKEN secret as the bearer, for whoever tunes the alerts' marks.
// What each alert posted, by day; every outage; and how the players' days spread out against each mark: team kills,
// headshots, Steam accounts. No Steam IDs and no names, so it can be read outside the staff page.

// The alert log keeps this many UTC days, and the outage log this many outages.
export const REVIEW_DAYS = 60;
export const OUTAGES_KEPT = 100;
export const ALERT_LOG_KEY = 'alertLog';
export const OUTAGE_LOG_KEY = 'outageLog';

// What was posted: the community alerts (seeding, live, lowPop, back) and the moderation log's (grief, steam,
// headshot, down, up).
export type AlertLog = Record<string, Record<string, number>>;

const AlertLogSchema = z.record(z.string(), z.record(z.string(), z.number().int().nonnegative()));

export const parseAlertLog = (raw: unknown): AlertLog => {
  const parsed = AlertLogSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
};

// Adds `count` posts of `kind` at `at`, keeping the last REVIEW_DAYS days.
export const countAlert = (log: AlertLog, kind: string, at: number, count = 1): AlertLog => {
  const day = dayOf(at);
  const oldest = dayOf(at - (REVIEW_DAYS - 1) * 86_400_000);
  const kept = Object.fromEntries(Object.entries(log).filter(([d]) => d >= oldest));
  return { ...kept, [day]: { ...kept[day], [kind]: (kept[day]?.[kind] ?? 0) + count } };
};

// An outage as the log keeps it: confirmed, and once over, when, with how many players and whether they came back.
export type LoggedOutage = Outage & { endedAt: number | null; players: number | null; refilled: boolean | null };

const OutageLogSchema = z.array(
  OutageSchema.extend({ endedAt: z.number().nullable(), players: z.number().nullable(), refilled: z.boolean().nullable() }),
);

export const parseOutageLog = (raw: unknown): LoggedOutage[] => {
  const parsed = OutageLogSchema.safeParse(raw);
  return parsed.success ? parsed.data : [];
};

// Logs an outage when it is confirmed, and fills it in when it is over.
export const logOutage = (log: LoggedOutage[], event: OutageEvent): LoggedOutage[] => {
  const entry: LoggedOutage =
    event.type === 'down'
      ? { ...event.outage, endedAt: null, players: null, refilled: null }
      : { ...event.outage, endedAt: event.at, players: event.players, refilled: event.refilled };
  const others = log.filter((o) => o.at !== event.outage.at);
  return [...others, entry].sort((a, b) => a.at - b.at).slice(-OUTAGES_KEPT);
};

// How many of `values` are 0, 1, … up to `top`, which counts everything from it up: { "0": 4, "1": 2, "5+": 1 }.
export const histogram = (values: number[], top: number): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const v of values) {
    const key = v >= top ? `${top}+` : String(v);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
};

// Chances by luck, in bands of ten, the flag's mark among them.
const CHANCE_BANDS: [label: string, below: number][] = [
  ['1 in 1,000,000 or less', 1e-6],
  ['1 in 100,000 to 1,000,000', 1e-5],
  ['1 in 10,000 to 100,000', 1e-4],
  ['1 in 1,000 to 10,000', 1e-3],
  ['1 in 100 to 1,000', 1e-2],
  ['1 in 20 to 100', 0.05],
];
const ORDINARY = 'likelier than 1 in 20';

export const chanceBand = (chance: number): string => CHANCE_BANDS.find(([, below]) => chance < below)?.[0] ?? ORDINARY;

// Kills on a player's day, in bands: is the flag's minimum of kills where the days are?
const KILL_BANDS: [label: string, below: number][] = [
  ['1-4', 5],
  ['5-9', 10],
  ['10-19', 20],
  ['20-49', 50],
];
const killBand = (kills: number): string => KILL_BANDS.find(([, below]) => kills < below)?.[0] ?? '50+';

const counted = (labels: string[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const label of labels) counts[label] = (counts[label] ?? 0) + 1;
  return counts;
};

export type ReviewSources = {
  now: number;
  days: number;
  rules: AlertRules;
  quietHours: QuietHours | null;
  posts: { modLog: boolean; grief: boolean; steam: boolean; headshot: boolean; outage: boolean };
  alertLog: AlertLog;
  outageLog: LoggedOutage[];
  // The outage going on now, if any.
  outage: Outage | null;
  // The period's griefing days, oldest first.
  grief: GriefDay[];
  // Every kill day kept (the server's usual aim is worked out from them), and the period's UTC days.
  kept: KillDaySummary[];
  // The Steam checks of everyone on the server in the period, or null without STEAM_API_KEY.
  steam: SteamCheck[] | null;
};

const minutes = (ms: number): number => Math.round(ms / 60_000);

// Team kills and suicides with a vehicle, by how, from each day's kept incidents (its latest INCIDENTS_KEPT), with how
// many of the day's team kills and vehicle suicides those cover. And the run-over team kills of each player's day,
// the kind a driver can do on purpose.
const vehicleDeaths = (days: GriefDay[]) => {
  const ways = (): Record<VehicleDeath, number> => ({ helicopter: 0, runOver: 0, explosion: 0, other: 0 });
  const teamKills = ways();
  const suicides = ways();
  const runOvers: number[] = [];
  let kept = 0;
  let all = 0;
  for (const day of days) {
    all += Object.values(day.players).reduce((n, t) => n + t.teamKills + t.vehicleSuicides, 0);
    kept += day.incidents.length;
    const byPlayer = new Map<string, number>();
    for (const incident of day.incidents) {
      const how = vehicleDeath(incident);
      if (how === null) continue;
      if (incident.kind === 'vehicle-suicide') {
        suicides[how] += 1;
        continue;
      }
      teamKills[how] += 1;
      if (how === 'runOver') byPlayer.set(incident.steamId, (byPlayer.get(incident.steamId) ?? 0) + 1);
    }
    runOvers.push(...byPlayer.values());
  }
  return { teamKills, suicides, runOverTeamKills: histogram(runOvers, 5), incidents: { kept, of: all } };
};

export const buildReview = (s: ReviewSources) => {
  const from = dayOf(s.now - (s.days - 1) * 86_400_000);
  const alertDays = Object.entries(s.alertLog)
    .filter(([day]) => day >= from)
    .sort(([a], [b]) => a.localeCompare(b));
  const totals: Record<string, number> = {};
  for (const [, counts] of alertDays) for (const [kind, n] of Object.entries(counts)) totals[kind] = (totals[kind] ?? 0) + n;

  // Griefing: each player's day, against the flags.
  const playerDays = s.grief.flatMap((day) => Object.values(day.players));
  const flaggedDays = Object.fromEntries((Object.keys(FLAGS) as Flag[]).map((f) => [f, 0])) as Record<Flag, number>;
  const flaggedBy = new Map<string, number>();
  for (const day of s.grief) {
    for (const [steamId, t] of Object.entries(day.players)) {
      const flags = dayFlags(t);
      for (const f of flags) flaggedDays[f] += 1;
      if (flags.length > 0) flaggedBy.set(steamId, (flaggedBy.get(steamId) ?? 0) + 1);
    }
  }

  // Headshots: each player's day in the period, judged as the staff page judges it.
  const server = tally(s.kept);
  const byPlayer = new Map<string, KillDaySummary[]>();
  for (const d of s.kept) byPlayer.set(d.steamId, [...(byPlayer.get(d.steamId) ?? []), d]);
  const own = new Map([...byPlayer].map(([steamId, days]) => [steamId, tally(days)]));
  const period = s.kept.filter((d) => d.day >= from && d.kills > 0);
  const judged = period.flatMap((d) => {
    const odds = headshotOdds(d.weapons, server, own.get(d.steamId) ?? tally([]));
    return odds === null || d.kills < HEADSHOT_FLAG.kills ? [] : [{ steamId: d.steamId, kills: d.kills, odds }];
  });
  const flagged = judged.filter((d) => flaggedDay(d.kills, d.odds));
  const headshotFlaggedBy = counted(flagged.map((d) => d.steamId));

  const steam =
    s.steam === null
      ? null
      : (() => {
          const assessed = s.steam.map((c) => assess(c, s.now));
          return {
            checked: assessed.length,
            risk: counted(assessed.map((a) => a.risk)),
            scores: histogram(
              assessed.map((a) => a.score),
              RISK.alert + 3,
            ),
            atAlertMark: assessed.filter((a) => a.score >= RISK.alert).length,
          };
        })();

  return {
    generatedAt: s.now,
    days: s.days,
    from,
    thresholds: {
      population: {
        seeding: s.rules.seeding,
        live: s.rules.live,
        lowPop: s.rules.lowPop,
        cooldownMinutes: minutes(s.rules.cooldownMs),
        dropGraceMinutes: minutes(s.rules.graceMs),
        seedingAlertMinutes: minutes(s.rules.seedHoldMs),
        quietHours: s.quietHours,
      },
      outages: {
        crashShare: CRASH_SHARE,
        crashConfirmMinutes: minutes(CRASH_CONFIRM_MS),
        downMinutes: minutes(DOWN_AFTER_MS),
        backShare: BACK_SHARE,
        giveUpMinutes: minutes(GIVE_UP_MS),
      },
      grief: FLAGS,
      headshots: HEADSHOT_FLAG,
      steam: RISK,
      posts: s.posts,
    },
    // What was posted, by UTC day, since the bot started counting.
    alerts: { totals, byDay: alertDays.map(([day, counts]) => ({ day, ...counts })) },
    outages: {
      now: s.outage,
      log: s.outageLog.filter((o) => dayOf(o.at) >= from),
    },
    grief: {
      // Everyone who team killed, was team killed or killed themselves, each day.
      playerDays: playerDays.length,
      // Team kills that count towards the flag (not helicopter crashes), per player-day.
      teamKills: histogram(
        playerDays.map((t) => t.teamKills - t.crashTeamKills),
        10,
      ),
      crashTeamKills: playerDays.reduce((n, t) => n + t.crashTeamKills, 0),
      vehicleTeamKills: playerDays.reduce((n, t) => n + t.vehicleTeamKills, 0),
      // The most times a player killed one teammate in a day.
      sameTeammate: histogram(
        playerDays.map((t) => Math.max(0, ...Object.values(t.victims))),
        5,
      ),
      vehicleSuicides: histogram(
        playerDays.map((t) => t.vehicleSuicides),
        5,
      ),
      suicides: histogram(
        playerDays.map((t) => t.suicides),
        15,
      ),
      flaggedDays,
      flaggedPlayers: flaggedBy.size,
      // How many players had 1, 2, 3… flagged days.
      playersByFlaggedDays: histogram([...flaggedBy.values()], 5),
      // Team kills and suicides with a vehicle by how, and the run-over team kills of each player's day that had one.
      vehicles: vehicleDeaths(s.grief),
    },
    headshots: {
      serverShare: server.all.kills === 0 ? null : Math.round((server.all.headshots / server.all.kills) * 1000) / 1000,
      playerDays: period.length,
      killsPerDay: counted(period.map((d) => killBand(d.kills))),
      // Days with enough kills to judge, by chance by luck.
      judgedDays: judged.length,
      chance: counted(judged.map((d) => chanceBand(d.odds.chance))),
      flaggedDays: flagged.length,
      flaggedPlayers: Object.keys(headshotFlaggedBy).length,
      playersByFlaggedDays: histogram(Object.values(headshotFlaggedBy), 5),
    },
    steam,
  };
};

export type Review = ReturnType<typeof buildReview>;
