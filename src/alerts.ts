export type Phase = 'empty' | 'seeding' | 'live';
export type AlertKind = 'seeding' | 'live' | 'lowPop';

export type AlertRules = {
  seeding: number;
  live: number;
  lowPop: number;
  cooldownMs: number;
};

export type MonitorState = {
  phase: Phase;
  lastAlertAt: Partial<Record<AlertKind, number>>;
};

export type StepResult = {
  state: MonitorState;
  alert: AlertKind | null;
};

const phaseFor = (players: number, rules: AlertRules): Phase => {
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
const nextPhase = (from: Phase, players: number, rules: AlertRules): Phase =>
  from === 'live' && players >= rules.lowPop ? 'live' : phaseFor(players, rules);

// The first reading only establishes where the server is; it never alerts.
export const initialState = (players: number, rules: AlertRules): MonitorState => ({
  phase: phaseFor(players, rules),
  lastAlertAt: {},
});

export const step = (state: MonitorState, players: number, now: number, rules: AlertRules): StepResult => {
  const phase = nextPhase(state.phase, players, rules);
  const candidate = transitionAlert(state.phase, phase);
  const lastSent = candidate === null ? undefined : state.lastAlertAt[candidate];
  const coolingDown = lastSent !== undefined && now - lastSent < rules.cooldownMs;

  if (candidate === null || coolingDown) {
    return { state: { ...state, phase }, alert: null };
  }
  return {
    state: { phase, lastAlertAt: { ...state.lastAlertAt, [candidate]: now } },
    alert: candidate,
  };
};
