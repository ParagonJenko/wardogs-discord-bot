import { z } from 'zod';
import type { Embed } from './discord.ts';

// Discord slash commands arrive as signed HTTP POSTs to the Worker's URL ("Interactions Endpoint URL").

const COMMAND_NAMES = ['serverstatus', 'players', 'lastmatch', 'rotation', 'broadcast'] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

const isCommandName = (name: string | undefined): name is CommandName =>
  COMMAND_NAMES.some((command) => command === name);

// Discord permission bit for "Manage Server".
const MANAGE_GUILD = 1n << 5n;

// Admin commands change things in game, so they are hidden from, and refused to, anyone without Manage Server.
// Their replies are only shown to the person who ran them.
const ADMIN_COMMANDS: readonly CommandName[] = ['broadcast'];

export const COMMANDS = [
  { name: 'serverstatus', description: 'Show the WARDOGS server status', type: 1 },
  { name: 'players', description: 'Who is on the server, with kills and deaths', type: 1 },
  { name: 'lastmatch', description: 'Summary of the last finished match', type: 1 },
  { name: 'rotation', description: 'The current map and what is coming next', type: 1 },
  {
    name: 'broadcast',
    description: 'Send a message to everyone in game (Manage Server only)',
    type: 1,
    default_member_permissions: String(MANAGE_GUILD),
    contexts: [0],
    options: [
      { type: 3, name: 'message', description: 'What to show in game (up to 200 characters)', required: true, max_length: 200 },
    ],
  },
] satisfies ({ name: CommandName } & Record<string, unknown>)[];

const PING = 1;
const APPLICATION_COMMAND = 2;
const PONG = 1;
const CHANNEL_MESSAGE = 4;
const DEFERRED_CHANNEL_MESSAGE = 5;
const EPHEMERAL = 64;

const InteractionSchema = z.object({
  type: z.number(),
  application_id: z.string(),
  token: z.string().optional(),
  data: z
    .object({
      name: z.string(),
      options: z.array(z.object({ name: z.string(), value: z.unknown() })).optional(),
    })
    .optional(),
  member: z
    .object({ permissions: z.string().optional(), user: z.object({ id: z.string() }).optional() })
    .optional(),
  guild_id: z.string().optional(),
});

export type CommandRequest = { name: CommandName; options: Record<string, string>; userId: string | null };
export type CommandReply = { content?: string; embeds?: Embed[] };

type Reply = CommandReply & { allowed_mentions: { parse: never[] } };

type InteractionDeps = {
  publicKey: string;
  runCommand: (request: CommandRequest) => Promise<CommandReply>;
  editReply: (applicationId: string, token: string, reply: Reply) => Promise<void>;
  log: { error: (message: string) => void };
  now: () => number;
  // The only Discord server allowed to use admin commands. Commands are registered globally, so without this an
  // admin in any server that adds the app could control this game server.
  adminGuildId: string | undefined;
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

const hasManageGuild = (permissions: string | undefined): boolean => {
  try {
    return permissions !== undefined && (BigInt(permissions) & MANAGE_GUILD) === MANAGE_GUILD;
  } catch {
    return false;
  }
};

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
  if (interaction.type !== APPLICATION_COMMAND || !isCommandName(name) || !interaction.token) {
    return { status: 200, body: privateMessage('Unknown command.') };
  }

  const admin = ADMIN_COMMANDS.includes(name);
  if (admin && (!deps.adminGuildId || interaction.guild_id !== deps.adminGuildId)) {
    return { status: 200, body: privateMessage('This command can only be used in the Discord server that runs this bot.') };
  }
  // Discord hides admin commands from other members, but server owners can override that, so check again.
  if (admin && !hasManageGuild(interaction.member?.permissions)) {
    return { status: 200, body: privateMessage('Only members with the Manage Server permission can use this.') };
  }

  const token = interaction.token;
  const request: CommandRequest = {
    name,
    options: Object.fromEntries((interaction.data?.options ?? []).map((o) => [o.name, String(o.value)])),
    userId: interaction.member?.user?.id ?? null,
  };
  // Discord allows 3 seconds for the first response and RCON can be slower, so defer and edit later.
  const followUp = async (): Promise<void> => {
    const reply: Reply = await deps.runCommand(request).then(
      (result) => ({ ...result, allowed_mentions: { parse: [] } }),
      (error: unknown) => {
        deps.log.error(`/${name} failed: ${errorText(error)}`);
        // A broadcast that timed out may still have reached the game, so don't invite a blind retry.
        const content = admin
          ? "Couldn't confirm the broadcast was delivered. Check in game before sending it again."
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
