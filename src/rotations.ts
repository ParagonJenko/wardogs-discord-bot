import { z } from 'zod';
import { appendSection, refusal, sectionLines, sectionRange } from './ini.ts';
import type { ConfigResult, MatchSetup, ServerConfig } from './rcon.ts';

// Map rotations staff save by name, such as "Rotation 1" and "Weekend", and which one the server plays on each day of
// the week. The bot puts a rotation on the server by writing its maps into ServerSettings.ini, as live builds have no
// other way to change the rotation; the server rebuilds its rotation at once and plays it from the next map change.
// Only the RotationEntries lines are written: whether the rotation is on, and in order or random, stay as they are.

export type RotationEntry = { map: string } & MatchSetup;
export type SavedRotation = { name: string; entries: RotationEntry[] };

// Monday first, as the week is shown.
export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

// The rotation the bot put on the server, or is putting on: its name, the rotation day it is for, when and who chose it
// ("schedule", or a Discord user ID). `pending` until the server has it; the checks keep trying until then.
export type AppliedRotation = { name: string; day: string; at: number; by: string; pending: boolean };

// `week`: each day's rotation by name, Monday first; null leaves the server's rotation as it is that day.
export type RotationBook = { rotations: SavedRotation[]; week: (string | null)[]; applied: AppliedRotation | null };

// The days /rotations schedule offers: one day, or several at once.
export const DAY_CHOICES: { name: string; value: string; days: number[] }[] = [
  ...WEEKDAYS.map((name, day) => ({ name, value: name.toLowerCase(), days: [day] })),
  { name: 'Weekdays (Monday to Friday)', value: 'weekdays', days: [0, 1, 2, 3, 4] },
  { name: 'Weekend (Saturday and Sunday)', value: 'weekend', days: [5, 6] },
  { name: 'Every day', value: 'every-day', days: [0, 1, 2, 3, 4, 5, 6] },
];

export const MAX_ROTATIONS = 10;
// The server takes far more, but this many is already a long day of matches.
export const MAX_ROTATION_MAPS = 100;
export const ROTATION_NAME_MAX = 32;

const EMPTY_BOOK: RotationBook = { rotations: [], week: WEEKDAYS.map(() => null), applied: null };

const EntrySchema = z.object({
  map: z.string(),
  experiences: z.array(z.string()).optional(),
  lighting: z.string().optional(),
  zoneAlternator: z.string().optional(),
});

const BookSchema = z.object({
  rotations: z.array(z.object({ name: z.string(), entries: z.array(EntrySchema) })),
  week: z.array(z.string().nullable()).length(WEEKDAYS.length),
  applied: z.object({ name: z.string(), day: z.string(), at: z.number(), by: z.string(), pending: z.boolean() }).nullable(),
});

// Reads what the store saved. Nothing saved yet means no rotations and nothing planned.
export const parseRotationBook = (raw: unknown): RotationBook => {
  const parsed = BookSchema.safeParse(raw);
  return parsed.success ? parsed.data : EMPTY_BOOK;
};

const HOUR_MS = 60 * 60_000;

// The day a rotation is for, and its weekday (0 is Monday). Days start at `hour` (UTC), so a late night still counts as
// the evening before.
export type RotationDay = { day: string; weekday: number };

export const rotationDay = (now: number, hour: number): RotationDay => {
  const shifted = new Date(now - hour * HOUR_MS);
  return { day: shifted.toISOString().slice(0, 10), weekday: (shifted.getUTCDay() + 6) % 7 };
};

// Names are shown in Discord in bold, so they keep to letters, numbers, spaces and a few marks that cannot restyle them.
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} '&()+.-]*$/u;

export const rotationName = (typed: string): { name: string } | { problem: string } => {
  const name = typed.trim().replace(/\s+/g, ' ');
  if (name === '') return { problem: 'Give the rotation a name, such as "Rotation 1".' };
  if (name.length > ROTATION_NAME_MAX) return { problem: `A rotation's name can be at most ${ROTATION_NAME_MAX} characters.` };
  if (!NAME.test(name)) return { problem: 'A rotation\'s name can have letters, numbers, spaces and - \' & ( ) + . only.' };
  return { name };
};

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

// A saved rotation by name, ignoring case.
export const findRotation = (book: RotationBook, name: string): SavedRotation | null =>
  book.rotations.find((r) => same(r.name, name.trim().replace(/\s+/g, ' '))) ?? null;

// The rotation planned for this day, if it is saved and has maps.
export const plannedRotation = (book: RotationBook, today: RotationDay): SavedRotation | null => {
  const name = book.week[today.weekday];
  const rotation = name ? findRotation(book, name) : null;
  return rotation !== null && rotation.entries.length > 0 ? rotation : null;
};

// The rotation on the server for this day, as the bot put it there (or is putting it there).
export const rotationToday = (book: RotationBook, today: RotationDay): AppliedRotation | null =>
  book.applied?.day === today.day ? book.applied : null;

// At the first check of each day, that day's planned rotation goes on the server. A staff choice made earlier the same
// day stays until the next day.
export const planToday = (book: RotationBook, today: RotationDay, now: number): RotationBook => {
  if (rotationToday(book, today) !== null) return book;
  const planned = plannedRotation(book, today);
  if (planned === null) return book;
  return { ...book, applied: { name: planned.name, day: today.day, at: now, by: 'schedule', pending: true } };
};

// What staff can change. Positions count from 1. `days` are weekdays, 0 for Monday.
export type RotationEdit =
  | { kind: 'add'; name: string; entry: RotationEntry; position?: number }
  | { kind: 'remove'; name: string; position: number }
  | { kind: 'save'; name: string; entries: RotationEntry[] }
  | { kind: 'delete'; name: string }
  | { kind: 'use'; name: string }
  | { kind: 'schedule'; days: number[]; name: string | null };

// `rotation`: the one the edit was about, as saved now (null once deleted, or for a day cleared in the schedule).
export type EditedBook = { book: RotationBook; rotation: SavedRotation | null };

// What happened on the server: it has the rotation now, had it already, or the bot could not put it there yet.
export type RotationServer = { outcome: 'updated' | 'unchanged' } | { outcome: 'failed'; reason: string };

// `server` is there when the edit put a rotation on the server, or tried to.
export type RotationEditResult = { problem: string } | (EditedBook & { server?: RotationServer });

const notSaved = (name: string): { problem: string } => ({ problem: `There's no rotation called "${name.trim()}". Pick one from the list.` });

const withRotation = (book: RotationBook, rotation: SavedRotation): RotationBook => ({
  ...book,
  rotations: book.rotations.some((r) => same(r.name, rotation.name))
    ? book.rotations.map((r) => (same(r.name, rotation.name) ? rotation : r))
    : [...book.rotations, rotation],
});

// Changes the book as staff asked, `by` a Discord user ID. Whatever should now be on the server is left `pending` in
// `applied`, for the caller to put there: the rotation staff picked for today, or today's rotation after its maps changed.
export const editRotations = (
  book: RotationBook,
  edit: RotationEdit,
  { today, now, by }: { today: RotationDay; now: number; by: string },
): EditedBook | { problem: string } => {
  const choose = (next: RotationBook, name: string): RotationBook => ({ ...next, applied: { name, day: today.day, at: now, by, pending: true } });
  // Today's rotation goes on the server again when its maps change, unless it has none left.
  const changed = (next: RotationBook, rotation: SavedRotation): EditedBook => {
    const current = rotationToday(next, today);
    const again = current !== null && same(current.name, rotation.name) && rotation.entries.length > 0;
    return { book: again ? { ...next, applied: { ...current, pending: true } } : next, rotation };
  };

  if (edit.kind === 'schedule') {
    if (edit.days.length === 0 || edit.days.some((d) => !Number.isInteger(d) || d < 0 || d >= WEEKDAYS.length)) {
      return { problem: 'Pick the day from the list.' };
    }
    const rotation = edit.name === null ? null : findRotation(book, edit.name);
    if (edit.name !== null && rotation === null) return notSaved(edit.name);
    if (rotation !== null && rotation.entries.length === 0) {
      return { problem: `**${rotation.name}** has no maps yet. Add some with /rotations add first.` };
    }
    const week = book.week.map((name, day) => (edit.days.includes(day) ? (rotation?.name ?? null) : name));
    const next = { ...book, week };
    // Setting today's rotation puts it on now; clearing today leaves the server as it is.
    return { book: rotation !== null && edit.days.includes(today.weekday) ? choose(next, rotation.name) : next, rotation };
  }

  if (edit.kind === 'add' || edit.kind === 'save') {
    const named = rotationName(edit.name);
    if ('problem' in named) return named;
    const existing = findRotation(book, named.name);
    if (existing === null && book.rotations.length >= MAX_ROTATIONS) {
      return { problem: `There are already ${MAX_ROTATIONS} rotations. Delete one with /rotations delete first.` };
    }
    const name = existing?.name ?? named.name;
    if (edit.kind === 'save') {
      if (edit.entries.length === 0) return { problem: "The server's rotation has no maps, so there's nothing to save." };
      if (edit.entries.length > MAX_ROTATION_MAPS) return { problem: `A rotation can have at most ${MAX_ROTATION_MAPS} maps.` };
      const rotation = { name, entries: edit.entries };
      return changed(withRotation(book, rotation), rotation);
    }
    const entries = existing?.entries ?? [];
    if (entries.length >= MAX_ROTATION_MAPS) return { problem: `**${name}** already has ${MAX_ROTATION_MAPS} maps, the most a rotation can have.` };
    const at = edit.position === undefined ? entries.length : Math.min(Math.max(1, Math.trunc(edit.position)), entries.length + 1) - 1;
    const rotation = { name, entries: [...entries.slice(0, at), edit.entry, ...entries.slice(at)] };
    return changed(withRotation(book, rotation), rotation);
  }

  const existing = findRotation(book, edit.name);
  if (existing === null) return notSaved(edit.name);

  if (edit.kind === 'remove') {
    const at = Math.trunc(edit.position) - 1;
    if (!(at >= 0 && at < existing.entries.length)) return { problem: `Pick a map from **${existing.name}**'s list.` };
    const rotation = { name: existing.name, entries: existing.entries.filter((_, i) => i !== at) };
    return changed(withRotation(book, rotation), rotation);
  }

  if (edit.kind === 'delete') {
    // The server keeps its maps, and so do the days it was planned for.
    const rotations = book.rotations.filter((r) => r !== existing);
    const week = book.week.map((name) => (name !== null && same(name, existing.name) ? null : name));
    return { book: { ...book, rotations, week }, rotation: null };
  }

  // use
  if (existing.entries.length === 0) return { problem: `**${existing.name}** has no maps yet. Add some with /rotations add first.` };
  return { book: choose(book, existing.name), rotation: existing };
};

// The rotation in ServerSettings.ini: `+RotationEntries=(Map="Kavkazi",Experience="Kavkazi_KOTH_01",Lighting="DayClear")`
// lines in this section. One experience goes in `Experience`, several in `Experiences` joined by `+`: the server
// ignores an entry with the wrong one. A setting left out is the map's own.
const SECTION = '[/Script/WDGame.WDServerMapRotationSettings]';
// As Unreal reads it: `+` adds an entry unless the same one is there already, `.` or no prefix adds it anyway, `-` takes
// one out, and `!` empties the list so far.
const ENTRY_LINE = /^\s*([+.!-]?)RotationEntries\s*=\s*(.*?)\s*$/i;
const FIELD = /(\w+)\s*=\s*(?:"([^"]*)"|([^,)]*))/g;
const ID = /^[A-Za-z0-9_.-]+$/;

export const parseEntry = (value: string): RotationEntry | null => {
  const inner = value.trim().replace(/^\(/, '').replace(/\)$/, '');
  const fields = new Map<string, string>();
  for (const m of inner.matchAll(FIELD)) fields.set((m[1] ?? '').toLowerCase(), (m[2] ?? m[3] ?? '').trim());
  const map = fields.get('map');
  if (!map) return null;
  const experiences = (fields.get('experiences') ?? fields.get('experience') ?? '')
    .split('+')
    .map((e) => e.trim())
    .filter((e) => e !== '');
  const lighting = fields.get('lighting');
  const zoneAlternator = fields.get('zonealternator');
  return {
    map,
    ...(experiences.length > 0 ? { experiences } : {}),
    ...(lighting ? { lighting } : {}),
    ...(zoneAlternator ? { zoneAlternator } : {}),
  };
};

const entryValue = (entry: RotationEntry): string => {
  const experiences = entry.experiences ?? [];
  if (![entry.map, ...experiences, entry.lighting ?? 'x', entry.zoneAlternator ?? 'x'].every((id) => ID.test(id))) {
    throw new Error(`refusing to write a rotation entry that is not made of ids: ${JSON.stringify(entry)}`);
  }
  const fields = [
    `Map="${entry.map}"`,
    ...(experiences.length === 1 ? [`Experience="${experiences[0]}"`] : []),
    ...(experiences.length > 1 ? [`Experiences="${experiences.join('+')}"`] : []),
    ...(entry.lighting ? [`Lighting="${entry.lighting}"`] : []),
    ...(entry.zoneAlternator ? [`ZoneAlternator="${entry.zoneAlternator}"`] : []),
  ];
  return `(${fields.join(',')})`;
};

// Two entries are the same when they say the same, ignoring case as Unreal does.
const key = (entry: RotationEntry): string =>
  JSON.stringify([entry.map, entry.experiences ?? [], entry.lighting ?? '', entry.zoneAlternator ?? '']).toLowerCase();

// The maps the file's rotation has, in order.
export const serverEntries = (text: string): RotationEntry[] =>
  sectionLines(text, SECTION).reduce<RotationEntry[]>((list, line) => {
    const match = ENTRY_LINE.exec(line);
    if (match === null) return list;
    const [, op, value = ''] = match;
    if (op === '!') return [];
    const entry = parseEntry(value);
    if (entry === null) return list;
    if (op === '-') return list.filter((e) => key(e) !== key(entry));
    if (op === '+' && list.some((e) => key(e) === key(entry))) return list;
    return [...list, entry];
  }, []);

// The file with its rotation replaced by these maps, written where the old ones were (or at the end of the section).
// A map that comes again with the same setup is written with `.`, as `+` would skip it.
export const setRotationEntries = (text: string, entries: RotationEntry[]): string => {
  const seen = new Set<string>();
  const written = entries.map((entry) => {
    const again = seen.has(key(entry));
    seen.add(key(entry));
    return `${again ? '.' : '+'}RotationEntries=${entryValue(entry)}`;
  });
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const { start, end } = sectionRange(lines, SECTION);
  if (start === -1) return appendSection(text, SECTION, written);
  const section = lines.slice(start + 1, end);
  const isEntry = (line: string): boolean => ENTRY_LINE.test(line);
  const first = section.findIndex(isEntry);
  const kept = section.filter((line) => !isEntry(line));
  // Without old ones: after the section's last line with something on it, so a blank line before the next stays.
  kept.splice(first === -1 ? kept.findLastIndex((line) => line.trim() !== '') + 1 : first, 0, ...written);
  return [...lines.slice(0, start + 1), ...kept, ...lines.slice(end)].join(eol);
};

const sameEntries = (a: RotationEntry[], b: RotationEntry[]): boolean =>
  a.length === b.length && a.every((entry, i) => b[i] !== undefined && key(entry) === key(b[i]));

type SettingsFile = {
  fetchConfig: () => Promise<ServerConfig>;
  validate: (text: string) => Promise<ConfigResult>;
  put: (config: ServerConfig) => Promise<ConfigResult>;
};

// Puts these maps in the server's rotation. False when it had exactly these already, so nothing was written. Throws
// with the reason when the server cannot be read, or would refuse or ignore the change.
export const putRotation = async (file: SettingsFile, entries: RotationEntry[]): Promise<boolean> => {
  if (entries.length === 0) throw new Error('refusing to leave the server with no maps');
  const config = await file.fetchConfig();
  if (sameEntries(serverEntries(config.text), entries)) return false;
  if (!config.writable) throw new Error('the server settings are read-only over RCON');
  const text = setRotationEntries(config.text, entries);
  const problem = refusal(await file.validate(text), 'RotationEntries') ?? refusal(await file.put({ ...config, text }), 'RotationEntries');
  if (problem !== null) throw new Error(problem);
  return true;
};
