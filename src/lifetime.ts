import type { Sql } from './killfeed.ts';
import type { RetentionDetail } from './retention.ts';

// The long-term records, for the staff page's Lifetime view and for analysis. The stays, kill feed and hourly figures
// only keep a few weeks, so each UTC day is summed up once it is over, in the Durable Object's SQLite database, and kept
// for good: a row a day, a row a match, and which players played on which days. A few MB a year.
//
// Tables:
//  - daily_stats: one row a day (DAY_COLUMNS). Columns that come from the stays are null for days before the bot kept
//    them (SESSION_DAYS_KEPT), and the ones from the day's player records are always there.
//  - match_stats: one row a match (MATCH_COLUMNS), with who was in game and who left early null when the stays are gone.
//  - player_days: a player and a day they were on the server, with their minutes and matches that day.
//  - players: each player's first and last day, days played, minutes and matches, built from player_days. Steam IDs
//    stay in these two tables and never go in the answers.
//  - daily_heat: each day's leaves and minutes by hour of the week (JSON, 168 numbers each), for the heatmap.
//
// A day is written once it is over, by the first check after midnight UTC (and the days since the last, the first time,
// as far back as the player records go). A value already kept is never replaced by a null, so rolling a day again after
// its stays are gone leaves what was kept.

type Col = readonly [name: string, type: 'INTEGER' | 'REAL' | 'TEXT'];

export const DAY_COLUMNS = [
  ['day', 'TEXT'],
  // From the day's player records.
  ['unique_players', 'INTEGER'],
  ['new_players', 'INTEGER'],
  ['returning_players', 'INTEGER'],
  ['player_minutes', 'INTEGER'],
  ['matches', 'INTEGER'],
  ['peak_players', 'INTEGER'],
  // From the stays.
  ['stays', 'INTEGER'],
  ['average_stay_minutes', 'REAL'],
  ['median_stay_minutes', 'REAL'],
  ['short_stays_new', 'INTEGER'],
  ['stays_new', 'INTEGER'],
  ['short_stays_other', 'INTEGER'],
  ['stays_other', 'INTEGER'],
  ['leaves_early', 'INTEGER'],
  ['leaves_mid', 'INTEGER'],
  ['leaves_late', 'INTEGER'],
  ['leaves_end', 'INTEGER'],
  ['leaves_between', 'INTEGER'],
  ['leaves_finale', 'INTEGER'],
  ['excluded_stays', 'INTEGER'],
  ['seeded_matches', 'INTEGER'],
  ['seeding_minutes', 'REAL'],
  ['seeders', 'INTEGER'],
  ['seeders_at_go_live', 'INTEGER'],
  // From the Discord numbers.
  ['invite_clicks', 'INTEGER'],
  ['accounts', 'INTEGER'],
  ['linked_accounts', 'INTEGER'],
] as const satisfies readonly Col[];

export const MATCH_COLUMNS = [
  ['started_at', 'INTEGER'],
  ['day', 'TEXT'],
  ['map', 'TEXT'],
  ['live_at', 'INTEGER'],
  ['ended_at', 'INTEGER'],
  ['duration_minutes', 'REAL'],
  ['seeding_minutes', 'REAL'],
  ['peak_players', 'INTEGER'],
  ['top_score', 'INTEGER'],
  ['second_score', 'INTEGER'],
  ['last_of_night', 'INTEGER'],
  ['players_at_start', 'INTEGER'],
  ['left_early', 'INTEGER'],
  ['seeders', 'INTEGER'],
  ['seeders_at_go_live', 'INTEGER'],
] as const satisfies readonly Col[];

type Value = string | number | null;
export type DayRow = Record<(typeof DAY_COLUMNS)[number][0], Value>;
export type MatchRow = Record<(typeof MATCH_COLUMNS)[number][0], Value>;

const columnsSql = (columns: readonly Col[], key: string): string => columns.map(([name, type]) => `${name} ${type}${name === key ? ' PRIMARY KEY' : ''}`).join(', ');

// The tables, made the first time.
export const createLifetime = (sql: Sql): void => {
  sql.exec(`CREATE TABLE IF NOT EXISTS daily_stats (${columnsSql(DAY_COLUMNS, 'day')})`);
  sql.exec(`CREATE TABLE IF NOT EXISTS match_stats (${columnsSql(MATCH_COLUMNS, 'started_at')})`);
  sql.exec('CREATE INDEX IF NOT EXISTS match_stats_day ON match_stats (day)');
  sql.exec('CREATE TABLE IF NOT EXISTS player_days (steam_id TEXT NOT NULL, day TEXT NOT NULL, minutes INTEGER NOT NULL, matches INTEGER NOT NULL, PRIMARY KEY (steam_id, day))');
  sql.exec('CREATE INDEX IF NOT EXISTS player_days_day ON player_days (day)');
  sql.exec('CREATE TABLE IF NOT EXISTS players (steam_id TEXT PRIMARY KEY, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, active_days INTEGER NOT NULL, minutes INTEGER NOT NULL, matches INTEGER NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS daily_heat (day TEXT PRIMARY KEY, leaves TEXT NOT NULL, minutes TEXT NOT NULL)');
};

// A row written, a value already kept staying when the new one is null.
const upsert = (sql: Sql, table: string, columns: readonly Col[], key: string, row: Record<string, Value>): void => {
  const names = columns.map(([name]) => name);
  const updates = names.filter((n) => n !== key).map((n) => `${n} = COALESCE(excluded.${n}, ${table}.${n})`);
  sql.exec(
    `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')}) ON CONFLICT(${key}) DO UPDATE SET ${updates.join(', ')}`,
    ...names.map((n) => row[n] ?? null),
  );
};

// A day's players, with the minutes they were on the server (seeding or live) and their matches. Only those who were on
// the server count: a finished match is credited to everyone in it on the day it ends, even someone who left before midnight.
export type DayPlayer = { minutes: number; matches: number };
export type DayPlayers = Record<string, DayPlayer>;

export const writePlayerDays = (sql: Sql, day: string, players: DayPlayers): void => {
  for (const [steamId, p] of Object.entries(players)) {
    if (p.minutes <= 0) continue;
    sql.exec('INSERT INTO player_days (steam_id, day, minutes, matches) VALUES (?, ?, ?, ?) ON CONFLICT(steam_id, day) DO UPDATE SET minutes = excluded.minutes, matches = excluded.matches', steamId, day, p.minutes, p.matches);
  }
};

// Each player's first and last day and totals, from their days.
export const rebuildPlayers = (sql: Sql): void => {
  sql.exec('DELETE FROM players');
  sql.exec('INSERT INTO players (steam_id, first_seen, last_seen, active_days, minutes, matches) SELECT steam_id, MIN(day), MAX(day), COUNT(*), SUM(minutes), SUM(matches) FROM player_days GROUP BY steam_id');
};

const count = (sql: Sql, query: string, ...bindings: (string | number)[]): number => Number(Object.values(sql.exec(query, ...bindings).toArray()[0] ?? {})[0] ?? 0);

// The first day anyone is recorded on: players first seen then could have played before it, so are not new.
const dataStart = (sql: Sql): string | null => {
  const [row] = sql.exec('SELECT MIN(day) AS day FROM player_days').toArray();
  return typeof row?.['day'] === 'string' ? row['day'] : null;
};

// What the day's Discord numbers were, and when taken (`accounts` and `linked` are as the bot counts them then).
export type DiscordDay = { clicks: number | null; accounts: number | null; linked: number | null };

export type DayInput = {
  day: string;
  // The stays' view of the day (see buildRetention), or null for a day before the bot kept them.
  stays: {
    sessions: number;
    averageMinutes: number | null;
    medianMinutes: number | null;
    bounce: { newPlayers: { sessions: number; short: number }; others: { sessions: number; short: number } } | null;
    leaves: { timing: Record<'early' | 'mid' | 'late' | 'end' | 'between', number>; finale: Record<string, number> };
    excluded: number;
    detail: RetentionDetail;
    heat: { leaves: number[]; minutes: number[] };
  } | null;
  // The matches that ended on the day.
  matches: { startedAt: number; map: string; liveAt: number; endedAt: number; peakPlayers: number; scores: number[] }[];
  discord: DiscordDay;
};

const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);

// Writes the day's row, its matches and its heat. The day's players are in player_days and players already.
export const writeDay = (sql: Sql, input: DayInput): void => {
  const { day, stays, matches, discord } = input;
  const start = dataStart(sql);
  const unique = count(sql, 'SELECT COUNT(*) FROM player_days WHERE day = ?', day);
  const fresh = start !== null && day > start ? count(sql, 'SELECT COUNT(*) FROM players WHERE first_seen = ?', day) : null;
  const details = new Map((stays?.detail.matches ?? []).map((m) => [m.startedAt, m]));
  const seeding = new Map((stays?.detail.seeding ?? []).map((m) => [m.startedAt, m]));
  for (const m of matches) {
    const kept = details.get(m.startedAt);
    const seeded = seeding.get(m.startedAt);
    const [top, second] = [...m.scores].sort((a, b) => b - a);
    const row: MatchRow = {
      started_at: m.startedAt,
      day,
      map: m.map,
      live_at: m.liveAt,
      ended_at: m.endedAt,
      duration_minutes: Math.round(((m.endedAt - m.liveAt) / 60_000) * 10) / 10,
      seeding_minutes: Math.round(((m.liveAt - m.startedAt) / 60_000) * 10) / 10,
      peak_players: m.peakPlayers,
      top_score: top ?? null,
      second_score: second ?? null,
      last_of_night: kept === undefined ? null : kept.lastOfNight ? 1 : 0,
      players_at_start: kept?.present ?? null,
      left_early: kept?.leftBefore ?? null,
      seeders: seeded?.seeders ?? null,
      seeders_at_go_live: seeded?.reachedLive ?? null,
    };
    upsert(sql, 'match_stats', MATCH_COLUMNS, 'started_at', row);
  }
  const bounce = stays?.bounce ?? null;
  const row: DayRow = {
    day,
    unique_players: unique,
    new_players: fresh,
    returning_players: fresh === null ? null : unique - fresh,
    player_minutes: count(sql, 'SELECT COALESCE(SUM(minutes), 0) FROM player_days WHERE day = ?', day),
    matches: matches.length,
    peak_players: matches.length === 0 ? null : Math.max(...matches.map((m) => m.peakPlayers)),
    stays: stays?.sessions ?? null,
    average_stay_minutes: stays?.averageMinutes ?? null,
    median_stay_minutes: stays?.medianMinutes ?? null,
    short_stays_new: bounce?.newPlayers.short ?? null,
    stays_new: bounce?.newPlayers.sessions ?? null,
    short_stays_other: bounce?.others.short ?? null,
    stays_other: bounce?.others.sessions ?? null,
    leaves_early: stays?.leaves.timing.early ?? null,
    leaves_mid: stays?.leaves.timing.mid ?? null,
    leaves_late: stays?.leaves.timing.late ?? null,
    leaves_end: stays?.leaves.timing.end ?? null,
    leaves_between: stays?.leaves.timing.between ?? null,
    leaves_finale: stays === null ? null : sum(Object.values(stays.leaves.finale)),
    excluded_stays: stays?.excluded ?? null,
    seeded_matches: stays === null ? null : stays.detail.seeding.length,
    seeding_minutes: stays === null ? null : Math.round(sum(stays.detail.seeding.map((m) => m.seedingMinutes)) * 10) / 10,
    seeders: stays === null ? null : sum(stays.detail.seeding.map((m) => m.seeders)),
    seeders_at_go_live: stays === null ? null : sum(stays.detail.seeding.map((m) => m.reachedLive)),
    invite_clicks: discord.clicks,
    accounts: discord.accounts,
    linked_accounts: discord.linked,
  };
  upsert(sql, 'daily_stats', DAY_COLUMNS, 'day', row);
  if (stays !== null) {
    sql.exec('INSERT OR REPLACE INTO daily_heat (day, leaves, minutes) VALUES (?, ?, ?)', day, JSON.stringify(stays.heat.leaves), JSON.stringify(stays.heat.minutes));
  }
};

// The earliest UTC day with a stay kept, or null when there are none.
export const firstStayDay = (sql: Sql): string | null => {
  const [row] = sql.exec('SELECT MIN(left_at) AS at FROM sessions').toArray();
  return typeof row?.['at'] === 'number' ? new Date(row['at']).toISOString().slice(0, 10) : null;
};

const WEEK = "date(day, '-' || ((CAST(strftime('%w', day) AS INTEGER) + 6) % 7) || ' days')";
const WEEK_OF_FIRST = "date(first_seen, '-' || ((CAST(strftime('%w', first_seen) AS INTEGER) + 6) % 7) || ' days')";

const rows = (sql: Sql, query: string, ...bindings: (string | number)[]): Record<string, unknown>[] => sql.exec(query, ...bindings).toArray();
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const round1 = (n: number): number => Math.round(n * 10) / 10;

export type Period = {
  // The Monday of the week, or the month as 2026-10.
  period: string;
  unique_players: number;
  new_players: number | null;
  regulars: number;
  player_minutes: number;
  matches: number;
  // The average day's players as a share of the period's: how often those who play come on.
  stickiness: number | null;
};

export type CohortWindow = { days: number; eligible: number; returned: number };
export type LifetimeCohort = { week: string; new_players: number; windows: CohortWindow[] };

export const RETURN_DAYS = [1, 7, 30, 90] as const;
// A regular plays this many days in a week, in a month, or in the last 30 days.
export const REGULAR_DAYS_WEEK = 3;
export const REGULAR_DAYS_MONTH = 5;
export const REGULAR_DAYS_30 = 5;
export const DAILY_LISTED = 800;

export type MapLifetime = { map: string; matches: number; average_peak: number; average_minutes: number; players_at_start: number; left_early: number; one_sided: number; with_scores: number };

export type Lifetime = {
  since: string | null;
  through: string | null;
  summary: {
    days: number;
    unique_players: number;
    new_last_30: number;
    active_last_30: number;
    regulars: number;
    lapsed_regulars: number;
    player_hours: number;
    matches: number;
  };
  daily: Partial<Record<string, Value>>[];
  weekly: Period[];
  monthly: Period[];
  cohorts: LifetimeCohort[];
  maps: MapLifetime[];
  heat: { leaves: number[]; minutes: number[]; days: number };
};

// Everything on the Lifetime view, as of the UTC day `today` (which is not in it: it is not over).
export const readLifetime = (sql: Sql, today: string): Lifetime => {
  const start = dataStart(sql);
  const since30 = new Date(Date.parse(`${today}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
  const [through] = rows(sql, 'SELECT MAX(day) AS day FROM daily_stats');
  const summary = {
    days: count(sql, 'SELECT COUNT(*) FROM daily_stats'),
    unique_players: count(sql, 'SELECT COUNT(*) FROM players'),
    new_last_30: start === null ? 0 : count(sql, 'SELECT COUNT(*) FROM players WHERE first_seen >= ? AND first_seen > ?', since30, start),
    active_last_30: count(sql, 'SELECT COUNT(*) FROM players WHERE last_seen >= ?', since30),
    regulars: count(sql, 'SELECT COUNT(*) FROM (SELECT steam_id FROM player_days WHERE day >= ? GROUP BY steam_id HAVING COUNT(*) >= ?)', since30, REGULAR_DAYS_30),
    lapsed_regulars: count(sql, 'SELECT COUNT(*) FROM players WHERE last_seen < ? AND active_days >= ?', since30, REGULAR_DAYS_30),
    player_hours: Math.round(count(sql, 'SELECT COALESCE(SUM(minutes), 0) FROM players') / 60),
    matches: count(sql, 'SELECT COUNT(*) FROM match_stats'),
  };

  const daily = rows(sql, `SELECT * FROM (SELECT ${DAY_COLUMNS.map(([n]) => n).join(', ')} FROM daily_stats ORDER BY day DESC LIMIT ${DAILY_LISTED}) ORDER BY day`) as Lifetime['daily'];

  const newByPeriod = (expr: string): Map<string, number> =>
    new Map(start === null ? [] : rows(sql, `SELECT ${expr} AS period, COUNT(*) AS n FROM players WHERE first_seen > ? GROUP BY period`, start).map((r) => [String(r['period']), num(r['n'])]));
  const period = (key: string, newExpr: string, regularKey: string): Period[] => {
    const fresh = newByPeriod(newExpr);
    const regulars = new Map(
      rows(sql, `SELECT m AS period, COUNT(*) AS n FROM (SELECT ${regularKey} AS m, steam_id, COUNT(*) AS d FROM player_days GROUP BY m, steam_id HAVING d >= ?) GROUP BY m`, regularKey === 'substr(day, 1, 7)' ? REGULAR_DAYS_MONTH : REGULAR_DAYS_WEEK).map((r) => [String(r['period']), num(r['n'])]),
    );
    const matches = new Map(rows(sql, `SELECT ${key} AS period, COALESCE(SUM(matches), 0) AS n, AVG(unique_players) AS avg FROM daily_stats GROUP BY period`).map((r) => [String(r['period']), { n: num(r['n']), avg: num(r['avg']) }]));
    return rows(sql, `SELECT ${key} AS period, COUNT(DISTINCT steam_id) AS unique_players, SUM(minutes) AS minutes FROM player_days GROUP BY period ORDER BY period`).map((r): Period => {
      const p = String(r['period']);
      const uniques = num(r['unique_players']);
      const m = matches.get(p);
      return {
        period: p,
        unique_players: uniques,
        new_players: start === null ? null : (fresh.get(p) ?? 0),
        regulars: regulars.get(p) ?? 0,
        player_minutes: num(r['minutes']),
        matches: m?.n ?? 0,
        stickiness: uniques === 0 || m === undefined ? null : Math.round((m.avg / uniques) * 1000) / 1000,
      };
    });
  };
  const weekly = period(WEEK, WEEK_OF_FIRST, WEEK);
  const monthly = period('substr(day, 1, 7)', 'substr(first_seen, 1, 7)', 'substr(day, 1, 7)');

  const cohorts: LifetimeCohort[] =
    start === null
      ? []
      : rows(
          sql,
          `SELECT ${WEEK_OF_FIRST} AS week, COUNT(*) AS new_players,
            ${RETURN_DAYS.map(
              (n) => `SUM(date(first_seen, '+${n} days') < ?) AS e${n},
              SUM(date(first_seen, '+${n} days') < ? AND EXISTS (SELECT 1 FROM player_days d WHERE d.steam_id = players.steam_id AND d.day > players.first_seen AND d.day <= date(players.first_seen, '+${n} days'))) AS r${n}`,
            ).join(', ')}
          FROM players WHERE first_seen > ? GROUP BY week ORDER BY week`,
          ...RETURN_DAYS.flatMap(() => [today, today]),
          start,
        ).map((r): LifetimeCohort => ({
          week: String(r['week']),
          new_players: num(r['new_players']),
          windows: RETURN_DAYS.map((n) => ({ days: n, eligible: num(r[`e${n}`]), returned: num(r[`r${n}`]) })),
        }));

  const maps = rows(
    sql,
    `SELECT map, COUNT(*) AS matches, AVG(peak_players) AS peak, AVG(duration_minutes) AS minutes,
      COALESCE(SUM(players_at_start), 0) AS present, COALESCE(SUM(left_early), 0) AS left_early,
      SUM(top_score IS NOT NULL AND second_score IS NOT NULL AND top_score > 0) AS with_scores,
      SUM(top_score IS NOT NULL AND second_score IS NOT NULL AND top_score > 0 AND (top_score - second_score) * 2 > top_score) AS one_sided
    FROM match_stats GROUP BY map ORDER BY matches DESC, map`,
  ).map((r): MapLifetime => ({
    map: String(r['map']),
    matches: num(r['matches']),
    average_peak: round1(num(r['peak'])),
    average_minutes: round1(num(r['minutes'])),
    players_at_start: num(r['present']),
    left_early: num(r['left_early']),
    one_sided: num(r['one_sided']),
    with_scores: num(r['with_scores']),
  }));

  const heat = { leaves: Array.from({ length: 168 }, () => 0), minutes: Array.from({ length: 168 }, () => 0), days: 0 };
  for (const r of rows(sql, 'SELECT leaves, minutes FROM daily_heat')) {
    const leaves = JSON.parse(String(r['leaves'])) as number[];
    const minutes = JSON.parse(String(r['minutes'])) as number[];
    heat.days += 1;
    for (let i = 0; i < 168; i += 1) {
      heat.leaves[i] = (heat.leaves[i] ?? 0) + (leaves[i] ?? 0);
      heat.minutes[i] = (heat.minutes[i] ?? 0) + (minutes[i] ?? 0);
    }
  }

  return { since: start, through: typeof through?.['day'] === 'string' ? through['day'] : null, summary, daily, weekly, monthly, cohorts, maps, heat };
};

// A table for download, as columns and rows.
export type TableName = 'daily' | 'matches' | 'weekly' | 'monthly' | 'cohorts';
export const TABLE_NAMES: TableName[] = ['daily', 'matches', 'weekly', 'monthly', 'cohorts'];

export const exportTable = (sql: Sql, today: string, name: TableName): { columns: string[]; rows: Value[][] } => {
  if (name === 'matches') {
    const columns = MATCH_COLUMNS.map(([n]) => n);
    return { columns, rows: rows(sql, `SELECT ${columns.join(', ')} FROM match_stats ORDER BY started_at`).map((r) => columns.map((c) => (r[c] ?? null) as Value)) };
  }
  if (name === 'daily') {
    const columns = DAY_COLUMNS.map(([n]) => n);
    return { columns, rows: rows(sql, `SELECT ${columns.join(', ')} FROM daily_stats ORDER BY day`).map((r) => columns.map((c) => (r[c] ?? null) as Value)) };
  }
  const lifetime = readLifetime(sql, today);
  if (name === 'cohorts') {
    const columns = ['week', 'new_players', ...RETURN_DAYS.flatMap((n) => [`eligible_${n}d`, `returned_${n}d`])];
    return { columns, rows: lifetime.cohorts.map((c) => [c.week, c.new_players, ...c.windows.flatMap((w) => [w.eligible, w.returned])]) };
  }
  const columns = ['period', 'unique_players', 'new_players', 'regulars', 'player_minutes', 'matches', 'stickiness'];
  return { columns, rows: (name === 'weekly' ? lifetime.weekly : lifetime.monthly).map((p) => [p.period, p.unique_players, p.new_players, p.regulars, p.player_minutes, p.matches, p.stickiness]) };
};

// A field as CSV needs it: quoted when it has a comma, quote or line break. A name starting with =, +, - or @ would be a
// formula to a spreadsheet, so it gets a ' in front (map names are the game's, but the file is opened by people).
const field = (v: Value): string => {
  if (v === null) return '';
  const text = String(v);
  const safe = typeof v === 'string' && /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

export const toCsv = (table: { columns: string[]; rows: Value[][] }): string => [table.columns.join(','), ...table.rows.map((r) => r.map(field).join(','))].join('\r\n') + '\r\n';

// Used by the worker to name a player's minutes.
export const dayPlayers = (players: Record<string, { seedingMinutes: number; liveMinutes: number; matches: number }>): DayPlayers =>
  Object.fromEntries(Object.entries(players).map(([id, p]) => [id, { minutes: p.seedingMinutes + p.liveMinutes, matches: p.matches }]));

// What the public website shows: only the figures players like to see, with no one named. Nothing about who left, who
// stopped coming, how new players fared, seeding or Discord. `busy` is the average players on the server in each hour of the
// week (UTC, Monday 00:00 first), and is there once seven days of stays are kept.
export const PUBLIC_DAYS = 90;
export const PUBLIC_WEEKS = 104;
export const PUBLIC_MAPS = 8;
export const BUSY_LEAST_DAYS = 7;

export type PublicLifetime = {
  since: string | null;
  through: string | null;
  totals: { players: number; player_hours: number; matches: number; days: number; players_last_30: number; regulars: number };
  records: {
    most_players: { day: string; players: number } | null;
    biggest_match: { day: string; players: number } | null;
    most_matches: { day: string; matches: number } | null;
  };
  typical_stay_minutes: number | null;
  days: { day: string; players: number; peak: number | null }[];
  weeks: { week: string; players: number; new_players: number | null }[];
  months: { month: string; players: number; new_players: number | null; hours: number; matches: number }[];
  maps: { map: string; matches: number }[];
  busy: { days: number; players: number[] } | null;
};

const best = <T>(items: T[], value: (item: T) => number | null): T | null =>
  items.reduce<T | null>((top, item) => ((value(item) ?? -1) > (top === null ? -1 : (value(top) ?? -1)) ? item : top), null);

export const readPublicLifetime = (sql: Sql, today: string): PublicLifetime => {
  const l = readLifetime(sql, today);
  const rowsOf = l.daily as { day: string; unique_players: number | null; peak_players: number | null; matches: number | null; median_stay_minutes: number | null }[];
  const mostPlayers = best(rowsOf, (r) => r.unique_players);
  const biggest = best(rowsOf, (r) => r.peak_players);
  const mostMatches = best(rowsOf, (r) => r.matches);
  const stays = rowsOf.slice(-30).flatMap((r) => (r.median_stay_minutes === null ? [] : [r.median_stay_minutes]));
  return {
    since: l.since,
    through: l.through,
    totals: {
      players: l.summary.unique_players,
      player_hours: l.summary.player_hours,
      matches: l.summary.matches,
      days: l.summary.days,
      players_last_30: l.summary.active_last_30,
      regulars: l.summary.regulars,
    },
    records: {
      most_players: mostPlayers === null || !mostPlayers.unique_players ? null : { day: mostPlayers.day, players: mostPlayers.unique_players },
      biggest_match: biggest === null || !biggest.peak_players ? null : { day: biggest.day, players: biggest.peak_players },
      most_matches: mostMatches === null || !mostMatches.matches ? null : { day: mostMatches.day, matches: mostMatches.matches },
    },
    typical_stay_minutes: stays.length === 0 ? null : round1(stays.reduce((a, b) => a + b, 0) / stays.length),
    days: rowsOf.slice(-PUBLIC_DAYS).map((r) => ({ day: r.day, players: r.unique_players ?? 0, peak: r.peak_players })),
    weeks: l.weekly.slice(-PUBLIC_WEEKS).map((w) => ({ week: w.period, players: w.unique_players, new_players: w.new_players })),
    months: l.monthly.map((m) => ({ month: m.period, players: m.unique_players, new_players: m.new_players, hours: Math.round(m.player_minutes / 60), matches: m.matches })),
    maps: l.maps.slice(0, PUBLIC_MAPS).map((m) => ({ map: m.map, matches: m.matches })),
    busy:
      l.heat.days < BUSY_LEAST_DAYS
        ? null
        : { days: l.heat.days, players: l.heat.minutes.map((minutes) => round1(minutes / 60 / (l.heat.days / 7))) },
  };
};
