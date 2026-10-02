export type Phase = 'empty' | 'seeding' | 'live';
export type AlertKind = 'seeding' | 'live' | 'lowPop';

export type AlertRules = {
  seeding: number;
  live: number;
  lowPop: number;
  cooldownMs: number;
  // How long a drop must last before it counts. A server that crashes or restarts and fills again within this time
  // keeps its phase, so a blip pings nobody.
  graceMs: number;
};

export type MonitorState = {
  phase: Phase;
  lastAlertAt: Partial<Record<AlertKind, number>>;
  // When the player count first fell below what keeps the current phase, while that drop is still within the grace time.
  lowSince?: number;
};

export type StepResult = {
  state: MonitorState;
  alert: AlertKind | null;
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

export const step = (state: MonitorState, players: number, now: number, rules: AlertRules): StepResult => {
  const phase = nextPhase(state.phase, players, rules);
  // A drop waits out the grace time first: if the players come back in time, it never happened.
  if (RANK[phase] < RANK[state.phase]) {
    const lowSince = state.lowSince ?? now;
    if (now - lowSince < rules.graceMs) return { state: { ...state, lowSince }, alert: null };
  }
  const { lowSince: _over, ...settled } = state;
  const candidate = transitionAlert(state.phase, phase);
  const lastSent = candidate === null ? undefined : state.lastAlertAt[candidate];
  const coolingDown = lastSent !== undefined && now - lastSent < rules.cooldownMs;

  if (candidate === null || coolingDown) {
    return { state: { ...settled, phase }, alert: null };
  }
  return {
    state: { phase, lastAlertAt: { ...settled.lastAlertAt, [candidate]: now } },
    alert: candidate,
  };
};

// A seeding call staff sent with /seednow counts as the seeding alert, so when the first players join within its
// cooldown, the automatic alert is skipped (as after any alert) instead of pinging the role a second time.
export const withSeedCall = (state: MonitorState, calledAt: number): MonitorState => {
  const sent = state.lastAlertAt.seeding;
  if (sent !== undefined && sent >= calledAt) return state;
  return { ...state, lastAlertAt: { ...state.lastAlertAt, seeding: calledAt } };
};
