import { describe, expect, it } from 'vitest';
import { blockCircle, blockedCircleIds, parseBlockedCircles, unblockCircle } from '../src/circles.ts';

const LINE = { id: 'ZoneAlternator.Ozeti.Default.Line', map: 'Europe', name: 'Line' };

describe('blocked circles', () => {
  it('blocks a circle once, with who did it and when', () => {
    const blocked = blockCircle({}, LINE, '42', 'Sarge', 100);
    expect(blocked).toEqual({ [LINE.id]: { map: 'Europe', name: 'Line', at: 100, by: '42', byName: 'Sarge' } });
    expect(blockCircle(blocked!, LINE, '7', undefined, 200)).toBeNull();
    expect(blockCircle({}, LINE, '42', undefined, 100)).toEqual({ [LINE.id]: { map: 'Europe', name: 'Line', at: 100, by: '42' } });
  });

  it('unblocks a circle, and says when it was not blocked', () => {
    const blocked = blockCircle({}, LINE, '42', undefined, 100)!;
    expect(unblockCircle(blocked, LINE.id)).toEqual({});
    expect(unblockCircle({}, LINE.id)).toBeNull();
  });

  it('lists the ids, and reads what was saved and nothing else', () => {
    const saved = { [LINE.id]: { map: 'Europe', name: 'Line', at: 1, by: '42' } };
    expect(blockedCircleIds(saved)).toEqual([LINE.id]);
    expect(parseBlockedCircles(saved)).toEqual(saved);
    expect(parseBlockedCircles({ [LINE.id]: { map: 1 } })).toEqual({});
    expect(parseBlockedCircles(undefined)).toEqual({});
  });
});
