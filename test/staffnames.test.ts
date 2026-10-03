import { describe, expect, it, vi } from 'vitest';
import { fetchDiscordUser, LOOKUPS_PER_LOAD, lookupsDue, noteStaffName, parseStaffNames, STAFF_NAME_MS } from '../src/staffnames.ts';

const NOW = Date.UTC(2026, 9, 3, 12);
const SARGE = '340568148044414976';
const KESTREL = '100000000000000002';

describe('staff names', () => {
  it('reads what was saved, and nothing from anything else', () => {
    const names = { [SARGE]: { name: 'Sarge', username: 'paragon', at: NOW } };

    expect(parseStaffNames(names)).toEqual(names);
    expect(parseStaffNames(undefined)).toEqual({});
    expect(parseStaffNames({ [SARGE]: { name: 1 } })).toEqual({});
  });

  it('notes a name when it is new or changed, and only then needs a write', () => {
    const first = noteStaffName({}, SARGE, 'Sarge', 'paragon', NOW);

    expect(first).toEqual({ [SARGE]: { name: 'Sarge', username: 'paragon', at: NOW } });
    expect(noteStaffName(first ?? {}, SARGE, 'Sarge', 'paragon', NOW + 60_000)).toBeNull();
    expect(noteStaffName(first ?? {}, SARGE, 'Sarge2', 'paragon', NOW + 60_000)?.[SARGE]?.name).toBe('Sarge2');
    expect(noteStaffName(first ?? {}, SARGE, 'Sarge', 'paragon', NOW + STAFF_NAME_MS)?.[SARGE]?.at).toBe(NOW + STAFF_NAME_MS);
    expect(noteStaffName({}, 'bot', 'The bot', null, NOW)).toBeNull();
    expect(noteStaffName({}, SARGE, '  ', null, NOW)).toBeNull();
  });

  it('asks Discord about staff it has never seen, or not for a long time, a few at a time', () => {
    const names = { [SARGE]: { name: 'Sarge', username: 'paragon', at: NOW - 1 } };
    const many = Array.from({ length: 30 }, (_, i) => `1000000000000000${String(i).padStart(2, '0')}`);

    expect(lookupsDue(names, [SARGE, KESTREL, 'server', 'bot', KESTREL], NOW)).toEqual([KESTREL]);
    expect(lookupsDue(names, [SARGE], NOW - 1 + STAFF_NAME_MS)).toEqual([SARGE]);
    expect(lookupsDue({}, many, NOW)).toHaveLength(LOOKUPS_PER_LOAD);
  });
});

describe('fetchDiscordUser', () => {
  it('asks Discord with the bot token, and takes their display name and username', async () => {
    const fetchFn = vi.fn(async () => Response.json({ id: SARGE, username: 'paragon', global_name: 'Sarge' }));

    await expect(fetchDiscordUser('bot-token', SARGE, fetchFn)).resolves.toEqual({ name: 'Sarge', username: 'paragon' });
    expect(fetchFn).toHaveBeenCalledWith(`https://discord.com/api/v10/users/${SARGE}`, expect.objectContaining({ headers: { authorization: 'Bot bot-token' } }));
  });

  it('uses the username when there is no display name, gives null for an unknown user, and throws otherwise', async () => {
    await expect(fetchDiscordUser('t', SARGE, async () => Response.json({ id: SARGE, username: 'paragon', global_name: null }))).resolves.toEqual({
      name: 'paragon',
      username: 'paragon',
    });
    await expect(fetchDiscordUser('t', SARGE, async () => new Response('Unknown User', { status: 404 }))).resolves.toBeNull();
    await expect(fetchDiscordUser('t', SARGE, async () => new Response('401: Unauthorized', { status: 401 }))).rejects.toThrow('401');
    await expect(fetchDiscordUser('t', 'server', vi.fn())).resolves.toBeNull();
  });
});
