import { describe, expect, it } from 'vitest';
import { initialState, isQuiet, step, withSeedCall, type AlertKind, type AlertRules, type MonitorState } from '../src/alerts.ts';

const MINUTE = 60_000;

const rules: AlertRules = { seeding: 1, live: 20, lowPop: 20, cooldownMs: 10 * MINUTE, graceMs: 0 };

// Feeds a sequence of player counts (one per minute) and returns the alerts that fired.
const run = (start: number, counts: number[], r: AlertRules = rules): (AlertKind | null)[] => {
  const alerts: (AlertKind | null)[] = [];
  counts.reduce<MonitorState>((state, players, i) => {
    const result = step(state, players, (i + 1) * MINUTE, r);
    alerts.push(result.alert);
    return result.state;
  }, initialState(start, r));
  return alerts;
};

describe('seeding alert', () => {
  it('fires when an empty server gets its first player', () => {
    expect(run(0, [1])).toEqual(['seeding']);
  });

  it('does not fire again while the server keeps filling', () => {
    expect(run(0, [1, 5, 12, 19])).toEqual(['seeding', null, null, null]);
  });

  it('respects a higher seeding threshold', () => {
    expect(run(0, [2, 4, 5], { ...rules, seeding: 5 })).toEqual([null, null, 'seeding']);
  });

  it('does not repeat when one player joins and leaves within the cooldown', () => {
    expect(run(0, [1, 0, 1])).toEqual(['seeding', null, null]);
  });

  it('fires again after the cooldown has passed', () => {
    expect(run(0, [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])).toEqual([
      'seeding', null, null, null, null, null, null, null, null, null, null, 'seeding',
    ]);
  });
});

describe('live alert', () => {
  it('fires when a seeding server reaches the live threshold', () => {
    expect(run(0, [1, 10, 20])).toEqual(['seeding', null, 'live']);
  });

  it('fires once, without a seeding alert, when an empty server jumps straight to live', () => {
    expect(run(0, [25, 30])).toEqual(['live', null]);
  });

  it('does not fire when the bot starts while the server is already live', () => {
    expect(run(40, [40, 45])).toEqual([null, null]);
  });
});

describe('low population alert', () => {
  it('fires when a live server drops below the threshold', () => {
    expect(run(0, [20, 19])).toEqual(['live', 'lowPop']);
  });

  it('fires when a live server empties out completely', () => {
    expect(run(30, [0])).toEqual(['lowPop']);
  });

  it('does not fire for a seeding server that never went live', () => {
    expect(run(0, [15, 10])).toEqual(['seeding', null]);
  });

  it('does not spam when the population flaps around the threshold', () => {
    expect(run(0, [20, 19, 20, 19, 20])).toEqual(['live', 'lowPop', null, null, null]);
  });

  it('fires live again after recovering once the cooldown has passed', () => {
    expect(run(0, [20, 19, 18, 17, 16, 15, 14, 13, 12, 12, 12, 20])).toEqual([
      'live', 'lowPop', null, null, null, null, null, null, null, null, null, 'live',
    ]);
  });

  it('stays quiet between a lower low-pop threshold and the live threshold', () => {
    expect(run(0, [40, 30, 20, 19], { ...rules, live: 40, lowPop: 20 })).toEqual([
      'live', null, null, 'lowPop',
    ]);
  });

  it('does not announce seeding after a drop from live with a higher seeding threshold', () => {
    expect(run(30, [4, 5, 8], { ...rules, seeding: 5 })).toEqual(['lowPop', null, null]);
  });

  it('re-arms seeding once the server has emptied', () => {
    expect(run(0, [5, 2, 5], { ...rules, seeding: 5, cooldownMs: 0 })).toEqual(['seeding', null, null]);
    expect(run(0, [5, 0, 5], { ...rules, seeding: 5, cooldownMs: 0 })).toEqual(['seeding', null, 'seeding']);
  });

  it('does not re-announce seeding after a drop from live', () => {
    expect(run(30, [10, 5])).toEqual(['lowPop', null]);
  });
});

describe('grace for drops', () => {
  const grace = { ...rules, graceMs: 5 * MINUTE };

  it('pings nobody when a live server drops for a couple of minutes, such as a crash or restart', () => {
    expect(run(60, [0, 0, 5, 30, 60], grace)).toEqual([null, null, null, null, null]);
  });

  it('sends the low-pop alert once the drop has lasted the grace time', () => {
    expect(run(60, [0, 0, 0, 0, 0, 0], grace)).toEqual([null, null, null, null, null, 'lowPop']);
    expect(run(60, [0, 10, 10, 10, 10, 10], grace)).toEqual([null, null, null, null, null, 'lowPop']);
  });

  it('does not treat a seeding server that empties for a moment as a new seed', () => {
    expect(run(0, [3, 0, 0, 4], { ...grace, cooldownMs: 0 })).toEqual(['seeding', null, null, null]);
    // Empty for the whole five minutes: it has emptied, so the next player starts a new seed.
    expect(run(0, [3, 0, 0, 0, 0, 0, 0, 4], { ...grace, cooldownMs: 0 })).toEqual([
      'seeding', null, null, null, null, null, null, 'seeding',
    ]);
  });

  it('starts the grace time again after the players come back', () => {
    expect(run(60, [0, 0, 60, 0, 0, 60, 0, 0], grace)).toEqual(Array(8).fill(null));
  });
});

describe('seeding call from staff', () => {
  const empty = initialState(0, rules);

  it('skips the automatic seeding alert when the first players join within its cooldown, so the role is not pinged twice', () => {
    const joined = step(withSeedCall(empty, 0), 1, 5 * MINUTE, rules);

    expect(joined).toMatchObject({ alert: null, state: { phase: 'seeding' } });
    // Skipped, not put off: the server is already seeding, as the call said it would be.
    expect(step(joined.state, 2, 10 * MINUTE, rules).alert).toBeNull();
  });

  it('holds back only for the cooldown: players who first join later still get the automatic alert', () => {
    expect(step(withSeedCall(empty, 0), 1, 10 * MINUTE, rules).alert).toBe('seeding');
  });

  it('keeps a later automatic alert', () => {
    const alerted = { ...empty, lastAlertAt: { seeding: 5 * MINUTE, live: MINUTE } };

    expect(withSeedCall(alerted, 2 * MINUTE)).toBe(alerted);
    expect(withSeedCall(alerted, 6 * MINUTE).lastAlertAt).toEqual({ seeding: 6 * MINUTE, live: MINUTE });
  });
});

describe('quiet hours', () => {
  const at = (hour: number, minute = 0): number => Date.UTC(2026, 9, 5, hour, minute);

  it('runs past midnight when it ends at a smaller hour', () => {
    const night = { start: 22, end: 8 };
    expect([21, 22, 23, 0, 7, 8, 12].map((hour) => isQuiet(at(hour, 30), night))).toEqual([
      false,
      true,
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  it('runs within the day when it starts at the smaller hour', () => {
    const early = { start: 1, end: 6 };
    expect([0, 1, 5, 6].map((hour) => isQuiet(at(hour, 59), early))).toEqual([false, true, true, false]);
  });

  it('is never quiet when there are no quiet hours', () => {
    expect(isQuiet(at(3), null)).toBe(false);
  });
});
