import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ADMIN_COMMAND_DEFINITIONS,
  checkOptions,
  COMMANDS,
  editOriginalReply,
  failureText,
  handleInteraction,
  isOptionOf,
  type CommandRequest,
} from '../src/interactions.ts';

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

  it.each(['players', 'lastmatch', 'rotation', 'roundup'])('defers /%s publicly and runs it', async (name) => {
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

  it('passes on the name the sender goes by in the server: their nickname, else their display name, else their username', async () => {
    const d = deps();
    const users = [
      { nick: 'Sarge', user: { id: '42', username: 'paragon', global_name: 'Paragon' } },
      { nick: null, user: { id: '42', username: 'paragon', global_name: 'Paragon' } },
      { user: { id: '42', username: 'paragon' } },
    ];
    for (const member of users) {
      const { body, signature, timestamp } = await signed({ ...broadcast(String(ADMINISTRATOR)), member: { ...member, permissions: String(ADMINISTRATOR) } });
      await (await handleInteraction(body, signature, timestamp, d)).followUp?.();
    }

    expect(d.runCommand.mock.calls.map(([request]) => request.userName)).toEqual(['Sarge', 'Paragon', 'paragon']);
    expect(d.runCommand.mock.calls.map(([request]) => request.userHandle)).toEqual(['paragon', 'paragon', 'paragon']);
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

  it('reads a subcommand and its options, as /vip add sends them', async () => {
    const vip = {
      ...broadcast(String(ADMINISTRATOR)),
      data: {
        name: 'vip',
        options: [
          {
            name: 'add',
            type: 1,
            options: [
              { name: 'steam_id', type: 3, value: '76561198000000001' },
              { name: 'days', type: 4, value: 30 },
            ],
          },
        ],
      },
    };
    const { body, signature, timestamp } = await signed(vip);
    const d = deps();

    await (await handleInteraction(body, signature, timestamp, d)).followUp?.();

    expect(d.runCommand).toHaveBeenCalledWith({
      name: 'vip',
      options: { subcommand: 'add', steam_id: '76561198000000001', days: '30' },
      userId: '42',
    });
  });

  it.each(['warn', 'player', 'kick', 'switchteam', 'ban', 'unban', 'setnextmap', 'changemap', 'vip'])(
    'keeps /%s to Administrators and staff, replying privately',
    async (name) => {
      const allowed = { ...broadcast('0'), member: { user: { id: '42' }, permissions: '0', roles: ['555'] }, data: { name } };
      const outsider = { ...allowed, member: { user: { id: '43' }, permissions: '0', roles: ['999'] } };
      const d = deps();
      const run = async (payload: unknown) => {
        const { body, signature, timestamp } = await signed(payload);
        return handleInteraction(body, signature, timestamp, d);
      };

      expect((await run(allowed)).body).toEqual({ type: 5, data: { flags: 64 } });
      expect((await run(outsider)).body).toMatchObject({ type: 4, data: { flags: 64 } });
      expect((await run({ ...allowed, guild_id: '888' })).body).toMatchObject({ type: 4, data: { flags: 64 } });
    },
  );

  it('tells staff to check before retrying an action that failed, with the reason', async () => {
    const { body, signature, timestamp } = await signed({ ...broadcast(String(ADMINISTRATOR)), data: { name: 'kick' } });
    const d = deps();
    d.runCommand.mockRejectedValueOnce(new Error('RCON request timed out after 8000ms'));

    await (await handleInteraction(body, signature, timestamp, d)).followUp?.();

    expect(d.editReply).toHaveBeenCalledWith('111', 'tok', {
      content: "Couldn't confirm /kick worked (RCON request timed out after 8000ms). Check before trying again.",
      allowed_mentions: { parse: [] },
    });
  });

  it('keeps /seednow to staff, and tells them to check the channel if it may have posted', async () => {
    const seednow = { ...broadcast(String(ADMINISTRATOR)), data: { name: 'seednow' } };
    const outsider = { ...seednow, member: { user: { id: '42' }, permissions: '0' } };
    const d = deps();
    d.runCommand.mockRejectedValueOnce(new Error('Discord webhook failed: 500'));
    const run = async (payload: unknown) => {
      const { body, signature, timestamp } = await signed(payload);
      return handleInteraction(body, signature, timestamp, d);
    };

    const allowed = await run(seednow);
    await allowed.followUp?.();
    const refused = await run(outsider);

    expect(allowed.body).toEqual({ type: 5, data: { flags: 64 } });
    expect(d.editReply).toHaveBeenCalledWith('111', 'tok', {
      content: "Couldn't confirm /seednow worked (Discord webhook failed: 500). Check before trying again.",
      allowed_mentions: { parse: [] },
    });
    expect(refused.body).toMatchObject({ type: 4, data: { content: 'Only Administrators and staff can use this.', flags: 64 } });
    expect(d.runCommand).toHaveBeenCalledTimes(1);
  });

  it('gives a failed /seeders the general error with its reason, as only staff see it', async () => {
    const { body, signature, timestamp } = await signed({ ...broadcast(String(ADMINISTRATOR)), data: { name: 'seeders' } });
    const d = deps();
    d.runCommand.mockRejectedValueOnce(new Error('storage unavailable'));

    await (await handleInteraction(body, signature, timestamp, d)).followUp?.();

    expect(d.editReply).toHaveBeenCalledWith('111', 'tok', {
      content: "Couldn't get that right now (storage unavailable). Try again in a minute.",
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
      expect(d.suggest).toHaveBeenCalledWith({ name: 'removematch', options: { match: 'oze' }, userId: '42', focused: 'match' });
      expect(d.runCommand).not.toHaveBeenCalled();
    });

    it('says which option is being typed in, inside a subcommand too', async () => {
      const vip = {
        ...typing(String(ADMINISTRATOR)),
        data: {
          name: 'vip',
          options: [{ name: 'remove', type: 1, options: [{ name: 'steam_id', type: 3, value: 'ash', focused: true }] }],
        },
      };
      const team = {
        ...typing(String(ADMINISTRATOR)),
        data: {
          name: 'switchteam',
          options: [
            { name: 'player', type: 3, value: '76561198000000001' },
            { name: 'team', type: 3, value: 'kh', focused: true },
          ],
        },
      };
      const d = deps();

      for (const payload of [vip, team]) {
        const { body, signature, timestamp } = await signed(payload);
        await handleInteraction(body, signature, timestamp, d);
      }

      expect(d.suggest.mock.calls).toEqual([
        [{ name: 'vip', options: { subcommand: 'remove', steam_id: 'ash' }, userId: '42', focused: 'steam_id' }],
        [{ name: 'switchteam', options: { player: '76561198000000001', team: 'kh' }, userId: '42', focused: 'team' }],
      ]);
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
  it('registers every command, with the staff ones limited to Administrators until a server allows other roles', () => {
    expect(COMMANDS.map((c) => c.name)).toEqual([
      'serverstatus',
      'players',
      'lastmatch',
      'rotation',
      'roundup',
      'broadcast',
      'seeders',
      'seednow',
      'removematch',
      'warn',
      'player',
      'kick',
      'switchteam',
      'ban',
      'unban',
      'setnextmap',
      'changemap',
      'vip',
    ]);
    for (const command of COMMANDS.slice(5)) {
      expect(command).toMatchObject({ default_member_permissions: '8', contexts: [0] });
      expect(command.description).toMatch(/\(staff only\)$/);
      expect(command.description.length).toBeLessThanOrEqual(100);
    }
    // Public: anyone can see the roundups.
    expect(COMMANDS.find((c) => c.name === 'roundup')).toEqual({
      name: 'roundup',
      description: 'The best players and team of the week or month',
      type: 1,
      options: [
        {
          type: 3,
          name: 'period',
          description: 'Which week or month (default: last week)',
          required: false,
          choices: [
            { name: 'Last week', value: 'week' },
            { name: 'Last month', value: 'month' },
            { name: 'This week so far', value: 'this-week' },
            { name: 'This month so far', value: 'this-month' },
          ],
        },
      ],
    });
    expect(COMMANDS.find((c) => c.name === 'removematch')).toMatchObject({
      default_member_permissions: '8',
      options: [{ name: 'match', type: 3, required: true, autocomplete: true }],
    });
    expect(COMMANDS.find((c) => c.name === 'seeders')).toMatchObject({
      default_member_permissions: '8',
      options: [{ name: 'days', type: 4, required: false, min_value: 1, max_value: 90 }],
    });
    expect(COMMANDS.find((c) => c.name === 'seednow')).toMatchObject({
      default_member_permissions: '8',
      options: [{ name: 'message', type: 3, required: false, max_length: 200 }],
    });
    expect(COMMANDS.find((c) => c.name === 'broadcast')).toMatchObject({
      default_member_permissions: '8',
      options: [{ name: 'message', type: 3, required: true, max_length: 200 }],
    });
  });

  it('lets staff pick players, teams, maps and bans from lists, and ban lengths from fixed choices', () => {
    const find = (name: string) => COMMANDS.find((c) => c.name === name);

    expect(find('kick')).toMatchObject({
      options: [
        { name: 'player', type: 3, required: true, autocomplete: true },
        { name: 'reason', type: 3, required: true, max_length: 200 },
      ],
    });
    expect(find('switchteam')).toMatchObject({
      options: [{ name: 'player', autocomplete: true }, { name: 'team', required: false, autocomplete: true }],
    });
    expect(find('ban')).toMatchObject({
      options: [
        { name: 'player', autocomplete: true },
        {
          name: 'duration',
          required: true,
          choices: [
            { name: '1 hour', value: '1h' },
            { name: '1 day', value: '1d' },
            { name: '3 days', value: '3d' },
            { name: '7 days', value: '7d' },
            { name: '30 days', value: '30d' },
            { name: 'Permanent', value: 'permanent' },
          ],
        },
        { name: 'reason', required: true },
      ],
    });
    const setup = [
      { name: 'map', required: true, autocomplete: true },
      { name: 'mode', type: 3, required: false, autocomplete: true },
      { name: 'infantry_only', type: 5, required: false },
      { name: 'hardcore', type: 5, required: false },
      { name: 'lighting', type: 3, required: false, autocomplete: true },
      { name: 'zones', type: 3, required: false, autocomplete: true },
    ];
    expect(find('setnextmap')).toMatchObject({ options: setup });
    expect(find('changemap')).toMatchObject({ options: setup });
    expect(find('vip')).toMatchObject({
      options: [
        { name: 'add', type: 1, options: [{ name: 'steam_id', autocomplete: true }, { name: 'days', type: 4, min_value: 1, max_value: 365 }] },
        { name: 'remove', type: 1, options: [{ name: 'steam_id', autocomplete: true }] },
      ],
    });
    // Discord caps option descriptions at 100 characters.
    type Described = { description: string; options?: Described[] };
    const all = (list: Described[]): Described[] => list.flatMap((o) => [o, ...all(o.options ?? [])]);
    expect(all(COMMANDS as Described[]).every((o) => o.description.length <= 100)).toBe(true);
  });
});

describe('staff commands from the staff page', () => {
  it('offers only the staff commands', () => {
    const names = ADMIN_COMMAND_DEFINITIONS.map((c) => c.name);

    expect(names).toContain('ban');
    expect(names).toContain('vip');
    expect(names).toContain('broadcast');
    expect(names).not.toContain('serverstatus');
    expect(names).not.toContain('roundup');
  });

  it('checks options as Discord would: required, length, choices', () => {
    const player = '76561198000000001';

    expect(checkOptions('ban', { player, duration: '7d', reason: 'TK' })).toEqual({ options: { player, duration: '7d', reason: 'TK' } });
    expect(checkOptions('ban', { player, duration: '7d' })).toEqual({ problem: '/ban needs reason.' });
    expect(checkOptions('ban', { player, duration: '7d', reason: '  ' })).toEqual({ problem: '/ban needs reason.' });
    expect(checkOptions('ban', { player, duration: '2y', reason: 'TK' })).toEqual({ problem: 'Pick duration from the list.' });
    expect(checkOptions('ban', { player, duration: '7d', reason: 'x'.repeat(201) })).toEqual({ problem: 'reason can be at most 200 characters.' });
    expect(checkOptions('ban', { player, duration: '7d', reason: 'TK', evil: 'x' })).toEqual({ problem: '/ban has no option called evil.' });
    expect(checkOptions('kick', { player, reason: 'TK', subcommand: 'add' })).toEqual({ problem: '/kick has no option called subcommand.' });
  });

  it('checks whole numbers, true or false, and leaves out optional options left empty', () => {
    expect(checkOptions('seeders', { days: 30 })).toEqual({ options: { days: '30' } });
    expect(checkOptions('seeders', {})).toEqual({ options: {} });
    expect(checkOptions('seeders', { days: '91' })).toEqual({ problem: 'days must be a whole number from 1 to 90.' });
    expect(checkOptions('seeders', { days: '2.5' })).toEqual({ problem: 'days must be a whole number from 1 to 90.' });
    expect(checkOptions('setnextmap', { map: 'Europe', hardcore: true, mode: '' })).toEqual({ options: { map: 'Europe', hardcore: 'true' } });
    expect(checkOptions('setnextmap', { map: 'Europe', hardcore: 'yes' })).toEqual({ problem: 'hardcore must be true or false.' });
  });

  it('takes a subcommand for /vip, and checks its options', () => {
    const steam_id = '76561198000000001';

    expect(checkOptions('vip', { subcommand: 'add', steam_id, days: '7' })).toEqual({ options: { subcommand: 'add', steam_id, days: '7' } });
    expect(checkOptions('vip', { subcommand: 'remove', steam_id })).toEqual({ options: { subcommand: 'remove', steam_id } });
    expect(checkOptions('vip', { subcommand: 'add', steam_id })).toEqual({ problem: '/vip needs days.' });
    expect(checkOptions('vip', { subcommand: 'remove', steam_id, days: '7' })).toEqual({ problem: '/vip has no option called days.' });
    expect(checkOptions('vip', { steam_id })).toEqual({ problem: 'Pick add or remove.' });
  });

  it('knows which options suggestions can be asked for', () => {
    expect(isOptionOf('ban', 'player')).toBe(true);
    expect(isOptionOf('ban', 'nope')).toBe(false);
    expect(isOptionOf('vip', 'steam_id', 'remove')).toBe(true);
    expect(isOptionOf('vip', 'steam_id')).toBe(false);
  });

  it('says what failed without inviting a blind retry of an action', () => {
    expect(failureText('kick', new Error('timed out'))).toBe("Couldn't confirm /kick worked (timed out). Check before trying again.");
    expect(failureText('broadcast', new Error('x'))).toBe("Couldn't confirm the broadcast was delivered. Check in game before sending it again.");
    expect(failureText('seeders', new Error('x'))).toBe("Couldn't get that right now (x). Try again in a minute.");
    expect(failureText('players', new Error('x'))).toBe("Couldn't get that right now. Try again in a minute.");
  });
});
