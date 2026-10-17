import { describe, expect, it } from 'vitest';
import { fetchGuildCounts, fetchInviteCounts } from '../src/invite.ts';

describe('fetchInviteCounts', () => {
  it('reads the approximate member and online counts', async () => {
    let requested = '';
    const fetchFn = async (url: string | URL | Request) => {
      requested = String(url);
      return Response.json({
        code: 'wardogs',
        guild: { id: '1', name: 'WARDOGS UK' },
        approximate_member_count: 1234,
        approximate_presence_count: 210,
      });
    };

    await expect(fetchInviteCounts('wardogs', 5, fetchFn)).resolves.toEqual({
      name: 'WARDOGS UK',
      members: 1234,
      online: 210,
      fetchedAt: 5,
    });
    expect(requested).toBe('https://discord.com/api/v10/invites/wardogs?with_counts=true');
  });

  it('fails on an unknown or expired invite', async () => {
    const fetchFn = async () => Response.json({ message: 'Unknown Invite', code: 10006 }, { status: 404 });

    await expect(fetchInviteCounts('gone', 0, fetchFn)).rejects.toThrow('Discord invite lookup failed: 404');
  });
});

describe('fetchGuildCounts', () => {
  it('reads the counts from the server with the bot token', async () => {
    let requested = '';
    let authorization = '';
    const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
      requested = String(url);
      authorization = new Headers(init?.headers).get('authorization') ?? '';
      return Response.json({ id: '9', name: 'WARDOGS UK', approximate_member_count: 1234, approximate_presence_count: 210 });
    };

    await expect(fetchGuildCounts('tok', '9', 5, fetchFn)).resolves.toEqual({ name: 'WARDOGS UK', members: 1234, online: 210, fetchedAt: 5 });
    expect(requested).toBe('https://discord.com/api/v10/guilds/9?with_counts=true');
    expect(authorization).toBe('Bot tok');
  });

  it('fails when Discord refuses', async () => {
    const fetchFn = async () => Response.json({ message: 'Missing Access', code: 50001 }, { status: 403 });

    await expect(fetchGuildCounts('tok', '9', 0, fetchFn)).rejects.toThrow('Discord server lookup failed: 403');
  });
});
