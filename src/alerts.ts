export type Phase = 'empty' | 'seeding' | 'live';
// `back`: the server is back after a crash (see outages.ts), in place of the low-pop and seeding alerts.
export type AlertKind = 'seeding' | 'live' | 'lowPop' | 'back';

export type AlertRules = {
  seeding: number;
  live: number;
  lowPop: number;
  cooldownMs: number;
  // How long a drop must last before it counts. A server that crashes or restarts and fills again within this time
  // keeps its phase, so a blip pings nobody.
  graceMs: number;
  // How long an empty server must keep its first players before the seeding alert goes out, so someone looking in for a
  // minute pings nobody. Seeding itself, and its credit, start at once.
  seedHoldMs: number;
};

export type MonitorState = {
  phase: Phase;
  lastAlertAt: Partial<Record<AlertKind, number>>;
  // When the player count first fell below what keeps the current phase, while that drop is still within the grace time.
  lowSince?: number;
  // When the server started seeding, while its alert waits out seedHoldMs, and whether it started after a crash, so
  // the alert is the back alert even when the crash is over before the hold.
  seedingSince?: number;
  afterCrash?: boolean;
};

export type StepResult = {
  state: MonitorState;
  alert: AlertKind | null;
};

// The night, in a time zone's own hours, so it follows the clocks changing (21 to 6 in Europe/London is 9pm to 6am in
// both summer and winter). From `start` up to `end`, running past midnight when `end` is the smaller.
export type QuietHours = { start: number; end: number; timeZone: string };

// Whether `now` is at night. Pings at night would only wake people up: see the poller.
export const isQuiet = (now: number, quiet: QuietHours | null): boolean => {
  if (quiet === null) return false;
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: quiet.timeZone, hour: 'numeric', hourCycle: 'h23' })
      .formatToParts(now)
      .find((part) => part.type === 'hour')?.value,
  );
  return quiet.start < quiet.end ? hour >= quiet.start && hour < quiet.end : hour >= quiet.start || hour < quiet.end;
};

export const phaseFor = (players: number, rules: AlertRules): Phase => {
  if (players >= rules.live) return 'live';
  if (players >= rules.seeding) return 'seeding';
  return 'empty';
};

const transitionAlert = (from: Phase, to: Phase): AlertKind | null => {
  if (from === 'live') return to === 'live' ? null : 'lowPop';
  if (to === 'live') return 'live';
  if (from === 'empty' && to === 'seeding') return 'seeding';
  return null;
};

// Once live, the server stays live until it drops below lowPop, which may be lower than live.
// Seeding is only re-armed by an empty server, so dropping from live to a few players never announces seeding.
const nextPhase = (from: Phase, players: number, rules: AlertRules): Phase => {
  if (from === 'live' && players >= rules.lowPop) return 'live';
  if (players >= rules.live) return 'live';
  if (players === 0) return 'empty';
  if (from === 'empty' && players < rules.seeding) return 'empty';
  return 'seeding';
};

// The first reading only establishes where the server is; it never alerts.
export const initialState = (players: number, rules: AlertRules): MonitorState => ({
  phase: phaseFor(players, rules),
  lastAlertAt: {},
});

const RANK: Record<Phase, number> = { empty: 0, seeding: 1, live: 2 };

// `crashed`: the server crashed and is not back yet (see outages.ts). Then a drop from live pings nobody, and seeding
// that starts after it, from live or from empty, gets the back alert in place of the seeding alert, once it has kept
// its players for seedHoldMs. The two share a cooldown, so either covers the other, and a /seednow call covers both.
export const step = (state: MonitorState, players: number, now: number, rules: AlertRules, crashed = false): StepResult => {
  const phase = nextPhase(state.phase, players, rules);
  // A drop waits out the grace time first: if the players come back in time, it never happened.
  if (RANK[phase] < RANK[state.phase]) {
    const lowSince = state.lowSince ?? now;
    if (now - lowSince < rules.graceMs) return { state: { ...state, lowSince }, alert: null };
  }
  const { lowSince: _over, seedingSince: waiting, afterCrash: wasCrash, ...settled } = state;
  const startsSeed = phase === 'seeding' && (state.phase === 'empty' || (state.phase === 'live' && crashed));
  const seedingSince = phase !== 'seeding' ? undefined : startsSeed ? now : waiting;
  const afterCrash = seedingSince !== undefined && (startsSeed ? crashed : wasCrash === true);
  const transition = transitionAlert(state.phase, phase);
  // The seeding alert waits for the hold, below. After a crash the low-pop alert is not sent: the back alert says it.
  const straightAway = transition === 'live' || (transition === 'lowPop' && !crashed) ? transition : null;
  const held = seedingSince !== undefined && now - seedingSince >= rules.seedHoldMs;
  const isHeld = (kind: AlertKind | null): boolean => kind === 'seeding' || kind === 'back';
  const candidate: AlertKind | null = straightAway ?? (held ? (afterCrash ? 'back' : 'seeding') : null);
  // A held alert's cooldown runs from when the seed started, so a /seednow call still covers players who join within
  // its cooldown however long the hold.
  const from = isHeld(candidate) ? (seedingSince ?? now) : now;
  const sent = (candidate === null ? [] : isHeld(candidate) ? (['seeding', 'back'] as const) : [candidate]).flatMap(
    (kind) => state.lastAlertAt[kind] ?? [],
  );
  const lastSent = sent.length === 0 ? undefined : Math.max(...sent);
  const coolingDown = lastSent !== undefined && from - lastSent < rules.cooldownMs;
  // Sent or skipped, a held alert is done with.
  const pending = held || seedingSince === undefined ? {} : { seedingSince, ...(afterCrash ? { afterCrash } : {}) };

  if (candidate === null || coolingDown) {
    return { state: { ...settled, phase, ...pending }, alert: null };
  }
  return {
    state: { phase, lastAlertAt: { ...settled.lastAlertAt, [candidate]: now } },
    alert: candidate,
  };
};

// A seeding call staff sent with /seednow counts as the seeding alert, so when the first players join within its
// cooldown, the automatic alert (or the back alert after a crash) is skipped instead of pinging the role a second time.
export const withSeedCall = (state: MonitorState, calledAt: number): MonitorState => {
  const sent = state.lastAlertAt.seeding;
  if (sent !== undefined && sent >= calledAt) return state;
  return { ...state, lastAlertAt: { ...state.lastAlertAt, seeding: calledAt } };
};
