import { describe, expect, it } from 'vitest';
import { CLICK_DAYS_KEPT, parseClicks, SOURCES_PER_DAY, sourceOf, summarise, withClick } from '../src/discordclicks.ts';

describe('clicks on the Discord invite', () => {
  it('names a place by lowercase letters, digits and dashes, and puts anything else under other', () => {
    expect(sourceOf('hero')).toBe('hero');
    expect(sourceOf('vote-peek')).toBe('vote-peek');
    expect(sourceOf('Hero')).toBe('other');
    expect(sourceOf('a b')).toBe('other');
    expect(sourceOf('<script>')).toBe('other');
    expect(sourceOf('x'.repeat(40))).toBe('other');
    expect(sourceOf(null)).toBe('other');
    expect(sourceOf('')).toBe('other');
  });

  it('counts a place named like something every object has', () => {
    let clicks = withClick({}, 'constructor', '2026-10-17');
    clicks = withClick(clicks, 'constructor', '2026-10-17');
    expect(clicks).toEqual({ '2026-10-17': { constructor: 2 } });
    expect(parseClicks(JSON.parse(JSON.stringify(clicks)))).toEqual(clicks);
  });

  it('counts a click for its place on its day', () => {
    let clicks = withClick({}, 'hero', '2026-10-17');
    clicks = withClick(clicks, 'hero', '2026-10-17');
    clicks = withClick(clicks, 'game', '2026-10-17');
    clicks = withClick(clicks, 'hero', '2026-10-18');
    expect(clicks).toEqual({ '2026-10-17': { hero: 2, game: 1 }, '2026-10-18': { hero: 1 } });
  });

  it('lumps places past the limit in other, so a stranger cannot fill the record', () => {
    let clicks = {};
    for (let i = 0; i < SOURCES_PER_DAY + 5; i++) clicks = withClick(clicks, `p${i}`, '2026-10-17');
    const day = (clicks as Record<string, Record<string, number>>)['2026-10-17']!;
    expect(Object.keys(day)).toHaveLength(SOURCES_PER_DAY + 1);
    expect(day['other']).toBe(5);
    // A place already counted that day still counts as itself.
    expect((withClick(clicks, 'p0', '2026-10-17') as Record<string, Record<string, number>>)['2026-10-17']!['p0']).toBe(2);
  });

  it('forgets days past those kept', () => {
    let clicks = {};
    for (let i = 0; i < CLICK_DAYS_KEPT + 3; i++) clicks = withClick(clicks, 'hero', new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10));
    expect(Object.keys(clicks)).toHaveLength(CLICK_DAYS_KEPT);
    expect(Object.keys(clicks)[0]).toBe('2026-09-04');
  });

  it('adds up the last days, most clicked place first', () => {
    const clicks = {
      '2026-09-01': { hero: 100 },
      '2026-10-10': { hero: 2, game: 5 },
      '2026-10-17': { hero: 4, vote: 1 },
    };
    expect(summarise(clicks, '2026-10-17', 30)).toEqual({
      days: 30,
      total: 12,
      places: [
        { src: 'game', clicks: 5 },
        { src: 'hero', clicks: 6 },
        { src: 'vote', clicks: 1 },
      ].sort((a, b) => b.clicks - a.clicks),
    });
    expect(summarise(clicks, '2026-10-17', 1).total).toBe(5);
  });

  it('reads what was saved, or starts again', () => {
    expect(parseClicks({ '2026-10-17': { hero: 1 } })).toEqual({ '2026-10-17': { hero: 1 } });
    expect(parseClicks('nope')).toEqual({});
    expect(parseClicks(null)).toEqual({});
  });
});
