import { describe, expect, it } from 'vitest';
import { addBounties, bountyEndedText, bountyLines, bountyEnds, bountyOnText, parseBountyPending, planBounties } from '../src/bounty.ts';

const DAY = 24 * 60 * 60_000;
const NOON = Date.UTC(2026, 9, 23, 12);
const win = (eventId: string, steamId: string, streak = 15) => ({ eventId, steamId, name: steamId, victim: 'Ash', streak });

describe('bountyEnds', () => {
  it('is the end of tomorrow, however late the win was', () => {
    expect(bountyEnds(NOON, 1)).toBe(Date.UTC(2026, 9, 25));
    expect(bountyEnds(Date.UTC(2026, 9, 23, 23, 59), 1)).toBe(Date.UTC(2026, 9, 25));
    expect(bountyEnds(NOON, 2)).toBe(Date.UTC(2026, 9, 26));
  });
});

describe('planBounties', () => {
  const pending = addBounties({}, [win('a', 'p1'), win('b', 'p1'), win('c', 'p2')], NOON);

  it('pays each player once, for the end of tomorrow, and settles all their wins', () => {
    const plan = planBounties(pending, { days: 1 }, NOON + 60_000);
    expect(plan.drop).toEqual([]);
    expect(plan.pay.map((p) => [p.win.steamId, p.until, p.events])).toEqual([
      ['p1', Date.UTC(2026, 9, 25), ['a', 'b']],
      ['p2', Date.UTC(2026, 9, 25), ['c']],
    ]);
  });

  it('drops wins whose time is up, and every win when the reward is off', () => {
    expect(planBounties(pending, { days: 1 }, NOON + 3 * DAY)).toEqual({ pay: [], drop: ['a', 'b', 'c'] });
    expect(planBounties(pending, null, NOON)).toEqual({ pay: [], drop: ['a', 'b', 'c'] });
  });

  it('reads nothing saved, or something unreadable, as no wins', () => {
    expect(parseBountyPending(undefined)).toEqual({});
    expect(parseBountyPending({ a: { eventId: 1 } })).toEqual({});
    expect(parseBountyPending(pending)).toEqual(pending);
  });
});

describe('what the server is told', () => {
  it('names who has the bounty, and who ended it', () => {
    expect(bountyOnText({ eventId: 'a', steamId: 'p1', name: 'Ash', streak: 10 }, 1)).toBe('BOUNTY: Ash is on a 10 kill streak! Kill them to win VIP for tomorrow.');
    expect(bountyEndedText({ eventId: 'b', steamId: 'p2', name: 'Bo', victim: 'Ash', streak: 12 }, 1)).toBe("Bo ended Ash's 12 kill streak and wins VIP for tomorrow!");
    expect(bountyOnText({ eventId: 'a', steamId: 'p1', name: 'Ash', streak: 10 }, 3)).toMatch(/win VIP for the next 3 days\.$/);
  });

  it('cleans a name of line breaks and cuts a long one', () => {
    const text = bountyOnText({ eventId: 'a', steamId: 'p1', name: `A\nsh${'x'.repeat(60)}`, streak: 10 }, 1);
    expect(text).not.toMatch(/\n/);
    expect(text).toContain('A shxxxxxxxxxxxxxxxxxxxxxxxxxxx…');
    expect(bountyOnText({ eventId: 'a', steamId: 'p1', name: '', streak: 10 }, 1)).toMatch(/^BOUNTY: Someone is/);
  });
});

describe('bountyLines', () => {
  const on = (eventId: string, name: string) => ({ eventId, steamId: name, name, streak: 10 });
  const end = (eventId: string, name: string, victim: string) => ({ eventId, steamId: name, name, victim, streak: 12 });

  it('keeps the order the kills happened in, so an active bounty never reads as over', () => {
    // Ash's bounty is ended (e2), then Ash reaches the streak again (e5).
    const lines = bountyLines([on('e5', 'Ash')], [end('e2', 'Bo', 'Ash')], 1, ['e1', 'e2', 'e3', 'e4', 'e5']);
    expect(lines).toEqual(["Bo ended Ash's 12 kill streak and wins VIP for tomorrow!", 'BOUNTY: Ash is on a 10 kill streak! Kill them to win VIP for tomorrow.']);
    expect(bountyLines([on('e1', 'Ash')], [end('e4', 'Bo', 'Ash')], 1, ['e1', 'e2', 'e3', 'e4'])[0]).toMatch(/^BOUNTY: Ash/);
  });

  it('says the end first when one kill ends a streak and starts another', () => {
    const lines = bountyLines([on('e3', 'Bo')], [end('e3', 'Bo', 'Ash')], 1, ['e3']);
    expect(lines.map((l) => l.split(' ')[0])).toEqual(['Bo', 'BOUNTY:']);
  });
});
