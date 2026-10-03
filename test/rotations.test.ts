import { describe, expect, it, vi } from 'vitest';
import type { ConfigResult, ServerConfig } from '../src/rcon.ts';
import {
  editRotations,
  parseEntry,
  parseRotationBook,
  planToday,
  putRotation,
  rotationDay,
  rotationName,
  serverEntries,
  setRotationEntries,
  type RotationBook,
  type RotationEntry,
} from '../src/rotations.ts';

// Saturday 3 October 2026, 12:00 UTC.
const NOW = Date.UTC(2026, 9, 3, 12);
const SATURDAY = rotationDay(NOW, 5);

const BAKURANI: RotationEntry = { map: 'Kavkazi', experiences: ['Kavkazi_KOTH_01'], lighting: 'DayClear' };
const OZETI: RotationEntry = { map: 'Europe', experiences: ['Europe_KOTH_01', 'KOTH_InfantryOnly'] };
const ZESTAFONA: RotationEntry = { map: 'NorthAmerica', experiences: ['NorthAmerica_KOTH_01'], zoneAlternator: 'ZoneAlternator.Zestafona.Default.Circle' };

const empty = parseRotationBook(undefined);

const book = (changes: Partial<RotationBook> = {}): RotationBook => ({
  rotations: [
    { name: 'Rotation 1', entries: [BAKURANI, OZETI] },
    { name: 'Weekend', entries: [ZESTAFONA] },
  ],
  week: [null, null, null, null, null, null, null],
  applied: null,
  ...changes,
});

const at = { today: SATURDAY, now: NOW, by: '42' };

const edited = (start: RotationBook, edit: Parameters<typeof editRotations>[1]): RotationBook => {
  const result = editRotations(start, edit, at);
  if ('problem' in result) throw new Error(result.problem);
  return result.book;
};

describe('rotationDay', () => {
  it('starts each day at the hour given, so a late night is still the evening before', () => {
    expect(SATURDAY).toEqual({ day: '2026-10-03', weekday: 5 });
    expect(rotationDay(Date.UTC(2026, 9, 3, 4, 59), 5)).toEqual({ day: '2026-10-02', weekday: 4 });
    expect(rotationDay(Date.UTC(2026, 9, 3, 5), 5)).toEqual({ day: '2026-10-03', weekday: 5 });
    expect(rotationDay(Date.UTC(2026, 9, 4, 0), 0)).toEqual({ day: '2026-10-04', weekday: 6 });
    expect(rotationDay(Date.UTC(2026, 9, 5, 0), 0).weekday).toBe(0);
  });
});

describe('rotationName', () => {
  it('tidies the spaces and keeps to a short name that cannot restyle Discord', () => {
    expect(rotationName('  Rotation   1 ')).toEqual({ name: 'Rotation 1' });
    expect(rotationName("Mike's Infantry-only (night)")).toEqual({ name: "Mike's Infantry-only (night)" });
    expect(rotationName('')).toEqual({ problem: expect.stringMatching(/name/) });
    expect(rotationName('**bold**')).toEqual({ problem: expect.stringMatching(/letters, numbers/) });
    expect(rotationName('x'.repeat(33))).toEqual({ problem: expect.stringMatching(/32 characters/) });
  });
});

describe('parseRotationBook', () => {
  it('starts with no rotations and nothing planned', () => {
    expect(empty).toEqual({ rotations: [], week: [null, null, null, null, null, null, null], applied: null });
    expect(parseRotationBook({ rotations: 'nonsense' })).toEqual(empty);
    expect(parseRotationBook(book())).toEqual(book());
  });
});

describe('editRotations', () => {
  it('starts a rotation with its first map, and adds the next at the end or where asked', () => {
    const one = edited(empty, { kind: 'add', name: 'Rotation 1', entry: BAKURANI });
    expect(one.rotations).toEqual([{ name: 'Rotation 1', entries: [BAKURANI] }]);

    const two = edited(one, { kind: 'add', name: 'rotation 1', entry: OZETI });
    const three = edited(two, { kind: 'add', name: 'Rotation 1', entry: ZESTAFONA, position: 1 });
    expect(three.rotations).toEqual([{ name: 'Rotation 1', entries: [ZESTAFONA, BAKURANI, OZETI] }]);
    // Past the end is the end.
    expect(edited(two, { kind: 'add', name: 'Rotation 1', entry: ZESTAFONA, position: 50 }).rotations[0]?.entries.at(-1)).toEqual(ZESTAFONA);
    // Building a rotation does not touch the server.
    expect(three.applied).toBeNull();
  });

  it('refuses a bad name, an eleventh rotation and an unknown one', () => {
    expect(editRotations(empty, { kind: 'add', name: '<@1>', entry: BAKURANI }, at)).toEqual({ problem: expect.any(String) });
    const ten: RotationBook = { ...empty, rotations: Array.from({ length: 10 }, (_, i) => ({ name: `R${i}`, entries: [BAKURANI] })) };
    expect(editRotations(ten, { kind: 'add', name: 'R10', entry: BAKURANI }, at)).toEqual({ problem: expect.stringMatching(/already 10/) });
    expect(editRotations(ten, { kind: 'add', name: 'r9', entry: OZETI }, at)).not.toHaveProperty('problem');
    expect(editRotations(book(), { kind: 'use', name: 'Nope' }, at)).toEqual({ problem: expect.stringMatching(/no rotation called "Nope"/) });
  });

  it('takes a map out by its number', () => {
    expect(edited(book(), { kind: 'remove', name: 'Rotation 1', position: 1 }).rotations[0]).toEqual({ name: 'Rotation 1', entries: [OZETI] });
    expect(editRotations(book(), { kind: 'remove', name: 'Rotation 1', position: 3 }, at)).toEqual({ problem: expect.stringMatching(/Pick a map/) });
  });

  it("saves the server's rotation under a name, in place of one with that name", () => {
    const saved = edited(book(), { kind: 'save', name: 'WEEKEND', entries: [BAKURANI, ZESTAFONA] });
    expect(saved.rotations).toEqual([book().rotations[0], { name: 'Weekend', entries: [BAKURANI, ZESTAFONA] }]);
    expect(editRotations(book(), { kind: 'save', name: 'New', entries: [] }, at)).toEqual({ problem: expect.stringMatching(/no maps/) });
  });

  it('plans a rotation for a day, or several, and puts it on now when one of them is today', () => {
    const weekdays = edited(book(), { kind: 'schedule', days: [0, 1, 2, 3, 4], name: 'rotation 1' });
    expect(weekdays.week).toEqual(['Rotation 1', 'Rotation 1', 'Rotation 1', 'Rotation 1', 'Rotation 1', null, null]);
    expect(weekdays.applied).toBeNull();

    const weekend = edited(weekdays, { kind: 'schedule', days: [5, 6], name: 'Weekend' });
    expect(weekend.week.slice(5)).toEqual(['Weekend', 'Weekend']);
    expect(weekend.applied).toEqual({ name: 'Weekend', day: '2026-10-03', at: NOW, by: '42', pending: true });

    // Clearing a day leaves the server as it is.
    const cleared = edited(weekend, { kind: 'schedule', days: [5], name: null });
    expect(cleared.week[5]).toBeNull();
    expect(cleared.applied).toBe(weekend.applied);
  });

  it('only plans a rotation that has maps', () => {
    const bare: RotationBook = { ...book(), rotations: [{ name: 'Bare', entries: [] }] };
    expect(editRotations(bare, { kind: 'schedule', days: [0], name: 'Bare' }, at)).toEqual({ problem: expect.stringMatching(/no maps yet/) });
    expect(editRotations(bare, { kind: 'use', name: 'Bare' }, at)).toEqual({ problem: expect.stringMatching(/no maps yet/) });
    expect(editRotations(book(), { kind: 'schedule', days: [7], name: 'Weekend' }, at)).toEqual({ problem: 'Pick the day from the list.' });
  });

  it('swaps the rotation for today', () => {
    expect(edited(book(), { kind: 'use', name: 'weekend' }).applied).toEqual({ name: 'Weekend', day: '2026-10-03', at: NOW, by: '42', pending: true });
  });

  it("puts today's rotation on again when its maps change, unless it has none left", () => {
    const onToday = book({ applied: { name: 'Rotation 1', day: '2026-10-03', at: 0, by: 'schedule', pending: false } });
    expect(edited(onToday, { kind: 'add', name: 'Rotation 1', entry: ZESTAFONA }).applied).toMatchObject({ name: 'Rotation 1', pending: true });
    expect(edited(onToday, { kind: 'add', name: 'Weekend', entry: BAKURANI }).applied?.pending).toBe(false);
    const one = edited(onToday, { kind: 'remove', name: 'Rotation 1', position: 1 });
    expect(one.applied?.pending).toBe(true);
    expect(edited({ ...one, applied: { ...onToday.applied!, pending: false } }, { kind: 'remove', name: 'Rotation 1', position: 1 }).applied?.pending).toBe(false);
    // Yesterday's is not today's.
    const yesterday = book({ applied: { name: 'Rotation 1', day: '2026-10-02', at: 0, by: 'schedule', pending: false } });
    expect(edited(yesterday, { kind: 'add', name: 'Rotation 1', entry: ZESTAFONA }).applied).toBe(yesterday.applied);
  });

  it('deletes a rotation and the days it was planned for', () => {
    const planned = book({ week: ['Weekend', null, null, null, null, 'Weekend', 'Rotation 1'] });
    const deleted = edited(planned, { kind: 'delete', name: 'weekend' });
    expect(deleted.rotations.map((r) => r.name)).toEqual(['Rotation 1']);
    expect(deleted.week).toEqual([null, null, null, null, null, null, 'Rotation 1']);
  });
});

describe('planToday', () => {
  const planned = book({ week: ['Rotation 1', 'Rotation 1', 'Rotation 1', 'Rotation 1', 'Rotation 1', 'Weekend', 'Weekend'] });

  it("puts the day's rotation on as the day starts", () => {
    expect(planToday(planned, SATURDAY, NOW).applied).toEqual({ name: 'Weekend', day: '2026-10-03', at: NOW, by: 'schedule', pending: true });
  });

  it("leaves a choice made earlier the same day, and a day with nothing planned", () => {
    const chosen = { ...planned, applied: { name: 'Rotation 1', day: '2026-10-03', at: 0, by: '42', pending: false } };
    expect(planToday(chosen, SATURDAY, NOW)).toBe(chosen);
    const nothing = book();
    expect(planToday(nothing, SATURDAY, NOW)).toBe(nothing);
    const bare = { ...planned, rotations: [{ name: 'Weekend', entries: [] }] };
    expect(planToday(bare, SATURDAY, NOW)).toBe(bare);
  });

  it('moves on from yesterday', () => {
    const yesterday = { ...planned, applied: { name: 'Rotation 1', day: '2026-10-02', at: 0, by: '42', pending: true } };
    expect(planToday(yesterday, SATURDAY, NOW).applied).toMatchObject({ name: 'Weekend', day: '2026-10-03' });
  });
});

const ini = (lines: string[]): string => `${lines.join('\n')}\n`;

const settings = ini([
  '[/Script/WDGame.WDGameSession]',
  'ServerName=gaminginit #1',
  '',
  '[/Script/WDGame.WDServerMapRotationSettings]',
  'bEnabled=True',
  'RotationMode=Ordered',
  '+RotationEntries=(Map="Kavkazi",Experience="Kavkazi_KOTH_01",Lighting="DayClear")',
  '+RotationEntries=(Map="Europe",Experiences="Europe_KOTH_01+KOTH_InfantryOnly")',
  '; the late map',
  '',
  '[/Script/Engine.GameSession]',
  'MaxPlayers=100',
]);

describe('the rotation in ServerSettings.ini', () => {
  it('reads one experience from Experience, several from Experiences, and leaves out what is not set', () => {
    expect(serverEntries(settings)).toEqual([BAKURANI, OZETI]);
    expect(parseEntry('(Map=Kavkazi, Lighting="DayEndClear")')).toEqual({ map: 'Kavkazi', lighting: 'DayEndClear' });
    expect(parseEntry('(Lighting="DayClear")')).toBeNull();
  });

  it('reads the lines as Unreal does: + once, . again, - out, ! empty', () => {
    const text = ini([
      '[/Script/WDGame.WDServerMapRotationSettings]',
      '+RotationEntries=(Map="Europe")',
      '!RotationEntries=ClearArray',
      '+RotationEntries=(Map="Kavkazi")',
      '+RotationEntries=(Map="kavkazi")',
      '.RotationEntries=(Map="Kavkazi")',
      'RotationEntries=(Map="NorthAmerica")',
      '-RotationEntries=(Map="NorthAmerica")',
    ]);
    expect(serverEntries(text)).toEqual([{ map: 'Kavkazi' }, { map: 'Kavkazi' }]);
  });

  it('replaces the entries where they were, and leaves every other line alone', () => {
    const text = setRotationEntries(settings, [ZESTAFONA, BAKURANI]);
    expect(text).toBe(
      ini([
        '[/Script/WDGame.WDGameSession]',
        'ServerName=gaminginit #1',
        '',
        '[/Script/WDGame.WDServerMapRotationSettings]',
        'bEnabled=True',
        'RotationMode=Ordered',
        '+RotationEntries=(Map="NorthAmerica",Experience="NorthAmerica_KOTH_01",ZoneAlternator="ZoneAlternator.Zestafona.Default.Circle")',
        '+RotationEntries=(Map="Kavkazi",Experience="Kavkazi_KOTH_01",Lighting="DayClear")',
        '; the late map',
        '',
        '[/Script/Engine.GameSession]',
        'MaxPlayers=100',
      ]),
    );
    expect(serverEntries(text)).toEqual([ZESTAFONA, BAKURANI]);
  });

  it('writes a map that comes again with the same setup with ., so the server keeps both', () => {
    const text = setRotationEntries(settings, [BAKURANI, OZETI, BAKURANI]);
    expect(text).toContain('.RotationEntries=(Map="Kavkazi",Experience="Kavkazi_KOTH_01",Lighting="DayClear")');
    expect(serverEntries(text)).toEqual([BAKURANI, OZETI, BAKURANI]);
  });

  it('adds the entries to a section without any, or a new section, keeping Windows line endings', () => {
    const bare = '[/Script/WDGame.WDServerMapRotationSettings]\r\nbEnabled=True\r\n\r\n[/Script/Engine.GameSession]\r\nMaxPlayers=100\r\n';
    expect(setRotationEntries(bare, [{ map: 'Europe' }])).toBe(
      '[/Script/WDGame.WDServerMapRotationSettings]\r\nbEnabled=True\r\n+RotationEntries=(Map="Europe")\r\n\r\n[/Script/Engine.GameSession]\r\nMaxPlayers=100\r\n',
    );
    expect(setRotationEntries('[/Script/Engine.GameSession]\nMaxPlayers=100\n', [{ map: 'Europe' }])).toBe(
      '[/Script/Engine.GameSession]\nMaxPlayers=100\n\n[/Script/WDGame.WDServerMapRotationSettings]\n+RotationEntries=(Map="Europe")\n',
    );
  });

  it('refuses to write anything that is not an id, and a file with the section twice', () => {
    expect(() => setRotationEntries(settings, [{ map: 'Kavkazi", Lighting="x' }])).toThrow(/not made of ids/);
    expect(() => setRotationEntries(`${settings}[/Script/WDGame.WDServerMapRotationSettings]\n`, [BAKURANI])).toThrow(/more than once/);
  });
});

describe('putRotation', () => {
  const ok: ConfigResult = { ok: true, errors: [], ignored: [] };
  const file = (config: Partial<ServerConfig> = {}, result: ConfigResult = ok) => ({
    fetchConfig: vi.fn(async (): Promise<ServerConfig> => ({ revision: '7', writable: true, text: settings, ...config })),
    validate: vi.fn(async () => result),
    put: vi.fn(async () => result),
  });

  it('checks the new file, then writes it against the revision it read', async () => {
    const server = file();
    await expect(putRotation(server, [ZESTAFONA])).resolves.toBe(true);
    const text = setRotationEntries(settings, [ZESTAFONA]);
    expect(server.validate).toHaveBeenCalledWith(text);
    expect(server.put).toHaveBeenCalledWith({ revision: '7', writable: true, text });
  });

  it('writes nothing when the server has these maps already', async () => {
    const server = file();
    await expect(putRotation(server, [BAKURANI, OZETI])).resolves.toBe(false);
    expect(server.put).not.toHaveBeenCalled();
  });

  it('says why when the server cannot take it', async () => {
    await expect(putRotation(file({ writable: false }), [ZESTAFONA])).rejects.toThrow(/read-only/);
    await expect(putRotation(file({}, { ok: false, errors: ['bad line 7'], ignored: [] }), [ZESTAFONA])).rejects.toThrow(/refused the change: bad line 7/);
    await expect(putRotation(file({}, { ok: true, errors: [], ignored: ['RotationEntries'] }), [ZESTAFONA])).rejects.toThrow(/ignores RotationEntries/);
    const server = file();
    await expect(putRotation(server, [])).rejects.toThrow(/no maps/);
    expect(server.fetchConfig).not.toHaveBeenCalled();
  });
});
