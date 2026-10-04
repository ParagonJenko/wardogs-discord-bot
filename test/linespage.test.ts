import { describe, expect, it } from 'vitest';
import { DEFAULT_LINES } from '../src/lines.ts';
import {
  buildLinesPage,
  editLines,
  LISTS,
  MAX_LINES,
  parseSavedLines,
  readLinesAction,
  resolveLines,
  TEAM_LONGEST,
  type LinesContext,
  type SavedLines,
} from '../src/linespage.ts';
import { fillLine, milestones, seedingMessage } from '../src/messages.ts';
import type { MatchState } from '../src/tracking.ts';

const vip = { seedDays: 3, seedMinutes: 10, windowDays: 7, lengthDays: 7 };
const context: LinesContext = { siteHost: 'gaminginit.com', vip, scoreToWin: 100, live: 20, match: true, seeding: true };
const who = { by: '42', byName: 'Sarge', now: 1_000 };

const save = (saved: SavedLines, list: string, lines: string[]) => editLines(saved, { action: 'save', list, lines }, context, who);

describe('resolveLines', () => {
  it("uses the bot's own lines for every list staff left alone", () => {
    expect(resolveLines({})).toEqual(DEFAULT_LINES);
  });

  it("puts staff's lists in place of the bot's, and only those", () => {
    const lines = resolveLines({
      seeding: { lines: ['Seed with us: {needed}'], at: 1, by: '42', byName: 'Sarge' },
      'halfway.lonestar': { lines: ['Blue on {score}!'], at: 1, by: '42', byName: 'Sarge' },
      // A list the bot no longer has is left out.
      gone: { lines: ['Old'], at: 1, by: '42', byName: 'Sarge' },
    });

    expect(lines.seeding).toEqual(['Seed with us: {needed}']);
    expect(lines.halfway['lonestar']).toEqual(['Blue on {score}!']);
    expect(lines.halfway['valkyra']).toEqual(DEFAULT_LINES.halfway['valkyra']);
    expect(lines.tenMinutes).toEqual(DEFAULT_LINES.tenMinutes);
  });
});

describe('parseSavedLines', () => {
  it('drops a list it cannot read and keeps the rest', () => {
    expect(
      parseSavedLines({
        seeding: { lines: ['Seed: {needed}'], at: 1, by: '42', byName: 'Sarge' },
        tenMinutes: { lines: [], at: 1, by: '42', byName: 'Sarge' },
        halfwayLevel: 'nonsense',
      }),
    ).toEqual({ seeding: { lines: ['Seed: {needed}'], at: 1, by: '42', byName: 'Sarge' } });
    expect(parseSavedLines(undefined)).toEqual({});
  });
});

describe('editLines', () => {
  it('saves a list with who changed it, tidying lines and dropping blank ones', () => {
    expect(save({}, 'halfway.valkyra', ['  Red  leads\n on {score}. ', '', '   ', '{team} again'])).toEqual({
      saved: { 'halfway.valkyra': { lines: ['Red leads on {score}.', '{team} again'], at: 1_000, by: '42', byName: 'Sarge' } },
    });
  });

  it("goes back to the bot's own lines on reset, or when saved the same as them", () => {
    const saved: SavedLines = {
      seeding: { lines: ['Seed: {needed}'], at: 1, by: '42', byName: 'Sarge' },
      halfwayLevel: { lines: ['Level!'], at: 1, by: '42', byName: 'Sarge' },
    };

    expect(editLines(saved, { action: 'reset', list: 'seeding' }, context, who)).toEqual({ saved: { halfwayLevel: saved['halfwayLevel'] } });
    expect(save(saved, 'halfwayLevel', [...DEFAULT_LINES.halfwayLevel])).toEqual({ saved: { seeding: saved['seeding'] } });
  });

  it('refuses a list it does not have, an empty list, or too many lines', () => {
    expect(save({}, 'nope', ['Hi'])).toEqual({ problem: 'There is no list of lines by that name. Reload the page.' });
    expect(save({}, 'seeding', ['', ' '])).toEqual({
      problem: "Keep at least one line. To go back to the bot's own lines, use \"Use the bot's lines\".",
    });
    expect(save({}, 'halfwayLevel', Array.from({ length: MAX_LINES + 1 }, (_, i) => `Line ${i}`))).toEqual({
      problem: `A list can have at most ${MAX_LINES} lines.`,
    });
  });

  it('refuses a placeholder the bot cannot fill in for that list', () => {
    expect(save({}, 'seeding', ['Seed: {needed}', 'Score {score}'])).toEqual({
      problem: "Line 2 has {score}, which the bot can't fill in. It can fill in {needed}.",
    });
    expect(save({}, 'halfway.lonestar', ['{team} on {score} at {site}'])).toEqual({
      problem: "Line 1 has {site}, which the bot can't fill in. It can fill in {team} and {score}.",
    });
    expect(save({}, 'halfwayLevel', ['Level on {score}'])).toEqual({
      problem: "Line 1 has {score}, which the bot can't fill in. These lines have nothing to fill in.",
    });
  });

  it('refuses a line too long for the game with what the bot adds to it', () => {
    // The room a Lonestar halfway line has: what is left of 200 after "Halfway there! " and the seeding call to action.
    const after = ' Seed on 3 days in a week and get a reserved slot. How at gaminginit.com';
    const room = 200 - 'Halfway there! '.length - after.length;

    expect(save({}, 'halfwayLevel', ['x'.repeat(200 - after.length)])).toHaveProperty('saved');
    expect(save({}, 'halfway.lonestar', ['x'.repeat(room)])).toHaveProperty('saved');
    expect(save({}, 'halfway.lonestar', ['x'.repeat(room + 3)])).toEqual({
      problem: 'Line 1 is 3 characters too long for the game, with what the bot adds to it.',
    });
    // Placeholders count as what they are filled in with: {site} as "gaminginit.com".
    expect(save({}, 'tenMinutes', [`${'x'.repeat(200 - 'gaminginit.com'.length)}{site}`])).toHaveProperty('saved');
    expect(save({}, 'tenMinutes', [`${'x'.repeat(201 - 'gaminginit.com'.length)}{site}`])).toHaveProperty('problem');
  });

  it('checks {score} and {team} at the longest they can be when the message goes out, not as the preview shows them', () => {
    const room = 200 - 'Halfway there! '.length - ' Seed on 3 days in a week and get a reserved slot. How at gaminginit.com'.length;

    // The preview shows 50, but the leader can be on 100 when the message goes out.
    expect(save({}, 'halfway.lonestar', [`${'x'.repeat(room - 3)}{score}`])).toHaveProperty('saved');
    expect(save({}, 'halfway.lonestar', [`${'x'.repeat(room - 2)}{score}`])).toEqual({
      problem: 'Line 1 is 1 character too long for the game, with what the bot adds to it.',
    });
    // The server may spell the team "Lone Star", and any other team could be called anything.
    expect(save({}, 'halfway.lonestar', [`${'x'.repeat(room - TEAM_LONGEST)}{team}`])).toHaveProperty('saved');
    expect(save({}, 'halfwayOther', [`${'x'.repeat(room - TEAM_LONGEST + 1)}{team}`])).toHaveProperty('problem');
  });

  it('keeps every line it saves from being cut short in game', () => {
    const room = 200 - 'Halfway there! '.length - ' Seed on 3 days in a week and get a reserved slot. How at gaminginit.com'.length;
    const line = `${'x'.repeat(room - TEAM_LONGEST - 4)}{team} {score}`;
    const sent = milestones(
      {
        key: 'Europe#1',
        startedAt: 0,
        lastSeenAt: 0,
        liveAt: 0,
        summarisable: true,
        peakPlayers: 40,
        players: {},
        factionScores: [{ name: 'L'.repeat(TEAM_LONGEST), score: 100 }],
      },
      0,
      { siteHost: 'gaminginit.com', scoreToWin: 100 },
      vip,
      () => 0,
      resolveLines((save({}, 'halfwayOther', [line]) as { saved: SavedLines }).saved),
    );

    expect(sent[0]?.text.length).toBe(200);
    expect(sent[0]?.text.endsWith('…')).toBe(false);
  });
});

describe('buildLinesPage', () => {
  it("lists every list with its lines, what goes around them, and who changed staff's", () => {
    const page = buildLinesPage({ 'nearly.manticore': { lines: ['Green on {score}.'], at: 5, by: '42', byName: 'Sarge' } }, context);

    expect(page.max).toBe(200);
    expect(page.lists.map((l) => l.id)).toEqual(LISTS.map((l) => l.id));
    expect(page.lists.find((l) => l.id === 'nearly.manticore')).toMatchObject({
      group: 'Nearly won',
      name: 'Manticore',
      off: null,
      lines: ['Green on {score}.'],
      values: { team: 'Manticore', score: '90' },
      longest: { team: 'x'.repeat(TEAM_LONGEST), score: '90' },
      before: '',
      after: ' Where do you rank? Leaderboard, Discord and seeding at gaminginit.com',
      changed: { at: 5, by: '42', byName: 'Sarge' },
    });
    expect(page.lists.find((l) => l.id === 'seeding')).toMatchObject({
      lines: DEFAULT_LINES.seeding,
      values: { needed: '19 more players' },
      after: ' Seed for over 10 min on 3 days in a week and get a reserved slot. How at gaminginit.com',
      changed: null,
    });
  });

  it('says which lists the bot is not sending now', () => {
    const page = buildLinesPage({}, { ...context, match: false, siteHost: null });

    expect(page.lists.find((l) => l.id === 'seeding')?.off).toBeNull();
    expect(page.lists.find((l) => l.id === 'seeding')?.after).toBe(' Seed for over 10 min on 3 days in a week and get a reserved slot.');
    expect(page.lists.find((l) => l.id === 'tenMinutes')?.off).toBe(
      'The bot is not sending match messages: MATCH_MESSAGES is off, or SITE_URL is not set.',
    );
  });

  it('shows each message as the bot sends it', () => {
    const page = buildLinesPage({}, context);
    const shown = (id: string, line: string) => {
      const list = page.lists.find((l) => l.id === id);
      return list ? `${list.before}${fillLine(line, list.values)}${list.after}` : null;
    };
    const match = (factionScores: MatchState['factionScores']): MatchState => ({
      key: 'Europe#1',
      startedAt: 0,
      lastSeenAt: 0,
      liveAt: 0,
      summarisable: true,
      peakPlayers: 40,
      players: {},
      factionScores,
    });
    const rule = { siteHost: 'gaminginit.com', scoreToWin: 100 };
    const first = () => 0;

    expect(milestones(match([{ name: 'Valkyra', score: 50 }]), 0, rule, vip, first)[0]?.text).toBe(
      shown('halfway.valkyra', DEFAULT_LINES.halfway['valkyra']?.[0] ?? ''),
    );
    expect(milestones(match([{ name: 'Lonestar', score: 95 }]), 0, rule, vip, first)[1]?.text).toBe(
      shown('nearly.lonestar', DEFAULT_LINES.nearly['lonestar']?.[0] ?? ''),
    );
    expect(milestones(match([{ name: 'A', score: 50 }, { name: 'B', score: 50 }]), 0, rule, vip, first)[0]?.text).toBe(
      shown('halfwayLevel', DEFAULT_LINES.halfwayLevel[0] ?? ''),
    );
    expect(milestones(match([{ name: 'Valkyra', score: 0 }]), 10 * 60_000, rule, vip, first)[0]?.text).toBe(
      shown('tenMinutes', DEFAULT_LINES.tenMinutes[0] ?? ''),
    );
    expect(seedingMessage(1, 20, { everyMs: 1, siteHost: 'gaminginit.com' }, vip, first)).toBe(shown('seeding', DEFAULT_LINES.seeding[0] ?? ''));
  });

  it("passes every one of the bot's own lines", () => {
    for (const list of LISTS) expect(save({}, list.id, [...list.get(DEFAULT_LINES), 'Extra'])).toHaveProperty('saved');
  });
});

describe('readLinesAction', () => {
  const post = (body: string) => new Request('https://bot.example/api/admin/lines', { method: 'POST', body });

  it('reads a save or a reset, and nothing else', async () => {
    expect(await readLinesAction(post(JSON.stringify({ action: 'save', list: 'seeding', lines: ['Hi {needed}'] })))).toEqual({
      action: 'save',
      list: 'seeding',
      lines: ['Hi {needed}'],
    });
    expect(await readLinesAction(post(JSON.stringify({ action: 'reset', list: 'seeding' })))).toEqual({ action: 'reset', list: 'seeding' });
    expect(await readLinesAction(post(JSON.stringify({ action: 'delete', list: 'seeding' })))).toBeNull();
    expect(await readLinesAction(post('not json'))).toBeNull();
    expect(await readLinesAction(post(JSON.stringify({ action: 'save', list: 'seeding', lines: ['x'.repeat(100)] })), 50)).toBeNull();
  });
});
