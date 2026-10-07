import { describe, expect, it } from 'vitest';
import { applyCheck, checkedToday, readCheckAction } from '../src/checked.ts';

const NOW = Date.UTC(2026, 9, 7, 12);
const SARGE = { id: '340568148044414976', name: 'Sarge' };
const KESTREL = { id: '100000000000000002', name: 'Kestrel' };
const VEX = '76561198000000008';
const PIKE = '76561198000000004';

const request = (body: unknown): Request =>
  new Request('https://bot.example/api/admin/check', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('checked, they are fine', () => {
  it('keeps who checked a player, when, and what they were flagged for then', () => {
    const stored = applyCheck(undefined, { action: 'check', steamId: VEX, reasons: ['steam', 'griefing'], teamKills: 4, vehicleSuicides: 1 }, SARGE, NOW);

    expect(stored).toEqual({
      day: '2026-10-07',
      players: {
        // The reasons in a set order, whatever order the page sent them in.
        [VEX]: { by: SARGE.id, byName: 'Sarge', at: NOW, reasons: ['griefing', 'steam'], teamKills: 4, vehicleSuicides: 1 },
      },
    });
    expect(checkedToday(stored, NOW + 60_000)[VEX]?.byName).toBe('Sarge');
  });

  it('lets another staff member check again, or take a check back, and leaves the rest', () => {
    const one = applyCheck(undefined, { action: 'check', steamId: VEX, reasons: ['headshots'], teamKills: 0, vehicleSuicides: 0 }, SARGE, NOW);
    const two = applyCheck(one, { action: 'check', steamId: PIKE, reasons: ['steam'], teamKills: 0, vehicleSuicides: 0 }, SARGE, NOW + 1);
    const again = applyCheck(two, { action: 'check', steamId: VEX, reasons: ['headshots'], teamKills: 0, vehicleSuicides: 0 }, KESTREL, NOW + 2);

    expect(checkedToday(again, NOW)[VEX]).toMatchObject({ by: KESTREL.id, at: NOW + 2 });
    const back = applyCheck(again, { action: 'uncheck', steamId: VEX }, SARGE, NOW + 3);
    expect(Object.keys(checkedToday(back, NOW))).toEqual([PIKE]);
  });

  it('forgets checks from an earlier day, and reads nothing from anything else', () => {
    const yesterday = applyCheck(undefined, { action: 'check', steamId: VEX, reasons: ['banned'], teamKills: 0, vehicleSuicides: 0 }, SARGE, NOW - 86_400_000);

    expect(checkedToday(yesterday, NOW)).toEqual({});
    const today = applyCheck(yesterday, { action: 'check', steamId: PIKE, reasons: [], teamKills: 0, vehicleSuicides: 0 }, SARGE, NOW);
    expect(Object.keys(today.players)).toEqual([PIKE]);
    expect(checkedToday(undefined, NOW)).toEqual({});
    expect(checkedToday({ day: '2026-10-07', players: { [VEX]: { by: 1 } } }, NOW)).toEqual({});
  });

  it('reads what the staff page sends, and refuses anything else', async () => {
    await expect(readCheckAction(request({ action: 'check', steamId: VEX, reasons: ['griefing'], teamKills: 3, vehicleSuicides: 0 }))).resolves.toEqual({
      action: 'check',
      steamId: VEX,
      reasons: ['griefing'],
      teamKills: 3,
      vehicleSuicides: 0,
    });
    await expect(readCheckAction(request({ action: 'uncheck', steamId: VEX }))).resolves.toEqual({ action: 'uncheck', steamId: VEX });
    // Not a Steam ID, a reason the page never sends, a count that is not one, and not JSON.
    await expect(readCheckAction(request({ action: 'uncheck', steamId: 'vex' }))).resolves.toBeNull();
    await expect(readCheckAction(request({ action: 'check', steamId: VEX, reasons: ['vibes'], teamKills: 0, vehicleSuicides: 0 }))).resolves.toBeNull();
    await expect(readCheckAction(request({ action: 'check', steamId: VEX, reasons: [], teamKills: -1, vehicleSuicides: 0 }))).resolves.toBeNull();
    await expect(readCheckAction(request('check'))).resolves.toBeNull();
    await expect(readCheckAction(request({ action: 'uncheck', steamId: VEX, pad: 'x'.repeat(2_000) }))).resolves.toBeNull();
    // Too big, with no length given: dropped as it is read, never buffered whole.
    const chunked = new Request('https://bot.example/api/admin/check', {
      method: 'POST',
      body: new ReadableStream({
        start(controller) {
          for (let i = 0; i < 4; i += 1) controller.enqueue(new TextEncoder().encode('x'.repeat(512)));
          controller.close();
        },
      }),
      duplex: 'half',
    } as RequestInit);
    await expect(readCheckAction(chunked)).resolves.toBeNull();
  });
});
