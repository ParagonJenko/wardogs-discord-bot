import { describe, expect, it, vi } from 'vitest';
import type { ConfigResult, Rotation, ServerConfig } from '../src/rcon.ts';
import {
  aroundPlace,
  DEFAULT_ROTATION,
  editRotations,
  inSavedOrder,
  lastPutOnFirst,
  parseEntry,
  parseRotationBook,
  planToday,
  putRotation,
  rotationDay,
  rotationName,
  rotationPlace,
  hasDefault,
  seedDefault,
  serverEntries,
  setRotationEntries,
  type RotationBook,
  type RotationEntry,
  type RotationPlace,
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
    expect(editRotations(book(), { kind: 'save', name: 'New', entries: [] }, at)).toEqual({ problem: 'A rotation needs at least one map.' });
    expect(editRotations(book(), { kind: 'save', name: 'New', entries: [{ map: 'Kavkazi', lighting: 'Day"Clear' }] }, at)).toEqual({
      problem: expect.stringMatching(/aren't ones the server knows/),
    });
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

describe('the Default rotation', () => {
  const withDefault = (changes: Partial<RotationBook> = {}): RotationBook => {
    const start = book(changes);
    return { ...start, rotations: [{ name: DEFAULT_ROTATION, entries: [OZETI] }, ...start.rotations] };
  };

  it("starts as the server's rotation, once, first in the list", () => {
    const seeded = seedDefault(book(), [BAKURANI, ZESTAFONA]);
    expect(seeded.rotations[0]).toEqual({ name: 'Default', entries: [BAKURANI, ZESTAFONA] });
    expect(seedDefault(seeded, [OZETI])).toBe(seeded);
    const nothing = book();
    expect(seedDefault(nothing, [])).toBe(nothing);
  });

  it('takes over a rotation staff already called "Default": an empty one gets the server\'s maps, one with maps keeps them', () => {
    const legacy = (entries: RotationEntry[]): RotationBook => ({ ...book(), rotations: [...book().rotations, { name: 'default', entries }] });
    const filled = seedDefault(legacy([]), [ZESTAFONA]);
    expect(filled.rotations.at(-1)).toEqual({ name: 'Default', entries: [ZESTAFONA] });
    expect(hasDefault(filled)).toBe(true);
    const kept = seedDefault(legacy([BAKURANI]), []);
    expect(kept.rotations.at(-1)).toEqual({ name: 'Default', entries: [BAKURANI] });
    // Empty, and nothing from the server: still not set up.
    expect(hasDefault(seedDefault(legacy([]), []))).toBe(false);
  });

  it("doesn't count against the most rotations staff can save", () => {
    const ten: RotationBook = { ...empty, rotations: Array.from({ length: 10 }, (_, i) => ({ name: `R${i}`, entries: [BAKURANI] })) };
    const seeded = seedDefault(ten, [OZETI]);
    expect(seeded.rotations).toHaveLength(11);
    expect(editRotations(seeded, { kind: 'add', name: 'R10', entry: BAKURANI }, at)).toEqual({ problem: expect.stringMatching(/already 10/) });
    expect(editRotations(seeded, { kind: 'add', name: 'Default', entry: BAKURANI }, at)).not.toHaveProperty('problem');
    // A full book without Default can still have one.
    expect(editRotations(ten, { kind: 'save', name: 'default', entries: [OZETI] }, at)).not.toHaveProperty('problem');
  });

  it('plays on every day without a rotation of its own, or whose rotation has no maps', () => {
    const start = withDefault({ week: [null, null, null, null, null, 'Weekend', 'Gone'] });
    expect(planToday(start, SATURDAY, NOW).applied).toMatchObject({ name: 'Weekend' });
    expect(planToday(start, rotationDay(Date.UTC(2026, 9, 4, 12), 5), NOW).applied).toMatchObject({ name: 'Default', by: 'schedule' });
    expect(planToday(start, rotationDay(Date.UTC(2026, 9, 5, 12), 5), NOW).applied).toMatchObject({ name: 'Default' });
  });

  it('is what a day goes back to, at once when it is today', () => {
    const start = withDefault({ week: [null, null, null, null, null, 'Weekend', 'Weekend'] });
    const cleared = edited(start, { kind: 'schedule', days: [5, 6], name: null });
    expect(cleared.week).toEqual([null, null, null, null, null, null, null]);
    expect(cleared.applied).toMatchObject({ name: 'Default', day: '2026-10-03', pending: true });
    // Picking Default is the same as picking nothing.
    expect(edited(start, { kind: 'schedule', days: [5], name: 'default' }).week[5]).toBeNull();
  });

  it("can't be deleted, renamed or emptied, and no other rotation takes its name", () => {
    const start = withDefault();
    expect(editRotations(start, { kind: 'delete', name: 'default' }, at)).toEqual({ problem: expect.stringMatching(/can't be deleted/) });
    expect(editRotations(start, { kind: 'rename', name: 'Default', to: 'Old' }, at)).toEqual({ problem: expect.stringMatching(/keeps its name/) });
    expect(editRotations(start, { kind: 'rename', name: 'Weekend', to: 'DEFAULT' }, at)).toEqual({ problem: expect.stringMatching(/is taken/) });
    expect(editRotations(start, { kind: 'remove', name: 'Default', position: 1 }, at)).toEqual({ problem: expect.stringMatching(/at least one map/) });
  });

  it("puts Default on when today's rotation is deleted", () => {
    const start = withDefault({ week: [null, null, null, null, null, 'Weekend', null], applied: { name: 'Weekend', day: '2026-10-03', at: 0, by: 'schedule', pending: false } });
    const deleted = edited(start, { kind: 'delete', name: 'Weekend' });
    expect(deleted.week[5]).toBeNull();
    expect(deleted.applied).toMatchObject({ name: 'Default', pending: true, by: '42' });
  });
});

describe('renaming', () => {
  it('renames a rotation everywhere it is used, and saves its maps as it renames it', () => {
    const start = book({ week: ['Rotation 1', null, null, null, null, 'Rotation 1', null], applied: { name: 'Rotation 1', day: '2026-10-03', at: 0, by: 'schedule', pending: false } });
    const renamed = edited(start, { kind: 'rename', name: 'rotation 1', to: 'Weekday mix' });
    expect(renamed.rotations[0]?.name).toBe('Weekday mix');
    expect(renamed.week).toEqual(['Weekday mix', null, null, null, null, 'Weekday mix', null]);
    expect(renamed.applied).toMatchObject({ name: 'Weekday mix', pending: false });

    const saved = edited(start, { kind: 'save', from: 'Rotation 1', name: 'Weekday mix', entries: [ZESTAFONA] });
    expect(saved.rotations[0]).toEqual({ name: 'Weekday mix', entries: [ZESTAFONA] });
    // Today's rotation changed its maps, so it goes on again.
    expect(saved.applied).toMatchObject({ name: 'Weekday mix', pending: true });
    expect(editRotations(start, { kind: 'rename', name: 'Rotation 1', to: 'weekend' }, at)).toEqual({ problem: expect.stringMatching(/already a rotation called \*\*Weekend/) });
    expect(edited(start, { kind: 'save', from: 'Rotation 1', name: 'ROTATION 1', entries: [ZESTAFONA] }).rotations[0]?.name).toBe('ROTATION 1');
  });

  it('notes who chose the rotation by the name they go by', () => {
    const result = editRotations(book(), { kind: 'use', name: 'Weekend' }, { ...at, byName: 'Sarge' });
    expect('book' in result && result.book.applied).toMatchObject({ by: '42', byName: 'Sarge' });
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
  const file = (config: Partial<ServerConfig> = {}, result: ConfigResult = ok, place: RotationPlace | null = null) => ({
    fetchConfig: vi.fn(async (): Promise<ServerConfig> => ({ revision: '7', writable: true, text: settings, ...config })),
    validate: vi.fn(async () => result),
    put: vi.fn(async () => result),
    place: vi.fn(async () => place),
  });

  it('checks the new file, then writes it against the revision it read', async () => {
    const server = file();
    await expect(putRotation(server, [ZESTAFONA])).resolves.toEqual({ written: true, next: null });
    const text = setRotationEntries(settings, [ZESTAFONA]);
    expect(server.validate).toHaveBeenCalledWith(text);
    expect(server.put).toHaveBeenCalledWith({ revision: '7', writable: true, text });
  });

  it('carries on from where the server is, so the map just played does not come again', async () => {
    // Bakurani is on, from the first slot. Written from the top, the second slot would send the server back to it.
    const server = file({}, ok, { slot: 0, playing: BAKURANI });
    await expect(putRotation(server, [OZETI, BAKURANI, ZESTAFONA])).resolves.toEqual({ written: true, next: ZESTAFONA });
    const text = setRotationEntries(settings, [BAKURANI, ZESTAFONA, OZETI]);
    expect(server.put).toHaveBeenCalledWith({ revision: '7', writable: true, text });
  });

  it('writes nothing when the server has these maps in the same order round, so it keeps its place', async () => {
    const server = file({}, ok, { slot: 1, playing: OZETI });
    await expect(putRotation(server, [BAKURANI, OZETI])).resolves.toEqual({ written: false });
    await expect(putRotation(server, [OZETI, BAKURANI])).resolves.toEqual({ written: false });
    expect(server.place).not.toHaveBeenCalled();
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

  it('writes nothing when it cannot tell where the server is', async () => {
    const server = file();
    server.place.mockRejectedValueOnce(new Error('RCON timed out'));
    await expect(putRotation(server, [ZESTAFONA])).rejects.toThrow(/timed out/);
    expect(server.put).not.toHaveBeenCalled();
  });
});

describe('aroundPlace', () => {
  const DUSK: RotationEntry = { ...BAKURANI, lighting: 'DayEndClear' };
  // The map the server plays next: the one in the slot after its own.
  const next = (written: RotationEntry[], place: RotationPlace): RotationEntry | undefined => written[(place.slot + 1) % written.length];

  it('puts the map after the one being played in the slot after the server\'s, keeping the order round', () => {
    const place = { slot: 2, playing: BAKURANI };
    const written = aroundPlace([OZETI, BAKURANI, ZESTAFONA], place);
    expect(written).toEqual([ZESTAFONA, OZETI, BAKURANI]);
    expect(next(written, place)).toEqual(ZESTAFONA);
    // A slot past the end of the new list counts on round it.
    expect(next(aroundPlace([OZETI, BAKURANI, ZESTAFONA], { slot: 4, playing: BAKURANI }), { slot: 4, playing: null })).toEqual(ZESTAFONA);
  });

  it('goes back to the first map after the last', () => {
    expect(aroundPlace([OZETI, ZESTAFONA, BAKURANI], { slot: 0, playing: BAKURANI })).toEqual([BAKURANI, OZETI, ZESTAFONA]);
  });

  it('starts with the rotation\'s first map when the map being played is not in it', () => {
    const place = { slot: 0, playing: BAKURANI };
    const written = aroundPlace([OZETI, ZESTAFONA], place);
    expect(next(written, place)).toEqual(OZETI);
    expect(aroundPlace([OZETI, ZESTAFONA], { slot: 2, playing: null })).toEqual([ZESTAFONA, OZETI]);
  });

  it('finds the map being played by its setup first, and else by its map', () => {
    const entries = [DUSK, OZETI, BAKURANI, ZESTAFONA];
    expect(next(aroundPlace(entries, { slot: 0, playing: BAKURANI }), { slot: 0, playing: null })).toEqual(ZESTAFONA);
    expect(next(aroundPlace(entries, { slot: 0, playing: { map: 'kavkazi' } }), { slot: 0, playing: null })).toEqual(OZETI);
  });

  it('writes the rotation as it is without a place', () => {
    expect(aroundPlace([OZETI, BAKURANI], null)).toEqual([OZETI, BAKURANI]);
  });
});

describe('rotationPlace', () => {
  const rotation = (entries: Rotation['entries']): Rotation => ({ enabled: true, mode: 'ordered', entries });

  it('reads the slot marked now, with that entry\'s setup when it is the map being played', () => {
    const server = rotation([
      { ...OZETI, status: null },
      { ...BAKURANI, status: 'now' },
      { ...ZESTAFONA, status: 'next' },
    ]);
    expect(rotationPlace(server, { map: 'Kavkazi', rotationIndex: 1 })).toEqual({ slot: 1, playing: BAKURANI });
    expect(rotationPlace(server, { map: '', rotationIndex: 1 })).toEqual({ slot: 1, playing: BAKURANI });
    // Staff changed the map: the slot stays, and the map is the one being played.
    expect(rotationPlace(server, { map: 'Europe', rotationIndex: 1 })).toEqual({ slot: 1, playing: { map: 'Europe' } });
  });

  it('takes the status\'s slot when no entry is marked, and is null when neither says', () => {
    const server = rotation([{ ...OZETI, status: null }]);
    expect(rotationPlace(server, { map: 'Kavkazi', rotationIndex: 3 })).toEqual({ slot: 3, playing: { map: 'Kavkazi' } });
    expect(rotationPlace(server, { map: 'Kavkazi', rotationIndex: null })).toBeNull();
  });
});

describe('inSavedOrder', () => {
  const saved = [
    { name: 'Default', entries: [BAKURANI] },
    { name: 'Rotation 1', entries: [BAKURANI, OZETI, ZESTAFONA] },
  ];

  it('turns the server\'s list to start where the saved rotation does', () => {
    const server = [{ ...ZESTAFONA, status: 'next' }, { ...BAKURANI, status: null }, { ...OZETI, status: 'now' }];
    expect(inSavedOrder(server, saved)).toEqual([
      { ...BAKURANI, status: null },
      { ...OZETI, status: 'now' },
      { ...ZESTAFONA, status: 'next' },
    ]);
  });

  it('matches by map when the server reports a setting differently', () => {
    expect(inSavedOrder([{ map: 'Europe' }, { map: 'NorthAmerica' }, { map: 'Kavkazi' }], saved).map((e) => e.map)).toEqual([
      'Kavkazi',
      'Europe',
      'NorthAmerica',
    ]);
  });

  it('leaves a list that is no saved rotation as it is', () => {
    expect(inSavedOrder([OZETI, BAKURANI, BAKURANI], saved)).toEqual([OZETI, BAKURANI, BAKURANI]);
  });

  it('tries the rotation put on last first', () => {
    const applied = { name: 'Rotation 1', day: '2026-10-03', at: 1, by: 'schedule', pending: false };
    expect(lastPutOnFirst({ ...book(), applied }).map((r) => r.name)).toEqual(['Rotation 1', 'Weekend']);
    expect(lastPutOnFirst(book()).map((r) => r.name)).toEqual(['Rotation 1', 'Weekend']);
    expect(lastPutOnFirst(book({ applied: { ...applied, name: 'Weekend' } })).map((r) => r.name)).toEqual(['Weekend', 'Rotation 1']);
  });
});
