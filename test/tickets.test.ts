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
    expect(overwrites.map((o) => o.id)).toEqual(['1', '300', '70', '71', '111']);
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
      if (String(url).endsWith('/channels')) return json({ id: '777' });
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
      return json({ id: '777' });
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
      return json({ id: '777' });
    }) as typeof fetch;
    await expect(openTicket({ rule, fetchFn }, 'query', request())).rejects.toThrow('post in the ticket channel');
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
      if (init?.method === 'GET') return json(channel);
      return json({ message: 'no' }, 403);
    }) as typeof fetch;
    await expect(closeTicket({ rule, fetchFn }, '777', request({ staff: true }))).rejects.toThrow('ticket was kept');
    expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false);
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
