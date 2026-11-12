import { z } from 'zod';
import { readJsonBody } from './body.ts';
import { DEFAULT_ALLOWED, DEFAULT_RACISM, DEFAULT_TOXICITY } from './chatwords.ts';
import type { ChatLine } from './rcon.ts';

// Chat moderation: the bot reads the game's chat (GET /v1/chat) at each check and acts on the lines that use a word on
// one of two lists (see chatwords.ts for the starter lists, which staff change on the staff page's Chat filter tab).
//
// - A listed word on its own in a line, in any case with only the punctuation around it ignored, is an exact match.
//   Exact on the racism list is an instant permanent ban, exact on the toxicity list is a warning in game.
// - A word that matches only once it is cleaned up is a fuzzy match: leetspeak (0 for o, 1 for i or l, 3 for e, 4 for a,
//   5 for s, 7 for t, @ for a, $ for s), repeated letters ("niiigger"), separators inside a word ("n.i.g.g.e.r", "k y s")
//   and a listed word inside a longer one. A fuzzy match only tells staff: they decide.
// - Staff are never acted on: a line from a staff member's linked Steam account is an alert instead.

export type WordListId = 'racism' | 'toxicity';
export const WORD_LISTS = ['racism', 'toxicity', 'allow'] as const;
export type ListName = (typeof WORD_LISTS)[number];

// --- Reading text ---

// Lower case, with the punctuation around each word taken off, and the words one space apart.
const trimPunctuation = (word: string): string => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

export const wordsOf = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .split(/\s+/)
    .map(trimPunctuation)
    .filter((word) => word !== '');

export const tidyWord = (text: string): string => wordsOf(text).join(' ');

const LEET: Record<string, string> = { '0': 'o', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's' };

// Digits and symbols read as letters. 1 is an i or an l, so `one` says which; a line with a 1 is read both ways.
const deleet = (text: string, one: string): string => text.replace(/[013457@$]/g, (c) => (c === '1' ? one : (LEET[c] ?? c)));

const withoutMarks = (text: string): string => text.normalize('NFKD').replace(/\p{M}/gu, '');

// Letters and digits only: what is left of a word once the separators inside it are gone.
const squash = (text: string): string => text.replace(/[^\p{L}\p{N}]/gu, '');

// A letter repeated is one letter ("niiigger" is "niger"). Digits are left as they are.
const collapse = (text: string): string => text.replace(/(\p{L})\1+/gu, '$1');

// What a listed word looks like to the fuzzy match, apart from the allowed words.
const fuzzyForm = (word: string): string => collapse(squash(deleet(withoutMarks(word.toLowerCase()), 'i')));

// --- The lists ---

export type WordEdits = { add: string[]; remove: string[] };
export type ChatWords = { racism: WordEdits; toxicity: WordEdits; allow: WordEdits; changed: { at: number; by: string; byName: string } | null };

export const NO_WORDS: ChatWords = {
  racism: { add: [], remove: [] },
  toxicity: { add: [], remove: [] },
  allow: { add: [], remove: [] },
  changed: null,
};

export const CHAT_WORDS_KEY = 'chatWords';

const DEFAULTS: Record<ListName, readonly string[]> = { racism: DEFAULT_RACISM, toxicity: DEFAULT_TOXICITY, allow: DEFAULT_ALLOWED };

export const MAX_WORD_LENGTH = 60;
export const MAX_PHRASE_WORDS = 4;
// The most words staff add to a list.
export const MAX_ADDED = 500;

const EditsSchema = z.object({ add: z.array(z.string()), remove: z.array(z.string()) });

const ChatWordsSchema = z.object({
  racism: EditsSchema,
  toxicity: EditsSchema,
  allow: EditsSchema,
  changed: z.object({ at: z.number(), by: z.string(), byName: z.string() }).nullable(),
});

// Nothing saved is the starter lists as they are.
export const parseChatWords = (raw: unknown): ChatWords => {
  const parsed = ChatWordsSchema.safeParse(raw);
  return parsed.success ? parsed.data : NO_WORDS;
};

const unique = (words: string[]): string[] => [...new Set(words)];

// The defaults, in their order, with staff's exclusions out and their additions after.
export const defaultsOf = (list: ListName): string[] => unique(DEFAULTS[list].map(tidyWord).filter((w) => w !== ''));

export const wordsIn = (words: ChatWords, list: ListName): string[] => {
  const out = new Set(words[list].remove);
  return unique([...defaultsOf(list).filter((w) => !out.has(w)), ...words[list].add]);
};

// --- Matching ---

type Entry = {
  word: string;
  list: WordListId;
  // The words as they are said, for an exact match.
  tokens: string[];
  // The word cleaned up, for a fuzzy match, as one piece (`fuzzy`) and by word (`parts`).
  fuzzy: string;
  parts: string[];
  // Whether it can be found inside a longer word.
  inside: boolean;
};

export type CompiledWords = { entries: Entry[]; allowed: string[] };

// A word shorter than this once cleaned up is only matched as a whole word, never found inside a longer one.
const INSIDE_MIN = 4;

export const compileWords = (words: ChatWords): CompiledWords => {
  const entries: Entry[] = [];
  for (const list of ['racism', 'toxicity'] as const) {
    for (const word of wordsIn(words, list)) {
      const tokens = wordsOf(word);
      const parts = tokens.map(fuzzyForm);
      const fuzzy = parts.join('');
      // A word that loses letters in the clean-up and is left very short ("coon" becomes "con") would match real words, so
      // such a word is only matched as typed.
      const whole = tokens.map((t) => squash(withoutMarks(t))).join('');
      const usable = fuzzy.length >= INSIDE_MIN || (fuzzy.length >= 3 && fuzzy.length === whole.length);
      entries.push({ word, list, tokens, fuzzy: usable ? fuzzy : '', parts, inside: fuzzy.length >= INSIDE_MIN });
    }
  }
  return { entries, allowed: unique(wordsIn(words, 'allow').map((w) => squash(withoutMarks(w))).filter((w) => w.length >= 3)) };
};

export type Hit = { kind: 'exact' | 'fuzzy'; list: WordListId; word: string };

const RANK = (hit: Hit): number => (hit.kind === 'exact' ? 0 : 2) + (hit.list === 'racism' ? 0 : 1);

// A token as the fuzzy match sees it: marks off, symbols read as letters, separators gone, allowed words blanked out
// (with # so no word is found across the gap), repeated letters collapsed.
const prepare = (token: string, one: string, allowed: string[]): string => {
  let text = squash(deleet(withoutMarks(token.toLowerCase()), one));
  for (const word of allowed) text = text.split(word).join('#'.repeat(word.length));
  return collapse(text);
};

const isSingle = (token: string): boolean => token.replace(/[^\p{L}\p{N}@$]/gu, '').length === 1;

// What a line holds from the lists, the most serious first. An exact match wins over a fuzzy one for the same word.
export const matchLine = (text: string, compiled: CompiledWords): Hit[] => {
  const words = wordsOf(text);
  const hits: Hit[] = [];
  const exact: Entry[] = [];
  for (const entry of compiled.entries) {
    if (entry.tokens.length === 0 || entry.tokens.length > words.length) continue;
    for (let i = 0; i + entry.tokens.length <= words.length; i++) {
      if (entry.tokens.every((token, j) => words[i + j] === token)) {
        exact.push(entry);
        hits.push({ kind: 'exact', list: entry.list, word: entry.word });
        break;
      }
    }
  }
  const spoken = text.toLowerCase().split(/\s+/).filter((t) => t !== '');
  const seen = new Set(hits.map((h) => `${h.list} ${h.word}`));
  const fuzzy = (entry: Entry): void => {
    const key = `${entry.list} ${entry.word}`;
    if (seen.has(key)) return;
    // The same word as an exact match, or a part of one: a fuzzy match to the same thing.
    if (exact.some((e) => e.fuzzy !== '' && (e.fuzzy.includes(entry.fuzzy) || entry.fuzzy.includes(e.fuzzy)))) return;
    seen.add(key);
    // Kept with its cleaned-up form, so a word found only as part of a longer listed word is dropped below.
    found.push({ hit: { kind: 'fuzzy', list: entry.list, word: entry.word }, fuzzy: entry.fuzzy });
  };
  const found: { hit: Hit; fuzzy: string }[] = [];
  const ones = text.includes('1') ? ['i', 'l'] : ['i'];
  for (const one of ones) {
    // Each word on its own, and each run of single letters ("k y s") as one word.
    const pieces = spoken.map((t) => prepare(t, one, compiled.allowed));
    for (let i = 0; i < spoken.length; i++) {
      if (!isSingle(spoken[i] ?? '')) continue;
      let end = i + 1;
      while (end < spoken.length && isSingle(spoken[end] ?? '')) end++;
      if (end - i >= 2) pieces.push(prepare(spoken.slice(i, end).join(''), one, compiled.allowed));
      i = end - 1;
    }
    // Where each word starts in the line with the separators gone, for phrases.
    const starts: number[] = [];
    let joined = '';
    for (const piece of pieces.slice(0, spoken.length)) {
      starts.push(joined.length);
      joined += piece;
    }
    for (const entry of compiled.entries) {
      if (entry.fuzzy === '') continue;
      if (entry.tokens.length === 1) {
        if (pieces.some((p) => p === entry.fuzzy || (entry.inside && p.includes(entry.fuzzy)))) fuzzy(entry);
        continue;
      }
      for (let at = joined.indexOf(entry.fuzzy); at !== -1; at = joined.indexOf(entry.fuzzy, at + 1)) {
        const end = at + entry.fuzzy.length;
        const token = starts.findLastIndex((s) => s <= at);
        const sameToken = end <= (starts[token + 1] ?? joined.length);
        if (starts.includes(at) || sameToken) {
          fuzzy(entry);
          break;
        }
      }
    }
  }
  const wider = found.filter((f) => !found.some((g) => g !== f && g.fuzzy.length > f.fuzzy.length && g.fuzzy.includes(f.fuzzy)));
  return [...hits, ...wider.map((f) => f.hit)].sort((a, b) => RANK(a) - RANK(b));
};

// --- Judging a batch of lines ---

export type ChatCall = {
  // What the bot does: `ban` and `warn` act, `alert` only tells staff.
  kind: 'ban' | 'warn' | 'alert';
  line: ChatLine;
  hit: Hit;
  // Other words the line holds.
  others: Hit[];
  // Why an exact match is only an alert: a staff member said it, nobody is behind the line, or actions are off.
  why: 'fuzzy' | 'staff' | 'no-player' | 'actions-off' | null;
  // More lines from the same player in the batch, folded into this call.
  more: number;
};

// What the matcher made of a line, and what the bot did about it, kept with the line for the live view and /chat.
// `action`: banned or warned; alert (only posted); staff (a staff member, no action); actions-off and no-player (only
// posted, and why); folded (the player was acted on for another line in the same check); backlog (said before the bot
// first read the chat); failed (the ban or warning did not go through); none (a clean line).
export const VERDICT_ACTIONS = ['banned', 'warned', 'alert', 'staff', 'actions-off', 'no-player', 'folded', 'backlog', 'failed', 'none'] as const;
export type VerdictAction = (typeof VERDICT_ACTIONS)[number];
export type Verdict = { kind: 'clean' | 'exact' | 'fuzzy'; list?: WordListId; word?: string; others?: string[]; action: VerdictAction };
export type ChatEntry = ChatLine & { verdict?: Verdict };

const CALL_RANK = { ban: 0, warn: 1, alert: 2 } as const;

// What a line holds, read both as players saw it and as typed (the game may filter the text): each word once, an exact
// match winning over a fuzzy one, the most serious first.
export const lineHits = (line: ChatLine, compiled: CompiledWords): Hit[] => {
  const best = new Map<string, Hit>();
  for (const hit of [...matchLine(line.text, compiled), ...(line.rawText === undefined ? [] : matchLine(line.rawText, compiled))]) {
    const key = `${hit.list} ${hit.word}`;
    const old = best.get(key);
    if (old === undefined || (old.kind === 'fuzzy' && hit.kind === 'exact')) best.set(key, hit);
  }
  return [...best.values()].sort((a, b) => RANK(a) - RANK(b));
};

// The line as typed: what staff are shown as evidence.
export const typed = (line: ChatLine): string => line.rawText ?? line.text;

const callOf = (line: ChatLine, hits: Hit[], staff: ReadonlySet<string>, actions: boolean): ChatCall | null => {
  const [hit, ...others] = hits;
  if (hit === undefined) return null;
  let kind: ChatCall['kind'] = 'alert';
  let why: ChatCall['why'] = 'fuzzy';
  if (hit.kind === 'exact') {
    if (line.steamId === null) why = 'no-player';
    else if (staff.has(line.steamId)) why = 'staff';
    else if (!actions) why = 'actions-off';
    else {
      kind = hit.list === 'racism' ? 'ban' : 'warn';
      why = null;
    }
  }
  return { kind, line, hit, others, why, more: 0 };
};

const PLANNED: Record<NonNullable<ChatCall['why']> | 'ban' | 'warn', VerdictAction> = {
  ban: 'banned',
  warn: 'warned',
  fuzzy: 'alert',
  staff: 'staff',
  'no-player': 'no-player',
  'actions-off': 'actions-off',
};

// What to do about a batch of new lines: one call for each player, the most serious. A player who says it five times in a
// minute is banned or warned once, and the other lines are counted. `actions` is false when automatic actions are off.
// Also the verdict of every line, by its id; `backlog` marks lines that are only kept, not acted on.
export const judgeLines = (
  lines: ChatLine[],
  compiled: CompiledWords,
  staff: ReadonlySet<string>,
  actions: boolean,
  backlog = false,
): { calls: ChatCall[]; verdicts: Map<number, Verdict> } => {
  const byPlayer = new Map<string, ChatCall>();
  const verdicts = new Map<number, Verdict>();
  const own = new Map<number, ChatCall>();
  for (const line of lines) {
    const call = callOf(line, lineHits(line, compiled), staff, actions);
    if (call === null) {
      verdicts.set(line.id, { kind: 'clean', action: 'none' });
      continue;
    }
    own.set(line.id, call);
    const key = line.steamId ?? `line ${line.id}`;
    const old = byPlayer.get(key);
    if (old === undefined) byPlayer.set(key, call);
    else if (CALL_RANK[call.kind] < CALL_RANK[old.kind] || (call.kind === old.kind && RANK(call.hit) < RANK(old.hit))) {
      byPlayer.set(key, { ...call, more: old.more + 1 });
    } else byPlayer.set(key, { ...old, more: old.more + 1 });
  }
  const chosen = new Set([...byPlayer.values()].map((c) => c.line.id));
  for (const [id, call] of own) {
    const planned = PLANNED[call.kind === 'alert' ? (call.why ?? 'fuzzy') : call.kind];
    const action: VerdictAction = backlog ? 'backlog' : chosen.has(id) || call.kind === 'alert' ? planned : 'folded';
    verdicts.set(id, {
      kind: call.hit.kind,
      list: call.hit.list,
      word: call.hit.word,
      ...(call.others.length > 0 ? { others: call.others.map((o) => o.word) } : {}),
      action,
    });
  }
  const calls = backlog ? [] : [...byPlayer.values()].sort((a, b) => CALL_RANK[a.kind] - CALL_RANK[b.kind] || a.line.id - b.line.id);
  return { calls, verdicts };
};

export const judgeChat = (lines: ChatLine[], compiled: CompiledWords, staff: ReadonlySet<string>, actions: boolean): ChatCall[] =>
  judgeLines(lines, compiled, staff, actions).calls;

export const LIST_NAMES: Record<WordListId, string> = { racism: 'racism list', toxicity: 'toxicity list' };

// What goes in the player's staff history and the moderation log: the line, and the word.
export const callEvidence = (call: ChatCall): string => {
  const original = typed(call.line);
  const said = original.length > 200 ? `${original.slice(0, 199)}…` : original;
  const more = call.more > 0 ? `, and ${call.more} more line${call.more === 1 ? '' : 's'} in the same minute` : '';
  return `Chat: "${said}" (matched "${call.hit.word}" on the ${LIST_NAMES[call.hit.list]}${more})`;
};

// A short reason for a ban, which the player sees with the kick. The game's one line holds 200 characters.
export const banReasonText = (line: ChatLine): string => {
  const original = typed(line);
  const said = original.length > 90 ? `${original.slice(0, 89)}…` : original;
  return `Racist language in chat: "${said}"`;
};

export const WARNING_TEXT = 'Toxic language in chat is not allowed on this server. Keep it friendly.';

// --- Following the chat ---

export const CHAT_STATE_KEY = 'chatState';
// How many lines the bot keeps for /chat.
export const CHAT_KEPT = 200;
// A page of the chat: the most lines asked for at once, and the pages read in one check.
export const CHAT_PAGE = 200;
const PAGES_PER_CHECK = 5;
// The first reading goes on to the newest line, which can be many pages from the oldest.
const PAGES_AT_START = 20;
// How many lines before the newest the first reading keeps for /chat.
const CHAT_BACKLOG = 50;

// `cursor` is the highest line number seen, the `after` of the next request. Null before the first reading.
export type ChatState = { cursor: number | null; buffer: ChatEntry[] };

const KeptSchema = z.object({
  id: z.number(),
  steamId: z.string().nullable(),
  name: z.string(),
  shownAs: z.string().optional(),
  text: z.string(),
  rawText: z.string().optional(),
  channel: z.string().optional(),
  faction: z.string().optional(),
  ping: z.boolean().optional(),
  at: z.number(),
  verdict: z
    .object({
      kind: z.enum(['clean', 'exact', 'fuzzy']),
      list: z.enum(['racism', 'toxicity']).optional(),
      word: z.string().optional(),
      others: z.array(z.string()).optional(),
      action: z.enum(VERDICT_ACTIONS),
    })
    .optional(),
});
const ChatStateSchema = z.object({ cursor: z.number().int().nonnegative().nullable(), buffer: z.array(KeptSchema) });

export const parseChatState = (raw: unknown): ChatState => {
  const parsed = ChatStateSchema.safeParse(raw);
  return parsed.success ? parsed.data : { cursor: null, buffer: [] };
};

// A line as kept for /chat: short enough that 200 of them stay well inside what one stored value can hold.
export const kept = (line: ChatEntry): ChatEntry => ({
  ...line,
  name: line.name.slice(0, 32),
  text: line.text.length > 160 ? `${line.text.slice(0, 159)}…` : line.text,
  ...(line.rawText === undefined ? {} : { rawText: line.rawText.length > 160 ? `${line.rawText.slice(0, 159)}…` : line.rawText }),
});

// The buffer with verdicts put on the lines they belong to, and the action of a line changed (a ban that failed).
export const withVerdicts = (buffer: ChatEntry[], verdicts: Map<number, Verdict>): ChatEntry[] =>
  buffer.map((entry) => {
    const verdict = verdicts.get(entry.id);
    return verdict === undefined ? entry : { ...entry, verdict };
  });

export type ChatReading = {
  state: ChatState;
  // The lines to act on: none on the first reading, whose lines are the backlog and are only kept.
  fresh: ChatLine[];
  // Every line this reading found, the backlog included.
  lines: ChatLine[];
  // Lines the server sent that could not be read.
  skipped: number;
  first: boolean;
};

// Reads what is new, a page at a time. The first reading only finds the newest line, so lines said before the bot was
// first on cannot be acted on. A page that fails after others were read keeps what they had; one that fails with nothing
// read throws, so the state is left as it was.
export const readChat = async (
  state: ChatState,
  page: (after: number, limit: number) => Promise<{ lines: ChatLine[]; skipped: number; latest: number | null }>,
): Promise<ChatReading> => {
  const first = state.cursor === null;
  let cursor = state.cursor ?? 0;
  let skipped = 0;
  const got = new Map<number, ChatLine>();
  // Lines at or before `from` are ones already had: the server's `after` is inclusive, and sends the cursor's line again.
  const take = (answer: { lines: ChatLine[]; skipped: number }, from: number): ChatLine[] => {
    skipped += answer.skipped;
    const news = answer.lines.filter((l) => l.id > from);
    for (const line of news) if (!got.has(line.id)) got.set(line.id, line);
    return news;
  };
  if (first) {
    // The first reading starts at the server's newest line (`latestSeq`), so nothing said before is acted on, and keeps
    // the last few lines for /chat. Without a latestSeq it reads on to the newest line page by page.
    const head = await page(0, 1);
    if (head.latest === null) take(head, 0);
    let latest = head.latest ?? Math.max(0, ...head.lines.map((l) => l.id));
    if (head.latest === null && head.lines.length > 0) {
      for (let n = 0; n < PAGES_AT_START; n++) {
        const answer = await page(latest, CHAT_PAGE);
        const news = take(answer, latest);
        if (news.length === 0) break;
        latest = Math.max(latest, ...news.map((l) => l.id));
        if (answer.lines.length < CHAT_PAGE) break;
      }
    } else if (latest > 0) {
      const from = Math.max(0, latest - CHAT_BACKLOG);
      try {
        take(await page(from, CHAT_PAGE), from);
      } catch {
        // The newest line number is enough to start from.
      }
    }
    cursor = Math.max(latest, ...[...got.keys()]);
  } else {
    for (let n = 0; n < PAGES_PER_CHECK; n++) {
      let answer: { lines: ChatLine[]; skipped: number };
      try {
        answer = await page(cursor, CHAT_PAGE);
      } catch (error) {
        if (got.size === 0 && n === 0) throw error;
        break;
      }
      const news = take(answer, cursor);
      if (news.length === 0) break;
      cursor = Math.max(cursor, ...news.map((l) => l.id));
      if (answer.lines.length < CHAT_PAGE) break;
    }
  }
  const lines = [...got.values()].sort((a, b) => a.id - b.id).filter((l) => l.id <= cursor);
  return {
    state: { cursor, buffer: [...state.buffer, ...lines.map(kept)].slice(-CHAT_KEPT) },
    fresh: first ? [] : lines,
    lines,
    skipped,
    first,
  };
};

// Whether the server lists the chat route in its capabilities (see fetchRoutes).
export const hasChatRoute = (routes: string[]): boolean =>
  routes.some((route) => {
    const [method, path] = route.split(' ');
    return method?.toUpperCase() === 'GET' && (path ?? '').split('?')[0]?.replace(/\/+$/, '') === '/v1/chat';
  });

// --- /chat ---

const neutral = (text: string): string =>
  text.replace(/[\\*_~`|>#[\]()-]/g, '\\$&').replace(/[<@]/g, '$&\u200b');

export const CHAT_REPLY_LINES = 20;
export const CHAT_MAX_LINES = 50;
const MAX_REPLY = 1900;

// The latest lines, newest last, for a Discord reply: all of them, or those from a player (a Steam ID, or part of a
// name). Cut from the top to fit Discord's 2000 characters.
// A flagged line's mark in /chat: what it matched and what the bot did.
const mark = (verdict: Verdict | undefined): string => {
  if (verdict === undefined || verdict.kind === 'clean') return '';
  const word = neutral(verdict.word ?? '');
  const what = verdict.kind === 'exact' ? `🚫 exact ${verdict.list ?? ''} "${word}"` : `❓ resembles "${word}"`;
  const did: Partial<Record<VerdictAction, string>> = {
    banned: 'banned',
    warned: 'warned',
    alert: 'alert only',
    staff: 'staff, no action',
    'actions-off': 'alert only, actions off',
    'no-player': 'no player, no action',
    folded: 'acted on for another line',
    backlog: 'before the bot started',
    failed: 'action failed',
  };
  const action = verdict.action === 'none' ? undefined : did[verdict.action];
  return `\n   ↳ ${what}${action === undefined ? '' : `, ${action}`}`;
};

export const chatReply = (buffer: ChatEntry[], player: string | undefined, count: number = CHAT_REPLY_LINES): string => {
  const typed = (player ?? '').trim().toLowerCase();
  const chosen = typed === '' ? buffer : buffer.filter((l) => l.steamId === typed || l.name.toLowerCase().includes(typed));
  if (chosen.length === 0) {
    return typed === '' ? 'No chat read yet.' : `No recent chat from "${neutral(player?.trim() ?? '')}". The bot keeps the last ${CHAT_KEPT} lines.`;
  }
  const rows = chosen.slice(-count).map((l) => {
    const where = [l.channel, l.faction].filter(Boolean).map((w) => neutral(w ?? ''));
    const channel = where.length > 0 ? ` (${where.join(', ')})` : '';
    const shown = l.shownAs ? ` (shown as ${neutral(l.shownAs)})` : '';
    const raw = l.rawText !== undefined && l.rawText !== l.text ? `\n   ↳ typed: ${neutral(l.rawText)}` : '';
    return `<t:${Math.floor(l.at / 1000)}:T> **${neutral(l.name || 'Unknown')}**${shown}${channel}${l.ping ? ' 📣' : ''}: ${neutral(l.text)}${raw}${mark(l.verdict)}`;
  });
  const shown: string[] = [];
  let length = 0;
  for (const row of rows.toReversed()) {
    if (length + row.length + 1 > MAX_REPLY) break;
    shown.unshift(row);
    length += row.length + 1;
  }
  const from = typed === '' ? '' : ` from "${neutral(player?.trim() ?? '')}"`;
  return `💬 Latest chat${from}:\n${shown.join('\n')}`;
};

// --- Staff page: the live chat ---

// The most lines one answer carries.
export const FEED_LINES = CHAT_KEPT;

export type ChatFeed = {
  // Whether the bot reads the chat (CHAT_MOD), and whether the game serves it.
  enabled: boolean;
  available: boolean;
  // The newest line id the bot has, to ask `after` next.
  cursor: number | null;
  lines: ChatEntry[];
};

// The lines after `after`, oldest first, for the staff page's live chat.
export const chatFeed = (state: ChatState, after: number, switches: { enabled: boolean; available: boolean }): ChatFeed => ({
  ...switches,
  cursor: state.buffer.at(-1)?.id ?? state.cursor,
  lines: state.buffer.filter((l) => l.id > after).slice(-FEED_LINES),
});

// --- Staff page: the word lists ---

export type WordsAction = { action: 'add' | 'remove' | 'restore'; list: ListName; word: string };

const WordsActionSchema = z.object({
  action: z.enum(['add', 'remove', 'restore']),
  list: z.enum(WORD_LISTS),
  word: z.string().max(200),
});

export const WORDS_BODY_BYTES = 2_048;

export const readWordsAction = async (request: Request, limit = WORDS_BODY_BYTES): Promise<WordsAction | null> => {
  const parsed = WordsActionSchema.safeParse(await readJsonBody(request, limit));
  return parsed.success ? parsed.data : null;
};

// What is wrong with a word to add, or null when nothing is.
export const wordProblem = (text: string, list: ListName): string | null => {
  const word = tidyWord(text);
  if (squash(word).length < 3) return 'A word needs at least 3 letters or numbers.';
  if (word.length > MAX_WORD_LENGTH) return `A word can be at most ${MAX_WORD_LENGTH} characters.`;
  if (!/^[\p{L}\p{N}][\p{L}\p{N}' -]*$/u.test(word)) return 'Use letters, numbers, spaces, apostrophes and hyphens only.';
  const count = word.split(' ').length;
  if (list === 'allow' && count > 1) return 'An allowed word is one word, with no spaces.';
  if (count > MAX_PHRASE_WORDS) return `A phrase can be at most ${MAX_PHRASE_WORDS} words.`;
  return null;
};

export type WordsResult = { words: ChatWords } | { problem: string };

// The lists after a change, or why it can't be made. Adding a default that staff took out puts it back.
export const editWords = (words: ChatWords, action: WordsAction, who: { by: string; byName: string; now: number }): WordsResult => {
  const { list } = action;
  const word = tidyWord(action.word);
  const mine = words[list];
  const done = (edits: WordEdits): WordsResult => ({
    words: { ...words, [list]: edits, changed: { at: who.now, by: who.by, byName: who.byName } },
  });
  const isDefault = defaultsOf(list).includes(word);
  if (action.action === 'restore') {
    return mine.remove.includes(word) ? done({ ...mine, remove: mine.remove.filter((w) => w !== word) }) : { problem: `"${word}" is not taken out of the list.` };
  }
  if (action.action === 'remove') {
    if (mine.add.includes(word)) return done({ ...mine, add: mine.add.filter((w) => w !== word) });
    if (isDefault && !mine.remove.includes(word)) return done({ ...mine, remove: [...mine.remove, word] });
    return { problem: `"${word}" is not on the list.` };
  }
  const problem = wordProblem(action.word, list);
  if (problem !== null) return { problem };
  if (wordsIn(words, list).includes(word)) return { problem: `"${word}" is on the list already.` };
  if (isDefault) return done({ ...mine, remove: mine.remove.filter((w) => w !== word) });
  if (mine.add.length >= MAX_ADDED) return { problem: `A list can have at most ${MAX_ADDED} added words.` };
  return done({ ...mine, add: [...mine.add, word] });
};

export type WordsPage = {
  // Whether the bot reads the chat (CHAT_MOD), and whether it acts on exact matches (CHAT_MOD_ACTIONS).
  enabled: boolean;
  actions: boolean;
  maxWord: number;
  maxPhraseWords: number;
  maxAdded: number;
  changed: ChatWords['changed'];
  lists: { id: ListName; name: string; note: string; defaults: string[]; added: string[]; removed: string[] }[];
};

const LIST_NOTES: Record<ListName, { name: string; note: string }> = {
  racism: {
    name: 'Racism and hate',
    note: 'A line with one of these as a whole word is an instant permanent ban. A spelling that only resembles one (leetspeak, repeated letters, spaces) is an alert for staff.',
  },
  toxicity: {
    name: 'Toxicity',
    note: 'A line with one of these as a whole word or phrase is a warning in game. A spelling that only resembles one is an alert for staff.',
  },
  allow: {
    name: 'Allowed words',
    note: 'Words that hold a listed word inside them, such as "Scunthorpe"-type matches. The bot does not alert for a listed word found inside these. A listed word typed on its own still counts.',
  },
};

export const buildWordsPage = (words: ChatWords, switches: { enabled: boolean; actions: boolean }): WordsPage => ({
  ...switches,
  maxWord: MAX_WORD_LENGTH,
  maxPhraseWords: MAX_PHRASE_WORDS,
  maxAdded: MAX_ADDED,
  changed: words.changed,
  lists: WORD_LISTS.map((id) => ({
    id,
    ...LIST_NOTES[id],
    defaults: defaultsOf(id),
    added: words[id].add,
    removed: words[id].remove,
  })),
});
