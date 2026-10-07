import { describe, expect, it } from 'vitest';
import { MAX_LENGTH } from '../src/messages.ts';
import {
  buildRulesPage,
  callDetail,
  editRules,
  judgeKills,
  kickText,
  MAX_RULES,
  MAX_WARNINGS,
  messageLimits,
  parseRuleBreaks,
  parseRules,
  PRESET_RULES,
  readRulesAction,
  SAME_OFFENCE_MS,
  warningText,
  type RuleBreaks,
  type RuleDraft,
  type WeaponRule,
} from '../src/weaponrules.ts';
import { namedWeapons, weaponName, type FeedKill } from '../src/weapons.ts';

const ASH = '76561198000000001';
const BO = '76561198000000002';
const NAMES: Record<string, string> = { [ASH]: 'Ash', [BO]: 'Bo' };
const AT = Date.UTC(2026, 9, 7, 20);
const HUMVEE_M249 = 'Id.Vehicle.WeaponExtension.WHL_05.RingTurret';
const HUMVEE_MINIGUN = 'Id.Vehicle.WeaponExtension.WHL_05.RingMinigun';
const KODIAK_M249 = 'Id.Vehicle.WeaponExtension.WHL_02.SUV.RingTurret';
const MGL = 'Id.Item.MMGL';
const context = { rulesNote: 'Rules: our Discord at gaminginit.com', feed: true };
const who = { by: '42', byName: 'Sarge', now: AT, newId: () => 'new-1' };

let next = 0;
const kill = (killer: string, cause: string): FeedKill => ({
  eventId: `e${next++}`,
  time: 100,
  matchId: 'm1',
  map: 'Kavkazi',
  victimSteamId: '76561198000000099',
  victimName: 'Target',
  killerSteamId: killer,
  killerName: NAMES[killer] ?? '',
  cause,
  distance: 40,
  headshot: false,
  tags: [],
});

const preset = (id: string, change: Partial<WeaponRule> = {}): WeaponRule => ({ ...PRESET_RULES.find((r) => r.id === id)!, ...change });
const today = (): RuleBreaks => parseRuleBreaks(undefined, AT);

const draft = (change: Partial<RuleDraft> = {}): { action: 'save' } & RuleDraft => ({
  action: 'save',
  id: null,
  name: 'Ural gunner',
  weapons: ['Id.Vehicle.WeaponExtension.WHL_07.MachineGun'],
  mode: 'warn',
  warnings: 1,
  warning: 'No kills from the Ural gun.',
  kick: '',
  ...change,
});

describe('PRESET_RULES', () => {
  it('has the Humvee gunner, Kodiak gunner and MGL, all off, with names the bot knows for every weapon', () => {
    expect(PRESET_RULES.map((r) => [r.name, r.mode])).toEqual([
      ['Humvee gunner', 'off'],
      ['Kodiak gunner', 'off'],
      ['MGL', 'off'],
    ]);
    expect(PRESET_RULES.flatMap((r) => r.weapons.map(weaponName))).toEqual(['Humvee M249', 'Humvee minigun', 'Kodiak M249', 'MGL-40']);
  });

  it('has messages that fit the game', () => {
    const limits = messageLimits(context);
    for (const rule of PRESET_RULES) {
      expect(rule.warning.length).toBeLessThanOrEqual(limits.warning);
      expect(rule.kick.length).toBeLessThanOrEqual(limits.kick);
    }
  });
});

describe('parseRules', () => {
  it('is the presets before staff save anything', () => {
    expect(parseRules(undefined)).toEqual(PRESET_RULES);
  });

  it("keeps staff's rules, none at all too, and drops one it can't read", () => {
    expect(parseRules([])).toEqual([]);
    expect(parseRules([preset('mgl', { mode: 'kick' }), { id: 'broken' }])).toEqual([preset('mgl', { mode: 'kick' })]);
  });
});

describe('messages', () => {
  it('says which warning it is with warn-kick, and when it is the last', () => {
    const rule = preset('mgl', { mode: 'warn-kick', warnings: 2 });
    expect(warningText(rule, 1, context)).toBe(`Warning 1 of 2: ${rule.warning} | ${context.rulesNote}`);
    expect(warningText(rule, 2, context)).toBe(`Last warning: ${rule.warning} | ${context.rulesNote}`);
    expect(warningText(preset('mgl', { mode: 'warn' }), 3, context)).toBe(`Warning: ${rule.warning} | ${context.rulesNote}`);
    expect(kickText(rule, context)).toBe(`${rule.kick} | ${context.rulesNote}`);
  });

  it('keeps every message at its longest within the game line', () => {
    const limits = messageLimits(context);
    const rule = preset('mgl', { mode: 'warn-kick', warnings: MAX_WARNINGS, warning: 'x'.repeat(limits.warning), kick: 'y'.repeat(limits.kick) });
    for (let offence = 1; offence <= MAX_WARNINGS; offence++) expect(warningText(rule, offence, context).length).toBeLessThanOrEqual(MAX_LENGTH);
    expect(kickText(rule, context)).toHaveLength(MAX_LENGTH);
  });
});

describe('editRules', () => {
  it('adds a rule with a new id and who made it', () => {
    const result = editRules(PRESET_RULES, draft(), context, who);
    expect('rules' in result && result.rules.at(-1)).toEqual({
      id: 'new-1',
      name: 'Ural gunner',
      weapons: ['Id.Vehicle.WeaponExtension.WHL_07.MachineGun'],
      mode: 'warn',
      warnings: 1,
      warning: 'No kills from the Ural gun.',
      kick: '',
      changed: { at: AT, by: '42', byName: 'Sarge' },
    });
  });

  it('changes a rule in place, tidying its messages and spelling its tags as the bot does', () => {
    const result = editRules(
      PRESET_RULES,
      draft({ id: 'humvee-gunner', name: ' Humvee  gunner ', weapons: [HUMVEE_M249.toUpperCase()], mode: 'kick', kick: ' Humvee\n gun ' }),
      context,
      who,
    );
    if (!('rules' in result)) throw new Error(result.problem);
    expect(result.rules.map((r) => r.id)).toEqual(['humvee-gunner', 'kodiak-gunner', 'mgl']);
    expect(result.rules[0]).toMatchObject({ name: 'Humvee gunner', weapons: [HUMVEE_M249], mode: 'kick', kick: 'Humvee gun' });
  });

  it('takes a rule out', () => {
    const result = editRules(PRESET_RULES, { action: 'remove', id: 'mgl' }, context, who);
    expect('rules' in result && result.rules.map((r) => r.id)).toEqual(['humvee-gunner', 'kodiak-gunner']);
    expect(editRules(PRESET_RULES, { action: 'remove', id: 'gone' }, context, who)).toHaveProperty('problem');
  });

  it.each([
    ['no name', draft({ name: '  ' }), 'Give the rule a name'],
    ['a name taken', draft({ name: 'mgl' }), 'There is a rule called "mgl" already'],
    ['no weapons', draft({ weapons: [] }), 'Pick at least one weapon'],
    ['a weapon the bot has no name for', draft({ weapons: ['Id.Item.WEPN_099'] }), "doesn't know one of those weapons"],
    ['a weapon in another rule', draft({ weapons: [MGL] }), 'MGL-40 is in the "MGL" rule already'],
    ['no warning to send', draft({ warning: '' }), 'Write the warning'],
    ['no kick reason', draft({ mode: 'warn-kick', kick: ' ' }), 'Write the reason'],
    ['too many warnings', draft({ mode: 'warn-kick', kick: 'Kicked', warnings: MAX_WARNINGS + 1 }), 'Warnings before the kick'],
    ['a warning too long', draft({ warning: 'x'.repeat(messageLimits(context).warning + 3) }), 'The warning is 3 characters too long'],
    ['a rule that is gone', draft({ id: 'gone' }), 'That rule is gone'],
  ])('refuses %s', (_case, action, problem) => {
    const result = editRules(PRESET_RULES, action, context, who);
    expect('problem' in result && result.problem).toContain(problem);
  });

  it('lets a rule keep its own weapons, and leaves a message blank when its mode does not use it', () => {
    const result = editRules(PRESET_RULES, draft({ id: 'mgl', name: 'MGL', weapons: [MGL], mode: 'kick', warning: '', kick: 'No MGL' }), context, who);
    expect('rules' in result).toBe(true);
  });

  it(`stops at ${MAX_RULES} rules`, () => {
    const many = Array.from({ length: MAX_RULES }, (_, i) => preset('mgl', { id: `r${i}`, name: `Rule ${i}`, weapons: [`Id.Item.Rule${i}`] }));
    expect(editRules(many, draft(), context, who)).toEqual({ problem: `There can be at most ${MAX_RULES} rules.` });
  });
});

describe('judgeKills', () => {
  const rules = [preset('humvee-gunner', { mode: 'warn' }), preset('kodiak-gunner', { mode: 'kick' }), preset('mgl')];

  it('does nothing for kills with weapons no rule that is on covers', () => {
    expect(judgeKills(today(), rules, [kill(ASH, 'Id.Item.M4'), kill(ASH, MGL)], AT)).toBeNull();
  });

  it('warns once for a burst of kills, and counts it as one offence', () => {
    const judged = judgeKills(today(), rules, [kill(ASH, HUMVEE_M249), kill(ASH, HUMVEE_MINIGUN)], AT);
    expect(judged?.calls).toEqual([
      { steamId: ASH, name: 'Ash', rule: rules[0], act: 'warn', offence: 1, kills: 2, weapon: 'Humvee minigun' },
    ]);
    expect(judged?.breaks).toEqual({
      day: '2026-10-07',
      players: { [ASH]: { 'humvee-gunner': { offences: 1, at: AT } } },
      done: { 'humvee-gunner': { warned: 1, kicked: 0 } },
    });
  });

  it(`takes kills within ${SAME_OFFENCE_MS / 1000} seconds of acting as the same offence`, () => {
    const first = judgeKills(today(), rules, [kill(ASH, HUMVEE_M249)], AT)!;
    expect(judgeKills(first.breaks, rules, [kill(ASH, HUMVEE_M249)], AT + SAME_OFFENCE_MS - 1)).toBeNull();
    expect(judgeKills(first.breaks, rules, [kill(ASH, HUMVEE_M249)], AT + SAME_OFFENCE_MS)?.calls[0]).toMatchObject({ act: 'warn', offence: 2 });
  });

  it('warns, and then kicks once the player has had their warnings', () => {
    const strict = [preset('mgl', { mode: 'warn-kick', warnings: 2 })];
    let breaks = today();
    const acts: string[] = [];
    for (let i = 0; i < 4; i++) {
      const judged = judgeKills(breaks, strict, [kill(ASH, MGL)], AT + i * SAME_OFFENCE_MS)!;
      breaks = judged.breaks;
      acts.push(`${judged.calls[0]?.act} ${judged.calls[0]?.offence}`);
    }
    expect(acts).toEqual(['warn 1', 'warn 2', 'kick 3', 'kick 4']);
    expect(breaks.done).toEqual({ mgl: { warned: 2, kicked: 2 } });
  });

  it('kicks first, and gives a player being kicked no warning', () => {
    const judged = judgeKills(today(), rules, [kill(ASH, HUMVEE_M249), kill(BO, HUMVEE_M249), kill(ASH, KODIAK_M249)], AT);
    expect(judged?.calls.map((c) => [c.name, c.act, c.rule.id])).toEqual([
      ['Ash', 'kick', 'kodiak-gunner'],
      ['Bo', 'warn', 'humvee-gunner'],
    ]);
    // Ash's Humvee kill still counts.
    expect(judged?.breaks.players[ASH]).toEqual({ 'humvee-gunner': { offences: 1, at: AT }, 'kodiak-gunner': { offences: 1, at: AT } });
  });

  it('starts each UTC day from nothing', () => {
    const yesterday = { day: '2026-10-06', players: { [ASH]: { mgl: { offences: 3, at: AT - 86_400_000 } } }, done: { mgl: { warned: 3, kicked: 0 } } };
    expect(parseRuleBreaks(yesterday, AT)).toEqual({ day: '2026-10-07', players: {}, done: {} });
    expect(parseRuleBreaks({ ...yesterday, day: '2026-10-07' }, AT)).toEqual({ ...yesterday, day: '2026-10-07' });
  });
});

describe('callDetail', () => {
  it('says the rule, the kills and what the bot did', () => {
    const judged = judgeKills(today(), [preset('mgl', { mode: 'warn-kick', warnings: 2 })], [kill(ASH, MGL), kill(ASH, MGL)], AT)!;
    expect(callDetail(judged.calls[0]!)).toBe('Weapon rule "MGL": 2 kills with the MGL-40, warning 1 of 2');
    const kicked = { ...judged.calls[0]!, act: 'kick' as const, offence: 3, kills: 1 };
    expect(callDetail(kicked)).toBe('Weapon rule "MGL": a kill with the MGL-40, kicked after 2 warnings');
  });
});

describe('buildRulesPage', () => {
  it("has every weapon the bot names, each rule with today's warnings and kicks, and what goes after the messages", () => {
    const judged = judgeKills(today(), [preset('mgl', { mode: 'kick' })], [kill(ASH, MGL)], AT)!;
    const page = buildRulesPage(PRESET_RULES, judged.breaks, context);
    expect(page.weapons).toEqual(namedWeapons());
    expect(page.weapons.find((w) => w.name === 'M113 APC')?.tags).toHaveLength(3);
    expect(page.rules.map((r) => [r.id, r.today])).toEqual([
      ['humvee-gunner', { warned: 0, kicked: 0 }],
      ['kodiak-gunner', { warned: 0, kicked: 0 }],
      ['mgl', { warned: 0, kicked: 1 }],
    ]);
    expect(page.after).toBe(' | Rules: our Discord at gaminginit.com');
    expect(page.limits).toEqual(messageLimits(context));
  });
});

describe('readRulesAction', () => {
  const request = (body: unknown) => new Request('https://bot/api/admin/rules', { method: 'POST', body: JSON.stringify(body) });

  it('reads a save and a removal, and nothing else', async () => {
    expect(await readRulesAction(request(draft()))).toEqual(draft());
    expect(await readRulesAction(request({ action: 'remove', id: 'mgl' }))).toEqual({ action: 'remove', id: 'mgl' });
    expect(await readRulesAction(request({ action: 'save', id: null }))).toBeNull();
    expect(await readRulesAction(request({ ...draft(), mode: 'ban' }))).toBeNull();
  });
});
