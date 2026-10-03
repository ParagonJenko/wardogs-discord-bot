import { describe, expect, it } from 'vitest';
import type { RotationBook } from '../src/rotations.ts';
import { actionEdit, buildCatalog, buildRotationsPage, readRotationAction, RotationActionSchema } from '../src/rotationspage.ts';

describe('buildCatalog', () => {
  it('lists each map by its players\' name, with its modes, modifiers and zone layouts', () => {
    const catalog = buildCatalog({
      maps: [
        { id: 'Kavkazi', name: 'Kavkazi' },
        { id: 'Somewhere', name: 'Somewhere New' },
      ],
      experiences: [{ id: 'Kavkazi_KOTH_01', name: 'King of the Hill' }],
      lightings: [{ id: 'DayClear', name: 'Day, clear' }],
      perMap: new Map([
        ['Kavkazi', { experiences: ['Kavkazi_KOTH_01', 'KOTH_InfantryOnly'], zones: [{ id: 'ZoneAlternator.Bakurani.Default.Circle', name: 'Circle' }] }],
        ['Somewhere', { experiences: null, zones: null }],
      ]),
    });
    expect(catalog).toEqual({
      maps: [
        {
          id: 'Kavkazi',
          name: 'Bakurani',
          modes: [{ id: 'Kavkazi_KOTH_01', name: 'King of the Hill' }],
          modifiers: [{ key: 'infantry_only', name: 'Infantry only', id: 'KOTH_InfantryOnly' }],
          zones: [{ id: 'ZoneAlternator.Bakurani.Default.Circle', name: 'Circle' }],
        },
        {
          id: 'Somewhere',
          name: 'Somewhere New',
          modes: [],
          // Its list could not be read, so every modifier is offered.
          modifiers: [
            { key: 'infantry_only', name: 'Infantry only', id: 'KOTH_InfantryOnly' },
            { key: 'hardcore', name: 'Hardcore', id: 'KOTH_Hardcore' },
          ],
          zones: [],
        },
      ],
      lightings: [{ id: 'DayClear', name: 'Day, clear' }],
      experiences: [{ id: 'Kavkazi_KOTH_01', name: 'King of the Hill' }],
    });
  });
});

describe('buildRotationsPage', () => {
  const book: RotationBook = {
    rotations: [
      { name: 'Weekend', entries: [{ map: 'Europe' }] },
      { name: 'Default', entries: [{ map: 'Kavkazi' }] },
    ],
    week: [null, null, null, null, null, 'Weekend', 'Weekend'],
    applied: { name: 'Weekend', day: '2026-10-03', at: 1, by: '42', byName: 'Sarge', pending: false },
  };

  it('puts Default first, says what each day plays, and what is on the server today', () => {
    const page = buildRotationsPage({
      book,
      today: { day: '2026-10-03', weekday: 5 },
      hour: 5,
      server: { enabled: true, mode: 'ordered', entries: [{ map: 'Europe', status: 'now' }] },
      catalog: null,
    });
    expect(page.rotations.map((r) => r.name)).toEqual(['Default', 'Weekend']);
    expect(page.plan).toEqual(['Default', 'Default', 'Default', 'Default', 'Default', 'Weekend', 'Weekend']);
    expect(page.current).toEqual(book.applied);
    expect(page.server).toEqual({ enabled: true, mode: 'ordered', entries: [{ map: 'Europe', status: 'now' }] });
    expect(page).toMatchObject({ defaultName: 'Default', hour: 5, limits: { rotations: 10, maps: 100, name: 32 } });
  });

  it('shows yesterday\'s rotation as nothing chosen today', () => {
    const page = buildRotationsPage({ book, today: { day: '2026-10-04', weekday: 6 }, hour: 5, server: null, catalog: null });
    expect(page.current).toBeNull();
    expect(page.server).toBeNull();
  });
});

describe('the Rotations tab\'s changes', () => {
  it('saves a rotation with empty settings left out and the game mode first, renaming it as it goes', () => {
    const parsed = RotationActionSchema.parse({
      action: 'save',
      name: ' Night ',
      from: 'Rotation 2',
      entries: [{ map: 'Kavkazi', experiences: ['KOTH_Hardcore', 'Kavkazi_KOTH_01', ''], lighting: '', zoneAlternator: 'ZoneAlternator.Bakurani.Default.Circle' }],
    });
    expect(actionEdit(parsed)).toEqual({
      kind: 'save',
      name: 'Night',
      from: 'Rotation 2',
      entries: [{ map: 'Kavkazi', experiences: ['Kavkazi_KOTH_01', 'KOTH_Hardcore'], zoneAlternator: 'ZoneAlternator.Bakurani.Default.Circle' }],
    });
  });

  it('plans days, swaps and deletes', () => {
    expect(actionEdit(RotationActionSchema.parse({ action: 'schedule', days: [5, 6, 5], name: null }))).toEqual({ kind: 'schedule', days: [5, 6], name: null });
    expect(actionEdit(RotationActionSchema.parse({ action: 'use', name: 'Weekend' }))).toEqual({ kind: 'use', name: 'Weekend' });
    expect(actionEdit(RotationActionSchema.parse({ action: 'delete', name: 'Weekend' }))).toEqual({ kind: 'delete', name: 'Weekend' });
  });

  it('refuses anything else', () => {
    expect(RotationActionSchema.safeParse({ action: 'schedule', days: [7], name: 'x' }).success).toBe(false);
    expect(RotationActionSchema.safeParse({ action: 'save', name: 'x', entries: Array.from({ length: 101 }, () => ({ map: 'Kavkazi' })) }).success).toBe(false);
    expect(RotationActionSchema.safeParse({ action: 'drop', name: 'x' }).success).toBe(false);
  });
});

describe('readRotationAction', () => {
  const streamed = (text: string, chunk = 4): Request => {
    const bytes = new TextEncoder().encode(text);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < bytes.length; at += chunk) controller.enqueue(bytes.slice(at, at + chunk));
        controller.close();
      },
    });
    return new Request('https://bot.example/api/admin/rotations', { method: 'POST', body, duplex: 'half' } as RequestInit);
  };

  it('reads a change sent in pieces', async () => {
    await expect(readRotationAction(streamed(JSON.stringify({ action: 'use', name: 'Weekend' })))).resolves.toEqual({ action: 'use', name: 'Weekend' });
  });

  it('drops a body past the limit, said or not, and anything that is not a change', async () => {
    const long = JSON.stringify({ action: 'use', name: 'x'.repeat(40) });
    await expect(readRotationAction(streamed(long), 32)).resolves.toBeNull();
    const said = new Request('https://bot.example/', { method: 'POST', body: long, headers: { 'content-length': '999999' } });
    await expect(readRotationAction(said)).resolves.toBeNull();
    await expect(readRotationAction(streamed('not json'))).resolves.toBeNull();
    await expect(readRotationAction(streamed(JSON.stringify({ action: 'drop' })))).resolves.toBeNull();
  });
});
