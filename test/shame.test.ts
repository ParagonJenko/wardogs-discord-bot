import { describe, expect, it } from 'vitest';
import { TEAM_KILL_WARNING } from '../src/griefing.ts';
import type { ModEntry } from '../src/moderation.ts';
import { buildShame, isTeamKillWarning, REMOVED_SHOWN, TEAM_KILLERS_SHOWN, TEAM_KILLER_MIN } from '../src/shame.ts';

const NOW = Date.UTC(2026, 9, 25, 12);
const HOUR = 60 * 60_000;

const ASH = '76561198000000001';
const BO = '76561198000000002';
const CY = '76561198000000003';
const DI = '76561198000000004';

const tk = (hoursAgo: number): ModEntry => ({ action: 'warn', at: NOW - hoursAgo * HOUR, by: 'bot', reason: TEAM_KILL_WARNING, detail: 'Team kill' });
const entry = (action: ModEntry['action'], hoursAgo: number, extra: Partial<ModEntry> = {}): ModEntry => ({ action, at: NOW - hoursAgo * HOUR, by: '1', ...extra });

const names: Record<string, string> = { [ASH]: 'Ash', [BO]: 'Bo', [CY]: 'Cy', [DI]: 'Di' };
const build = (logs: Record<string, ModEntry[]>, hidden: string[] = []) =>
  buildShame({
    now: NOW,
    logs: new Map(Object.entries(logs)),
    hidden: new Set(hidden),
    nameOf: (steamId) => names[steamId],
    idOf: (steamId) => `id-${names[steamId]}`,
  });

describe('isTeamKillWarning', () => {
  it("counts the bot's warning and staff warnings about team killing", () => {
    expect(isTeamKillWarning(tk(1))).toBe(true);
    expect(isTeamKillWarning(entry('warn', 1, { reason: 'Teamkilling in the base' }))).toBe(true);
    expect(isTeamKillWarning(entry('warn', 1, { reason: 'Team-killed twice' }))).toBe(true);
    expect(isTeamKillWarning(entry('warn', 1, { reason: 'TKs at spawn' }))).toBe(true);
  });

  it('leaves out other warnings and other actions', () => {
    expect(isTeamKillWarning(entry('warn', 1, { reason: 'Language' }))).toBe(false);
    expect(isTeamKillWarning(entry('warn', 1))).toBe(false);
    expect(isTeamKillWarning(entry('kick', 1, { reason: 'Team killing' }))).toBe(false);
  });
});

describe('buildShame', () => {
  it('ranks team killers by warnings and skips those under the minimum', () => {
    const shame = build({
      [ASH]: [tk(9), tk(8), tk(7)],
      [BO]: [tk(6), tk(5), tk(4), tk(3), tk(2)],
      [CY]: Array.from({ length: TEAM_KILLER_MIN - 1 }, (_, i) => tk(i + 1)),
    });

    expect(shame.teamKillers).toEqual([
      { id: 'id-Bo', name: 'Bo', warnings: 5, lastAt: NOW - 2 * HOUR },
      { id: 'id-Ash', name: 'Ash', warnings: 3, lastAt: NOW - 7 * HOUR },
    ]);
    expect(shame.totals).toEqual({ teamKillWarnings: 10, warned: 3, kicked: 0, banned: 0 });
  });

  it('is only as long as the list is shown', () => {
    const logs = Object.fromEntries(Array.from({ length: TEAM_KILLERS_SHOWN + 5 }, (_, i) => [`7656119800000${i + 100}`, [tk(3), tk(2), tk(1)]]));
    const shame = buildShame({ now: NOW, logs: new Map(Object.entries(logs)), hidden: new Set(), nameOf: (steamId) => `P${steamId.slice(-3)}`, idOf: () => undefined });
    expect(shame.teamKillers).toHaveLength(TEAM_KILLERS_SHOWN);
  });

  it('says what came of each kick and ban, newest first', () => {
    const shame = build({
      [ASH]: [tk(50), entry('kick', 40), entry('ban', 30, { reason: 'Racism', byName: 'Sarge' })],
      [BO]: [entry('ban', 20)],
      [CY]: [entry('kick', 10), entry('kick', 5)],
      [DI]: [entry('ban', 60), entry('kick', 55)],
    });

    expect(shame.removed.map((r) => [r.name, r.outcome, r.kicks, r.bans])).toEqual([
      ['Cy', 'kicked', 2, 0],
      ['Bo', 'banned', 0, 1],
      ['Ash', 'kicked-then-banned', 1, 1],
      // The kick came after the ban, so it did not lead to it.
      ['Di', 'banned', 1, 1],
    ]);
    expect(shame.removed.find((r) => r.name === 'Ash')?.teamKillWarnings).toBe(1);
    expect(shame.totals).toMatchObject({ kicked: 3, banned: 3 });
  });

  it('notes a ban that was lifted afterwards', () => {
    const shame = build({
      [ASH]: [entry('ban', 30), entry('unban', 20)],
      [BO]: [entry('ban', 30), entry('unban', 20), entry('ban', 10)],
    });

    expect(shame.removed.map((r) => [r.name, r.unbanned])).toEqual([
      ['Bo', false],
      ['Ash', true],
    ]);
  });

  it('never gives reasons, staff names or Steam IDs', () => {
    const shame = build({ [ASH]: [entry('kick', 5, { reason: 'Racism', byName: 'Sarge' }), entry('ban', 4, { reason: 'Racism', byName: 'Sarge' })] });
    const text = JSON.stringify(shame);

    expect(text).not.toContain('Racism');
    expect(text).not.toContain('Sarge');
    expect(text).not.toContain(ASH);
  });

  it('leaves out private profiles, and anyone with no name', () => {
    const logs = { [ASH]: [tk(3), tk(2), tk(1), entry('ban', 1)], [BO]: [entry('kick', 1)], [CY]: [entry('kick', 1)], '76561198000000009': [entry('kick', 1)] };
    const shame = build(logs, [ASH, BO]);

    expect(shame.teamKillers).toEqual([]);
    expect(shame.removed.map((r) => r.name)).toEqual(['Cy']);
    expect(shame.totals).toEqual({ teamKillWarnings: 0, warned: 0, kicked: 1, banned: 0 });
  });

  it('falls back on the name in the log, and has no id for a player with no page', () => {
    const shame = buildShame({
      now: NOW,
      logs: new Map([[ASH, [entry('kick', 1, { name: 'Ashley' })]]]),
      hidden: new Set(),
      nameOf: () => undefined,
      idOf: () => undefined,
    });

    expect(shame.removed).toEqual([expect.objectContaining({ name: 'Ashley' })]);
    expect(shame.removed[0]).not.toHaveProperty('id');
  });

  it('keeps the removed list to its length', () => {
    const logs = new Map<string, ModEntry[]>(Array.from({ length: REMOVED_SHOWN + 3 }, (_, i) => [`s${i}`, [entry('kick', i + 1)]]));
    const shame = buildShame({ now: NOW, logs, hidden: new Set(), nameOf: (steamId) => steamId, idOf: () => undefined });
    expect(shame.removed).toHaveLength(REMOVED_SHOWN);
    expect(shame.removed[0]?.name).toBe('s0');
  });
});
