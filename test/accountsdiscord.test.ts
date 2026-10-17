import { describe, expect, it, vi } from 'vitest';
import { addMember, isMember, sendDirectMessage, setRole } from '../src/accountsdiscord.ts';

const answer = (status: number, body: unknown = '') =>
  vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => (status === 204 ? new Response(null, { status }) : typeof body === 'string' ? new Response(body, { status }) : Response.json(body, { status })));
const initOf = (fn: ReturnType<typeof answer>, call = 0) => fn.mock.calls[call]![1] as RequestInit;
const urlOf = (fn: ReturnType<typeof answer>, call = 0) => String(fn.mock.calls[call]![0]);

describe('adding a member', () => {
  it('puts the access token in the body and says if they were added or already in', async () => {
    const created = answer(201, {});
    await expect(addMember('bot-token', '777', '42', 'user-token', created)).resolves.toBe('added');
    expect(urlOf(created)).toBe('https://discord.com/api/v10/guilds/777/members/42');
    expect(initOf(created).method).toBe('PUT');
    expect(initOf(created).headers).toMatchObject({ authorization: 'Bot bot-token' });
    expect(JSON.parse(String(initOf(created).body))).toEqual({ access_token: 'user-token' });

    await expect(addMember('bot-token', '777', '42', 'user-token', answer(204))).resolves.toBe('already');
  });

  it('says banned when Discord will not, and fails on anything else', async () => {
    await expect(addMember('bot-token', '777', '42', 'user-token', answer(403, 'Banned'))).resolves.toBe('banned');
    await expect(addMember('bot-token', '777', '42', 'user-token', answer(500, 'oops'))).rejects.toThrow('Discord refused to add a member: 500 oops');
  });
});

describe('knowing a member', () => {
  it('answers yes, no, or nothing when it cannot tell', async () => {
    await expect(isMember('t', '777', '42', answer(200, {}))).resolves.toBe(true);
    await expect(isMember('t', '777', '42', answer(404, { code: 10007 }))).resolves.toBe(false);
    await expect(isMember('t', '777', '42', answer(500))).resolves.toBeNull();
  });
});

describe('roles', () => {
  it('gives with PUT and takes with DELETE, with a reason for the audit log', async () => {
    const give = answer(204);
    await expect(setRole('t', '777', '42', '900', true, give)).resolves.toBe('done');
    expect(urlOf(give)).toBe('https://discord.com/api/v10/guilds/777/members/42/roles/900');
    expect(initOf(give).method).toBe('PUT');
    expect(initOf(give).headers).toHaveProperty('x-audit-log-reason');

    const take = answer(204);
    await setRole('t', '777', '42', '900', false, take);
    expect(initOf(take).method).toBe('DELETE');
  });

  it('says gone for someone not in the server, and fails on a refusal', async () => {
    await expect(setRole('t', '777', '42', '900', true, answer(404))).resolves.toBe('gone');
    await expect(setRole('t', '777', '42', '900', true, answer(403, 'Missing Permissions'))).rejects.toThrow(
      'Discord refused to give role 900: 403 Missing Permissions',
    );
  });
});

describe('private messages', () => {
  const sequence = (...answers: Response[]) => {
    const queue = [...answers];
    return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => queue.shift() ?? new Response('none left', { status: 500 }));
  };

  it('opens a channel with them and posts the message without pinging anyone', async () => {
    const fetchFn = sequence(Response.json({ id: '555' }), Response.json({ id: 'm1' }));
    await expect(sendDirectMessage('t', '42', 'hello', fetchFn)).resolves.toBe('sent');
    expect(String(fetchFn.mock.calls[0]![0])).toBe('https://discord.com/api/v10/users/@me/channels');
    expect(String(fetchFn.mock.calls[1]![0])).toBe('https://discord.com/api/v10/channels/555/messages');
    expect(JSON.parse(String((fetchFn.mock.calls[1]![1] as RequestInit).body))).toEqual({
      content: 'hello',
      allowed_mentions: { parse: [] },
    });
  });

  it('says closed when they take no messages from the server, and fails on anything else', async () => {
    await expect(
      sendDirectMessage('t', '42', 'hi', sequence(Response.json({ id: '555' }), Response.json({ code: 50007 }, { status: 403 }))),
    ).resolves.toBe('closed');
    await expect(
      sendDirectMessage('t', '42', 'hi', sequence(Response.json({ id: '555' }), new Response('boom', { status: 500 }))),
    ).rejects.toThrow('Discord refused the message to 42: 500');
    await expect(sendDirectMessage('t', '42', 'hi', sequence(new Response('no', { status: 403 })))).rejects.toThrow('would not open a message');
  });
});
