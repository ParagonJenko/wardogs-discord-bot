import { parseSecrets, SECRET_NAMES, SETTING_NAMES, settingsProblems, type SecretName, type SettingName } from './config.ts';
import { escapeMarkdown, type Embed } from './discord.ts';
import { rconAddressProblem, type TenantLimits } from './tenants.ts';

// A community's admins connect the bot themselves: /setup opens a form (a Discord modal) for the secrets, which go
// straight from Discord to the bot and are stored encrypted, and /settings changes everything else.

export const SETUP_MODAL_ID = 'setup';

const OPTIONAL: readonly SecretName[] = ['DISCORD_STATUS_WEBHOOK_URL', 'DISCORD_ROUNDUP_WEBHOOK_URL'];
const WEBHOOKS: readonly SecretName[] = ['DISCORD_WEBHOOK_URL', ...OPTIONAL];

const SETUP_FIELDS: { name: SecretName; label: string; placeholder: string; max: number }[] = [
  { name: 'RCON_URL', label: 'RCON address', placeholder: 'http://203.0.113.10:7776 (blank: keep what is set)', max: 200 },
  { name: 'RCON_PASSWORD', label: 'RCON password', placeholder: 'Blank: keep what is set', max: 256 },
  { name: 'DISCORD_WEBHOOK_URL', label: 'Alerts channel webhook URL', placeholder: 'https://discord.com/api/webhooks/… (blank: keep)', max: 200 },
  { name: 'DISCORD_STATUS_WEBHOOK_URL', label: 'Live status channel webhook URL (optional)', placeholder: 'Blank: keep · "off": no live status', max: 200 },
  { name: 'DISCORD_ROUNDUP_WEBHOOK_URL', label: 'Roundups channel webhook URL (optional)', placeholder: 'Blank: keep · "off": post in alerts', max: 200 },
];

const ACTION_ROW = 1;
const TEXT_INPUT = 4;
const SHORT = 1;
const LABEL = 18;

// The form. Nothing already set is shown in it: secrets are never sent back.
export const setupModal = () => ({
  custom_id: SETUP_MODAL_ID,
  title: 'Connect the bot',
  components: SETUP_FIELDS.map((field) => ({
    type: ACTION_ROW,
    components: [
      {
        type: TEXT_INPUT,
        custom_id: field.name,
        label: field.label,
        style: SHORT,
        required: false,
        max_length: field.max,
        placeholder: field.placeholder,
      },
    ],
  })),
});

type Component = { type?: number; custom_id?: string; value?: unknown; components?: Component[]; component?: Component };

// What was typed in the form, by secret. Blank fields are left out: they keep what is set. Discord sends each text
// input in an action row, or in a label in newer clients.
export const setupValues = (components: unknown): Partial<Record<SecretName, string>> => {
  const inputs: Component[] = [];
  const walk = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const item of list as Component[]) {
      if (typeof item !== 'object' || item === null) continue;
      if (item.type === TEXT_INPUT) inputs.push(item);
      if (item.type === LABEL && item.component) walk([item.component]);
      walk(item.components);
    }
  };
  walk(components);
  return Object.fromEntries(
    inputs.flatMap((input) => {
      const name = SECRET_NAMES.find((n) => n === input.custom_id);
      const value = typeof input.value === 'string' ? input.value.trim() : '';
      return name === undefined || value === '' ? [] : [[name, value]];
    }),
  );
};

export type SecretsChange = { values: Partial<Record<SecretName, string>>; changed: SecretName[] } | { problems: string[] };

// The secrets after a change from the form or the operator. "off" removes an optional webhook. The result must be
// complete, with a public RCON address.
export const mergeSecrets = (current: Partial<Record<SecretName, string>>, change: Partial<Record<string, string>>): SecretsChange => {
  const unknown = Object.keys(change).filter((name) => !(SECRET_NAMES as string[]).includes(name));
  if (unknown.length > 0) return { problems: unknown.map((name) => `${name}: is not a secret this bot uses`) };
  const next: Partial<Record<SecretName, string>> = { ...current };
  const problems: string[] = [];
  for (const name of SECRET_NAMES) {
    const value = change[name];
    if (value === undefined) continue;
    if (value.trim().toLowerCase() === 'off') {
      if (OPTIONAL.includes(name)) delete next[name];
      else problems.push(`${name}: is needed, so it cannot be turned off`);
    } else {
      next[name] = value;
    }
  }
  if (problems.length > 0) return { problems };
  const missing = SECRET_NAMES.filter((name) => !OPTIONAL.includes(name) && next[name] === undefined);
  if (missing.length > 0) return { problems: missing.map((name) => `${name}: is needed the first time`) };
  const parsed = parseSecrets(next);
  if ('problems' in parsed) return parsed;
  const address = rconAddressProblem(parsed.values.RCON_URL ?? '');
  if (address !== null) return { problems: [`RCON_URL: ${address}`] };
  const changed = SECRET_NAMES.filter((name) => parsed.values[name] !== current[name]);
  return { values: parsed.values, changed };
};

export const rconChanged = (changed: SecretName[]): boolean => changed.includes('RCON_URL') || changed.includes('RCON_PASSWORD');
export const webhooksChanged = (changed: SecretName[]): SecretName[] => changed.filter((name) => WEBHOOKS.includes(name));

// /settings: what each setting is, as Discord lists them.
export const SETTING_LABELS: Record<SettingName, string> = {
  DISCORD_ROLE_ID: 'Role to ping on alerts (role ID)',
  DISCORD_ADMIN_ROLE_IDS: 'Staff roles (role IDs, comma-separated)',
  DISCORD_INVITE: 'Discord invite link, for member counts',
  SITE_URL: 'Community website',
  SEEDING_THRESHOLD: 'Players for seeding',
  LIVE_THRESHOLD: 'Players for live',
  LOW_POP_THRESHOLD: 'Low pop below this many players',
  BUSY_THRESHOLD: 'Players for a busy hour (website)',
  ALERT_COOLDOWN_MINUTES: 'Minutes between alerts of a kind',
  DROP_GRACE_MINUTES: 'Minutes a drop must last to count',
  VIP_SEED_DAYS: 'Seed days a week for VIP (0: off)',
  VIP_SEED_MINUTES: 'Minutes of seeding that count as a seed',
  MATCH_MESSAGES: 'In-game match messages (on or off)',
  SCORE_TO_WIN: 'Score that wins a match',
  SEEDING_MESSAGE_MINUTES: 'Seeding message every this many minutes (0: off)',
  ROUNDUPS: 'Weekly and monthly roundups (on or off)',
  ROUNDUP_HOUR: 'Roundup hour (UTC, 0 to 23)',
};

export const SETTING_CHOICES = SETTING_NAMES.map((name) => ({ name: SETTING_LABELS[name], value: name }));

export const isSettingName = (name: string | undefined): name is SettingName => SETTING_NAMES.some((n) => n === name);

// The settings after changing some (null puts one back to its default), or what is wrong with that. They are checked
// together, so a change that breaks a rule between settings, such as seeding below live, is refused.
export const changeSettings = (
  current: Record<string, string>,
  changes: Record<string, string | null>,
): { settings: Record<string, string> } | { problem: string } => {
  const unknown = Object.keys(changes).filter((name) => !isSettingName(name));
  if (unknown.length > 0) return { problem: unknown.map((name) => `${name}: is not a setting`).join('\n') };
  const next = { ...current };
  for (const [name, value] of Object.entries(changes)) {
    const trimmed = value?.trim() ?? '';
    if (trimmed === '') delete next[name];
    else next[name] = trimmed;
  }
  const problems = settingsProblems(next);
  return problems.length === 0 ? { settings: next } : { problem: problems.join('\n') };
};

export const changeSetting = (current: Record<string, string>, name: SettingName, value: string | null) =>
  changeSettings(current, { [name]: value });

// A webhook must be one Discord knows, in the community's own Discord server: a webhook pasted from another server
// would send this community's alerts, and its players' names, there. Null when it is fine.
export const webhookProblem = async (
  webhookUrl: string,
  guildId: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 8_000,
): Promise<string | null> => {
  let response: Response;
  try {
    response = await fetchFn(webhookUrl, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  } catch {
    return 'Discord could not be asked about it; try again';
  }
  if (response.status === 401 || response.status === 404) return 'is not a webhook Discord knows (deleted, or copied wrong?)';
  if (!response.ok) return `Discord could not check it (${response.status}); try again`;
  const webhook = (await response.json().catch(() => null)) as { guild_id?: unknown } | null;
  return webhook?.guild_id === guildId ? null : "is in another Discord server: make it in this server's channel";
};

const SECRET_LABELS: Record<SecretName, string> = {
  RCON_URL: 'RCON address',
  RCON_PASSWORD: 'RCON password',
  DISCORD_WEBHOOK_URL: 'alerts webhook',
  DISCORD_STATUS_WEBHOOK_URL: 'live status webhook',
  DISCORD_ROUNDUP_WEBHOOK_URL: 'roundups webhook',
};

export type SaveSecretsResult =
  | { ok: true; changed: SecretName[]; server: { name: string; players: number; maxPlayers: number } | null }
  | { ok: false; problems: string[] };

// The reply to /setup. It names what changed, never what it changed to.
export const setupReply = (result: SaveSecretsResult): string => {
  if (!result.ok) return ['❌ Nothing was saved:', ...result.problems.map((p) => `• ${p}`)].join('\n');
  if (result.changed.length === 0) return 'Nothing changed: every field was blank or the same as before.';
  const saved = `✅ Saved, encrypted: ${result.changed.map((name) => SECRET_LABELS[name]).join(', ')}.`;
  if (result.server === null) return saved;
  return `${saved} Connected to **${escapeMarkdown(result.server.name)}** (${result.server.players}/${result.server.maxPlayers} players): the bot checks it every minute from now on.`;
};

const SETTINGS_COLOR = 0x5865f2;

// /settings show: every setting, which secrets are set (never what they are), and the operator's limits.
export const settingsEmbed = (
  settings: Record<string, string>,
  secretsSet: SecretName[],
  limits: TenantLimits,
  serverName: string | null,
): Embed => ({
  title: '⚙️ Bot settings',
  description: [
    serverName === null ? 'Not connected to a game server yet: run `/setup`.' : `Connected to **${escapeMarkdown(serverName)}**.`,
    '',
    ...SECRET_NAMES.map((name) => `${secretsSet.includes(name) ? '🔒' : '▫️'} \`${name}\` ${secretsSet.includes(name) ? 'set' : 'not set'}`),
    '',
    ...SETTING_NAMES.map((name) => `\`${name}\`: ${settings[name] === undefined ? '*default*' : `**${settings[name]}**`}`),
  ].join('\n'),
  fields: [
    {
      name: 'Limits (set by whoever runs the bot)',
      value: [
        `Website stats: ${limits.publicApi ? 'on' : 'off'}`,
        `Join checks while seeding: ${limits.joinChecks ? 'on' : 'off'}`,
        `Commands: ${limits.commandsPerMinute} a minute`,
        `Website reads: ${limits.publicReadsPerMinute} a minute`,
      ].join(' · '),
    },
  ],
  color: SETTINGS_COLOR,
  footer: { text: 'Change one with /settings set, or /setup for the game server and channels.' },
});
