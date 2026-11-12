import { describe, expect, it, vi } from 'vitest';
import {
  banReasonText,
  buildWordsPage,
  chatFeed,
  judgeLines,
  withVerdicts,
  callEvidence,
  chatReply,
  compileWords,
  defaultsOf,
  editWords,
  hasChatRoute,
  judgeChat,
  kept,
  matchLine,
  NO_WORDS,
  parseChatState,
  parseChatWords,
  readChat,
  readWordsAction,
  tidyWord,
  wordProblem,
  wordsIn,
  type ChatState,
  type Verdict,
  type ChatWords,
} from '../src/chatmod.ts';
import { DEFAULT_ALLOWED, DEFAULT_RACISM, DEFAULT_TOXICITY } from '../src/chatwords.ts';
import { parseChat, type ChatLine } from '../src/rcon.ts';

const ASH = '76561198000000001';
const BO = '76561198000000002';
const AT = Date.UTC(2026, 9, 7, 20);

const compiled = compileWords(NO_WORDS);
const hitsOf = (text: string, words: ChatWords = NO_WORDS) =>
  matchLine(text, words === NO_WORDS ? compiled : compileWords(words)).map((h) => `${h.kind} ${h.list} ${h.word}`);

const line = (id: number, text: string, steamId: string | null = ASH, name = 'Ash'): ChatLine => ({ id, steamId, name, text, at: AT });

describe('the starter lists', () => {
  it('keep the slurs on the racism list and the abuse on the toxicity list, and swearing on neither', () => {
    expect(DEFAULT_RACISM).toContain('nigger');
    expect(DEFAULT_RACISM).toContain('faggot');
    expect(DEFAULT_TOXICITY).toContain('kys');
    expect(DEFAULT_TOXICITY).toContain('kill yourself');
    const all = [...DEFAULT_RACISM, ...DEFAULT_TOXICITY].join(' ');
    for (const swear of ['fuck', 'shit', 'bitch', 'damn']) expect(all).not.toContain(swear);
    expect(hitsOf('what the fuck, this is shit')).toEqual([]);
  });

  it('have no word on both lists, and every default is already in its tidy form', () => {
    expect(DEFAULT_RACISM.filter((w) => DEFAULT_TOXICITY.includes(w))).toEqual([]);
    for (const word of [...DEFAULT_RACISM, ...DEFAULT_TOXICITY, ...DEFAULT_ALLOWED]) expect(tidyWord(word)).toBe(word);
    expect(DEFAULT_ALLOWED.filter((w) => w.includes(' '))).toEqual([]);
  });
});

describe('exact matches', () => {
  it('match a listed word as a whole word in any case', () => {
    expect(hitsOf('you are a NiGgEr')).toEqual(['exact racism nigger']);
    expect(hitsOf('kys')).toEqual(['exact toxicity kys']);
    expect(hitsOf('KYS lol')).toEqual(['exact toxicity kys']);
  });

  it('ignore the punctuation around a word', () => {
    expect(hitsOf('"kys!!!"')).toEqual(['exact toxicity kys']);
    expect(hitsOf('(retard), really')).toEqual(['exact toxicity retard']);
    expect(hitsOf('...faggot...')).toEqual(['exact racism faggot']);
    expect(hitsOf('  kys  ')).toEqual(['exact toxicity kys']);
  });

  it('match phrases as the words in a row', () => {
    expect(hitsOf('please kill yourself')).toEqual(['exact toxicity kill yourself']);
    expect(hitsOf('Kill   Yourself.')).toEqual(['exact toxicity kill yourself']);
    expect(hitsOf('you porch monkey')).toEqual(['exact racism porch monkey']);
    expect(hitsOf('kill your self')).toEqual(['fuzzy toxicity kill yourself']);
    expect(hitsOf('i will not kill you or yourself')).toEqual([]);
  });

  it('put the racism list first', () => {
    expect(hitsOf('kys nigger')).toEqual(['exact racism nigger', 'exact toxicity kys']);
  });

  it('do not match a word that is only part of a longer one, but a fuzzy match does', () => {
    expect(hitsOf('retardation')).toEqual(['fuzzy toxicity retard']);
    expect(hitsOf('niggerlover')).toEqual(['fuzzy racism nigger']);
  });
});

describe('fuzzy matches', () => {
  it('see through leetspeak', () => {
    expect(hitsOf('n1gg3r')).toEqual(['fuzzy racism nigger']);
    expect(hitsOf('n1663r')).toEqual([]);
    expect(hitsOf('f4gg0t')).toEqual(['fuzzy racism faggot']);
    expect(hitsOf('r3t4rd')).toEqual(['fuzzy toxicity retard']);
    expect(hitsOf('k¥s')).toEqual([]);
    expect(hitsOf('ky$')).toEqual(['fuzzy toxicity kys']);
    expect(hitsOf('@ss h0le')).toEqual([]);
    expect(hitsOf('sp1c')).toEqual(['fuzzy racism spic']);
    expect(hitsOf('7ard')).toEqual([]);
  });

  it('read each 1 on its own as an i or an l, so mixed ones are found', () => {
    expect(hitsOf('k1ll yourse1f')).toEqual(['fuzzy toxicity kill yourself']);
    expect(hitsOf('k1ll y0urs3lf')).toEqual(['fuzzy toxicity kill yourself']);
    expect(hitsOf('k1ll yourself')).toEqual(['fuzzy toxicity kill yourself']);
    const withL = compileWords({ ...NO_WORDS, toxicity: { add: ['killer'], remove: [] } });
    expect(matchLine('k1ller', withL).map((h) => h.word)).toEqual(['killer']);
    // A 1 is only an i or an l: not any letter.
    expect(matchLine('k1ger', withL)).toEqual([]);
    expect(hitsOf('kiiller')).toEqual([]);
  });

  it('read a 1 as an i or an l', () => {
    expect(hitsOf('k1ke')).toEqual(['fuzzy racism kike']);
    const withL = compileWords({ ...NO_WORDS, toxicity: { add: ['killer'], remove: [] } });
    expect(matchLine('ki11er', withL).map((h) => h.word)).toEqual(['killer']);
  });

  it('collapse repeated letters', () => {
    expect(hitsOf('niiiigggggerrr')).toEqual(['fuzzy racism nigger']);
    expect(hitsOf('kyyyyyssss')).toEqual(['fuzzy toxicity kys']);
    expect(hitsOf('retaaaaard')).toEqual(['fuzzy toxicity retard']);
  });

  it('take out the separators inside a word', () => {
    expect(hitsOf('n.i.g.g.e.r')).toEqual(['fuzzy racism nigger']);
    expect(hitsOf('n-i-g-g-a')).toEqual(['fuzzy racism nigga']);
    expect(hitsOf('k_y_s')).toEqual(['fuzzy toxicity kys']);
    expect(hitsOf('r*e*t*a*r*d')).toEqual(['fuzzy toxicity retard']);
  });

  it('join letters that are said one at a time', () => {
    expect(hitsOf('k y s')).toEqual(['fuzzy toxicity kys']);
    expect(hitsOf('K. Y. S.')).toEqual(['fuzzy toxicity kys']);
    expect(hitsOf('go k y s now')).toEqual(['fuzzy toxicity kys']);
    expect(hitsOf('n i g g e r')).toEqual(['fuzzy racism nigger']);
    expect(hitsOf('i a m a')).toEqual([]);
  });

  it('find a listed word inside a longer one', () => {
    expect(hitsOf('youfaggotlol')).toEqual(['fuzzy racism faggot']);
    expect(hitsOf('retardedly')).toEqual(['fuzzy toxicity retarded']);
  });

  it('see phrases with the spaces gone, leetspeak and repeated letters', () => {
    expect(hitsOf('killyourself')).toEqual(['fuzzy toxicity kill yourself']);
    expect(hitsOf('k1ll y0urs3lf')).toEqual(['fuzzy toxicity kill yourself']);
    expect(hitsOf('kiiill yoooourself')).toEqual(['fuzzy toxicity kill yourself']);
    expect(hitsOf('pleasekillyourselfnow')).toEqual(['fuzzy toxicity kill yourself']);
    expect(hitsOf('kill yourselves')).toEqual(['exact toxicity kill yourselves']);
  });

  it('do not find a phrase that starts in the middle of a word', () => {
    expect(hitsOf('your skill yourself')).toEqual([]);
    expect(hitsOf('skill yourself')).toEqual([]);
  });

  it('let an exact match win over a fuzzy one for the same word', () => {
    expect(hitsOf('niggers')).toEqual(['exact racism niggers']);
    expect(hitsOf('retard')).toEqual(['exact toxicity retard']);
    expect(hitsOf('nigger and n1gger')).toEqual(['exact racism nigger']);
  });

  it('leave words alone that would match real words once cleaned up', () => {
    // "coon" cleaned up is "con", so it is only ever matched as typed.
    expect(hitsOf('what a con')).toEqual([]);
    expect(hitsOf('coon')).toEqual(['exact racism coon']);
    expect(hitsOf('c00n')).toEqual([]);
  });
});

describe('the allowed words', () => {
  it('keep ordinary words that hold a listed word from being flagged', () => {
    for (const text of [
      'Niger and Nigeria are in Africa',
      'stop sniggering',
      'a niggardly amount',
      'raccoon',
      'cocoon',
      'a tycoon',
      'spicy, despicable, suspicious',
      'a conspicuous spice',
      'Pakistan and Pakistani players',
      'we are among friends',
      'amongus',
      'a warmonger and a fishmonger',
      'mongoose',
      'flame retardant',
      'swopped places',
    ]) {
      expect(hitsOf(text), text).toEqual([]);
    }
  });

  it('only cover the allowed word: a slur next to one is still found', () => {
    expect(hitsOf('snigger nigger')).toEqual(['exact racism nigger']);
    expect(hitsOf('raccoon c00nz')).toEqual([]);
    expect(hitsOf('amongnigger')).toEqual(['fuzzy racism nigger']);
  });

  it('see through spellings of an allowed word, and not a stretched slur', () => {
    expect(hitsOf('sn.igger')).toEqual([]);
    expect(hitsOf('n1ger1a')).toEqual([]);
    expect(hitsOf('niiigger')).toEqual(['fuzzy racism nigger']);
  });

  it('do not stop a listed word that is typed on its own', () => {
    const words: ChatWords = { ...NO_WORDS, allow: { add: ['kys'], remove: [] } };
    expect(hitsOf('kys', words)).toEqual(['exact toxicity kys']);
  });

  it('stop a word staff add, such as a town (the Scunthorpe problem)', () => {
    const lists: ChatWords = { ...NO_WORDS, toxicity: { add: ['cunt'], remove: [] } };
    expect(hitsOf('i live in Scunthorpe', lists)).toEqual(['fuzzy toxicity cunt']);
    const allowed: ChatWords = { ...lists, allow: { add: ['scunthorpe'], remove: [] } };
    expect(hitsOf('i live in Scunthorpe', allowed)).toEqual([]);
    expect(hitsOf('you cunt', allowed)).toEqual(['exact toxicity cunt']);
  });
});

describe('staff changing the lists', () => {
  const who = { by: '42', byName: 'Sarge', now: AT };
  const act = (words: ChatWords, action: 'add' | 'remove' | 'restore', list: 'racism' | 'toxicity' | 'allow', word: string) =>
    editWords(words, { action, list, word }, who);

  it('start from the defaults', () => {
    expect(wordsIn(NO_WORDS, 'racism')).toEqual(defaultsOf('racism'));
    expect(parseChatWords(undefined)).toEqual(NO_WORDS);
    expect(parseChatWords({ racism: 3 })).toEqual(NO_WORDS);
  });

  it('add a word in its tidy form, and match it at once', () => {
    const result = act(NO_WORDS, 'add', 'toxicity', '  "Noob Scum!" ');
    if ('problem' in result) throw new Error(result.problem);
    expect(result.words.toxicity.add).toEqual(['noob scum']);
    expect(result.words.changed).toEqual({ at: AT, by: '42', byName: 'Sarge' });
    expect(hitsOf('you noob scum', result.words)).toEqual(['exact toxicity noob scum']);
  });

  it('take a default out as an exclusion, and put it back', () => {
    const out = act(NO_WORDS, 'remove', 'racism', 'chink');
    if ('problem' in out) throw new Error(out.problem);
    expect(out.words.racism.remove).toEqual(['chink']);
    expect(wordsIn(out.words, 'racism')).not.toContain('chink');
    expect(hitsOf('a chink in the armour', out.words)).toEqual([]);
    const back = act(out.words, 'restore', 'racism', 'chink');
    if ('problem' in back) throw new Error(back.problem);
    expect(back.words.racism.remove).toEqual([]);
    expect(act(out.words, 'add', 'racism', 'chink')).toMatchObject({ words: { racism: { remove: [] } } });
  });

  it('take an added word off the list', () => {
    const added = act(NO_WORDS, 'add', 'racism', 'testword');
    if ('problem' in added) throw new Error(added.problem);
    expect(act(added.words, 'remove', 'racism', 'TestWord')).toMatchObject({ words: { racism: { add: [], remove: [] } } });
  });

  it('refuse what makes no sense', () => {
    expect(act(NO_WORDS, 'add', 'racism', 'nigger')).toEqual({ problem: '"nigger" is on the list already.' });
    expect(act(NO_WORDS, 'add', 'racism', 'ab')).toEqual({ problem: 'A word needs at least 3 letters or numbers.' });
    expect(act(NO_WORDS, 'add', 'racism', 'a b c d e')).toEqual({ problem: 'A phrase can be at most 4 words.' });
    expect(act(NO_WORDS, 'add', 'allow', 'two words')).toEqual({ problem: 'An allowed word is one word, with no spaces.' });
    expect(act(NO_WORDS, 'add', 'racism', 'bad_word')).toEqual({ problem: 'Use letters, numbers, spaces, apostrophes and hyphens only.' });
    expect(act(NO_WORDS, 'add', 'racism', 'x'.repeat(61))).toEqual({ problem: 'A word can be at most 60 characters.' });
    expect(act(NO_WORDS, 'remove', 'racism', 'notaword')).toEqual({ problem: '"notaword" is not on the list.' });
    expect(act(NO_WORDS, 'restore', 'racism', 'nigger')).toEqual({ problem: '"nigger" is not taken out of the list.' });
    expect(wordProblem('kill yourself', 'toxicity')).toBeNull();
  });

  it('stop at the most added words', () => {
    const full: ChatWords = { ...NO_WORDS, toxicity: { add: Array.from({ length: 500 }, (_, i) => `word${i}x`), remove: [] } };
    expect(act(full, 'add', 'toxicity', 'onemore')).toEqual({ problem: 'A list can have at most 500 added words.' });
  });

  it('describe the lists for the page', () => {
    const removed = act(NO_WORDS, 'remove', 'toxicity', 'mong');
    if ('problem' in removed) throw new Error(removed.problem);
    const page = buildWordsPage(removed.words, { enabled: true, actions: false });
    expect(page).toMatchObject({ enabled: true, actions: false, maxWord: 60, maxPhraseWords: 4, maxAdded: 500 });
    expect(page.lists.map((l) => l.id)).toEqual(['racism', 'toxicity', 'allow']);
    expect(page.lists[1]).toMatchObject({ added: [], removed: ['mong'] });
    expect(page.lists[0]?.defaults).toEqual(defaultsOf('racism'));
  });

  it('read a change sent by the page', async () => {
    const send = (body: unknown) => readWordsAction(new Request('https://x', { method: 'POST', body: JSON.stringify(body) }));
    await expect(send({ action: 'add', list: 'racism', word: 'abc' })).resolves.toEqual({ action: 'add', list: 'racism', word: 'abc' });
    await expect(send({ action: 'explode', list: 'racism', word: 'abc' })).resolves.toBeNull();
    await expect(send({ action: 'add', list: 'other', word: 'abc' })).resolves.toBeNull();
    await expect(send({ action: 'add', list: 'racism' })).resolves.toBeNull();
  });
});

describe('what the bot does about a batch', () => {
  const none = new Set<string>();
  const call = (lines: ChatLine[], staff = none, actions = true) => judgeChat(lines, compiled, staff, actions);

  it('bans for an exact racism match and warns for an exact toxicity match', () => {
    const calls = call([line(1, 'kys', BO, 'Bo'), line(2, 'you nigger')]);
    expect(calls.map((c) => [c.kind, c.line.steamId, c.hit.word])).toEqual([
      ['ban', ASH, 'nigger'],
      ['warn', BO, 'kys'],
    ]);
    expect(calls.map((c) => c.why)).toEqual([null, null]);
  });

  it('only tells staff about a fuzzy match', () => {
    const calls = call([line(1, 'n1gger'), line(2, 'k y s', BO)]);
    expect(calls.map((c) => [c.kind, c.why, c.hit.kind])).toEqual([
      ['alert', 'fuzzy', 'fuzzy'],
      ['alert', 'fuzzy', 'fuzzy'],
    ]);
  });

  it('never acts on staff: an exact match from a staff member is an alert', () => {
    const calls = call([line(1, 'you nigger'), line(2, 'kys', BO)], new Set([ASH, BO]));
    expect(calls.map((c) => [c.kind, c.why])).toEqual([
      ['alert', 'staff'],
      ['alert', 'staff'],
    ]);
  });

  it('only tells staff about a line nobody is behind', () => {
    expect(call([line(1, 'you nigger', null, 'Server')]).map((c) => [c.kind, c.why])).toEqual([['alert', 'no-player']]);
  });

  it('only tells staff when automatic actions are off', () => {
    expect(call([line(1, 'you nigger'), line(2, 'kys', BO)], none, false).map((c) => [c.kind, c.why])).toEqual([
      ['alert', 'actions-off'],
      ['alert', 'actions-off'],
    ]);
  });

  it('acts once for each player in a batch, on the most serious line, and counts the rest', () => {
    const calls = call([line(1, 'kys'), line(2, 'kys again'), line(3, 'you nigger'), line(4, 'n1gger')]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: 'ban', more: 3, line: { id: 3 } });
    const warns = call([line(1, 'kys'), line(2, 'kys')]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ kind: 'warn', more: 1, line: { id: 1 } });
    expect(callEvidence(warns[0]!)).toContain('and 1 more line in the same minute');
  });

  it('skips lines with nothing on the lists', () => {
    expect(call([line(1, 'gg well played'), line(2, 'fuck this map')])).toEqual([]);
  });

  it('says the line and the word as evidence, and keeps a ban reason short', () => {
    const [ban] = call([line(1, 'you nigger')]);
    expect(callEvidence(ban!)).toBe('Chat #1: "you nigger" (matched "nigger" on the racism list)');
    expect(callEvidence({ ...ban!, line: { ...ban!.line, channel: 'Team', faction: 'Lonestar' } })).toContain('Chat #1 (Team, Lonestar): "you nigger"');
    expect(banReasonText(line(1, 'x'.repeat(300)), 'nigger').length).toBeLessThan(140);
    expect(banReasonText(line(1, 'you nigger'), 'nigger')).toBe('Racist language in chat (nigger): "you nigger"');
  });
});

describe('following the chat', () => {
  // The server as it really is: `after` is inclusive (after=57 sends line 57 again) and the answer has `latestSeq`.
  const page = (all: ChatLine[], skipped = 0, latest: number | null | 'newest' = 'newest') =>
    vi.fn(async (after: number, limit: number) => ({
      lines: all.filter((l) => l.id >= after).slice(0, limit),
      skipped,
      latest: latest === 'newest' ? Math.max(0, ...all.map((l) => l.id)) : latest,
    }));
  const start: ChatState = { cursor: null, buffer: [] };

  it('on the first reading goes to the newest line without acting on the backlog', async () => {
    const reading = await readChat(start, page([line(5, 'nigger'), line(9, 'kys')]));
    expect(reading.first).toBe(true);
    expect(reading.fresh).toEqual([]);
    expect(reading.state.cursor).toBe(9);
    expect(reading.state.buffer.map((l) => l.id)).toEqual([5, 9]);
  });

  it('starts from latestSeq on the first reading, and keeps only the last few lines for /chat', async () => {
    const all = Array.from({ length: 450 }, (_, i) => line(i + 1, `line ${i + 1}`));
    const ask = page(all);
    const reading = await readChat(start, ask);
    expect(reading.state.cursor).toBe(450);
    expect(reading.fresh).toEqual([]);
    expect(reading.state.buffer).toHaveLength(50);
    expect(reading.state.buffer[0]?.id).toBe(401);
    expect(reading.state.buffer.at(-1)?.id).toBe(450);
    expect(ask.mock.calls).toEqual([
      [0, 1],
      [400, 200],
    ]);
  });

  it('starts from latestSeq even when the lines cannot be read after it', async () => {
    let calls = 0;
    const reading = await readChat(start, async () => {
      if (calls++ > 0) throw new Error('down');
      return { lines: [line(1, 'old')], skipped: 0, latest: 88 };
    });
    expect(reading.state).toEqual({ cursor: 88, buffer: [] });
    expect(reading.fresh).toEqual([]);
  });

  it('reads on page by page to the newest line when the server gives no latestSeq', async () => {
    const all = Array.from({ length: 450 }, (_, i) => line(i + 1, `line ${i + 1}`));
    const reading = await readChat(start, page(all, 0, null));
    expect(reading.state.cursor).toBe(450);
    expect(reading.fresh).toEqual([]);
    expect(reading.state.buffer.at(-1)?.id).toBe(450);
  });

  it('is not given the cursor line again when the server repeats it (after is inclusive), so it is never acted on twice', async () => {
    const all = [line(56, 'a'), line(57, 'kys'), line(58, 'b')];
    const ask = page(all);
    const first = await readChat({ cursor: 57, buffer: [] }, ask);
    expect(ask).toHaveBeenCalledWith(57, 200);
    expect(first.fresh.map((l) => l.id)).toEqual([58]);
    // Nothing new: the server sends the cursor's own line and nothing else.
    const idle = await readChat(first.state, page(all));
    expect(idle.fresh).toEqual([]);
    expect(idle.state.cursor).toBe(58);
    expect(idle.state.buffer.map((l) => l.id)).toEqual([58]);
    const repeat = await readChat({ cursor: 57, buffer: [] }, page([line(57, 'nigger')]));
    expect(repeat.fresh).toEqual([]);
  });

  it('starts at the beginning when the first reading finds no chat, so what comes next is acted on', async () => {
    const reading = await readChat(start, page([]));
    expect(reading.state.cursor).toBe(0);
    const next = await readChat(reading.state, page([line(1, 'kys')]));
    expect(next.first).toBe(false);
    expect(next.fresh.map((l) => l.id)).toEqual([1]);
  });

  it('gives each line once: the cursor moves past what was read', async () => {
    const all = [line(1, 'a'), line(2, 'kys'), line(3, 'c')];
    const first = await readChat({ cursor: 1, buffer: [] }, page(all));
    expect(first.fresh.map((l) => l.id)).toEqual([2, 3]);
    expect(first.state.cursor).toBe(3);
    const again = await readChat(first.state, page(all));
    expect(again.fresh).toEqual([]);
    expect(again.state.cursor).toBe(3);
  });

  it('asks after the cursor, and ignores lines at or before it even if the server sends them', async () => {
    const ask = vi.fn(async () => ({ lines: [line(3, 'old'), line(4, 'new')], skipped: 0, latest: 4 }));
    const reading = await readChat({ cursor: 3, buffer: [] }, ask);
    expect(ask).toHaveBeenCalledWith(3, 200);
    expect(reading.fresh.map((l) => l.id)).toEqual([4]);
  });

  it('keeps only the latest lines', async () => {
    const all = Array.from({ length: 150 }, (_, i) => line(i + 1, `line ${i + 1}`));
    const old = { cursor: 0, buffer: Array.from({ length: 150 }, (_, i) => kept(line(1000 + i, 'older'))) };
    const reading = await readChat(old, page(all));
    expect(reading.state.buffer).toHaveLength(200);
    expect(reading.state.buffer.at(-1)?.id).toBe(150);
  });

  it('leaves the state as it was when the first page fails, and keeps what earlier pages read', async () => {
    await expect(readChat({ cursor: 4, buffer: [] }, async () => Promise.reject(new Error('down')))).rejects.toThrow('down');
    const all = Array.from({ length: 300 }, (_, i) => line(i + 1, `line ${i + 1}`));
    let calls = 0;
    const reading = await readChat({ cursor: 0, buffer: [] }, async (after, limit) => {
      if (calls++ > 0) throw new Error('down');
      return { lines: all.filter((l) => l.id >= after).slice(0, limit), skipped: 0, latest: null };
    });
    expect(reading.fresh).toHaveLength(200);
    expect(reading.state.cursor).toBe(200);
  });

  it('moves the cursor on past rows it could not use, so it is never stuck', async () => {
    const unusable = vi.fn(async () => ({ lines: [], skipped: 3, latest: 12, maxSeq: 12, rows: 3 }));
    const reading = await readChat({ cursor: 9, buffer: [] }, unusable);
    expect(reading.state.cursor).toBe(12);
    expect(reading.skipped).toBe(3);
    expect(reading.fresh).toEqual([]);
    expect(unusable).toHaveBeenCalledTimes(1);
    // A full page of them goes on to the next page.
    let n = 0;
    const full = vi.fn(async (after: number) => {
      n += 1;
      return { lines: [], skipped: 200, latest: 999, maxSeq: after + 200, rows: n < 3 ? 200 : 5 };
    });
    expect((await readChat({ cursor: 0, buffer: [] }, full)).state.cursor).toBe(600);
  });

  it('never saves a cursor before it knows where the chat ends: a first reading that cannot find the end saves nothing', async () => {
    // No latestSeq, and more chat than the pages read at the start.
    const endless = async (after: number) => ({ lines: [line(after + 200, 'nigger')], skipped: 0, latest: null, maxSeq: after + 200, rows: 200 });
    await expect(readChat(start, endless)).rejects.toThrow('The end of the chat was not found');
    // The head page failing, or the newest line failing to be read after it, never leaves a cursor behind the end.
    await expect(readChat(start, async () => Promise.reject(new Error('down')))).rejects.toThrow('down');
    let calls = 0;
    const failing = await readChat(start, async () => {
      if (calls++ === 1) throw new Error('down');
      return { lines: [line(1, 'old')], skipped: 0, latest: 500, maxSeq: 1, rows: 1 };
    });
    expect(failing.state.cursor).toBe(500);
    expect(failing.fresh).toEqual([]);
  });

  it('never moves the cursor backwards', async () => {
    const behind = async () => ({ lines: [], skipped: 0, latest: 3, maxSeq: 3, rows: 0 });
    expect((await readChat({ cursor: 50, buffer: [] }, behind)).state.cursor).toBe(50);
  });

  it('counts the lines it could not read', async () => {
    const reading = await readChat({ cursor: 0, buffer: [] }, page([line(1, 'a')], 2));
    expect(reading.skipped).toBe(2);
  });

  it('reads the saved state, or starts again when it cannot', () => {
    expect(parseChatState({ cursor: 7, buffer: [kept(line(7, 'hi'))] })).toEqual({ cursor: 7, buffer: [kept(line(7, 'hi'))] });
    expect(parseChatState(undefined)).toEqual({ cursor: null, buffer: [] });
    expect(parseChatState({ cursor: 'x' })).toEqual({ cursor: null, buffer: [] });
  });

  it('keeps a long line short in the buffer, but not in what is acted on', async () => {
    const long = 'x'.repeat(250);
    const reading = await readChat({ cursor: 0, buffer: [] }, page([line(1, long)]));
    expect(reading.fresh[0]?.text).toHaveLength(250);
    expect(reading.state.buffer[0]?.text).toHaveLength(160);
  });
});

describe('the capabilities', () => {
  it('say whether GET /v1/chat is served', () => {
    expect(hasChatRoute(['GET /v1/status', 'GET /v1/chat'])).toBe(true);
    expect(hasChatRoute(['get /v1/chat?after=*'])).toBe(true);
    expect(hasChatRoute(['GET /v1/chat/'])).toBe(true);
    expect(hasChatRoute(['POST /v1/chat', 'GET /v1/chatter', 'GET /v1/players'])).toBe(false);
    expect(hasChatRoute([])).toBe(false);
  });
});

describe('/chat', () => {
  const buffer = [
    kept({ ...line(1, 'hello there', ASH, 'Ash'), channel: 'Team' }),
    kept(line(2, 'gg @everyone <@123>', BO, 'Bo')),
    kept(line(3, 'nice *shot*', ASH, 'Ash')),
  ];

  it('shows the latest lines, safe to post', () => {
    const reply = chatReply(buffer, undefined);
    expect(reply.split('\n')).toHaveLength(4);
    expect(reply).toContain('**Ash** (Team): hello there');
    expect(reply).toContain('gg @\u200beveryone <\u200b@\u200b123');
    expect(reply).toContain('nice \\*shot\\*');
    expect(reply).toContain(`<t:${Math.floor(AT / 1000)}:T>`);
  });

  it('filters by Steam ID or part of a name', () => {
    expect(chatReply(buffer, ASH).split('\n')).toHaveLength(3);
    expect(chatReply(buffer, 'bo').split('\n')).toHaveLength(2);
    expect(chatReply(buffer, 'nobody')).toBe('No recent chat from "nobody". The bot keeps the last 200 lines.');
    expect(chatReply([], undefined)).toBe('No chat read yet.');
  });

  it('shows the last lines asked for, and fits Discord', () => {
    expect(chatReply(buffer, undefined, 1).split('\n')).toHaveLength(2);
    const many = Array.from({ length: 200 }, (_, i) => kept(line(i, 'word '.repeat(30), ASH, 'Ash')));
    const reply = chatReply(many, undefined, 50);
    expect(reply.length).toBeLessThanOrEqual(2000);
    expect(reply.split('\n').length).toBeGreaterThan(2);
  });
});

describe('the verdict kept with each line', () => {
  const none = new Set<string>();
  const verdictsOf = (lines: ChatLine[], staff = none, actions = true, backlog = false) =>
    Object.fromEntries([...judgeLines(lines, compiled, staff, actions, backlog).verdicts].map(([id, v]) => [id, v]));

  it('says clean, exact or fuzzy, the word, and what the bot did', () => {
    expect(verdictsOf([line(1, 'gg'), line(2, 'you nigger', BO), line(3, 'kys'), line(4, 'k y s', BO)])).toEqual({
      1: { kind: 'clean', action: 'none' },
      2: { kind: 'exact', list: 'racism', word: 'nigger', action: 'banned' },
      3: { kind: 'exact', list: 'toxicity', word: 'kys', action: 'warned' },
      // Bo is banned for the line before: this one is only noted.
      4: { kind: 'fuzzy', list: 'toxicity', word: 'kys', action: 'alert' },
    });
  });

  it('says staff, actions off, no player and folded', () => {
    expect(verdictsOf([line(1, 'kys')], new Set([ASH]))[1]).toMatchObject({ kind: 'exact', action: 'staff' });
    expect(verdictsOf([line(1, 'kys')], none, false)[1]).toMatchObject({ action: 'actions-off' });
    expect(verdictsOf([line(1, 'kys', null, 'Server')])[1]).toMatchObject({ action: 'no-player' });
    const folded = verdictsOf([line(1, 'kys'), line(2, 'kys again'), line(3, 'nigger')]);
    expect(folded[1]).toMatchObject({ action: 'folded' });
    expect(folded[2]).toMatchObject({ action: 'folded' });
    expect(folded[3]).toMatchObject({ action: 'banned' });
  });

  it('lists the other words a line holds', () => {
    expect(verdictsOf([line(1, 'kys nigger')])[1]).toEqual({ kind: 'exact', list: 'racism', word: 'nigger', others: ['kys'], action: 'banned' });
  });

  it('marks the backlog as not acted on, with no calls', () => {
    const judged = judgeLines([line(1, 'nigger')], compiled, none, true, true);
    expect(judged.calls).toEqual([]);
    expect(judged.verdicts.get(1)).toMatchObject({ kind: 'exact', action: 'backlog' });
  });

  it('is kept in the saved state, and a failed action can be put on a line', () => {
    const verdict: Verdict = { kind: 'exact', list: 'racism', word: 'nigger', action: 'banned' };
    const buffer = withVerdicts([kept(line(1, 'a')), kept(line(2, 'nigger'))], new Map([[2, verdict]]));
    expect(buffer[0]?.verdict).toBeUndefined();
    expect(parseChatState({ cursor: 2, buffer })).toEqual({ cursor: 2, buffer });
    expect(withVerdicts(buffer, new Map([[2, { ...verdict, action: 'failed' as const }]]))[1]?.verdict?.action).toBe('failed');
    expect(parseChatState({ cursor: 2, buffer: [{ ...kept(line(1, 'a')), verdict: { kind: 'odd', action: 'banned' } }] })).toEqual({ cursor: null, buffer: [] });
  });

  it('shows in /chat', () => {
    const buffer = withVerdicts(
      [kept(line(1, 'you nigger')), kept(line(2, 'k y s', BO, 'Bo')), kept(line(3, 'gg'))],
      new Map<number, Verdict>([
        [1, { kind: 'exact', list: 'racism', word: 'nigger', action: 'banned' }],
        [2, { kind: 'fuzzy', list: 'toxicity', word: 'kys', action: 'alert' }],
      ]),
    );
    const rows = chatReply(buffer, undefined).split('\n');
    expect(rows).toContain('   ↳ 🚫 exact racism "nigger", banned');
    expect(rows).toContain('   ↳ ❓ resembles "kys", alert only');
    expect(rows.filter((r) => r.includes('↳'))).toHaveLength(2);
  });
});

describe('the live chat feed', () => {
  const state: ChatState = {
    cursor: 5,
    buffer: [1, 2, 3, 4, 5].map((id) => kept(line(id, `line ${id}`))),
  };
  const on = { enabled: true, available: true };

  it('gives the lines after the cursor asked, oldest first, and the newest id', () => {
    expect(chatFeed(state, 0, on).lines.map((l) => l.id)).toEqual([1, 2, 3, 4, 5]);
    expect(chatFeed(state, 3, on)).toMatchObject({ cursor: 5, enabled: true, available: true, lines: [{ id: 4 }, { id: 5 }] });
    expect(chatFeed(state, 5, on).lines).toEqual([]);
  });

  it('says when nothing is read yet or the chat is not served', () => {
    expect(chatFeed({ cursor: null, buffer: [] }, 0, { enabled: false, available: false })).toEqual({ enabled: false, available: false, cursor: null, lines: [] });
    expect(chatFeed({ cursor: 0, buffer: [] }, 0, on).cursor).toBe(0);
  });
});

describe('a line is matched whole, never cut first', () => {
  it('does not turn a long line into a listed word by cutting it', () => {
    // 295 letters and " spice": cut to 300 characters it would end in "spic", a listed word.
    const long = `${'x'.repeat(295)} spice`;
    const [kept] = parseChat({ messages: [{ seq: 1, text: long, steamId: ASH, realName: 'A' }] }, AT).lines;
    expect(kept?.text).toBe(long);
    expect(matchLine(kept!.text, compiled)).toEqual([]);
    expect(judgeChat([kept!], compiled, new Set(), true)).toEqual([]);
  });
});

describe('the text as typed, and names', () => {
  const none = new Set<string>();

  it('reads both what players saw and what was typed, and takes the more serious', () => {
    const filtered: ChatLine = { ...line(1, 'you ******'), rawText: 'you nigger' };
    const [call] = judgeChat([filtered], compiled, none, true);
    expect(call).toMatchObject({ kind: 'ban', hit: { kind: 'exact', word: 'nigger' } });
    // Exact in one reading and fuzzy in the other: exact.
    const mixed: ChatLine = { ...line(2, 'n1gger', BO), rawText: 'nigger' };
    expect(judgeLines([mixed], compiled, none, true).verdicts.get(2)).toMatchObject({ kind: 'exact', action: 'banned' });
    const fuzzyOnly: ChatLine = { ...line(3, 'gg'), rawText: 'k y s' };
    expect(judgeLines([fuzzyOnly], compiled, none, true).verdicts.get(3)).toMatchObject({ kind: 'fuzzy', word: 'kys' });
  });

  it('gives the line as typed as the evidence and the ban reason', () => {
    const [call] = judgeChat([{ ...line(1, 'you ******'), rawText: 'you nigger' }], compiled, none, true);
    expect(callEvidence(call!)).toBe('Chat #1: "you nigger" (matched "nigger" on the racism list)');
    expect(banReasonText({ ...line(1, 'you ******'), rawText: 'you nigger' }, 'nigger')).toBe('Racist language in chat (nigger): "you nigger"');
  });

  it('shows /chat the typed text, the name others saw, the channel, the faction and a ping', () => {
    const entry = kept({ ...line(1, 'you ****', ASH, '[LAND] Ash'), rawText: 'you nigger', shownAs: 'Olive', channel: 'Team', faction: 'Lonestar', ping: true });
    const rows = chatReply([entry], undefined).split('\n');
    expect(rows[1]).toContain('**\\[LAND\\] Ash** (shown as Olive) (Team, Lonestar) 📣: you \\*\\*\\*\\*');
    expect(rows[2]).toBe('   ↳ typed: you nigger');
  });
});
