import { z } from 'zod';
import type { Embed } from './discord.ts';

// Support tickets. Staff post a panel with `/ticketpanel`; a member presses a button, fills in a form, and the bot opens a
// private channel in the tickets category that only they, the staff roles and the bot can see. Staff claim and close it
// with the buttons in the channel; closing saves a transcript to the log channel and deletes the channel.
//
// Nothing is stored: a ticket is its channel, and the channel's topic says what kind it is and who opened it.

const DISCORD_API = 'https://discord.com/api/v10';
const TIMEOUT_MS = 8_000;

export const TICKET_PANEL_COMMAND = {
  name: 'ticketpanel',
  description: 'Post the support ticket panel in this channel (staff only)',
  type: 1,
  // Hidden from everyone but Administrators until a server gives other roles access, and only usable in a server.
  default_member_permissions: String(1n << 3n),
  contexts: [0],
};

// Discord permission bits.
const MANAGE_CHANNELS = 1n << 4n;
const VIEW_CHANNEL = 1n << 10n;
const SEND_MESSAGES = 1n << 11n;
const MENTION_EVERYONE = 1n << 17n;
const EMBED_LINKS = 1n << 14n;
const ATTACH_FILES = 1n << 15n;
const READ_HISTORY = 1n << 16n;

const CREATE_INVITE = 1n << 0n;
const CREATE_PUBLIC_THREADS = 1n << 35n;
const CREATE_PRIVATE_THREADS = 1n << 36n;

const MEMBER_ALLOW = VIEW_CHANNEL | SEND_MESSAGES | EMBED_LINKS | ATTACH_FILES | READ_HISTORY;
// The person who opened the ticket cannot bring anyone else in: no invites, no threads (a thread can add people), and no
// pinging everyone.
const MEMBER_DENY = CREATE_INVITE | CREATE_PUBLIC_THREADS | CREATE_PRIVATE_THREADS | MENTION_EVERYONE;
const STAFF_ALLOW = MEMBER_ALLOW;
// Mention Everyone lets the bot ping staff roles that are not set to be mentionable, for urgent tickets.
const BOT_ALLOW = STAFF_ALLOW | MANAGE_CHANNELS | MENTION_EVERYONE;

// How many tickets one person can have open at once, and how many pages of 100 messages a transcript can hold.
// A ticket longer than that is not closed, rather than saved with its start missing.
export const MAX_OPEN_PER_USER = 3;
const TRANSCRIPT_PAGES = 20;

export type TicketType = 'urgent' | 'report' | 'appeal' | 'query';

type FormField = { id: string; label: string; paragraph: boolean; required: boolean; max: number; placeholder?: string };

type TicketKind = {
  label: string;
  emoji: string;
  // The button's style: 1 blue, 2 grey, 3 green, 4 red.
  style: number;
  color: number;
  blurb: string;
  // What staff are told in the channel.
  welcome: string;
  // Staff roles are pinged when it opens.
  ping: boolean;
  fields: FormField[];
};

export const TICKET_KINDS: Record<TicketType, TicketKind> = {
  urgent: {
    label: 'Urgent support',
    emoji: '🚨',
    style: 4,
    color: 0xed4245,
    blurb: 'A hacker or cheater on the server right now, or something that cannot wait.',
    welcome: 'Staff have been pinged. Stay in this channel and tell us what you can see.',
    ping: true,
    fields: [
      { id: 'who', label: 'Player name or Steam ID', paragraph: false, required: true, max: 100 },
      { id: 'details', label: 'What are they doing?', paragraph: true, required: true, max: 1000, placeholder: 'What you saw, and when.' },
      { id: 'evidence', label: 'Evidence links (optional)', paragraph: true, required: false, max: 500, placeholder: 'Clips or screenshots.' },
    ],
  },
  report: {
    label: 'Player report',
    emoji: '⚠️',
    style: 2,
    color: 0xfaa61a,
    blurb: 'Griefing, team killing, abuse or breaking the rules.',
    welcome: 'Staff will look at this when they can. Add anything else that helps, such as clips or screenshots.',
    ping: false,
    fields: [
      { id: 'who', label: 'Player name or Steam ID', paragraph: false, required: true, max: 100 },
      { id: 'details', label: 'What happened?', paragraph: true, required: true, max: 1000, placeholder: 'Which match or time, and what they did.' },
      { id: 'evidence', label: 'Evidence links (optional)', paragraph: true, required: false, max: 500, placeholder: 'Clips or screenshots.' },
    ],
  },
  appeal: {
    label: 'Ban appeal',
    emoji: '⚖️',
    style: 1,
    color: 0x5865f2,
    blurb: 'Ask for a ban to be looked at again.',
    welcome: 'Staff will review your appeal and reply here. Please be honest: it speeds things up.',
    ping: false,
    fields: [
      { id: 'who', label: 'Your in-game name or Steam ID', paragraph: false, required: true, max: 100 },
      { id: 'banned', label: 'Why were you banned?', paragraph: true, required: true, max: 500, placeholder: 'As you understand it.' },
      { id: 'why', label: 'Why should it be lifted?', paragraph: true, required: true, max: 1000 },
    ],
  },
  query: {
    label: 'General query',
    emoji: '💬',
    style: 3,
    color: 0x57f287,
    blurb: 'Anything else you need to ask staff.',
    welcome: 'Staff will reply here when they can.',
    ping: false,
    fields: [
      { id: 'subject', label: 'Subject', paragraph: false, required: true, max: 100 },
      { id: 'details', label: 'Your question', paragraph: true, required: true, max: 1000 },
    ],
  },
};

const TYPES = Object.keys(TICKET_KINDS) as TicketType[];
const isType = (value: string | undefined): value is TicketType => TYPES.some((type) => type === value);

// The settings tickets need; null leaves tickets switched off.
export type TicketRule = {
  botToken: string;
  guildId: string;
  // The category tickets are made in.
  categoryId: string;
  // Where closed tickets' transcripts go. Without it a closed ticket is deleted with nothing kept.
  logChannelId: string | undefined;
  // The roles that see every ticket (the staff roles).
  staffRoleIds: string[];
};

export type TicketTools = { rule: TicketRule | null; fetchFn?: typeof fetch };

export type TicketReply = { content: string };
export type TicketResult = { status: number; body: unknown; followUp?: () => Promise<void> };

// What an interaction asks for, as the interaction handler reads it.
export type TicketRequest = {
  kind: 'panel' | 'button' | 'modal';
  customId: string;
  // A form's answers, by field.
  fields: Record<string, string>;
  channelId: string | undefined;
  userId: string;
  userName: string;
  staff: boolean;
  applicationId: string;
  // The message a button was pressed on: the ticket's first message for Claim.
  message?: { id: string; embeds: unknown[] } | undefined;
  token: string;
};

export const TICKET_ID_PREFIX = 'ticket:';

const CHANNEL_MESSAGE = 4;
const UPDATE_MESSAGE = 7;
const DEFERRED_CHANNEL_MESSAGE = 5;
const MODAL = 9;
const EPHEMERAL = 64;

const privateMessage = (content: string, components?: unknown[]): TicketResult => ({
  status: 200,
  body: { type: CHANNEL_MESSAGE, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] }, ...(components ? { components } : {}) } },
});

// A failure whose cause is safe to show the person who pressed the button, because it says what staff must fix and nothing
// private. Anything else gets the general message, with the detail in the log.
// `detail` is what goes in the log: the operation, status and Discord's answer. It never reaches the person.
export class TicketProblem extends Error {
  detail: string;
  constructor(message: string, detail: string = message) {
    super(message);
    this.detail = detail;
  }
}

const PERMISSIONS_NEEDED = 'View Channel, Manage Channels, Send Messages, Embed Links, Attach Files, Read Message History and Mention Everyone';

// What a refusal from Discord means for staff.
export const discordProblem = (action: string, status: number, body: string): TicketProblem | null => {
  const detail = `${action}: ${status} ${body}`;
  const code = z.object({ code: z.number() }).safeParse((() => { try { return JSON.parse(body); } catch { return null; } })());
  const known = code.success ? code.data.code : undefined;
  if (known === 50013 || status === 403) {
    return new TicketProblem(`I can't open tickets yet: the bot is missing permissions in the ticket category. It needs ${PERMISSIONS_NEEDED} there. Please tell staff. (Discord ${known ?? status})`, detail);
  }
  if (known === 30013 || known === 50035) {
    return new TicketProblem(`I can't open tickets right now: the ticket category is full or set up wrong. Please tell staff. (Discord ${known})`, detail);
  }
  if (known === 10003 || status === 404) {
    return new TicketProblem('I can\'t open tickets yet: the ticket category was not found. Please tell staff. (Discord 10003)', detail);
  }
  return null;
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// The panel staff post: what each kind of ticket is for, and a button for each.
export const ticketPanel = (): { embeds: Embed[]; components: unknown[] } => ({
  embeds: [
    {
      title: '🎫 Support',
      description: [
        'Need staff? Press a button to open a private ticket. Only you and staff can see it.',
        '',
        ...TYPES.map((type) => `${TICKET_KINDS[type].emoji} **${TICKET_KINDS[type].label}**: ${TICKET_KINDS[type].blurb}`),
      ].join('\n'),
      color: 0x5865f2,
    },
  ],
  components: [
    {
      type: 1,
      components: TYPES.map((type) => ({
        type: 2,
        style: TICKET_KINDS[type].style,
        label: TICKET_KINDS[type].label,
        emoji: { name: TICKET_KINDS[type].emoji },
        custom_id: `${TICKET_ID_PREFIX}open:${type}`,
      })),
    },
  ],
});

// The form a button opens.
export const ticketModal = (type: TicketType) => ({
  type: MODAL,
  data: {
    custom_id: `${TICKET_ID_PREFIX}new:${type}`,
    title: TICKET_KINDS[type].label,
    components: TICKET_KINDS[type].fields.map((field) => ({
      type: 1,
      components: [
        {
          type: 4,
          custom_id: field.id,
          label: field.label,
          style: field.paragraph ? 2 : 1,
          required: field.required,
          max_length: field.max,
          ...(field.placeholder ? { placeholder: field.placeholder } : {}),
        },
      ],
    })),
  },
});

// Who has claimed a ticket is kept on its first message, in a "Claimed by" field of the details embed. Only the bot edits that
// message, so nobody can fake a claim.
const CLAIM_FIELD = 'Claimed by';

const EmbedsSchema = z.array(z.object({ fields: z.array(z.object({ name: z.string(), value: z.string() }).passthrough()).optional() }).passthrough());

export const claimedBy = (embeds: unknown): string | null => {
  const parsed = EmbedsSchema.safeParse(embeds);
  const value = parsed.success ? parsed.data[0]?.fields?.find((f) => f.name === CLAIM_FIELD)?.value : undefined;
  return /^<@(\d+)>$/.exec(value ?? '')?.[1] ?? null;
};

// The embeds with the claim set to this person.
export const withClaim = (embeds: unknown, userId: string): unknown[] => {
  const parsed = EmbedsSchema.safeParse(embeds);
  if (!parsed.success || parsed.data[0] === undefined) return [];
  const [first, ...rest] = parsed.data;
  const others = (first?.fields ?? []).filter((f) => f.name !== CLAIM_FIELD);
  return [{ ...first, fields: [...others, { name: CLAIM_FIELD, value: `<@${userId}>`, inline: false }] }, ...rest];
};

const TAKE_OVER_BUTTON = (messageId: string) => [
  { type: 1, components: [{ type: 2, style: 4, label: 'Take over anyway', custom_id: `${TICKET_ID_PREFIX}takeover:${messageId}` }] },
];

// Takes a ticket over from whoever claimed it: re-reads the ticket's message so a claim made a moment ago is not overwritten
// unseen, changes the claim, and says so in the channel so the previous person knows.
export const takeOverTicket = async (tools: TicketTools & { rule: TicketRule }, channelId: string, messageId: string, request: TicketRequest): Promise<string> => {
  const { rule } = tools;
  const send = call(rule, tools.fetchFn ?? fetch);
  const found = await send(`/channels/${channelId}`, 'GET');
  if (!found.ok) throw new Error(`Discord would not show the channel: ${found.status} ${await found.text()}`);
  const channel = ChannelSchema.parse(await found.json());
  if (parseTopic(channel.topic) === null || channel.parent_id !== rule.categoryId) return 'This is not a ticket channel.';
  const got = await send(`/channels/${channelId}/messages/${messageId}`, 'GET');
  if (!got.ok) throw new Error(`Discord would not show the ticket message: ${got.status} ${await got.text()}`);
  const message = z.object({ author: z.object({ id: z.string() }), embeds: z.array(z.unknown()) }).parse(await got.json());
  // Only the bot's own ticket message holds a claim.
  if (message.author.id !== request.applicationId) return 'That is not the ticket message.';
  const previous = claimedBy(message.embeds);
  if (previous === request.userId) return 'You have already claimed this ticket.';
  const edited = await send(`/channels/${channelId}/messages/${messageId}`, 'PATCH', { embeds: withClaim(message.embeds, request.userId) });
  if (!edited.ok) throw new Error(`Discord would not update the ticket: ${edited.status} ${await edited.text()}`);
  await send(`/channels/${channelId}/messages`, 'POST', {
    content: `🔁 <@${request.userId}> took this ticket over${previous === null ? '' : ` from <@${previous}>`}.`,
    allowed_mentions: { parse: [] },
  });
  return '✅ You now have this ticket.';
};

const STAFF_BUTTONS = [
  {
    type: 1,
    components: [
      { type: 2, style: 3, label: 'Claim', emoji: { name: '🙋' }, custom_id: `${TICKET_ID_PREFIX}claim` },
      { type: 2, style: 4, label: 'Close', emoji: { name: '🔒' }, custom_id: `${TICKET_ID_PREFIX}close` },
    ],
  },
];

const CONFIRM_BUTTONS = [
  { type: 1, components: [{ type: 2, style: 4, label: 'Close and delete', custom_id: `${TICKET_ID_PREFIX}close-yes` }] },
];

// A ticket channel's topic says what kind it is and who opened it. It is what tells a ticket from any other channel.
const topicOf = (type: TicketType, userId: string): string => `${type} ticket · opener ${userId}`;

const TOPIC = /^(urgent|report|appeal|query) ticket · opener (\d+)$/;

export const parseTopic = (topic: string | null | undefined): { type: TicketType; userId: string } | null => {
  const match = TOPIC.exec(topic ?? '');
  const type = match?.[1];
  const userId = match?.[2];
  return isType(type) && userId !== undefined ? { type, userId } : null;
};

// A channel name from the kind and the person's name: lowercase letters, digits and dashes.
export const ticketChannelName = (type: TicketType, userName: string, userId: string): string => {
  const slug = userName
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${type}-${slug || userId.slice(-4)}`;
};

// Who sees the channel: nobody, except the person who opened it, the staff roles and the bot.
// Never the @everyone role (its ID is the server's), whatever the staff roles are set to.
const staffRoles = (rule: TicketRule): string[] => rule.staffRoleIds.filter((id) => id !== rule.guildId);

export const ticketOverwrites = (rule: TicketRule, userId: string, botId: string) => [
  { id: rule.guildId, type: 0, allow: '0', deny: String(VIEW_CHANNEL) },
  ...staffRoles(rule).map((id) => ({ id, type: 0, allow: String(STAFF_ALLOW), deny: '0' })),
  { id: userId, type: 1, allow: String(MEMBER_ALLOW), deny: String(MEMBER_DENY) },
  { id: botId, type: 1, allow: String(BOT_ALLOW), deny: '0' },
];

const OverwritesSchema = z.array(z.object({ id: z.string(), type: z.number(), allow: z.string(), deny: z.string() }));
const bits = (value: string): bigint => {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
};

// What Discord says a channel's permissions are, checked against what a ticket must be: hidden from @everyone, and shown to
// nobody but `allowed`. Null when it is; otherwise what is wrong. A missing list fails, so nothing is trusted unseen.
export const exposure = (channel: unknown, guildId: string, allowed: string[]): string | null => {
  const parsed = z.object({ permission_overwrites: OverwritesSchema }).safeParse(channel);
  if (!parsed.success) return "Discord did not say who can see the channel";
  const overwrites = parsed.data.permission_overwrites;
  const everyone = overwrites.find((o) => o.id === guildId);
  if (everyone === undefined || (bits(everyone.deny) & VIEW_CHANNEL) === 0n || (bits(everyone.allow) & VIEW_CHANNEL) !== 0n) {
    return 'the channel is not hidden from @everyone';
  }
  const stranger = overwrites.find((o) => o.id !== guildId && (bits(o.allow) & VIEW_CHANNEL) !== 0n && !allowed.includes(o.id));
  return stranger === undefined ? null : `the channel is shown to ${stranger.type === 0 ? 'role' : 'member'} ${stranger.id}`;
};

const call =
  (rule: TicketRule, fetchFn: typeof fetch) =>
  (path: string, method: string, body?: unknown, reason?: string): Promise<Response> =>
    fetchFn(`${DISCORD_API}${path}`, {
      method,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        authorization: `Bot ${rule.botToken}`,
        ...(body === undefined || body instanceof FormData ? {} : { 'content-type': 'application/json' }),
        ...(reason === undefined ? {} : { 'x-audit-log-reason': encodeURIComponent(reason) }),
      },
      ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
    });

const ChannelSchema = z.object({
  id: z.string(),
  parent_id: z.string().nullish(),
  topic: z.string().nullish(),
  name: z.string().optional(),
});

// The tickets someone has open: the channels in the category whose topic names them.
const openTickets = async (rule: TicketRule, fetchFn: typeof fetch, userId: string): Promise<string[]> => {
  const response = await call(rule, fetchFn)(`/guilds/${rule.guildId}/channels`, 'GET');
  if (!response.ok) throw new Error(`Discord would not list the channels: ${response.status} ${await response.text()}`);
  return z
    .array(ChannelSchema)
    .parse(await response.json())
    .filter((channel) => channel.parent_id === rule.categoryId && parseTopic(channel.topic)?.userId === userId)
    .map((channel) => channel.id);
};

const detailsEmbed = (type: TicketType, request: TicketRequest): Embed => {
  const kind = TICKET_KINDS[type];
  return {
    title: `${kind.emoji} ${kind.label}`,
    description: `Opened by <@${request.userId}>\n${kind.welcome}`,
    color: kind.color,
    fields: kind.fields
      .filter((field) => (request.fields[field.id] ?? '').trim() !== '')
      .map((field) => ({ name: field.label, value: clip((request.fields[field.id] ?? '').trim(), 1024) })),
  };
};

// Opens the ticket's channel and the first message in it. Returns what to tell the person.
export const openTicket = async (tools: TicketTools & { rule: TicketRule }, type: TicketType, request: TicketRequest): Promise<string> => {
  const { rule } = tools;
  const fetchFn = tools.fetchFn ?? fetch;
  const send = call(rule, fetchFn);
  const open = await openTickets(rule, fetchFn, request.userId);
  if (open.length >= MAX_OPEN_PER_USER) {
    return `You already have ${open.length} tickets open (${open.map((id) => `<#${id}>`).join(', ')}). Use one of those, or wait for staff to close it.`;
  }

  const created = await send(
    `/guilds/${rule.guildId}/channels`,
    'POST',
    {
      name: ticketChannelName(type, request.userName, request.userId),
      type: 0,
      parent_id: rule.categoryId,
      topic: topicOf(type, request.userId),
      permission_overwrites: ticketOverwrites(rule, request.userId, request.applicationId),
    },
    `${TICKET_KINDS[type].label} ticket opened by ${request.userName}`,
  );
  if (!created.ok) {
    const text = await created.text();
    throw discordProblem('creating the ticket channel', created.status, text) ?? new Error(`Discord would not create the ticket channel: ${created.status} ${text}`);
  }
  const made: unknown = await created.json();
  const channel = z.object({ id: z.string() }).parse(made);
  // A channel without its details and buttons is worse than none, and would count against the person's limit.
  const discard = () => send(`/channels/${channel.id}`, 'DELETE').catch(() => undefined);
  // Never trust the channel to be private: check what Discord made, and delete it before anyone is told if it is not.
  const exposed = exposure(made, rule.guildId, [request.userId, request.applicationId, ...staffRoles(rule)]);
  if (exposed !== null) {
    await discard();
    throw new TicketProblem("I didn't open your ticket because I couldn't make it private. Please tell staff.", `the new channel ${channel.id} was not private: ${exposed}`);
  }

  const ping = TICKET_KINDS[type].ping ? staffRoles(rule) : [];
  const posted = await send(`/channels/${channel.id}/messages`, 'POST', {
    content: [`<@${request.userId}>`, ...ping.map((id) => `<@&${id}>`)].join(' '),
    embeds: [detailsEmbed(type, request)],
    components: STAFF_BUTTONS,
    allowed_mentions: { users: [request.userId], roles: ping },
  }).catch(async (error: unknown) => {
    await discard();
    throw error;
  });
  if (!posted.ok) {
    await discard();
    const text = await posted.text();
    throw discordProblem('posting in the ticket channel', posted.status, text) ?? new Error(`Discord would not post in the ticket channel: ${posted.status} ${text}`);
  }
  return `✅ Your ticket is open: <#${channel.id}>`;
};

const MessageSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  content: z.string(),
  author: z.object({ username: z.string(), bot: z.boolean().optional() }),
  attachments: z.array(z.object({ url: z.string() })).default([]),
  embeds: z
    .array(z.object({ title: z.string().nullish(), description: z.string().nullish(), fields: z.array(z.object({ name: z.string(), value: z.string() })).default([]) }))
    .default([]),
});
type TicketMessage = z.infer<typeof MessageSchema>;

// All of the channel's messages, oldest first. Throws when there are more than TRANSCRIPT_PAGES of 100: a transcript with
// its start missing must not be taken for the whole.
const fetchMessages = async (rule: TicketRule, fetchFn: typeof fetch, channelId: string): Promise<TicketMessage[]> => {
  const send = call(rule, fetchFn);
  const newestFirst: TicketMessage[] = [];
  let before: string | undefined;
  for (let page = 0; page < TRANSCRIPT_PAGES; page++) {
    const response = await send(`/channels/${channelId}/messages?limit=100${before ? `&before=${before}` : ''}`, 'GET');
    if (!response.ok) throw new Error(`Discord would not list the ticket's messages: ${response.status} ${await response.text()}`);
    const batch = z.array(MessageSchema).parse(await response.json());
    newestFirst.push(...batch);
    const last = batch[batch.length - 1];
    if (batch.length < 100 || last === undefined) return newestFirst.reverse();
    before = last.id;
  }
  throw new Error(`the ticket has more than ${TRANSCRIPT_PAGES * 100} messages, which is too many to save, so it was kept`);
};

export const transcriptText = (messages: TicketMessage[]): string =>
  messages
    .map((message) => {
      const lines = [
        message.content,
        ...message.embeds.flatMap((embed) => [embed.title, embed.description, ...embed.fields.map((f) => `${f.name}: ${f.value}`)]),
        ...message.attachments.map((a) => `[attachment] ${a.url}`),
      ].filter((line): line is string => typeof line === 'string' && line !== '');
      return `[${message.timestamp}] ${message.author.username}${message.author.bot ? ' (bot)' : ''}: ${lines.join('\n    ')}`;
    })
    .join('\n');

// Why the log channel cannot take transcripts, or null when it can: it must be hidden from @everyone, or tickets would be
// copied out to a channel anyone can read. Anything else with access is the staff's to choose.
export const logChannelProblem = async (rule: TicketRule, fetchFn: typeof fetch): Promise<string | null> => {
  if (rule.logChannelId === undefined) return null;
  const response = await call(rule, fetchFn)(`/channels/${rule.logChannelId}`, 'GET');
  if (!response.ok) return `the bot cannot see the log channel (${response.status})`;
  const channel: unknown = await response.json();
  const roleOrMember = z.object({ permission_overwrites: OverwritesSchema }).safeParse(channel);
  if (!roleOrMember.success) return 'Discord did not say who can see the log channel';
  const everyone = roleOrMember.data.permission_overwrites.find((o) => o.id === rule.guildId);
  return everyone !== undefined && (bits(everyone.deny) & VIEW_CHANNEL) !== 0n && (bits(everyone.allow) & VIEW_CHANNEL) === 0n
    ? null
    : 'the log channel is not hidden from @everyone. Deny View Channel for @everyone on it, so only staff can read transcripts';
};

// Saves the transcript, then deletes the channel. Returns what to tell staff. A transcript that could not be saved stops
// the delete: closing must not lose the record.
export const closeTicket = async (tools: TicketTools & { rule: TicketRule }, channelId: string, request: TicketRequest): Promise<string> => {
  const { rule } = tools;
  const fetchFn = tools.fetchFn ?? fetch;
  const send = call(rule, fetchFn);
  const found = await send(`/channels/${channelId}`, 'GET');
  if (!found.ok) throw new Error(`Discord would not show the channel: ${found.status} ${await found.text()}`);
  const channel = ChannelSchema.parse(await found.json());
  // Never delete a channel that is not a ticket, whatever button was pressed.
  const ticket = parseTopic(channel.topic);
  if (ticket === null || channel.parent_id !== rule.categoryId) return 'This is not a ticket channel, so it was not closed.';

  if (rule.logChannelId !== undefined) {
    const problem = await logChannelProblem(rule, fetchFn);
    if (problem !== null) throw new Error(`the ticket was kept: ${problem}`);
    const messages = await fetchMessages(rule, fetchFn, channelId);
    const form = new FormData();
    form.append(
      'payload_json',
      JSON.stringify({
        embeds: [
          {
            title: `${TICKET_KINDS[ticket.type].emoji} ${TICKET_KINDS[ticket.type].label} closed`,
            color: TICKET_KINDS[ticket.type].color,
            fields: [
              { name: 'Opened by', value: `<@${ticket.userId}>`, inline: true },
              { name: 'Closed by', value: `<@${request.userId}>`, inline: true },
              { name: 'Channel', value: `#${channel.name ?? channelId}`, inline: true },
              { name: 'Messages', value: String(messages.length), inline: true },
            ],
          },
        ],
        allowed_mentions: { parse: [] },
      }),
    );
    form.append('files[0]', new Blob([transcriptText(messages) || '(no messages)'], { type: 'text/plain' }), `${channel.name ?? 'ticket'}.txt`);
    const logged = await send(`/channels/${rule.logChannelId}/messages`, 'POST', form);
    if (!logged.ok) throw new Error(`Discord would not post the transcript, so the ticket was kept: ${logged.status} ${await logged.text()}`);
  }

  const deleted = await send(`/channels/${channelId}`, 'DELETE', undefined, `Ticket closed by ${request.userName}`);
  if (!deleted.ok && deleted.status !== 404) throw new Error(`Discord would not delete the channel: ${deleted.status} ${await deleted.text()}`);
  return rule.logChannelId === undefined ? 'Ticket closed. No log channel is set, so no transcript was kept.' : 'Ticket closed. The transcript is in the log channel.';
};

// Posts the panel in the channel `/ticketpanel` was used in.
export const postPanel = async (tools: TicketTools & { rule: TicketRule }, channelId: string): Promise<void> => {
  const response = await call(tools.rule, tools.fetchFn ?? fetch)(`/channels/${channelId}/messages`, 'POST', ticketPanel());
  if (!response.ok) throw new Error(`Discord would not post the panel: ${response.status} ${await response.text()}`);
};

// Everything a ticket interaction does. `edit` changes the reply the person was given while the work ran.
export const handleTicket = async (
  tools: TicketTools,
  request: TicketRequest,
  edit: (reply: TicketReply) => Promise<void>,
  log: { error: (message: string) => void },
): Promise<TicketResult> => {
  const { rule } = tools;
  if (rule === null) return privateMessage('Tickets are not set up yet. Ask staff to set DISCORD_TICKET_CATEGORY_ID.');
  const ready = { ...tools, rule };
  const [, action, argument] = request.customId.split(':');

  // Work that can outlast Discord's three seconds is deferred, and the answer edited in.
  const deferred = (work: () => Promise<string>, failure: string): TicketResult => ({
    status: 200,
    body: { type: DEFERRED_CHANNEL_MESSAGE, data: { flags: EPHEMERAL } },
    followUp: async () => {
      const content = await work().catch((error: unknown) => {
        log.error(`Ticket ${request.customId} failed: ${error instanceof TicketProblem ? error.detail : errorText(error)}`);
        return error instanceof TicketProblem ? error.message : failure;
      });
      await edit({ content });
    },
  });

  if (request.kind === 'panel') {
    if (!request.staff) return privateMessage('Only staff can post the ticket panel.');
    const channelId = request.channelId;
    if (channelId === undefined) return privateMessage('Use this in the channel you want the panel in.');
    return deferred(async () => {
      await postPanel(ready, channelId);
      const warning = await logChannelProblem(rule, tools.fetchFn ?? fetch).catch((error: unknown) => errorText(error));
      return warning === null ? '✅ Ticket panel posted.' : `✅ Ticket panel posted.\n⚠️ Closing tickets will not work yet: ${warning}.`;
    }, "Couldn't post the panel. The bot needs View Channel, Send Messages and Embed Links in this channel.");
  }

  if (request.kind === 'modal') {
    if (action !== 'new' || !isType(argument)) return privateMessage('Unknown form.');
    return deferred(
      () => openTicket(ready, argument, request),
      "Couldn't open your ticket right now. Try again in a minute, or ask staff in the server.",
    );
  }

  if (action === 'open') return isType(argument) ? { status: 200, body: ticketModal(argument) } : privateMessage('Unknown button.');

  if (action === 'claim') {
    if (!request.staff) return privateMessage('Only staff can claim tickets.');
    const message = request.message;
    if (message === undefined) return privateMessage('Unknown message.');
    const owner = claimedBy(message.embeds);
    if (owner === request.userId) return privateMessage('You have already claimed this ticket.');
    // Someone else has it: ask first, so two staff don't both work a ticket without knowing.
    if (owner !== null) {
      return privateMessage(`<@${owner}> has already claimed this ticket. Take it over only if you have agreed it with them.`, TAKE_OVER_BUTTON(message.id));
    }
    return { status: 200, body: { type: UPDATE_MESSAGE, data: { embeds: withClaim(message.embeds, request.userId), allowed_mentions: { parse: [] } } } };
  }

  if (action === 'takeover') {
    if (!request.staff) return privateMessage('Only staff can claim tickets.');
    const channelId = request.channelId;
    if (channelId === undefined || argument === undefined || !/^\d+$/.test(argument)) return privateMessage('Unknown ticket.');
    return {
      status: 200,
      body: { type: UPDATE_MESSAGE, data: { content: 'Taking the ticket over…', components: [] } },
      followUp: async () => {
        const content = await takeOverTicket(ready, channelId, argument, request).catch((error: unknown) => {
          log.error(`Taking over ticket ${channelId} failed: ${errorText(error)}`);
          return "Couldn't take the ticket over right now. Try again.";
        });
        await edit({ content }).catch(() => undefined);
      },
    };
  }

  if (action === 'close') {
    if (!request.staff) return privateMessage('Only staff can close tickets.');
    const note = rule.logChannelId === undefined ? ' No log channel is set, so nothing will be kept.' : ' A transcript is saved to the log channel first.';
    return privateMessage(`Close this ticket? The channel is deleted.${note}`, CONFIRM_BUTTONS);
  }

  if (action === 'close-yes') {
    if (!request.staff) return privateMessage('Only staff can close tickets.');
    const channelId = request.channelId;
    if (channelId === undefined) return privateMessage('Unknown channel.');
    return {
      status: 200,
      body: { type: UPDATE_MESSAGE, data: { content: 'Closing the ticket…', components: [] } },
      followUp: async () => {
        const content = await closeTicket(ready, channelId, request).catch((error: unknown) => {
          log.error(`Closing ticket ${channelId} failed: ${errorText(error)}`);
          return `Couldn't close the ticket (${errorText(error)}).`;
        });
        // The channel may be gone by now; the answer is for the staff member's private message, which outlives it.
        await edit({ content }).catch(() => undefined);
      },
    };
  }

  return privateMessage('Unknown button.');
};
