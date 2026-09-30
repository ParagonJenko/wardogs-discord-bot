import { beforeAll, describe, expect, it, vi } from 'vitest';
import { COMMANDS, editOriginalReply, handleInteraction, type CommandRequest } from '../src/interactions.ts';

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer): string => Buffer.from(bytes).toString('hex');

let keys: CryptoKeyPair;
let publicKey: string;

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  publicKey = hex(await crypto.subtle.exportKey('raw', keys.publicKey));
});

// Signs a request body the way Discord does: Ed25519 over timestamp + body.
const NOW_MS = 1_727_690_000_000;
// Discord's Administrator permission bit.
const ADMINISTRATOR = 1 << 3;

const signed = async (payload: unknown, timestamp = String(NOW_MS / 1000)) => {
  const body = JSON.stringify(payload);
  const signature = hex(await crypto.subtle.sign('Ed25519', keys.privateKey, encoder.encode(timestamp + body)));
  return { body, signature, timestamp };
};

const statusCommand = { type: 2, application_id: '111', token: 'tok', data: { name: 'serverstatus' } };
const embed = { title: 'UK Wardogs #1', description: '🟢 **Live** · **24/98** players', color: 1 };

const deps = () => ({
  publicKey,
  runCommand: vi.fn(async (_request: CommandRequest) => ({ embeds: [embed] })),
  suggest: vi.fn(async (_request: CommandRequest) => [{ name: 'Ozeti · 69 min', value: '1790776000000' }]),
  editReply: vi.fn(async () => undefined),
  log: { error: vi.fn() },
  now: () => NOW_MS,
  adminGuildId: '777' as string | undefined,
  adminRoleIds: ['555'],
});

describe('handleInteraction', () => {
  it('rejects a request without a valid Discord signature', async () => {
    const { body, timestamp } = await signed({ type: 1, application_id: '111' });

    const result = await handleInteraction(body, 'ab'.repeat(64), timestamp, deps());

    expect(result.status).toBe(401);
  });

  it('rejects a request whose body was changed after signing', async () => {
    const { signature, timestamp } = await signed({ type: 1, application_id: '111' });

    const result = await handleInteraction('{"type":1,"application_id":"222"}', signature, timestamp, deps());

    expect(result.status).toBe(401);
  });

  it('rejects a correctly signed request that is more than five minutes old or ahead', async () => {
    const old = await signed(statusCommand, String(NOW_MS / 1000 - 301));
    const ahead = await signed(statusCommand, String(NOW_MS / 1000 + 301));
    const d = deps();

    expect((await handleInteraction(old.body, old.signature, old.timestamp, d)).status).toBe(401);
    expect((await handleInteraction(ahead.body, ahead.signature, ahead.timestamp, d)).status).toBe(401);
    expect(d.runCommand).not.toHaveBeenCalled();
  });

  it('answers Discord\'s ping so the endpoint can be saved', async () => {
    const { body, signature, timestamp } = await signed({ type: 1, application_id: '111' });

    await expect(handleInteraction(body, signature, timestamp, deps())).resolves.toMatchObject({
      status: 200,
      body: { type: 1 },
    });
  });

  it('defers /serverstatus, then edits the reply with the status embed', async () => {
    const { body, signature, timestamp } = await signed(statusCommand);
    const d = deps();

    const result = await handleInteraction(body, signature, timestamp, d);
    await result.followUp?.();

    expect(result).toMatchObject({ status: 200, body: { type: 5 } });
    expect(d.editReply).toHaveBeenCalledWith('111', 'tok', { embeds: [embed], allowed_mentions: { parse: [] } });
  });

  it('replies with a short message, and logs the reason, when the server cannot be reached', async () => {
    const { body, signature, timestamp } = await signed(statusCommand);
    const d = deps();
    d.runCommand.mockRejectedValueOnce(new Error('RCON request timed out after 8000ms'));

    await (await handleInteraction(body, signature, timestamp, d)).followUp?.();

    expect(d.editReply).toHaveBeenCalledWith('111', 'tok', {
      content: "Couldn't get that right now. Try again in a minute.",
      allowed_mentions: { parse: [] },
    });
    expect(d.log.error).toHaveBeenCalledWith(expect.stringContaining('timed out'));
  });

  it.each(['players', 'lastmatch', 'rotation'])('defers /%s publicly and runs it', async (name) => {
    const { body, signature, timestamp } = await signed({ ...statusCommand, data: { name } });
    const d = deps();

    const result = await handleInteraction(body, signature, timestamp, d);
    await result.followUp?.();

    expect(result.body).toEqual({ type: 5 });
    expect(d.runCommand).toHaveBeenCalledWith({ name, options: {}, userId: null });
  });

  const broadcast = (permissions: string | undefined, guildId: string | null = '777') => ({
    ...statusCommand,
    ...(guildId === null ? {} : { guild_id: guildId }),
    data: { name: 'broadcast', options: [{ name: 'message', type: 3, value: 'Seeding now!' }] },
    member: { user: { id: '42' }, ...(permissions === undefined ? {} : { permissions }) },
  });

  it('runs /broadcast for an Administrator, replying privately', async () => {
    const { body, signature, timestamp } = await signed(broadcast(String(ADMINISTRATOR)));
    const d = deps();

    const result = await handleInteraction(body, signature, timestamp, d);
    await result.followUp?.();

    expect(result.body).toEqual({ type: 5, data: { flags: 64 } });
    expect(d.runCommand).toHaveBeenCalledWith({ name: 'broadcast', options: { message: 'Seeding now!' }, userId: '42' });
  });

  it('refuses /broadcast from anyone who is not an Administrator, Manage Server included, even if Discord let it through', async () => {
    const d = deps();
    const results = await Promise.all(
      [String(1 << 5), String(1 << 11), undefined].map(async (permissions) => {
        const { body, signature, timestamp } = await signed(broadcast(permissions));
        return handleInteraction(body, signature, timestamp, d);
      }),
    );

    results.forEach((result) => {
      expect(result.body).toMatchObject({ type: 4, data: { flags: 64 } });
      expect(result.followUp).toBeUndefined();
    });
    expect(d.runCommand).not.toHaveBeenCalled();
  });

  it('refuses /broadcast from any other Discord server, or when no server is configured', async () => {
    const cases: [string | null, string | undefined][] = [
      ['888', '777'],
      [null, '777'],
      ['777', undefined],
    ];
    const d = deps();
    const results = await Promise.all(
      cases.map(async ([guildId, adminGuildId]) => {
        const { body, signature, timestamp } = await signed(broadcast(String(ADMINISTRATOR), guildId));
        return handleInteraction(body, signature, timestamp, { ...d, adminGuildId });
      }),
    );

    results.forEach((result) => {
      expect(result.body).toMatchObject({ type: 4, data: { flags: 64 } });
    });
    expect(d.runCommand).not.toHaveBeenCalled();
  });

  it('runs admin commands for members with an admin role, such as Staff, without Administrator', async () => {
    const staff = { ...broadcast(String(1 << 5)), member: { user: { id: '42' }, permissions: String(1 << 5), roles: ['111', '555'] } };
    const { body, signature, timestamp } = await signed(staff);
    const d = deps();

    const result = await handleInteraction(body, signature, timestamp, d);
    await result.followUp?.();

    expect(result.body).toEqual({ type: 5, data: { flags: 64 } });
    expect(d.runCommand).toHaveBeenCalledWith({ name: 'broadcast', options: { message: 'Seeding now!' }, userId: '42' });
  });

  it('refuses members with other roles, and admin roles from another Discord server', async () => {
    const d = deps();
    const results = await Promise.all(
      [
        { ...broadcast('0'), member: { user: { id: '42' }, permissions: '0', roles: ['111'] } },
        { ...broadcast('0', '888'), member: { user: { id: '42' }, permissions: '0', roles: ['555'] } },
      ].map(async (payload) => {
        const { body, signature, timestamp } = await signed(payload);
        return handleInteraction(body, signature, timestamp, d);
      }),
    );

    expect(results.map((r) => r.body)).toEqual([
      { type: 4, data: { content: 'Only Administrators and staff can use this.', flags: 64 } },
      { type: 4, data: { content: 'This command can only be used in the Discord server that runs this bot.', flags: 64 } },
    ]);
    expect(d.runCommand).not.toHaveBeenCalled();
  });

  it('tells an admin a failed /broadcast may still have been delivered', async () => {
    const { body, signature, timestamp } = await signed(broadcast(String(ADMINISTRATOR)));
    const d = deps();
    d.runCommand.mockRejectedValueOnce(new Error('RCON request timed out after 8000ms'));

    await (await handleInteraction(body, signature, timestamp, d)).followUp?.();

    expect(d.editReply).toHaveBeenCalledWith('111', 'tok', {
      content: "Couldn't confirm the broadcast was delivered. Check in game before sending it again.",
      allowed_mentions: { parse: [] },
    });
  });

  it('treats /seeders as an admin command, replying privately', async () => {
    const seeders = { ...broadcast(String(ADMINISTRATOR)), data: { name: 'seeders', options: [{ name: 'days', type: 4, value: 30 }] } };
    const outsider = { ...seeders, member: { user: { id: '42' }, permissions: String(1 << 5) } };
    const d = deps();
    const run = async (payload: unknown) => {
      const { body, signature, timestamp } = await signed(payload);
      return handleInteraction(body, signature, timestamp, d);
    };

    const allowed = await run(seeders);
    await allowed.followUp?.();
    const refused = await run(outsider);

    expect(allowed.body).toEqual({ type: 5, data: { flags: 64 } });
    expect(d.runCommand).toHaveBeenCalledWith({ name: 'seeders', options: { days: '30' }, userId: '42' });
    expect(refused.body).toMatchObject({ type: 4, data: { flags: 64 } });
    expect(d.runCommand).toHaveBeenCalledTimes(1);
  });

  it('gives a failed /seeders the general error, not the broadcast one', async () => {
    const { body, signature, timestamp } = await signed({ ...broadcast(String(ADMINISTRATOR)), data: { name: 'seeders' } });
    const d = deps();
    d.runCommand.mockRejectedValueOnce(new Error('storage unavailable'));

    await (await handleInteraction(body, signature, timestamp, d)).followUp?.();

    expect(d.editReply).toHaveBeenCalledWith('111', 'tok', {
      content: "Couldn't get that right now. Try again in a minute.",
      allowed_mentions: { parse: [] },
    });
  });

  describe('autocomplete', () => {
    const typing = (permissions: string, guildId = '777') => ({
      type: 4,
      application_id: '111',
      guild_id: guildId,
      data: { name: 'removematch', options: [{ name: 'match', type: 3, value: 'oze', focused: true }] },
      member: { user: { id: '42' }, permissions },
    });

    it('offers choices for what an Administrator has typed so far', async () => {
      const { body, signature, timestamp } = await signed(typing(String(ADMINISTRATOR)));
      const d = deps();

      const result = await handleInteraction(body, signature, timestamp, d);

      expect(result.body).toEqual({ type: 8, data: { choices: [{ name: 'Ozeti · 69 min', value: '1790776000000' }] } });
      expect(d.suggest).toHaveBeenCalledWith({ name: 'removematch', options: { match: 'oze' }, userId: '42' });
      expect(d.runCommand).not.toHaveBeenCalled();
    });

    it('offers choices to staff too', async () => {
      const staff = { ...typing('0'), member: { user: { id: '42' }, permissions: '0', roles: ['555'] } };
      const { body, signature, timestamp } = await signed(staff);
      const d = deps();

      await handleInteraction(body, signature, timestamp, d);

      expect(d.suggest).toHaveBeenCalled();
    });

    it('offers nothing to anyone who could not run the command', async () => {
      const d = deps();
      const results = await Promise.all(
        [typing(String(1 << 5)), typing(String(ADMINISTRATOR), '888')].map(async (payload) => {
          const { body, signature, timestamp } = await signed(payload);
          return handleInteraction(body, signature, timestamp, d);
        }),
      );

      results.forEach((result) => expect(result.body).toEqual({ type: 8, data: { choices: [] } }));
      expect(d.suggest).not.toHaveBeenCalled();
    });

    it('offers nothing, and logs why, when the suggestions fail', async () => {
      const { body, signature, timestamp } = await signed(typing(String(ADMINISTRATOR)));
      const d = deps();
      d.suggest.mockRejectedValueOnce(new Error('storage unavailable'));

      const result = await handleInteraction(body, signature, timestamp, d);

      expect(result.body).toEqual({ type: 8, data: { choices: [] } });
      expect(d.log.error).toHaveBeenCalledWith('/removematch suggestions failed: storage unavailable');
    });
  });

  it('answers an unknown command privately', async () => {
    const { body, signature, timestamp } = await signed({ ...statusCommand, data: { name: 'other' } });

    await expect(handleInteraction(body, signature, timestamp, deps())).resolves.toMatchObject({
      status: 200,
      body: { type: 4, data: { flags: 64 } },
    });
  });
});

describe('editOriginalReply', () => {
  it('patches the original interaction response', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response('{}', { status: 200 });
    };

    await editOriginalReply(fetchFn)('111', 'tok', { content: 'hi' });

    expect(calls[0]?.url).toBe('https://discord.com/api/v10/webhooks/111/tok/messages/@original');
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ content: 'hi' });
  });

  it('retries when Discord has not saved the deferred reply yet (404)', async () => {
    const statuses = [404, 404, 200];
    const fetchFn = vi.fn(async () => new Response('{}', { status: statuses.shift() ?? 200 }));

    await editOriginalReply(fetchFn, [0, 0, 0])('111', 'tok', { content: 'hi' });

    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('gives up after the last retry and reports what Discord said', async () => {
    const fetchFn = vi.fn(async () => new Response('{"message": "Unknown Message", "code": 10008}', { status: 404 }));

    await expect(editOriginalReply(fetchFn, [0, 0, 0])('111', 'tok', {})).rejects.toThrow(
      /404 .*Unknown Message/,
    );
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it('does not retry other errors', async () => {
    const fetchFn = vi.fn(async () => new Response('{"message": "Invalid Form Body"}', { status: 400 }));

    await expect(editOriginalReply(fetchFn, [0, 0, 0])('111', 'tok', {})).rejects.toThrow(/400 .*Invalid Form Body/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('COMMANDS', () => {
  it('registers every command, with /broadcast and /seeders limited to Administrators', () => {
    expect(COMMANDS.map((c) => c.name)).toEqual(['serverstatus', 'players', 'lastmatch', 'rotation', 'broadcast', 'seeders', 'removematch']);
    expect(COMMANDS.find((c) => c.name === 'removematch')).toMatchObject({
      default_member_permissions: '8',
      options: [{ name: 'match', type: 3, required: true, autocomplete: true }],
    });
    expect(COMMANDS.find((c) => c.name === 'seeders')).toMatchObject({
      default_member_permissions: '8',
      options: [{ name: 'days', type: 4, required: false, min_value: 1, max_value: 90 }],
    });
    expect(COMMANDS.find((c) => c.name === 'broadcast')).toMatchObject({
      default_member_permissions: '8',
      options: [{ name: 'message', type: 3, required: true, max_length: 200 }],
    });
  });
});
