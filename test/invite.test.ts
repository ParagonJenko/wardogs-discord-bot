import { describe, expect, it } from 'vitest';
import { fetchInviteCounts } from '../src/invite.ts';

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
