import { z } from 'zod';
import { dayOf } from './stats.ts';

// INITcoins: what players earn by seeding, playing and doing missions, and spend on whitelist days and cosmetics. It
// replaces automatic seeder VIP (see vip.ts), which gave a week of whitelist for seeding on 3 days in a week.
//
// Everything here is pure: the Durable Object (worker.ts) reads and writes each player's account (`coin:<Steam ID>`),
// and calls these with the time. Coins go to the Steam ID, linked or not, so nobody loses what they earned before linking
// their account; spending needs a linked account, as that is how we know who is buying.
//
// The balance: seeding is what the server needs, so it pays best per hour; playing and missions pay a little, capped
// each day. A week of whitelist costs about what 4 seeds earn, or 3 seeds and a few evenings playing, so the old way
// (seed on 3 days a week) still keeps a seeder in VIP, and a player who only plays needs well over a week. The whitelist can't be held more
// than a fortnight ahead, so it can't be stockpiled. Every number is in wrangler.jsonc.

export const DAY_MS = 24 * 60 * 60_000;

export type CoinRole = { id: string; name: string; price: number };

export type CoinRule = {
  // A successful seed (the rule VIP_SEED_MINUTES), and then 1 coin for each `seedMinutesPer` minutes past the least, to
  // `seedMinutesCap` coins a day.
  seed: number;
  seedMinutesPer: number;
  seedMinutesCap: number;
  // 1 coin for each `playMinutesPer` minutes with the server live.
  playMinutesPer: number;
  // A match played, and a match won, for the first `matchesPaid` matches of the day.
  match: number;
  win: number;
  matchesPaid: number;
  // What playing, seeding minutes and matches can pay in a day (the seed itself and missions are not counted in it).
  activityCap: number;
  vipDayPrice: number;
  vipWeekPrice: number;
  // The whitelist can't be held more than this many days ahead.
  vipAheadDays: number;
  rerollPrice: number;
  roles: CoinRole[];
  // Whether the server tracks kill streaks (BOUNTY_STREAK), which the "end a kill streak" mission needs.
  streaks: boolean;
  // The least kills and deaths together for a match to count as played, so sitting in a match earns nothing.
  playedLeast: number;
};

export const MISSION_REROLLS_PER_DAY = 3;

// ---- Missions ----

export type Metric = 'kills' | 'matches' | 'wins' | 'minutes' | 'bestKills' | 'breaks' | 'seeded' | 'seedDays' | 'activeDays';
export type Scope = 'day' | 'week';
export type Tier = 0 | 1 | 2;

export type Mission = {
  id: string;
  scope: Scope;
  tier: Tier;
  text: string;
  metric: Metric;
  target: number;
  reward: number;
  // Needs the kill streak bounty to be on.
  streaks?: true;
};

const day = (id: string, tier: Tier, text: string, metric: Metric, target: number, reward: number, streaks?: true): Mission => ({
  id,
  scope: 'day',
  tier,
  text,
  metric,
  target,
  reward,
  ...(streaks ? { streaks } : {}),
});
const week = (id: string, tier: Tier, text: string, metric: Metric, target: number, reward: number): Mission => ({
  id,
  scope: 'week',
  tier,
  text,
  metric,
  target,
  reward,
});

// Three a day, one of each tier, the same for everyone: easy 10, medium 15, hard 25. Three a week: 30, 50, 80.
export const MISSIONS: Mission[] = [
  day('d-play-2', 0, 'Play 2 matches', 'matches', 2, 10),
  day('d-minutes-60', 0, 'Play for an hour with the server live', 'minutes', 60, 10),
  day('d-kills-10', 0, 'Get 10 kills', 'kills', 10, 10),
  day('d-win-1', 1, 'Win a match', 'wins', 1, 15),
  day('d-kills-25', 1, 'Get 25 kills', 'kills', 25, 15),
  day('d-play-4', 1, 'Play 4 matches', 'matches', 4, 15),
  day('d-best-12', 2, 'Get 12 kills in one match', 'bestKills', 12, 25),
  day('d-win-2', 2, 'Win 2 matches', 'wins', 2, 25),
  day('d-streak-end', 2, 'End an enemy bounty (a long kill streak)', 'breaks', 1, 25, true),
  week('w-play-10', 0, 'Play 10 matches', 'matches', 10, 30),
  week('w-days-3', 0, 'Play on 3 different days', 'activeDays', 3, 30),
  week('w-seed-2', 0, 'Seed the server on 2 days', 'seedDays', 2, 30),
  week('w-win-5', 1, 'Win 5 matches', 'wins', 5, 50),
  week('w-kills-150', 1, 'Get 150 kills', 'kills', 150, 50),
  week('w-days-5', 1, 'Play on 5 different days', 'activeDays', 5, 50),
  week('w-seed-4', 2, 'Seed the server on 4 days', 'seedDays', 4, 80),
  week('w-win-8', 2, 'Win 8 matches', 'wins', 8, 80),
  week('w-kills-300', 2, 'Get 300 kills', 'kills', 300, 80),
];

export const missionById = (id: string): Mission | undefined => MISSIONS.find((m) => m.id === id);

const hash = (text: string): number => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
};

const available = (m: Mission, rule: Pick<CoinRule, 'streaks'>): boolean => m.streaks !== true || rule.streaks;
const poolOf = (scope: Scope, tier: Tier, rule: Pick<CoinRule, 'streaks'>): Mission[] =>
  MISSIONS.filter((m) => m.scope === scope && m.tier === tier && available(m, rule));

// The day's (or week's) three missions, easiest first. `key` is the UTC date, or the date of the week's Monday.
export const missionsFor = (scope: Scope, key: string, rule: Pick<CoinRule, 'streaks'>): Mission[] =>
  ([0, 1, 2] as const).flatMap((tier) => {
    const pool = poolOf(scope, tier, rule);
    return pool.length === 0 ? [] : [pool[hash(`${scope}:${key}:${tier}`) % pool.length] as Mission];
  });

// ---- Titles and the shop ----

export const TITLES = [
  { id: 'title-sprout', name: 'Sprout', price: 300 },
  { id: 'title-seeder', name: 'Seeder', price: 500 },
  { id: 'title-grunt', name: 'Grunt', price: 800 },
  { id: 'title-hound', name: 'Hound', price: 1500 },
  { id: 'title-wardog', name: 'Wardog', price: 3000 },
  { id: 'title-alpha', name: 'Alpha', price: 6000 },
] as const;

export type Item =
  | { id: string; kind: 'vip'; name: string; price: number; days: number }
  | { id: string; kind: 'title'; name: string; price: number }
  | { id: string; kind: 'role'; name: string; price: number; roleId: string };

export const catalogue = (rule: CoinRule): Item[] => [
  { id: 'vip-1', kind: 'vip', name: 'Whitelist, 1 day', price: rule.vipDayPrice, days: 1 },
  { id: 'vip-7', kind: 'vip', name: 'Whitelist, 7 days', price: rule.vipWeekPrice, days: 7 },
  ...TITLES.map((t): Item => ({ id: t.id, kind: 'title', name: `Title: ${t.name}`, price: t.price })),
  ...rule.roles.map((r): Item => ({ id: `role-${r.id}`, kind: 'role', name: `Discord role: ${r.name}`, price: r.price, roleId: r.id })),
];

export const itemById = (rule: CoinRule, id: string): Item | undefined => catalogue(rule).find((i) => i.id === id);

export const titleName = (id: string | null): string | null => TITLES.find((t) => t.id === id)?.name ?? null;

// ---- Accounts ----

export type Metrics = { kills: number; matches: number; wins: number; minutes: number; bestKills: number; breaks: number; seeded: number };
export type WeekMetrics = { kills: number; matches: number; wins: number; seedDays: number; activeDays: number };

export type Why = 'seed' | 'seed-time' | 'play' | 'match' | 'win' | 'mission' | 'migrate' | 'staff' | 'buy' | 'reroll';
export type Tx = { at: number; delta: number; why: Why; note?: string };

export type DayState = {
  day: string;
  m: Metrics;
  // Coins paid today that count towards the cap.
  activity: number;
  playPaid: number;
  done: string[];
  // Missions the player swapped for another, by slot (0 to 2) → mission id.
  swaps: Record<string, string>;
  rerolls: number;
};
export type WeekState = { week: string; m: WeekMetrics; done: string[]; lastActive: string };

export type CoinAccount = {
  name: string;
  balance: number;
  earned: number;
  spent: number;
  day: DayState;
  week: WeekState;
  // Recent awards by key, so one that is sent again is not paid twice.
  keys: string[];
  log: Tx[];
  // Cosmetics bought: titles and Discord roles, by item id.
  owned: string[];
  title: string | null;
  updatedAt: number;
};

export const COIN_PREFIX = 'coin:';
export const coinKey = (steamId: string): string => `${COIN_PREFIX}${steamId}`;

const LOG_KEPT = 30;
const KEYS_KEPT = 80;

const blankMetrics = (): Metrics => ({ kills: 0, matches: 0, wins: 0, minutes: 0, bestKills: 0, breaks: 0, seeded: 0 });
const blankWeekMetrics = (): WeekMetrics => ({ kills: 0, matches: 0, wins: 0, seedDays: 0, activeDays: 0 });

export const weekOf = (at: number): string => {
  const behind = (new Date(at).getUTCDay() + 6) % 7;
  return dayOf(at - behind * DAY_MS);
};

const blankDay = (key: string): DayState => ({ day: key, m: blankMetrics(), activity: 0, playPaid: 0, done: [], swaps: {}, rerolls: 0 });
const blankWeek = (key: string): WeekState => ({ week: key, m: blankWeekMetrics(), done: [], lastActive: '' });

export const blankAccount = (name: string, now: number): CoinAccount => ({
  name,
  balance: 0,
  earned: 0,
  spent: 0,
  day: blankDay(dayOf(now)),
  week: blankWeek(weekOf(now)),
  keys: [],
  log: [],
  owned: [],
  title: null,
  updatedAt: now,
});

const num = z.number().default(0);
const MetricsSchema = z.object({ kills: num, matches: num, wins: num, minutes: num, bestKills: num, breaks: num, seeded: num }).default(blankMetrics());
const WeekMetricsSchema = z.object({ kills: num, matches: num, wins: num, seedDays: num, activeDays: num }).default(blankWeekMetrics());
const WHY = ['seed', 'seed-time', 'play', 'match', 'win', 'mission', 'migrate', 'staff', 'buy', 'reroll'] as const;

const AccountSchema = z.object({
  name: z.string(),
  balance: z.number(),
  earned: z.number(),
  spent: z.number(),
  day: z.object({
    day: z.string(),
    m: MetricsSchema,
    activity: num,
    playPaid: num,
    done: z.array(z.string()).default([]),
    swaps: z.record(z.string(), z.string()).default({}),
    rerolls: num,
  }),
  week: z.object({ week: z.string(), m: WeekMetricsSchema, done: z.array(z.string()).default([]), lastActive: z.string().default('') }),
  keys: z.array(z.string()).default([]),
  log: z.array(z.object({ at: z.number(), delta: z.number(), why: z.enum(WHY), note: z.string().optional() })).default([]),
  owned: z.array(z.string()).default([]),
  title: z.string().nullable().default(null),
  updatedAt: z.number().default(0),
});

export const parseAccount = (raw: unknown): CoinAccount | null => {
  const parsed = AccountSchema.safeParse(raw);
  return parsed.success ? (parsed.data as CoinAccount) : null;
};

// The account with its day and week brought to `now`: a new day starts the day's counts again, a new week the week's.
export const rolled = (account: CoinAccount, now: number): CoinAccount => {
  const today = dayOf(now);
  const monday = weekOf(now);
  const sameDay = account.day.day === today;
  const sameWeek = account.week.week === monday;
  if (sameDay && sameWeek) return account;
  return {
    ...account,
    day: sameDay ? account.day : blankDay(today),
    week: sameWeek ? account.week : blankWeek(monday),
    // Keys of earlier days can't come round again.
    keys: sameDay ? account.keys : account.keys.filter((k) => !k.startsWith('play:') && !k.startsWith('seed')),
  };
};

const touch = (account: CoinAccount, now: number): CoinAccount => ({ ...account, updatedAt: now });

type Credit = { key: string; amount: number; why: Why; note?: string; capped?: boolean };

// Pays a credit once: a key already paid, or a day's cap already reached, pays nothing.
const credit = (account: CoinAccount, c: Credit, now: number, rule: Pick<CoinRule, 'activityCap'>): { account: CoinAccount; paid: number } => {
  if (account.keys.includes(c.key)) return { account, paid: 0 };
  const room = c.capped === true ? Math.max(0, rule.activityCap - account.day.activity) : Infinity;
  const paid = Math.min(Math.floor(c.amount), room);
  if (paid <= 0) return { account, paid: 0 };
  const tx: Tx = { at: now, delta: paid, why: c.why, ...(c.note === undefined ? {} : { note: c.note }) };
  return {
    paid,
    account: touch(
      {
        ...account,
        balance: account.balance + paid,
        earned: account.earned + paid,
        day: c.capped === true ? { ...account.day, activity: account.day.activity + paid } : account.day,
        keys: [...account.keys, c.key].slice(-KEYS_KEPT),
        log: [...account.log, tx].slice(-LOG_KEPT),
      },
      now,
    ),
  };
};

const remember = (account: CoinAccount, key: string): CoinAccount =>
  account.keys.includes(key) ? account : { ...account, keys: [...account.keys, key].slice(-KEYS_KEPT) };

// ---- Missions: what a player has done, and when it pays ----

// The day's three missions for this account: the day's own, with any the player swapped.
export const dayMissions = (account: CoinAccount, rule: Pick<CoinRule, 'streaks'>): Mission[] =>
  missionsFor('day', account.day.day, rule).map((m, slot) => missionById(account.day.swaps[String(slot)] ?? '') ?? m);

export const weekMissions = (account: CoinAccount, rule: Pick<CoinRule, 'streaks'>): Mission[] => missionsFor('week', account.week.week, rule);

const valueOf = (account: CoinAccount, m: Mission): number => {
  if (m.scope === 'day') return m.metric === 'seedDays' || m.metric === 'activeDays' ? 0 : account.day.m[m.metric as keyof Metrics];
  return m.metric === 'bestKills' || m.metric === 'breaks' || m.metric === 'minutes' || m.metric === 'seeded'
    ? 0
    : account.week.m[m.metric as keyof WeekMetrics];
};

export type Completed = { mission: Mission; paid: number };

// Pays the missions that are done and not paid yet.
const settle = (account: CoinAccount, now: number, rule: CoinRule): { account: CoinAccount; completed: Completed[] } => {
  let next = account;
  const completed: Completed[] = [];
  for (const m of [...dayMissions(next, rule), ...weekMissions(next, rule)]) {
    const done = m.scope === 'day' ? next.day.done : next.week.done;
    if (done.includes(m.id) || valueOf(next, m) < m.target) continue;
    const period = m.scope === 'day' ? next.day.day : next.week.week;
    const result = credit(next, { key: `mission:${period}:${m.id}`, amount: m.reward, why: 'mission', note: m.text }, now, rule);
    next = m.scope === 'day' ? { ...result.account, day: { ...result.account.day, done: [...done, m.id] } } : { ...result.account, week: { ...result.account.week, done: [...done, m.id] } };
    completed.push({ mission: m, paid: result.paid });
  }
  return { account: next, completed };
};

export type Earned = { account: CoinAccount; paid: number; completed: Completed[] };

const withActiveDay = (account: CoinAccount, today: string): CoinAccount =>
  account.week.lastActive === today
    ? account
    : { ...account, week: { ...account.week, lastActive: today, m: { ...account.week.m, activeDays: account.week.m.activeDays + 1 } } };

const finish = (account: CoinAccount, paid: number, now: number, rule: CoinRule): Earned => {
  const settled = settle(account, now, rule);
  return { account: settled.account, paid: paid + settled.completed.reduce((sum, c) => sum + c.paid, 0), completed: settled.completed };
};

// A successful seed: the server went live with this player on for `minutes` minutes of its seeding, more than the least
// (`least`). Once a day.
export const onSeed = (account: CoinAccount, minutes: number, least: number, now: number, rule: CoinRule): Earned => {
  const a = rolled(account, now);
  const today = dayOf(now);
  if (a.keys.includes(`seed:${today}`)) return { account: a, paid: 0, completed: [] };
  let next = withActiveDay(a, today);
  next = { ...next, day: { ...next.day, m: { ...next.day.m, seeded: 1 } }, week: { ...next.week, m: { ...next.week.m, seedDays: next.week.m.seedDays + 1 } } };
  const base = credit(next, { key: `seed:${today}`, amount: rule.seed, why: 'seed' }, now, rule);
  const extra = rule.seedMinutesPer > 0 ? Math.min(rule.seedMinutesCap, Math.max(0, Math.floor((minutes - least) / rule.seedMinutesPer))) : 0;
  const bonus = credit(remember(base.account, `seed:${today}`), { key: `seed-time:${today}`, amount: extra, why: 'seed-time', capped: true }, now, rule);
  return finish(bonus.account, base.paid + bonus.paid, now, rule);
};

// `minutes` more with the server live.
export const onPlay = (account: CoinAccount, minutes: number, now: number, rule: CoinRule): Earned => {
  const a = rolled(account, now);
  const today = dayOf(now);
  let next = withActiveDay(a, today);
  const total = next.day.m.minutes + minutes;
  next = { ...next, day: { ...next.day, m: { ...next.day.m, minutes: total } } };
  const blocks = rule.playMinutesPer > 0 ? Math.floor(total / rule.playMinutesPer) : 0;
  const due = blocks - next.day.playPaid;
  if (due <= 0) return finish(next, 0, now, rule);
  const paid = credit(next, { key: `play:${today}:${blocks}`, amount: due, why: 'play', capped: true }, now, rule);
  return finish({ ...paid.account, day: { ...paid.account.day, playPaid: blocks } }, paid.paid, now, rule);
};

// A match that ended, with this player's kills and deaths in it, and whether their side won. `id` is when it began.
export const onMatch = (
  account: CoinAccount,
  match: { id: number; kills: number; deaths: number; won: boolean },
  now: number,
  rule: CoinRule,
): Earned => {
  const a = rolled(account, now);
  if (a.keys.includes(`match:${match.id}`)) return { account: a, paid: 0, completed: [] };
  if (match.kills + match.deaths < rule.playedLeast) return { account: a, paid: 0, completed: [] };
  const today = dayOf(now);
  let next = withActiveDay(a, today);
  const played = next.day.m.matches;
  next = {
    ...next,
    day: {
      ...next.day,
      m: {
        ...next.day.m,
        matches: played + 1,
        kills: next.day.m.kills + match.kills,
        bestKills: Math.max(next.day.m.bestKills, match.kills),
        wins: next.day.m.wins + (match.won ? 1 : 0),
      },
    },
    week: {
      ...next.week,
      m: { ...next.week.m, matches: next.week.m.matches + 1, kills: next.week.m.kills + match.kills, wins: next.week.m.wins + (match.won ? 1 : 0) },
    },
  };
  const paysMatch = played < rule.matchesPaid;
  const seen = credit(next, { key: `match:${match.id}`, amount: paysMatch ? rule.match : 0, why: 'match', capped: true }, now, rule);
  // Remembered even when nothing was paid, so the match is never counted twice.
  const after = remember(seen.account, `match:${match.id}`);
  const win =
    match.won && paysMatch
      ? credit(after, { key: `win:${match.id}`, amount: rule.win, why: 'win', capped: true }, now, rule)
      : { account: after, paid: 0 };
  return finish(win.account, seen.paid + win.paid, now, rule);
};

// A kill that ended another player's kill streak.
export const onBreak = (account: CoinAccount, eventId: string, now: number, rule: CoinRule): Earned => {
  const a = rolled(account, now);
  if (a.keys.includes(`break:${eventId}`)) return { account: a, paid: 0, completed: [] };
  const next = withActiveDay(a, dayOf(now));
  const marked = remember({ ...next, day: { ...next.day, m: { ...next.day.m, breaks: next.day.m.breaks + 1 } } }, `break:${eventId}`);
  return finish(marked, 0, now, rule);
};

// Swaps one of today's missions that isn't done for another of its tier, for a price. Not one already in play today.
export type RerollResult = { ok: true; account: CoinAccount; mission: Mission } | { ok: false; reason: string };

export const reroll = (account: CoinAccount, slot: number, now: number, rule: CoinRule): RerollResult => {
  const a = rolled(account, now);
  const current = dayMissions(a, rule)[slot];
  if (current === undefined) return { ok: false, reason: 'There is no such mission.' };
  if (a.day.done.includes(current.id)) return { ok: false, reason: 'That mission is done already.' };
  if (a.day.rerolls >= MISSION_REROLLS_PER_DAY) return { ok: false, reason: `You can swap ${MISSION_REROLLS_PER_DAY} missions a day.` };
  const inPlay = new Set([...dayMissions(a, rule).map((m) => m.id), ...a.day.done]);
  const options = poolOf('day', current.tier, rule).filter((m) => !inPlay.has(m.id));
  const pick = options[hash(`${a.day.day}:${slot}:${a.day.rerolls}`) % Math.max(1, options.length)];
  if (pick === undefined) return { ok: false, reason: 'There is no other mission to swap it for.' };
  if (a.balance < rule.rerollPrice) return { ok: false, reason: `Swapping costs ${rule.rerollPrice} INITcoins.` };
  const spent = debit(a, rule.rerollPrice, 'reroll', current.text, now);
  const next = { ...spent, day: { ...spent.day, swaps: { ...spent.day.swaps, [String(slot)]: pick.id }, rerolls: spent.day.rerolls + 1 } };
  return { ok: true, account: settle(next, now, rule).account, mission: pick };
};

// ---- Spending ----

const debit = (account: CoinAccount, amount: number, why: Why, note: string, now: number): CoinAccount =>
  touch(
    {
      ...account,
      balance: account.balance - amount,
      spent: account.spent + amount,
      log: [...account.log, { at: now, delta: -amount, why, note }].slice(-LOG_KEPT),
    },
    now,
  );

export type BuyCheck = { ok: true } | { ok: false; reason: string };

// Whether this player can buy this item now. `vipUntil` is when the whitelist slot the bot gave them ends, or null.
export const canBuy = (account: CoinAccount, item: Item, vipUntil: number | null, now: number, rule: CoinRule): BuyCheck => {
  if (item.kind === 'vip') {
    const ahead = Math.max(0, (vipUntil ?? now) - now) / DAY_MS;
    if (ahead + item.days > rule.vipAheadDays + 1e-9) {
      return { ok: false, reason: `You can hold at most ${rule.vipAheadDays} days of whitelist at once. Try again once some has run out.` };
    }
  }
  if (item.kind === 'title' && account.owned.includes(item.id)) return { ok: false, reason: 'You already own that title.' };
  if (account.balance < item.price && !(item.kind === 'role' && account.owned.includes(item.id))) {
    return { ok: false, reason: `That costs ${item.price} INITcoins and you have ${account.balance}.` };
  }
  return { ok: true };
};

// The account after paying for the item (a role they own again is free: it is given back).
export const buy = (account: CoinAccount, item: Item, now: number): CoinAccount => {
  const free = item.kind === 'role' && account.owned.includes(item.id);
  const paid = free ? account : debit(account, item.price, 'buy', item.name, now);
  const owned = item.kind === 'vip' || paid.owned.includes(item.id) ? paid.owned : [...paid.owned, item.id];
  return { ...paid, owned, title: item.kind === 'title' && paid.title === null ? item.id : paid.title };
};

export const setTitle = (account: CoinAccount, id: string | null): CoinAccount | null =>
  id === null ? { ...account, title: null } : account.owned.includes(id) && titleName(id) !== null ? { ...account, title: id } : null;

// Staff giving or taking coins. Taking never leaves less than 0.
export const adjust = (account: CoinAccount, delta: number, note: string, now: number): CoinAccount => {
  const change = Math.max(delta, -account.balance);
  if (change === 0) return account;
  return touch(
    {
      ...account,
      balance: account.balance + change,
      earned: account.earned + Math.max(0, change),
      spent: account.spent + Math.max(0, -change),
      log: [...account.log, { at: now, delta: change, why: 'staff' as const, note }].slice(-LOG_KEPT),
    },
    now,
  );
};

// What the bot gave seeders when INITcoins took over from automatic VIP: the seeds they had in `seedDays`, as if the coins
// had always been paid. Once.
export const migrationGrant = (account: CoinAccount, seedDays: number, now: number, rule: Pick<CoinRule, 'seed'>): CoinAccount =>
  seedDays <= 0 || account.keys.includes('migrate')
    ? account
    : touch(
        {
          ...account,
          balance: account.balance + seedDays * rule.seed,
          earned: account.earned + seedDays * rule.seed,
          keys: [...account.keys, 'migrate'].slice(-KEYS_KEPT),
          log: [...account.log, { at: now, delta: seedDays * rule.seed, why: 'migrate' as const, note: `${seedDays} seeds before INITcoins` }].slice(-LOG_KEPT),
        },
        now,
      );

// ---- What the website and Discord show ----

export type MissionView = { id: string; text: string; tier: Tier; reward: number; progress: number; target: number; done: boolean; scope: Scope; slot: number };

const missionView = (account: CoinAccount, m: Mission, slot: number): MissionView => ({
  id: m.id,
  text: m.text,
  tier: m.tier,
  reward: m.reward,
  progress: Math.min(m.target, valueOf(account, m)),
  target: m.target,
  done: (m.scope === 'day' ? account.day.done : account.week.done).includes(m.id),
  scope: m.scope,
  slot,
});

export type ShopView = { id: string; kind: Item['kind']; name: string; price: number; owned: boolean; afford: boolean; reason: string | null };

export type PlayerCoins = {
  balance: number;
  earned: number;
  spent: number;
  title: string | null;
  today: { earned: number; cap: number };
  daily: MissionView[];
  weekly: MissionView[];
  rerolls: { left: number; price: number };
  shop: ShopView[];
  log: Tx[];
  // When the whitelist the bot gave them ends, if they have it.
  vipUntil: number | null;
  // Whether they can spend at all: it needs a linked Steam account.
  linked: boolean;
};

export const playerCoins = (account: CoinAccount, vipUntil: number | null, linked: boolean, now: number, rule: CoinRule): PlayerCoins => {
  const a = rolled(account, now);
  return {
    balance: a.balance,
    earned: a.earned,
    spent: a.spent,
    title: titleName(a.title),
    today: { earned: a.day.activity, cap: rule.activityCap },
    daily: dayMissions(a, rule).map((m, slot) => missionView(a, m, slot)),
    weekly: weekMissions(a, rule).map((m, slot) => missionView(a, m, slot)),
    rerolls: { left: Math.max(0, MISSION_REROLLS_PER_DAY - a.day.rerolls), price: rule.rerollPrice },
    shop: catalogue(rule).map((item) => {
      const check = canBuy(a, item, vipUntil, now, rule);
      return {
        id: item.id,
        kind: item.kind,
        name: item.name,
        price: item.price,
        owned: item.kind !== 'vip' && a.owned.includes(item.id),
        afford: check.ok,
        reason: check.ok ? null : check.reason,
      };
    }),
    log: [...a.log].reverse().slice(0, 15),
    vipUntil,
    linked,
  };
};

export type LeaderRow = { steamId: string; name: string; earned: number; title: string | null };

// The players who have earned the most, ever. Not the balance, so spending coins costs nobody their place.
export const topEarners = (accounts: [string, CoinAccount][], count: number): LeaderRow[] =>
  accounts
    .filter(([, a]) => a.earned > 0)
    .sort(([, a], [, b]) => b.earned - a.earned || a.name.localeCompare(b.name))
    .slice(0, count)
    .map(([steamId, a]) => ({ steamId, name: a.name, earned: a.earned, title: titleName(a.title) }));

// What the website says about how coins work, from the settings.
type MissionLine = Pick<MissionView, 'id' | 'text' | 'tier' | 'reward'>;
export type CoinsInfo = {
  rates: { seed: number; seedMinutes: { per: number; cap: number }; playMinutes: number; match: number; win: number; matchesPaid: number; activityCap: number };
  prices: { vipDay: number; vipWeek: number; vipAheadDays: number; reroll: number };
  shop: { id: string; kind: Item['kind']; name: string; price: number }[];
  missions: { daily: MissionLine[]; weekly: MissionLine[] };
};

export const coinsInfo = (rule: CoinRule, now: number): CoinsInfo => ({
  rates: {
    seed: rule.seed,
    seedMinutes: { per: rule.seedMinutesPer, cap: rule.seedMinutesCap },
    playMinutes: rule.playMinutesPer,
    match: rule.match,
    win: rule.win,
    matchesPaid: rule.matchesPaid,
    activityCap: rule.activityCap,
  },
  prices: { vipDay: rule.vipDayPrice, vipWeek: rule.vipWeekPrice, vipAheadDays: rule.vipAheadDays, reroll: rule.rerollPrice },
  shop: catalogue(rule).map(({ id, kind, name, price }) => ({ id, kind, name, price })),
  missions: {
    daily: missionsFor('day', dayOf(now), rule).map((m) => ({ id: m.id, text: m.text, tier: m.tier, reward: m.reward })),
    weekly: missionsFor('week', weekOf(now), rule).map((m) => ({ id: m.id, text: m.text, tier: m.tier, reward: m.reward })),
  },
});

// What a signed-in player can do with their coins, and what they are told.
export type CoinAction = { action: 'buy'; item: string } | { action: 'reroll'; slot: number } | { action: 'title'; id: string | null };
export type CoinReply = { ok: true; message: string; coins: PlayerCoins } | { ok: false; problem: string };
export type CoinsAccountView = { enabled: boolean; linked: boolean; coins: PlayerCoins | null };
export type PublicCoins = {
  info: CoinsInfo;
  leaders: { id: string; name: string; earned: number; title: string | null }[];
  // How many players have coins, what they hold between them, and what has been earned in all.
  players: number;
  held: number;
  earned: number;
};

// ---- Messages ----

export const COIN_NAME = 'INITcoins';
export const coinsText = (n: number): string => `${n.toLocaleString('en-GB')} ${n === 1 ? 'INITcoin' : COIN_NAME}`;

// A private message in game: the game shows one line of up to 200 characters.
export const missionDoneText = (c: Completed, balance: number): string =>
  `Mission complete: ${c.mission.text}. +${c.paid} ${COIN_NAME}. You have ${balance.toLocaleString('en-GB')}.`;

export const seedPaidText = (paid: number, balance: number, siteHost: string | null): string =>
  `Thanks for seeding! +${paid} ${COIN_NAME}. You have ${balance.toLocaleString('en-GB')}.${siteHost === null ? '' : ` Spend them at ${siteHost}/coins`}`;
