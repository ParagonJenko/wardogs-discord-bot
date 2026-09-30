import { describe, expect, it } from 'vitest';
import { initialState, step, type AlertKind, type AlertRules, type MonitorState } from '../src/alerts.ts';

const MINUTE = 60_000;

const rules: AlertRules = { seeding: 1, live: 20, lowPop: 20, cooldownMs: 10 * MINUTE };

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
