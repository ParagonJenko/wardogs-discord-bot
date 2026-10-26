import { describe, expect, it, vi } from 'vitest';
import {
  closeTicket,
  handleTicket,
  MAX_OPEN_PER_USER,
  openTicket,
  parseTopic,
  ticketChannelName,
  ticketModal,
  ticketOverwrites,
  ticketPanel,
  transcriptText,
  type TicketRequest,
  type TicketRule,
} from '../src/tickets.ts';

const rule: TicketRule = { botToken: 'bot', guildId: '1', categoryId: '50', logChannelId: '60', staffRoleIds: ['70', '71'] };

const request = (over: Partial<TicketRequest> = {}): TicketRequest => ({
  kind: 'modal',
  customId: 'ticket:new:appeal',
  fields: { who: 'Ozeti', banned: 'Team killing', why: 'Sorry' },
  channelId: '900',
  userId: '300',
  userName: 'Ozeti',
  staff: false,
  applicationId: '111',
  token: 'tok',
  ...over,
});

const OPENER = '300';
const BOT = '111';
// A channel as Discord returns it after creating it with the overwrites we sent.
const madeChannel = (id = '777') => ({ id, permission_overwrites: ticketOverwrites(rule, OPENER, BOT) });
const hiddenLog = { id: '60', permission_overwrites: [{ id: '1', type: 0, allow: '0', deny: String(1 << 10) }] };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('ticket helpers', () => {
  it('reads a ticket topic, and nothing else', () => {
    expect(parseTopic('appeal ticket · opener 300')).toEqual({ type: 'appeal', userId: '300' });
    expect(parseTopic('general chat')).toBeNull();
    expect(parseTopic(null)).toBeNull();
  });

  it('makes a channel name from letters and digits', () => {
    expect(ticketChannelName('appeal', 'Ozeti_ [WD]!', '300')).toBe('appeal-ozeti-wd');
    expect(ticketChannelName('query', '😀😀', '123456')).toBe('query-3456');
  });

  it('hides the channel from everyone but the opener, staff roles and the bot', () => {
    const overwrites = ticketOverwrites(rule, '300', '111');
    expect(overwrites[0]).toMatchObject({ id: '1', type: 0, allow: '0' });
    expect(BigInt(overwrites[0]?.deny ?? 0) & (1n << 10n)).toBe(1n << 10n);
    expect(overwrites.map((o) => o.id)).toEqual(['1', '70', '71', '300', '111']);
    expect(overwrites.filter((o) => BigInt(o.allow) & (1n << 10n)).length).toBe(4);
  });

  it('has a button and a form for each kind', () => {
    const ids = ticketPanel().components.flatMap((row) => (row as { components: { custom_id: string }[] }).components.map((b) => b.custom_id));
    expect(ids).toEqual(['ticket:open:urgent', 'ticket:open:report', 'ticket:open:appeal', 'ticket:open:query']);
    for (const type of ['urgent', 'report', 'appeal', 'query'] as const) {
      const modal = ticketModal(type);
      expect(modal.data.components.length).toBeLessThanOrEqual(5);
      for (const row of modal.data.components) expect(row.components[0]?.label.length).toBeLessThanOrEqual(45);
    }
  });

  it('writes a transcript with embeds and attachments', () => {
    const text = transcriptText([
      {
        id: '1',
        timestamp: '2026-10-26T10:00:00Z',
        content: '',
        author: { username: 'bot', bot: true },
        attachments: [],
        embeds: [{ title: 'Ban appeal', description: null, fields: [{ name: 'Why', value: 'Sorry' }] }],
      },
      { id: '2', timestamp: '2026-10-26T10:01:00Z', content: 'hi', author: { username: 'Ozeti' }, attachments: [{ url: 'https://x/y.png' }], embeds: [] },
    ]);
    expect(text).toContain('bot (bot): Ban appeal\n    Why: Sorry');
    expect(text).toContain('Ozeti: hi\n    [attachment] https://x/y.png');
  });
});

describe('openTicket', () => {
  it('creates a private channel and posts the details', async () => {
    const calls: { url: string; method: string; body: any }[] = [];
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: String(url), method: init?.method ?? 'GET', body });
      if (init?.method === 'GET') return json([{ id: '9', parent_id: '50', topic: 'query ticket · opener 999' }]);
      if (String(url).endsWith('/channels')) return json(madeChannel());
      return json({ id: 'm1' });
    }) as unknown as typeof fetch;
    const reply = await openTicket({ rule, fetchFn }, 'appeal', request());
    expect(reply).toBe('✅ Your ticket is open: <#777>');
    const created = calls.find((c) => c.method === 'POST' && c.url.endsWith('/guilds/1/channels'));
    expect(created?.body).toMatchObject({ name: 'appeal-ozeti', parent_id: '50', topic: 'appeal ticket · opener 300' });
    const posted = calls.find((c) => c.url.endsWith('/channels/777/messages'));
    expect(posted?.body.embeds[0].fields).toEqual([
      { name: 'Your in-game name or Steam ID', value: 'Ozeti' },
      { name: 'Why were you banned?', value: 'Team killing' },
      { name: 'Why should it be lifted?', value: 'Sorry' },
    ]);
    // An appeal does not ping staff.
    expect(posted?.body.allowed_mentions).toEqual({ users: ['300'], roles: [] });
  });

  it('pings the staff roles for an urgent ticket', async () => {
    const bodies: any[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'GET') return json([]);
      bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
      return json(madeChannel());
    }) as typeof fetch;
    await openTicket({ rule, fetchFn }, 'urgent', request({ fields: { who: 'x', details: 'aimbot' } }));
    expect(bodies[1].allowed_mentions).toEqual({ users: ['300'], roles: ['70', '71'] });
    expect(bodies[1].content).toBe('<@300> <@&70> <@&71>');
  });

  it('refuses a fourth open ticket', async () => {
    const open = Array.from({ length: MAX_OPEN_PER_USER }, (_, i) => ({ id: String(10 + i), parent_id: '50', topic: 'report ticket · opener 300' }));
    const fetchFn = vi.fn(async () => json(open)) as unknown as typeof fetch;
    const reply = await openTicket({ rule, fetchFn }, 'query', request());
    expect(reply).toContain('already have 3 tickets open');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('deletes the channel if the first message cannot be posted', async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method} ${String(url)}`);
      if (init?.method === 'GET') return json([]);
      if (init?.method === 'DELETE') return json({});
      if (String(url).endsWith('/messages')) return json({ message: 'Missing Access' }, 403);
      return json(madeChannel());
    }) as typeof fetch;
    await expect(openTicket({ rule, fetchFn }, 'query', request())).rejects.toThrow('missing permissions in the ticket category');
    expect(calls).toContain('DELETE https://discord.com/api/v10/channels/777');
  });
});

describe('privacy', () => {
  it('refuses to trust a channel that is visible to anyone else', async () => {
    const mine = madeChannel();
    const cases: Record<string, unknown> = {
      'not hidden from @everyone': { id: '777', permission_overwrites: mine.permission_overwrites.filter((o) => o.id !== '1') },
      '@everyone allowed': { id: '777', permission_overwrites: [{ id: '1', type: 0, allow: String(1 << 10), deny: '0' }, ...mine.permission_overwrites.slice(1)] },
      'a stranger shown it': { id: '777', permission_overwrites: [...mine.permission_overwrites, { id: '999', type: 0, allow: String(1 << 10), deny: '0' }] },
      'no list': { id: '777' },
    };
    for (const [name, channel] of Object.entries(cases)) {
      const calls: string[] = [];
      const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push(`${init?.method} ${String(url)}`);
        if (init?.method === 'GET') return json([]);
        if (init?.method === 'DELETE') return json({});
        return json(channel);
      }) as typeof fetch;
      await expect(openTicket({ rule, fetchFn }, 'query', request()), name).rejects.toThrow();
      expect(calls, name).toContain('DELETE https://discord.com/api/v10/channels/777');
      // Nothing was posted in it, and nobody was told it exists.
      expect(calls.some((c) => c.endsWith('/messages')), name).toBe(false);
    }
  });

  it('never gives @everyone access, even if it is set as a staff role', () => {
    const overwrites = ticketOverwrites({ ...rule, staffRoleIds: ['1', '70'] }, '300', '111');
    expect(overwrites.filter((o) => o.id === '1')).toEqual([{ id: '1', type: 0, allow: '0', deny: String(1 << 10) }]);
  });

  it('stops the opener from inviting, starting threads or pinging everyone', () => {
    const opener = ticketOverwrites(rule, '300', '111').find((o) => o.id === '300');
    const deny = BigInt(opener?.deny ?? 0);
    for (const bit of [0n, 35n, 36n, 17n]) expect(deny & (1n << bit)).toBe(1n << bit);
  });

  it('keeps transcripts out of a log channel anyone can read', async () => {
    const channel = { id: '777', name: 'appeal-ozeti', parent_id: '50', topic: 'appeal ticket · opener 300' };
    for (const log of [{ id: '60', permission_overwrites: [] }, { id: '60' }]) {
      const calls: string[] = [];
      const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push(`${init?.method} ${String(url)}`);
        return json(String(url).endsWith('/channels/60') ? log : channel);
      }) as typeof fetch;
      await expect(closeTicket({ rule, fetchFn }, '777', request({ staff: true }))).rejects.toThrow(/not hidden from @everyone|did not say/);
      expect(calls.some((c) => c.startsWith('DELETE') || c.startsWith('POST'))).toBe(false);
    }
  });
});

describe('failures', () => {
  const log = { error: vi.fn() };
  it('tells the person when the bot lacks permissions, without leaking details', async () => {
    const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) =>
      init?.method === 'GET' ? json([]) : json({ code: 50013, message: 'Missing Permissions' }, 403)) as typeof fetch;
    const edit = vi.fn(async () => undefined);
    const result = await handleTicket({ rule, fetchFn }, request(), edit, log);
    await result.followUp?.();
    expect(edit).toHaveBeenCalledWith({ content: expect.stringContaining('missing permissions in the ticket category') });
    expect(edit).toHaveBeenCalledWith({ content: expect.stringContaining('Discord 50013') });
    // The log keeps the operation, status and Discord's answer.
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('creating the ticket channel: 403 {"code":50013'));
  });

  it('says a private channel could not be made when it is exposed', async () => {
    const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) =>
      init?.method === 'GET' ? json([]) : json({ id: '777', permission_overwrites: [] })) as typeof fetch;
    const edit = vi.fn(async () => undefined);
    const result = await handleTicket({ rule, fetchFn }, request(), edit, log);
    await result.followUp?.();
    expect(edit).toHaveBeenCalledWith({ content: expect.stringContaining("couldn't make it private") });
    // Who the channel was shown to is for the log only.
    expect(JSON.stringify(edit.mock.calls)).not.toContain('@everyone');
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('was not private: the channel is not hidden from @everyone'));
  });
});

describe('claiming', () => {
  const log = { error: vi.fn() };
  const edit = vi.fn(async () => undefined);
  const details = { title: 'Ban appeal', type: 'rich', fields: [{ name: 'Why', value: 'Sorry', inline: false }] };
  const claimed = (id: string) => ({ ...details, fields: [...details.fields, { name: 'Claimed by', value: `<@${id}>`, inline: false }] });
  const press = (embed: unknown, over: Partial<TicketRequest> = {}) =>
    request({ kind: 'button', customId: 'ticket:claim', staff: true, userId: '400', message: { id: '555', embeds: [embed] }, ...over });

  it('marks an unclaimed ticket as claimed on its message', async () => {
    const result = await handleTicket({ rule }, press(details), edit, log);
    const data = (result.body as { type: number; data: { embeds: { fields: { name: string; value: string }[] }[] } });
    expect(data.type).toBe(7);
    expect(data.data.embeds[0]?.fields.at(-1)).toMatchObject({ name: 'Claimed by', value: '<@400>' });
    expect(data.data.embeds[0]?.fields).toHaveLength(2);
  });

  it('tells you if you already have it', async () => {
    const result = await handleTicket({ rule }, press(claimed('400')), edit, log);
    expect(JSON.stringify(result.body)).toContain('already claimed this ticket');
    expect(result.body).toMatchObject({ type: 4, data: { flags: 64 } });
  });

  it('asks before claiming a ticket someone else has, and changes nothing', async () => {
    const result = await handleTicket({ rule }, press(claimed('300')), edit, log);
    expect(result.body).toMatchObject({ type: 4, data: { flags: 64 } });
    const text = JSON.stringify(result.body);
    expect(text).toContain('<@300> has already claimed');
    expect(text).toContain('ticket:takeover:555');
    expect(result.followUp).toBeUndefined();
  });

  it('only lets staff take over, and only from a real message id', async () => {
    const member = await handleTicket({ rule }, request({ kind: 'button', customId: 'ticket:takeover:555', staff: false }), edit, log);
    expect(JSON.stringify(member.body)).toContain('Only staff');
    const bad = await handleTicket({ rule }, request({ kind: 'button', customId: 'ticket:takeover:../x', staff: true }), edit, log);
    expect(JSON.stringify(bad.body)).toContain('Unknown ticket');
  });

  it('takes over, saying so in the channel, from a fresh read of the message', async () => {
    const calls: { method: string; url: string; body?: any }[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (String(url).endsWith('/channels/900')) return json({ id: '900', parent_id: '50', topic: 'appeal ticket · opener 300' });
      if (String(url).endsWith('/messages/555') && init?.method !== 'PATCH') return json({ author: { id: '111' }, embeds: [claimed('300')] });
      return json({});
    }) as typeof fetch;
    const done = vi.fn(async () => undefined);
    const result = await handleTicket(
      { rule, fetchFn },
      request({ kind: 'button', customId: 'ticket:takeover:555', staff: true, userId: '400' }),
      done,
      log,
    );
    await result.followUp?.();
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.body.embeds[0].fields.filter((f: { name: string }) => f.name === 'Claimed by')).toEqual([
      { name: 'Claimed by', value: '<@400>', inline: false },
    ]);
    const note = calls.find((c) => c.method === 'POST');
    expect(note?.body).toEqual({ content: '🔁 <@400> took this ticket over from <@300>.', allowed_mentions: { parse: [] } });
    expect(done).toHaveBeenCalledWith({ content: '✅ You now have this ticket.' });
  });

  it('will not edit a message that is not the bot\'s, or a channel that is not a ticket', async () => {
    for (const [channel, message] of [
      [{ id: '900', parent_id: '50', topic: 'appeal ticket · opener 300' }, { author: { id: '999' }, embeds: [] }],
      [{ id: '900', parent_id: '51', topic: 'appeal ticket · opener 300' }, { author: { id: '111' }, embeds: [] }],
      [{ id: '900', parent_id: '50', topic: 'general' }, { author: { id: '111' }, embeds: [] }],
    ] as const) {
      const methods: string[] = [];
      const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
        methods.push(init?.method ?? 'GET');
        return json(String(url).endsWith('/channels/900') ? channel : message);
      }) as typeof fetch;
      const result = await handleTicket({ rule, fetchFn }, request({ kind: 'button', customId: 'ticket:takeover:555', staff: true }), vi.fn(async () => undefined), log);
      await result.followUp?.();
      expect(methods).not.toContain('PATCH');
      expect(methods).not.toContain('POST');
    }
  });
});

describe('openTicket cleanup', () => {
  it('deletes the channel when posting rejects outright', async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method} ${String(url)}`);
      if (init?.method === 'GET') return json([]);
      if (init?.method === 'DELETE') return json({});
      if (String(url).endsWith('/messages')) throw new Error('timeout');
      return json(madeChannel());
    }) as typeof fetch;
    await expect(openTicket({ rule, fetchFn }, 'query', request())).rejects.toThrow('timeout');
    expect(calls).toContain('DELETE https://discord.com/api/v10/channels/777');
  });
});

describe('closeTicket', () => {
  const channel = { id: '777', name: 'appeal-ozeti', parent_id: '50', topic: 'appeal ticket · opener 300' };

  it('saves the transcript, then deletes the channel', async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method} ${String(url)}`);
      if (String(url).includes('/messages?')) return json([{ id: '1', timestamp: 't', content: 'hello', author: { username: 'Ozeti' } }]);
      if (String(url).endsWith('/channels/60')) return json(hiddenLog);
      if (init?.method === 'GET') return json(channel);
      if (init?.method === 'DELETE') return json({});
      return json({ id: 'log' });
    }) as typeof fetch;
    const text = await closeTicket({ rule, fetchFn }, '777', request({ staff: true, userId: '400' }));
    expect(text).toContain('transcript is in the log channel');
    expect(calls.at(-2)).toBe('POST https://discord.com/api/v10/channels/60/messages');
    expect(calls.at(-1)).toBe('DELETE https://discord.com/api/v10/channels/777');
  });

  it('keeps the ticket when the transcript cannot be saved', async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method} ${String(url)}`);
      if (String(url).includes('/messages?')) return json([]);
      if (String(url).endsWith('/channels/60')) return json(hiddenLog);
      if (init?.method === 'GET') return json(channel);
      return json({ message: 'no' }, 403);
    }) as typeof fetch;
    await expect(closeTicket({ rule, fetchFn }, '777', request({ staff: true }))).rejects.toThrow('ticket was kept');
    expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false);
  });

  it('keeps a ticket whose history is too long to save', async () => {
    const calls: string[] = [];
    const page = Array.from({ length: 100 }, (_, i) => ({ id: String(i), timestamp: 't', content: 'x', author: { username: 'a' } }));
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method} ${String(url)}`);
      if (String(url).includes('/messages?')) return json(page);
      if (String(url).endsWith('/channels/60')) return json(hiddenLog);
      return json(channel);
    }) as typeof fetch;
    await expect(closeTicket({ rule, fetchFn }, '777', request({ staff: true }))).rejects.toThrow('too many to save');
    expect(calls.some((c) => c.startsWith('DELETE') || c.startsWith('POST'))).toBe(false);
  });

  it('never deletes a channel that is not a ticket', async () => {
    for (const other of [{ ...channel, topic: 'general chat' }, { ...channel, parent_id: '51' }]) {
      const fetchFn = vi.fn(async () => json(other)) as unknown as typeof fetch;
      expect(await closeTicket({ rule, fetchFn }, '777', request({ staff: true }))).toContain('not a ticket');
      expect(fetchFn).toHaveBeenCalledTimes(1);
    }
  });
});

describe('handleTicket', () => {
  const log = { error: vi.fn() };
  const edit = vi.fn(async () => undefined);

  it('says tickets are off without settings', async () => {
    const result = await handleTicket({ rule: null }, request(), edit, log);
    expect(JSON.stringify(result.body)).toContain('not set up');
  });

  it('opens a form for a button, for anyone', async () => {
    const result = await handleTicket({ rule }, request({ kind: 'button', customId: 'ticket:open:report' }), edit, log);
    expect(result.body).toMatchObject({ type: 9, data: { custom_id: 'ticket:new:report' } });
  });

  it('keeps claim, close and the panel for staff', async () => {
    for (const customId of ['ticket:claim', 'ticket:close', 'ticket:close-yes']) {
      const result = await handleTicket({ rule }, request({ kind: 'button', customId }), edit, log);
      expect(result.body).toMatchObject({ type: 4, data: { flags: 64 } });
      expect(result.followUp).toBeUndefined();
    }
    const panel = await handleTicket({ rule }, request({ kind: 'panel', customId: '' }), edit, log);
    expect(JSON.stringify(panel.body)).toContain('Only staff');
  });

  it('asks staff to confirm before closing', async () => {
    const result = await handleTicket({ rule }, request({ kind: 'button', customId: 'ticket:close', staff: true }), edit, log);
    expect(JSON.stringify(result.body)).toContain('ticket:close-yes');
  });

  it('tells the person when opening fails, without the details', async () => {
    const failing = vi.fn(async () => json({ message: 'secret' }, 500)) as unknown as typeof fetch;
    const result = await handleTicket({ rule, fetchFn: failing }, request(), edit, log);
    expect(result.body).toMatchObject({ type: 5, data: { flags: 64 } });
    await result.followUp?.();
    expect(edit).toHaveBeenCalledWith({ content: expect.not.stringContaining('secret') });
    expect(log.error).toHaveBeenCalled();
  });
});
