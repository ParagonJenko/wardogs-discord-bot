import { z } from 'zod';
import type { Embed } from './discord.ts';
import { BAN_LENGTHS } from './moderation.ts';
import { STAFF_COMMANDS, VIP_MAX_DAYS, WARNING_MAX_LENGTH } from './staff.ts';

// Discord slash commands arrive as signed HTTP POSTs to the Worker's URL ("Interactions Endpoint URL").

const COMMAND_NAMES = [
  'serverstatus',
  'players',
  'lastmatch',
  'rotation',
  'broadcast',
  'seeders',
  'seednow',
  'removematch',
  ...STAFF_COMMANDS,
] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

const isCommandName = (name: string | undefined): name is CommandName =>
  COMMAND_NAMES.some((command) => command === name);

// Discord permission bit for "Administrator".
const ADMINISTRATOR = 1n << 3n;

// Admin commands change things in game or in the records, or show Steam IDs, so they are hidden from, and refused to,
// anyone who has neither Discord's Administrator permission nor one of the admin roles. Their replies are only shown
// to the person who ran them.
const ADMIN_COMMANDS: readonly CommandName[] = ['broadcast', 'seeders', 'seednow', 'removematch', ...STAFF_COMMANDS];

// Staff commands that change something in game. If one fails, it may still have happened, so the reply says to check.
const ACTIONS: readonly CommandName[] = ['seednow', 'warn', 'kick', 'switchteam', 'ban', 'unban', 'setnextmap', 'changemap', 'vip'];

export const SEEDERS_DEFAULT_DAYS = 7;
export const SEEDERS_MAX_DAYS = 90;

// Hidden from everyone but Administrators until a server gives other roles access, and only usable in a server.
const STAFF_ONLY = { type: 1, default_member_permissions: String(ADMINISTRATOR), contexts: [0] };

const STRING = 3;
const INTEGER = 4;
const SUBCOMMAND = 1;

const player = (description: string) => ({ type: STRING, name: 'player', description, required: true, autocomplete: true });
const reason = (description: string) => ({ type: STRING, name: 'reason', description, required: true, max_length: 200 });
const steamId = (description: string) => ({ type: STRING, name: 'steam_id', description, required: true, autocomplete: true });
const BOOLEAN = 5;

// The map and how it is played. Anything left out is what the rotation plays that map with.
const matchSetup = [
  { type: STRING, name: 'map', description: 'Pick the map from the list', required: true, autocomplete: true },
  { type: STRING, name: 'mode', description: 'Game mode (default: as in the rotation)', required: false, autocomplete: true },
  { type: BOOLEAN, name: 'infantry_only', description: 'Infantry only (default: as in the rotation)', required: false },
  { type: BOOLEAN, name: 'hardcore', description: 'Hardcore (default: as in the rotation)', required: false },
  { type: STRING, name: 'lighting', description: 'Time of day and weather (default: as in the rotation)', required: false, autocomplete: true },
  { type: STRING, name: 'zones', description: 'Control zone layout (default: as in the rotation)', required: false, autocomplete: true },
];

export const COMMANDS = [
  { name: 'serverstatus', description: 'Show the WARDOGS server status', type: 1 },
  { name: 'players', description: 'Who is on the server, with kills and deaths', type: 1 },
  { name: 'lastmatch', description: 'Summary of the last finished match', type: 1 },
  { name: 'rotation', description: 'The current map and what is coming next', type: 1 },
  {
    name: 'broadcast',
    description: 'Send a message to everyone in game (staff only)',
    type: 1,
    default_member_permissions: String(ADMINISTRATOR),
    contexts: [0],
    options: [
      { type: 3, name: 'message', description: 'What to show in game (up to 200 characters)', required: true, max_length: 200 },
    ],
  },
  {
    name: 'seeders',
    description: 'Who seeded the most, with Steam IDs for VIP (staff only)',
    type: 1,
    default_member_permissions: String(ADMINISTRATOR),
    contexts: [0],
    options: [
      {
        type: 4,
        name: 'days',
        description: `How many days to count, including today (default ${SEEDERS_DEFAULT_DAYS})`,
        required: false,
        min_value: 1,
        max_value: SEEDERS_MAX_DAYS,
      },
    ],
  },
  {
    name: 'seednow',
    description: "Post \"we're seeding now, come join\" to the alerts channel and ping the role (staff only)",
    ...STAFF_ONLY,
    options: [
      { type: STRING, name: 'message', description: 'Anything to add, such as which squad to join', required: false, max_length: 200 },
    ],
  },
  {
    name: 'removematch',
    description: 'Delete a wrongly recorded match and its leaderboard counts (staff only)',
    type: 1,
    default_member_permissions: String(ADMINISTRATOR),
    contexts: [0],
    options: [{ type: 3, name: 'match', description: 'Pick the match from the list', required: true, autocomplete: true }],
  },
  {
    name: 'warn',
    description: 'Send a player a private warning in game (staff only)',
    ...STAFF_ONLY,
    options: [
      player('Who to warn: pick from the players in game'),
      { type: STRING, name: 'message', description: 'The warning', required: true, max_length: WARNING_MAX_LENGTH },
    ],
  },
  {
    name: 'player',
    description: "A player's Steam ID, playtime, seeding, VIP, bans and staff history (staff only)",
    ...STAFF_ONLY,
    options: [player('Pick the player, or type a name or Steam ID')],
  },
  {
    name: 'kick',
    description: 'Remove a player from the server; they can rejoin (staff only)',
    ...STAFF_ONLY,
    options: [player('Who to kick: pick from the players in game'), reason('Why; the player sees this')],
  },
  {
    name: 'switchteam',
    description: 'Move a player to another team (staff only)',
    ...STAFF_ONLY,
    options: [
      player('Who to move: pick from the players in game'),
      {
        type: STRING,
        name: 'team',
        description: 'The team to move them to (with two teams, leave it out for the other one)',
        required: false,
        autocomplete: true,
      },
    ],
  },
  {
    name: 'ban',
    description: 'Ban a player for a set time or for good (staff only)',
    ...STAFF_ONLY,
    options: [
      player('Pick the player, or type a name or Steam ID'),
      {
        type: STRING,
        name: 'duration',
        description: 'How long',
        required: true,
        choices: BAN_LENGTHS.map(({ name, value }) => ({ name, value })),
      },
      reason('Why; kept with the ban'),
    ],
  },
  {
    name: 'unban',
    description: 'Lift a ban (staff only)',
    ...STAFF_ONLY,
    options: [steamId('Pick from the banned players, or type a Steam ID')],
  },
  {
    name: 'setnextmap',
    description: 'Set the map and setup after this match, without changing the rotation (staff only)',
    ...STAFF_ONLY,
    options: matchSetup,
  },
  {
    name: 'changemap',
    description: 'End the current match now and change map and setup (staff only)',
    ...STAFF_ONLY,
    options: matchSetup,
  },
  {
    name: 'vip',
    description: 'Give or take away a reserved slot (staff only)',
    ...STAFF_ONLY,
    options: [
      {
        type: SUBCOMMAND,
        name: 'add',
        description: 'Give a player a reserved slot for a number of days',
        options: [
          steamId('Pick the player, or type a name or Steam ID'),
          { type: INTEGER, name: 'days', description: 'How many days', required: true, min_value: 1, max_value: VIP_MAX_DAYS },
        ],
      },
      {
        type: SUBCOMMAND,
        name: 'remove',
        description: 'Take a player off the reserved list; automatic VIP skips them for 7 days',
        options: [steamId('Pick from the reserved list, or type a Steam ID')],
      },
    ],
  },
] satisfies ({ name: CommandName } & Record<string, unknown>)[];

const PING = 1;
const APPLICATION_COMMAND = 2;
const AUTOCOMPLETE = 4;
const PONG = 1;
const CHANNEL_MESSAGE = 4;
const DEFERRED_CHANNEL_MESSAGE = 5;
const AUTOCOMPLETE_RESULT = 8;
const EPHEMERAL = 64;

const OptionSchema = z.object({
  name: z.string(),
  type: z.number().optional(),
  value: z.unknown().optional(),
  focused: z.boolean().optional(),
});

const InteractionSchema = z.object({
  type: z.number(),
  application_id: z.string(),
  token: z.string().optional(),
  data: z
    .object({
      name: z.string(),
      // A subcommand, such as /vip add, arrives as an option holding its own options.
      options: z.array(OptionSchema.extend({ options: z.array(OptionSchema).optional() })).optional(),
    })
    .optional(),
  member: z
    .object({
      permissions: z.string().optional(),
      roles: z.array(z.string()).optional(),
      user: z.object({ id: z.string() }).optional(),
    })
    .optional(),
  guild_id: z.string().optional(),
});

// A subcommand's name is in `options.subcommand`. `focused` is the option being typed in, for suggestions.
export type CommandRequest = { name: CommandName; options: Record<string, string>; userId: string | null; focused?: string };
export type CommandReply = { content?: string; embeds?: Embed[] };
// An option value offered while someone types, such as a match to pick.
export type Choice = { name: string; value: string };

type Reply = CommandReply & { allowed_mentions: { parse: never[] } };

type InteractionDeps = {
  publicKey: string;
  runCommand: (request: CommandRequest) => Promise<CommandReply>;
  // What to offer for an option with autocomplete; the request holds what has been typed so far.
  suggest: (request: CommandRequest) => Promise<Choice[]>;
  editReply: (applicationId: string, token: string, reply: Reply) => Promise<void>;
  log: { error: (message: string) => void };
  now: () => number;
  // The only Discord server allowed to use admin commands. Commands are registered globally, so without this an
  // admin in any server that adds the app could control this game server.
  adminGuildId: string | undefined;
  // Roles in that server whose members may use admin commands without being Administrators, such as Staff.
  adminRoleIds: string[];
};

export type InteractionResult = { status: number; body: unknown; followUp?: () => Promise<void> };

// A signed request older (or newer) than this is refused, so a captured one cannot be replayed later.
const MAX_CLOCK_SKEW_SECONDS = 300;

const encoder = new TextEncoder();

const fromHex = (hex: string): Uint8Array<ArrayBuffer> =>
  /^([0-9a-f]{2})+$/i.test(hex) ? Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16)) : new Uint8Array();

const verifySignature = async (publicKey: string, signature: string, timestamp: string, body: string) => {
  try {
    const key = await crypto.subtle.importKey('raw', fromHex(publicKey), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, fromHex(signature), encoder.encode(timestamp + body));
  } catch {
    return false;
  }
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const isAdministrator = (permissions: string | undefined): boolean => {
  try {
    return permissions !== undefined && (BigInt(permissions) & ADMINISTRATOR) === ADMINISTRATOR;
  } catch {
    return false;
  }
};

type Member = { permissions?: string | undefined; roles?: string[] | undefined } | undefined;

const isAdmin = (member: Member, adminRoleIds: string[]): boolean =>
  isAdministrator(member?.permissions) || (member?.roles ?? []).some((role) => adminRoleIds.includes(role));

const privateMessage = (content: string) => ({ type: CHANNEL_MESSAGE, data: { content, flags: EPHEMERAL } });

export const handleInteraction = async (
  body: string,
  signature: string | null,
  timestamp: string | null,
  deps: InteractionDeps,
): Promise<InteractionResult> => {
  if (!signature || !timestamp || !(await verifySignature(deps.publicKey, signature, timestamp, body))) {
    return { status: 401, body: { error: 'invalid request signature' } };
  }
  if (Math.abs(deps.now() / 1000 - Number(timestamp)) > MAX_CLOCK_SKEW_SECONDS) {
    return { status: 401, body: { error: 'stale request' } };
  }

  const parsed = InteractionSchema.safeParse(JSON.parse(body));
  if (!parsed.success) return { status: 400, body: { error: 'unrecognised interaction' } };
  const interaction = parsed.data;

  if (interaction.type === PING) return { status: 200, body: { type: PONG } };

  const name = interaction.data?.name;
  const toRequest = (command: CommandName): CommandRequest => {
    const top = interaction.data?.options ?? [];
    const subcommand = top.find((o) => o.type === SUBCOMMAND);
    const options = subcommand?.options ?? top;
    const focused = options.find((o) => o.focused)?.name;
    return {
      name: command,
      options: Object.fromEntries([
        ...(subcommand ? [['subcommand', subcommand.name]] : []),
        ...options.flatMap((o) => (o.value === undefined ? [] : [[o.name, String(o.value)]])),
      ]),
      userId: interaction.member?.user?.id ?? null,
      ...(focused === undefined ? {} : { focused }),
    };
  };

  // Suggestions while someone types. Nobody who could not run the command gets any.
  if (interaction.type === AUTOCOMPLETE) {
    const allowed =
      isCommandName(name) &&
      (!ADMIN_COMMANDS.includes(name) ||
        (deps.adminGuildId !== undefined &&
          interaction.guild_id === deps.adminGuildId &&
          isAdmin(interaction.member, deps.adminRoleIds)));
    const choices = allowed
      ? await deps.suggest(toRequest(name)).catch((error: unknown) => {
          deps.log.error(`/${name} suggestions failed: ${errorText(error)}`);
          return [];
        })
      : [];
    return { status: 200, body: { type: AUTOCOMPLETE_RESULT, data: { choices } } };
  }

  if (interaction.type !== APPLICATION_COMMAND || !isCommandName(name) || !interaction.token) {
    return { status: 200, body: privateMessage('Unknown command.') };
  }

  const admin = ADMIN_COMMANDS.includes(name);
  if (admin && (!deps.adminGuildId || interaction.guild_id !== deps.adminGuildId)) {
    return { status: 200, body: privateMessage('This command can only be used in the Discord server that runs this bot.') };
  }
  // Discord shows admin commands only to Administrators and roles given access in Server Settings, and server owners
  // can change that, so check again.
  if (admin && !isAdmin(interaction.member, deps.adminRoleIds)) {
    return { status: 200, body: privateMessage('Only Administrators and staff can use this.') };
  }

  const token = interaction.token;
  const request = toRequest(name);
  // Discord allows 3 seconds for the first response and RCON can be slower, so defer and edit later.
  const followUp = async (): Promise<void> => {
    const reply: Reply = await deps.runCommand(request).then(
      (result) => ({ ...result, allowed_mentions: { parse: [] } }),
      (error: unknown) => {
        deps.log.error(`/${name} failed: ${errorText(error)}`);
        // A broadcast or staff action that timed out may still have reached the game, so don't invite a blind retry.
        // Staff replies are private, so they say why; public ones don't show internals.
        const content =
          name === 'broadcast'
            ? "Couldn't confirm the broadcast was delivered. Check in game before sending it again."
            : ACTIONS.includes(name)
              ? `Couldn't confirm /${name} worked (${errorText(error)}). Check before trying again.`
              : admin
                ? `Couldn't get that right now (${errorText(error)}). Try again in a minute.`
                : "Couldn't get that right now. Try again in a minute.";
        return { content, allowed_mentions: { parse: [] } };
      },
    );
    await deps.editReply(interaction.application_id, token, reply);
  };
  const deferred = admin ? { type: DEFERRED_CHANNEL_MESSAGE, data: { flags: EPHEMERAL } } : { type: DEFERRED_CHANNEL_MESSAGE };
  return { status: 200, body: deferred, followUp };
};

// The edit races the deferred "thinking…" response: if RCON answers (or fails) quickly, Discord may not have
// saved that message yet and answers 404. Waiting briefly and trying again fixes it.
const RETRY_DELAYS_MS = [500, 1_500, 3_000];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const editOriginalReply =
  (fetchFn: typeof fetch = fetch, retryDelaysMs: number[] = RETRY_DELAYS_MS) =>
  async (applicationId: string, token: string, reply: unknown): Promise<void> => {
    const url = `https://discord.com/api/v10/webhooks/${applicationId}/${token}/messages/@original`;
    const attempt = (): Promise<Response> =>
      fetchFn(url, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(reply),
        signal: AbortSignal.timeout(8_000),
      });

    const response = await retryDelaysMs.reduce<Promise<Response>>(
      async (previous, delay) => {
        const last = await previous;
        if (last.status !== 404) return last;
        await sleep(delay);
        return attempt();
      },
      attempt(),
    );
    if (!response.ok) {
      throw new Error(`Discord rejected the command reply: ${response.status} ${await response.text()}`);
    }
  };
