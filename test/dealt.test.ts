import { describe, expect, it } from 'vitest';
import { applyDealt, dealtLately, readDealtAction, type DealtAction } from '../src/dealt.ts';

const NOW = Date.UTC(2026, 9, 16, 12);
const DAY = 24 * 60 * 60_000;
const SARGE = { id: '340568148044414976', name: 'Sarge' };
const KESTREL = { id: '100000000000000002', name: 'Kestrel' };
const VEX = '76561198000000008';
const PIKE = '76561198000000004';

const deal = (steamId: string, more: Partial<Extract<DealtAction, { action: 'deal' }>> = {}): DealtAction => ({
  action: 'deal',
  steamId,
  reasons: ['headshots'],
  headshotDay: '2026-10-15',
  griefDay: null,
  steamScore: null,
  ...more,
});

const request = (body: unknown): Request =>
  new Request('https://bot.example/api/admin/dealt', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('dealt with', () => {
  it('keeps who dealt with a player, when, and what the Queue showed for them then', () => {
    const stored = applyDealt(undefined, deal(VEX, { reasons: ['griefing', 'headshots'], griefDay: '2026-10-14', steamScore: 3 }), SARGE, NOW);

    expect(stored).toEqual({
      // The reasons in a set order, whatever order the page sent them in.
      [VEX]: { by: SARGE.id, byName: 'Sarge', at: NOW, reasons: ['headshots', 'griefing'], headshotDay: '2026-10-15', griefDay: '2026-10-14', steamScore: 3 },
    });
    expect(dealtLately(stored, NOW + DAY)[VEX]?.byName).toBe('Sarge');
  });

  it('lets another staff member deal with them again, or undo it, and leaves the rest', () => {
    const one = applyDealt(undefined, deal(VEX), SARGE, NOW);
    const two = applyDealt(one, deal(PIKE, { reasons: ['steam'], headshotDay: null, steamScore: 5 }), SARGE, NOW + 1);
    const again = applyDealt(two, deal(VEX), KESTREL, NOW + 2);

    expect(dealtLately(again, NOW)[VEX]).toMatchObject({ by: KESTREL.id, at: NOW + 2 });
    const undone = applyDealt(again, { action: 'undo', steamId: VEX }, SARGE, NOW + 3);
    expect(Object.keys(dealtLately(undone, NOW))).toEqual([PIKE]);
  });

  it('lasts 30 days, across days, and reads nothing from anything else', () => {
    const stored = applyDealt(undefined, deal(VEX), SARGE, NOW);

    expect(Object.keys(dealtLately(stored, NOW + 29 * DAY))).toEqual([VEX]);
    expect(dealtLately(stored, NOW + 30 * DAY)).toEqual({});
    expect(Object.keys(applyDealt(stored, deal(PIKE), SARGE, NOW + 31 * DAY))).toEqual([PIKE]);
    expect(dealtLately(undefined, NOW)).toEqual({});
    expect(dealtLately({ [VEX]: { by: 1 } }, NOW)).toEqual({});
  });

  it('keeps the newest 300', () => {
    let stored: unknown = undefined;
    for (let i = 0; i < 305; i++) stored = applyDealt(stored, deal(`7656119800000${String(i).padStart(4, '0')}`), SARGE, NOW + i);

    const kept = dealtLately(stored, NOW + 305);
    expect(Object.keys(kept)).toHaveLength(300);
    expect(kept['76561198000000000']).toBeUndefined();
    expect(kept['76561198000000304']).toBeDefined();
  });

  it('reads what the staff page sends, and refuses anything else', async () => {
    await expect(readDealtAction(request(deal(VEX)))).resolves.toEqual(deal(VEX));
    await expect(readDealtAction(request({ action: 'undo', steamId: VEX }))).resolves.toEqual({ action: 'undo', steamId: VEX });
    await expect(readDealtAction(request({ ...deal(VEX), steamId: '123' }))).resolves.toBeNull();
    await expect(readDealtAction(request({ ...deal(VEX), reasons: ['banned'] }))).resolves.toBeNull();
    await expect(readDealtAction(request({ ...deal(VEX), headshotDay: 'yesterday' }))).resolves.toBeNull();
    await expect(readDealtAction(request({ ...deal(VEX), steamScore: -1 }))).resolves.toBeNull();
    await expect(readDealtAction(request('not json'))).resolves.toBeNull();
    await expect(readDealtAction(request({ ...deal(VEX), padding: 'x'.repeat(2_000) }))).resolves.toBeNull();
  });

  it('reads an outcome with a deal, and refuses one it does not know', async () => {
    expect(await readDealtAction(request({ ...deal(VEX), outcome: 'cheating' }))).toMatchObject({ outcome: 'cheating' });
    expect(await readDealtAction(request(deal(VEX)))).not.toHaveProperty('outcome');
    expect(await readDealtAction(request({ ...deal(VEX), outcome: 'banned-for-fun' }))).toBeNull();
  });
});
