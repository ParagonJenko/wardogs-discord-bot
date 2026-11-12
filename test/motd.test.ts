import { describe, expect, it, vi } from 'vitest';
import {
  checkMotdLine,
  escapeMotdLine,
  motdPage,
  parseMotd,
  saveMotd,
  setMotd,
  unescapeMotdLine,
  validateMotd,
} from '../src/motd.ts';
import { RconError, type ConfigResult, type ServerConfig } from '../src/rcon.ts';

const SECTION = '[/Script/WDGame.WDGameStateSession]';

const FILE = [
  '[/Script/WDGame.WDGameModeBase]',
  'ServerName=Test',
  '',
  SECTION,
  'bLockOverpopulatedTeamsConfig=True',
  'bServerWelcomeMessageEnabled=True',
  '!ServerWelcomeMessageLines=ClearArray',
  '.ServerWelcomeMessageLines=&lt;Header&gt;Welcome&lt;/&gt;',
  '.ServerWelcomeMessageLines=',
  '.ServerWelcomeMessageLines=&lt;Italic&gt;Have fun &amp;amp; good hunting!&lt;/&gt;',
  'SomethingElse=1',
  '',
  '[/Script/WDGame.Other]',
  'Key=Value',
  '',
].join('\n');

describe('escaping', () => {
  it('stores a line escaped once', () => {
    expect(escapeMotdLine('<Italic>Have fun &amp; good hunting!</>')).toBe('&lt;Italic&gt;Have fun &amp;amp; good hunting!&lt;/&gt;');
    expect(escapeMotdLine('say "hi"')).toBe('say &quot;hi&quot;');
  });

  it('reads it back once, so &amp;lt; is not turned into <', () => {
    expect(unescapeMotdLine('&lt;Italic&gt;Have fun &amp;amp; good hunting!&lt;/&gt;')).toBe('<Italic>Have fun &amp; good hunting!</>');
    expect(unescapeMotdLine('&amp;lt;')).toBe('&lt;');
    expect(unescapeMotdLine('&quot;x&quot;')).toBe('"x"');
    expect(unescapeMotdLine('a &unknown; b')).toBe('a &unknown; b');
  });

  it.each(['', 'plain', '<Bold>1. No cheats</> - no hacks', '<Italic>Have fun &amp; good hunting!</>', '&lt;&gt;&amp;&quot;', 'a &amp;lt; b', '<text color="#FF4D4D">x</>'])(
    'round-trips %j',
    (line) => {
      expect(unescapeMotdLine(escapeMotdLine(line))).toBe(line);
    },
  );
});

describe('the validator', () => {
  const problems = (line: string) => checkMotdLine(line).problems;

  it.each([
    '',
    'plain text',
    '<Header>Welcome to gaminginit</>',
    '<Bold>1. No cheats</> - no aimbots',
    '<Italic>Have fun &amp; good hunting!</>',
    '<text color="#E8A33D" size="16" fontface="Bold">Play hard, play fair.</>',
    '<text>no attributes</>',
    '<text size="8">small</> and <text size="24">big</>',
    'Ask in our Discord: <text color="#7FD6FF">discord.gg/qsJFYGhSJ4</>',
    '&lt;3 &quot;quoted&quot;',
  ])('accepts %j', (line) => {
    expect(problems(line)).toEqual([]);
  });

  it.each([
    ['<Bold>never closed', /never closed/],
    ['closed</>', /no tag to close/],
    ['<Bold><Italic>x</></>', /inside each other/],
    ['<Header color="#FFFFFF">x</>', /Header> takes no attributes/],
    ['<Bold size="9">x</>', /takes no attributes/],
    ['<a href="x">link</>', /isn't a tag/],
    ['<bold>x</>', /case sensitive/],
    ['<text size="7">x</>', /from 8 to 24/],
    ['<text size="25">x</>', /from 8 to 24/],
    ['<text size="1.5">x</>', /whole number/],
    ['<text color="red">x</>', /#E8A33D/],
    ['<text color="#FFF">x</>', /six hex/],
    ['<text fontface="Comic">x</>', /Bold" or "Italic/],
    ['<text colour="#FFFFFF">x</>', /no colour attribute/],
    ['<text size="9" size="10">x</>', /twice/],
    ['<text size=16>x</>', /straight double quotes/],
    ['<text size=“16”>x</>', /straight quotes/],
    ['<text size="16”>x</>', /straight quotes/],
    ['a > b', /">" on its own/],
    ['a < b', /"<"/],
    ['fish & chips', /"&" on its own/],
    ['say "hi"', /&quot;/],
    ['bad &nbsp; entity', /"&" on its own/],
    ['line\nbreak', /line break/],
  ])('refuses %j', (line, message) => {
    expect(problems(line).join('\n')).toMatch(message);
  });

  it('counts what shows: tags are free and each entity is one', () => {
    expect(checkMotdLine('<Bold>abc</>').visible).toBe(3);
    expect(checkMotdLine('&amp;&lt;&gt;&quot;').visible).toBe(4);
    expect(checkMotdLine('<text color="#FFFFFF" size="9">hi</> there').visible).toBe(8);
    expect(checkMotdLine('\u{1F600}x').visible).toBe(2);
  });

  it('allows 128 characters and refuses 129', () => {
    expect(problems('a'.repeat(128))).toEqual([]);
    expect(problems(`<Bold>${'a'.repeat(128)}</>`)).toEqual([]);
    expect(problems(`${'&amp;'.repeat(128)}`)).toEqual([]);
    expect(problems('a'.repeat(129)).join()).toMatch(/129 characters/);
    expect(problems('&amp;'.repeat(129)).join()).toMatch(/129 characters/);
  });

  it('allows 128 lines and refuses 129, numbering lines from 1', () => {
    expect(validateMotd(Array.from({ length: 128 }, () => 'x'))).toEqual([]);
    expect(validateMotd(Array.from({ length: 129 }, () => 'x'))).toEqual([{ line: null, problem: '129 lines, but a message can have at most 128.' }]);
    expect(validateMotd(['ok', '<Bold>x', 'fine'])).toEqual([{ line: 2, problem: '<Bold> is never closed. End it with </>.' }]);
  });
});

describe('reading the settings', () => {
  it('reads the flag and the lines as the popup shows them', () => {
    expect(parseMotd(FILE)).toEqual({
      enabled: true,
      lines: ['<Header>Welcome</>', '', '<Italic>Have fun &amp; good hunting!</>'],
    });
  });

  it('reads missing keys as off with no lines, and the file as CRLF', () => {
    expect(parseMotd('[/Script/Other]\nA=1\n')).toEqual({ enabled: false, lines: [] });
    expect(parseMotd(FILE.replace(/\n/g, '\r\n')).lines).toHaveLength(3);
    expect(parseMotd(FILE.replace('Enabled=True', 'Enabled=False')).enabled).toBe(false);
  });

  it('follows the array prefixes: ! empties, + and . add, - takes out', () => {
    const text = [
      SECTION,
      '+ServerWelcomeMessageLines=old',
      '!ServerWelcomeMessageLines=ClearArray',
      '+ServerWelcomeMessageLines=a',
      'ServerWelcomeMessageLines=b',
      '.ServerWelcomeMessageLines=c',
      '-ServerWelcomeMessageLines=b',
    ].join('\n');
    expect(parseMotd(text).lines).toEqual(['a', 'c']);
  });

  it('ignores the same keys in another section', () => {
    expect(parseMotd(['[/Script/Other]', 'bServerWelcomeMessageEnabled=True', '.ServerWelcomeMessageLines=x'].join('\n'))).toEqual({
      enabled: false,
      lines: [],
    });
  });
});

describe('writing the settings', () => {
  it('replaces the two keys in place and touches nothing else', () => {
    const next = setMotd(FILE, false, ['<Bold>Hi</>', '', 'a &amp; b']);
    expect(next).toBe(
      FILE.replace('bServerWelcomeMessageEnabled=True', 'bServerWelcomeMessageEnabled=False').replace(
        [
          '.ServerWelcomeMessageLines=&lt;Header&gt;Welcome&lt;/&gt;',
          '.ServerWelcomeMessageLines=',
          '.ServerWelcomeMessageLines=&lt;Italic&gt;Have fun &amp;amp; good hunting!&lt;/&gt;',
        ].join('\n'),
        ['.ServerWelcomeMessageLines=&lt;Bold&gt;Hi&lt;/&gt;', '.ServerWelcomeMessageLines=', '.ServerWelcomeMessageLines=a &amp;amp; b'].join('\n'),
      ),
    );
    expect(parseMotd(next)).toEqual({ enabled: false, lines: ['<Bold>Hi</>', '', 'a &amp; b'] });
  });

  it('round-trips lines through the file, &amp; and quotes included', () => {
    const lines = ['<Italic>Have fun &amp; good hunting!</>', '', 'a &lt; b &quot;c&quot;', '&amp;lt;', '<text color="#FF4D4D" size="20">x</>'];
    expect(parseMotd(setMotd(FILE, true, lines)).lines).toEqual(lines);
    expect(parseMotd(setMotd('', true, lines)).lines).toEqual(lines);
  });

  it('writes the file as the live server has it', () => {
    const next = setMotd(FILE, true, ['<Italic>Have fun &amp; good hunting!</>']);
    expect(next).toContain('!ServerWelcomeMessageLines=ClearArray\n.ServerWelcomeMessageLines=&lt;Italic&gt;Have fun &amp;amp; good hunting!&lt;/&gt;\nSomethingElse=1');
  });

  it('drops old lines with any prefix, and a second copy of the flag', () => {
    const messy = [SECTION, '+ServerWelcomeMessageLines=old', 'bServerWelcomeMessageEnabled=False', 'Other=1', '-ServerWelcomeMessageLines=old', 'bServerWelcomeMessageEnabled=True'].join('\n');
    expect(setMotd(messy, true, ['x'])).toBe(
      [SECTION, '!ServerWelcomeMessageLines=ClearArray', '.ServerWelcomeMessageLines=x', 'bServerWelcomeMessageEnabled=True', 'Other=1'].join('\n'),
    );
  });

  it('keeps a prefix on the flag, and the file line endings', () => {
    expect(setMotd(`${SECTION}\r\n+bServerWelcomeMessageEnabled=False\r\n`, true, ['a'])).toBe(
      `${SECTION}\r\n+bServerWelcomeMessageEnabled=True\r\n!ServerWelcomeMessageLines=ClearArray\r\n.ServerWelcomeMessageLines=a\r\n`,
    );
  });

  it('inserts the missing keys after the last line of the section, ahead of the next one', () => {
    const text = [SECTION, 'bLockOverpopulatedTeamsConfig=True', '', '[/Script/WDGame.Other]', 'Key=Value'].join('\n');
    expect(setMotd(text, true, ['a'])).toBe(
      [SECTION, 'bLockOverpopulatedTeamsConfig=True', 'bServerWelcomeMessageEnabled=True', '!ServerWelcomeMessageLines=ClearArray', '.ServerWelcomeMessageLines=a', '', '[/Script/WDGame.Other]', 'Key=Value'].join('\n'),
    );
  });

  it('inserts the flag when only the lines are there, and the lines when only the flag is', () => {
    expect(setMotd([SECTION, '.ServerWelcomeMessageLines=old'].join('\n'), true, ['a'])).toBe(
      [SECTION, 'bServerWelcomeMessageEnabled=True', '!ServerWelcomeMessageLines=ClearArray', '.ServerWelcomeMessageLines=a'].join('\n'),
    );
    expect(setMotd([SECTION, 'bServerWelcomeMessageEnabled=False', 'X=1'].join('\n'), true, ['a'])).toBe(
      [SECTION, 'bServerWelcomeMessageEnabled=True', '!ServerWelcomeMessageLines=ClearArray', '.ServerWelcomeMessageLines=a', 'X=1'].join('\n'),
    );
  });

  it('adds the section when the file has none', () => {
    expect(setMotd('[/Script/Other]\nA=1\n', false, [])).toBe(
      ['[/Script/Other]', 'A=1', '', SECTION, 'bServerWelcomeMessageEnabled=False', '!ServerWelcomeMessageLines=ClearArray', ''].join('\n'),
    );
  });

  it('refuses a line with a line break, and a section that is there twice', () => {
    expect(() => setMotd(FILE, true, ['a\nb'])).toThrow(/line break/);
    expect(() => setMotd(`${FILE}\n${SECTION}\n`, true, ['a'])).toThrow(/more than once/);
  });
});

describe('saving', () => {
  const config = (over: Partial<ServerConfig> = {}): ServerConfig => ({ revision: '7', writable: true, text: FILE, ...over });
  const file = (current: ServerConfig, validate: ConfigResult = { ok: true, errors: [], ignored: [] }, put?: () => Promise<ConfigResult>) => ({
    fetchConfig: vi.fn(async () => current),
    validate: vi.fn(async () => validate),
    put: vi.fn(put ?? (async () => ({ ok: true, errors: [], ignored: [] }))),
  });
  const edit = { enabled: true, lines: ['<Bold>Hi</>'], revision: '7' };

  it('writes only after the server has checked it, with the revision it read', async () => {
    const f = file(config());
    expect(await saveMotd(f, edit)).toEqual({ status: 'saved', outcome: 'next-match' });
    const text = setMotd(FILE, true, edit.lines);
    expect(f.validate).toHaveBeenCalledWith(text);
    expect(f.put).toHaveBeenCalledWith({ revision: '7', writable: true, text });
  });

  it('refuses a message that breaks the rules without reading the server', async () => {
    const f = file(config());
    expect(await saveMotd(f, { ...edit, lines: ['ok', '<a>x</>'] })).toMatchObject({ status: 'invalid', problems: [{ line: 2 }] });
    expect(f.fetchConfig).not.toHaveBeenCalled();
  });

  it('says it changed when the revision is not the one staff had, and writes nothing', async () => {
    const f = file(config({ revision: '8' }));
    expect(await saveMotd(f, edit)).toEqual({ status: 'changed' });
    expect(f.put).not.toHaveBeenCalled();
  });

  it('says it changed on a 412, and never retries', async () => {
    const f = file(config(), undefined, async () => {
      throw new RconError('412', 412, 'revision_mismatch');
    });
    expect(await saveMotd(f, edit)).toEqual({ status: 'changed' });
    expect(f.put).toHaveBeenCalledTimes(1);
  });

  it('does not write what the server refuses or would ignore', async () => {
    const refused = file(config(), { ok: false, errors: ['bad line'], ignored: [] });
    expect(await saveMotd(refused, edit)).toMatchObject({ status: 'refused', reason: expect.stringContaining('bad line') });
    expect(refused.put).not.toHaveBeenCalled();
    const ignored = file(config(), { ok: true, errors: [], ignored: ['ServerWelcomeMessageLines'] });
    expect(await saveMotd(ignored, edit)).toMatchObject({ status: 'refused' });
    expect(ignored.put).not.toHaveBeenCalled();
  });

  it('writes nothing when the file says it already', async () => {
    const f = file(config());
    expect(await saveMotd(f, { ...parseMotd(FILE), revision: '7' })).toEqual({ status: 'saved', outcome: 'unchanged' });
    expect(f.put).not.toHaveBeenCalled();
  });

  it('throws when the settings are read-only, or another error comes back from the server', async () => {
    await expect(saveMotd(file(config({ writable: false })), edit)).rejects.toThrow(/read-only/);
    const f = file(config(), undefined, async () => {
      throw new RconError('boom', 500);
    });
    await expect(saveMotd(f, edit)).rejects.toThrow('boom');
  });

  it('shows the page with problems in what the file has now', () => {
    const bad = [SECTION, '.ServerWelcomeMessageLines=&lt;Bold&gt;oops'].join('\n');
    expect(motdPage(config({ text: bad }))).toEqual({ enabled: false, lines: ['<Bold>oops'], revision: '7', problems: [{ line: 1, problem: '<Bold> is never closed. End it with </>.' }] });
  });
});
