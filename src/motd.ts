import { z } from 'zod';
import { readJsonBody } from './body.ts';
import { appendSection, refusal, sectionLines, sectionRange } from './ini.ts';
import { RconError, type ConfigResult, type ServerConfig } from './rcon.ts';

// The welcome popup players see when they join: the lines in ServerSettings.ini under WDGameStateSession, and whether
// it shows at all. Staff edit it on the staff page. Only those two keys are written, and the section applies from the
// next match.
//
// In the file each line is the popup line HTML-escaped once, so `<Italic>Fish &amp; chips</>` is stored as
// `&lt;Italic&gt;Fish &amp;amp; chips&lt;/&gt;`. One `.ServerWelcomeMessageLines=` per popup line, after a
// `!ServerWelcomeMessageLines=ClearArray`; an empty value is a blank spacer line.

const SECTION = '[/Script/WDGame.WDGameStateSession]';
// As Unreal reads an array: `.` or `+` adds a line, `-` takes one out, and `!` empties the list so far.
const LINE_ENTRY = /^\s*([+.!-]?)ServerWelcomeMessageLines\s*=(.*)$/i;
const ENABLED_ENTRY = /^\s*([+.!-]?)bServerWelcomeMessageEnabled\s*=\s*(.*?)\s*$/i;

export const MOTD_MAX_LINES = 128;
export const MOTD_MAX_CHARS = 128;
export const MOTD_MIN_SIZE = 8;
export const MOTD_MAX_SIZE = 24;

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', quot: '"', amp: '&' };

// A line as it is stored in the file. `&` goes first, so the ones the other three add are not escaped again.
export const escapeMotdLine = (line: string): string =>
  line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// A stored line back as the popup line. One pass, so `&amp;lt;` comes back as `&lt;`, not `<`.
export const unescapeMotdLine = (stored: string): string =>
  stored.replace(/&(lt|gt|quot|amp);/g, (_, name: string) => ENTITIES[name] ?? '');

export type MotdProblem = { line: number | null; problem: string };

const FONTFACES = ['Bold', 'Italic'];
const SMART_QUOTES = /[‘’‚‛“”„‟′″]/;
const PLAIN_TAGS = ['Header', 'Bold', 'Italic'];

// What is wrong with the attributes of a `<text …>` tag, written as `rest` (everything after `text`), or null.
const attributeProblem = (rest: string): string | null => {
  if (SMART_QUOTES.test(rest)) return 'Use straight quotes (") around attribute values, not curly ones.';
  const seen = new Set<string>();
  let left = rest;
  for (;;) {
    const match = /^\s+([A-Za-z]+)="([^"]*)"/.exec(left);
    if (match === null) break;
    const [whole, name = '', value = ''] = match;
    left = left.slice(whole.length);
    if (seen.has(name)) return `The ${name} attribute is there twice.`;
    seen.add(name);
    if (name === 'color') {
      if (!/^#[0-9A-Fa-f]{6}$/.test(value)) return `color must be like #E8A33D (a # and six hex digits), not "${value}".`;
    } else if (name === 'size') {
      const size = /^\d+$/.test(value) ? Number(value) : NaN;
      if (!(size >= MOTD_MIN_SIZE && size <= MOTD_MAX_SIZE)) return `size must be a whole number from ${MOTD_MIN_SIZE} to ${MOTD_MAX_SIZE}, not "${value}".`;
    } else if (name === 'fontface') {
      if (!FONTFACES.includes(value)) return `fontface must be "Bold" or "Italic", not "${value}".`;
    } else {
      return `<text> has no ${name} attribute. It takes color, size and fontface.`;
    }
  }
  return left.trim() === '' ? null : 'Write attributes as name="value", with straight double quotes, such as size="16".';
};

// What is wrong inside one tag, `<inner>`, or null when it is one of the game's.
const tagProblem = (inner: string): string | null => {
  const name = /^[A-Za-z]*/.exec(inner)?.[0] ?? '';
  const rest = inner.slice(name.length);
  if (name === 'text' && (rest === '' || /^\s/.test(rest))) return attributeProblem(rest);
  if (PLAIN_TAGS.includes(name)) {
    if (rest === '') return null;
    return name === 'Header' ? '<Header> takes no attributes.' : `<${name}> takes no attributes. Use <text …> for colour or size.`;
  }
  const known = [...PLAIN_TAGS, 'text'].find((tag) => tag.toLowerCase() === name.toLowerCase());
  if (known !== undefined && rest === '') return `Tags are case sensitive: write <${known}>.`;
  if (name === '') return 'A "<" has to start a tag. To show it, write &lt;.';
  return `<${name}> isn't a tag the game knows (a link is refused too). Use <Header>, <Bold>, <Italic> or <text …>.`;
};

// How many characters a line shows, and what is wrong with it. Tags are not counted, and each of &lt; &gt; &amp; &quot;
// counts as one.
export const checkMotdLine = (line: string): { visible: number; problems: string[] } => {
  const problems: string[] = [];
  const add = (problem: string): void => {
    if (!problems.includes(problem)) problems.push(problem);
  };
  let visible = 0;
  // The tag being written, and whether it was a bad one (already reported, so its </> and its end are not).
  let open: { name: string; bad: boolean } | null = null;
  let i = 0;
  while (i < line.length) {
    const c = line.charAt(i);
    if (c === '<') {
      if (line.startsWith('</>', i)) {
        if (open === null) add('There is a </> with no tag to close.');
        open = null;
        i += 3;
        continue;
      }
      const end = line.indexOf('>', i);
      if (end === -1) {
        add('A "<" with no ">" after it. To show it, write &lt;.');
        i += 1;
        continue;
      }
      const inner = line.slice(i + 1, end);
      const problem = tagProblem(inner);
      if (problem !== null) add(problem);
      else if (open !== null) add(`Tags can't be inside each other: close <${open.name}> with </> first.`);
      if (open === null) open = { name: /^[A-Za-z]*/.exec(inner)?.[0] ?? '', bad: problem !== null };
      i = end + 1;
      continue;
    }
    if (c === '>') add('A ">" on its own. To show it, write &gt;.');
    if (c === '"') add('A " in the text. To show it, write &quot;.');
    if (c === '\r' || c === '\n') add("A line can't have a line break in it.");
    if (c === '&') {
      const entity = /^&(lt|gt|quot|amp);/.exec(line.slice(i, i + 6));
      if (entity === null) {
        add('A "&" on its own. To show it, write &amp;.');
      } else {
        visible += 1;
        i += entity[0].length;
        continue;
      }
    }
    // Counted by character, not by UTF-16 unit.
    const code = line.codePointAt(i) ?? 0;
    visible += 1;
    i += code > 0xffff ? 2 : 1;
  }
  if (open !== null && !open.bad) add(`<${open.name}> is never closed. End it with </>.`);
  if (visible > MOTD_MAX_CHARS) add(`${visible} characters shown, but a line can have at most ${MOTD_MAX_CHARS}.`);
  return { visible, problems };
};

// Everything wrong with a message, by line from 1. A problem with the message as a whole has no line.
export const validateMotd = (lines: string[]): MotdProblem[] => [
  ...(lines.length > MOTD_MAX_LINES ? [{ line: null, problem: `${lines.length} lines, but a message can have at most ${MOTD_MAX_LINES}.` }] : []),
  ...lines.flatMap((line, i) => checkMotdLine(line).problems.map((problem) => ({ line: i + 1, problem }))),
];

// What the file says now: whether the popup shows, and its lines as the popup shows them. Missing keys read as off and no
// lines.
export const parseMotd = (text: string): { enabled: boolean; lines: string[] } => {
  const section = sectionLines(text, SECTION);
  const enabled = section.reduce((on, line) => {
    const match = ENABLED_ENTRY.exec(line);
    return match === null ? on : /^(true|1|yes|on)$/i.test(match[2] ?? '');
  }, false);
  const lines = section.reduce<string[]>((list, line) => {
    const match = LINE_ENTRY.exec(line);
    if (match === null) return list;
    const [, op, value = ''] = match;
    if (op === '!') return [];
    if (op === '-') return list.filter((stored) => stored !== value);
    return [...list, value];
  }, []);
  return { enabled, lines: lines.map(unescapeMotdLine) };
};

// The file with the popup's two keys set, in place of the old ones (or after the section's last line, or in a new
// section). Every other line stays as it was. The lines are written as a fresh list: cleared, then one per line.
export const setMotd = (text: string, enabled: boolean, lines: string[]): string => {
  if (lines.some((line) => /[\r\n]/.test(line))) throw new Error('refusing to write a welcome message line with a line break');
  const flag = (prefix: string) => `${prefix}bServerWelcomeMessageEnabled=${enabled ? 'True' : 'False'}`;
  const array = ['!ServerWelcomeMessageLines=ClearArray', ...lines.map((line) => `.ServerWelcomeMessageLines=${escapeMotdLine(line)}`)];
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const all = text.split(/\r?\n/);
  const { start, end } = sectionRange(all, SECTION);
  if (start === -1) return appendSection(text, SECTION, [flag(''), ...array]);
  const section = all.slice(start + 1, end);
  const hasFlag = section.some((line) => ENABLED_ENTRY.test(line));
  const hasArray = section.some((line) => LINE_ENTRY.test(line));
  let flagged = false;
  let arrayed = false;
  const out = section.flatMap((line) => {
    const flagMatch = ENABLED_ENTRY.exec(line);
    if (flagMatch !== null) {
      if (flagged) return [];
      flagged = true;
      // A key with no array in the file brings the array with it.
      return [flag(flagMatch[1] ?? ''), ...(hasArray ? [] : array)];
    }
    if (LINE_ENTRY.test(line)) {
      if (arrayed) return [];
      arrayed = true;
      return [...(hasFlag ? [] : [flag('')]), ...array];
    }
    return [line];
  });
  // Neither key was there: after the last line with something on it, so a blank line before the next section stays.
  if (!hasFlag && !hasArray) out.splice(out.findLastIndex((line) => line.trim() !== '') + 1, 0, flag(''), ...array);
  return [...all.slice(0, start + 1), ...out, ...all.slice(end)].join(eol);
};

// The staff page's Welcome message tab.
export type MotdPage = { enabled: boolean; lines: string[]; revision: string; problems: MotdProblem[] };

export const motdPage = (config: ServerConfig): MotdPage => {
  const { enabled, lines } = parseMotd(config.text);
  return { enabled, lines, revision: config.revision, problems: validateMotd(lines) };
};

// What the server did: the section applies from the next match, or the file already said this.
export type MotdOutcome = 'next-match' | 'unchanged';

export type MotdSave =
  | { status: 'saved'; outcome: MotdOutcome }
  | { status: 'invalid'; problems: MotdProblem[] }
  | { status: 'changed' }
  | { status: 'refused'; reason: string };

type SettingsFile = {
  fetchConfig: () => Promise<ServerConfig>;
  validate: (text: string) => Promise<ConfigResult>;
  put: (config: ServerConfig) => Promise<ConfigResult>;
};

export type MotdEdit = { enabled: boolean; lines: string[]; revision: string };

// Writes the message to the server's settings. Nothing is written when the message breaks the rules, when the file is
// not the revision staff were looking at, or when the server's dry run would refuse it; and a change made meanwhile is
// never overwritten (the server answers 412). Throws when the server cannot be read, or the file is read-only.
export const saveMotd = async (file: SettingsFile, edit: MotdEdit): Promise<MotdSave> => {
  const problems = validateMotd(edit.lines);
  if (problems.length > 0) return { status: 'invalid', problems };
  const config = await file.fetchConfig();
  if (!config.writable) throw new Error('the server settings are read-only over RCON');
  if (config.revision !== edit.revision) return { status: 'changed' };
  const text = setMotd(config.text, edit.enabled, edit.lines);
  if (text === config.text) return { status: 'saved', outcome: 'unchanged' };
  const check = await file.validate(text);
  const problem = refusal(check, 'ServerWelcomeMessageLines') ?? refusal(check, 'bServerWelcomeMessageEnabled');
  if (problem !== null) return { status: 'refused', reason: problem };
  try {
    const result = await file.put({ ...config, text });
    const stopped = refusal(result, 'ServerWelcomeMessageLines') ?? refusal(result, 'bServerWelcomeMessageEnabled');
    if (stopped !== null) return { status: 'refused', reason: stopped };
  } catch (error) {
    if (error instanceof RconError && error.status === 412) return { status: 'changed' };
    throw error;
  }
  return { status: 'saved', outcome: 'next-match' };
};

// A message is at most 128 lines of a few hundred bytes each once tags and entities are in.
export const MOTD_BODY_BYTES = 65_536;

const MotdBodySchema = z.object({
  enabled: z.boolean(),
  // Longer than the limits, so the problems can be named; much longer is not a message.
  lines: z.array(z.string().max(2_000)).max(MOTD_MAX_LINES * 2),
  revision: z.string().max(200),
});

// A save from the page, or null when it is not one.
export const readMotdEdit = async (request: Request, limit = MOTD_BODY_BYTES): Promise<MotdEdit | null> => {
  const parsed = MotdBodySchema.safeParse(await readJsonBody(request, limit));
  return parsed.success ? parsed.data : null;
};
