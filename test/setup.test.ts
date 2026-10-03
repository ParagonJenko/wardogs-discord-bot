import { describe, expect, it, vi } from 'vitest';
import { SETTING_NAMES } from '../src/config.ts';
import { changeSetting, changeSettings, mergeSecrets, setupReply, webhookProblem, rconChanged, setupModal, setupValues, settingsEmbed, SETTING_CHOICES, webhooksChanged } from '../src/setup.ts';
import { DEFAULT_LIMITS } from '../src/tenants.ts';

const ALERTS = 'https://discord.com/api/webhooks/111/alerts-Token';
const STATUS = 'https://discord.com/api/webhooks/222/status-Token';
const complete = { RCON_URL: 'http://203.0.113.10:7776', RCON_PASSWORD: 'hunter2', DISCORD_WEBHOOK_URL: ALERTS };

describe('setupModal', () => {
  it('asks for each secret, none required, and shows nothing already set', () => {
    const modal = setupModal();
    const inputs = modal.components.map((row) => row.components[0]);

    expect(modal.custom_id).toBe('setup');
    expect(modal.components).toHaveLength(5);
    expect(inputs.map((i) => i?.custom_id)).toEqual(['RCON_URL', 'RCON_PASSWORD', 'DISCORD_WEBHOOK_URL', 'DISCORD_STATUS_WEBHOOK_URL', 'DISCORD_ROUNDUP_WEBHOOK_URL']);
    expect(inputs.every((i) => i?.required === false && !('value' in (i ?? {})))).toBe(true);
    // Discord's limits: labels up to 45 characters, placeholders up to 100.
    expect(inputs.every((i) => (i?.label.length ?? 0) <= 45 && (i?.placeholder.length ?? 0) <= 100)).toBe(true);
  });
});

describe('setupValues', () => {
  it('reads the text inputs from action rows and from labels, leaving out blanks and anything else', () => {
    const submitted = [
      { type: 1, components: [{ type: 4, custom_id: 'RCON_URL', value: ' http://203.0.113.10:7776 ' }] },
      { type: 1, components: [{ type: 4, custom_id: 'RCON_PASSWORD', value: '' }] },
      { type: 18, component: { type: 4, custom_id: 'DISCORD_WEBHOOK_URL', value: ALERTS } },
      { type: 1, components: [{ type: 4, custom_id: 'SOMETHING_ELSE', value: 'x' }] },
    ];

    expect(setupValues(submitted)).toEqual({ RCON_URL: 'http://203.0.113.10:7776', DISCORD_WEBHOOK_URL: ALERTS });
    expect(setupValues('nonsense')).toEqual({});
  });
});

describe('mergeSecrets', () => {
  it('needs the RCON address, password and alerts webhook the first time', () => {
    expect(mergeSecrets({}, { RCON_URL: complete.RCON_URL })).toEqual({
      problems: ['RCON_PASSWORD: is needed the first time', 'DISCORD_WEBHOOK_URL: is needed the first time'],
    });
  });

  it('keeps what is set, changes what is given, and says what changed', () => {
    expect(mergeSecrets(complete, { DISCORD_STATUS_WEBHOOK_URL: STATUS })).toEqual({
      values: { ...complete, DISCORD_STATUS_WEBHOOK_URL: STATUS },
      changed: ['DISCORD_STATUS_WEBHOOK_URL'],
    });
    expect(mergeSecrets({}, { ...complete, RCON_URL: '203.0.113.10:7776' })).toMatchObject({
      values: complete,
      changed: ['RCON_URL', 'RCON_PASSWORD', 'DISCORD_WEBHOOK_URL'],
    });
  });

  it('turns an optional webhook off, but not a needed secret', () => {
    expect(mergeSecrets({ ...complete, DISCORD_STATUS_WEBHOOK_URL: STATUS }, { DISCORD_STATUS_WEBHOOK_URL: 'OFF' })).toEqual({
      values: complete,
      changed: ['DISCORD_STATUS_WEBHOOK_URL'],
    });
    expect(mergeSecrets(complete, { RCON_PASSWORD: 'off' })).toEqual({ problems: ['RCON_PASSWORD: is needed, so it cannot be turned off'] });
  });

  it('refuses a private RCON address, a webhook that is not Discord, and anything that is not a secret', () => {
    expect(mergeSecrets(complete, { RCON_URL: 'http://192.168.1.5:7776' })).toEqual({ problems: ['RCON_URL: must be a public address'] });
    expect(mergeSecrets(complete, { DISCORD_WEBHOOK_URL: 'https://evil.example/hook' })).toEqual({
      problems: ['DISCORD_WEBHOOK_URL: must be a Discord webhook URL'],
    });
    expect(mergeSecrets(complete, { SITE_URL: 'https://x.example' })).toEqual({ problems: ['SITE_URL: is not a secret this bot uses'] });
  });

  it('says whether the game server or a webhook changed, to test them', () => {
    expect(rconChanged(['RCON_PASSWORD'])).toBe(true);
    expect(rconChanged(['DISCORD_WEBHOOK_URL'])).toBe(false);
    expect(webhooksChanged(['RCON_URL', 'DISCORD_WEBHOOK_URL', 'DISCORD_ROUNDUP_WEBHOOK_URL'])).toEqual(['DISCORD_WEBHOOK_URL', 'DISCORD_ROUNDUP_WEBHOOK_URL']);
  });
});

describe('changeSetting', () => {
  it('sets a setting, or puts it back to its default', () => {
    expect(changeSetting({ LIVE_THRESHOLD: '40' }, 'SEEDING_THRESHOLD', ' 5 ')).toEqual({ settings: { LIVE_THRESHOLD: '40', SEEDING_THRESHOLD: '5' } });
    expect(changeSetting({ LIVE_THRESHOLD: '40' }, 'LIVE_THRESHOLD', null)).toEqual({ settings: {} });
  });

  it('refuses a value, or a reset, that breaks the rules between settings', () => {
    expect(changeSetting({}, 'SEEDING_THRESHOLD', '25')).toEqual({ problem: 'SEEDING_THRESHOLD: must be below LIVE_THRESHOLD' });
    expect(changeSetting({ LIVE_THRESHOLD: '40', SEEDING_THRESHOLD: '25' }, 'LIVE_THRESHOLD', null)).toEqual({
      problem: 'SEEDING_THRESHOLD: must be below LIVE_THRESHOLD',
    });
    expect(changeSetting({}, 'ROUNDUPS', 'maybe')).toMatchObject({ problem: expect.stringMatching(/^ROUNDUPS: /) });
  });

  it('offers every setting as a choice, within Discord’s limits', () => {
    expect(SETTING_CHOICES.map((c) => c.value)).toEqual(SETTING_NAMES);
    expect(SETTING_CHOICES.every((c) => c.name.length <= 100)).toBe(true);
  });
});

describe('settingsEmbed', () => {
  it('shows which secrets are set, never what they are', () => {
    const embed = settingsEmbed({ LIVE_THRESHOLD: '40' }, ['RCON_URL', 'RCON_PASSWORD'], DEFAULT_LIMITS, 'UK *Wardogs*');

    expect(embed.description).toContain('🔒 `RCON_PASSWORD` set');
    expect(embed.description).toContain('▫️ `DISCORD_STATUS_WEBHOOK_URL` not set');
    expect(embed.description).toContain('`LIVE_THRESHOLD`: **40**');
    expect(embed.description).toContain('`SEEDING_THRESHOLD`: *default*');
    expect(embed.description).toContain('Connected to **UK \\*Wardogs\\***.');
    expect(embed.fields?.[0]?.value).toContain('Commands: 20 a minute');
  });
});

describe('changeSettings', () => {
  it('changes several at once, checked together', () => {
    expect(changeSettings({}, { LIVE_THRESHOLD: '40', SEEDING_THRESHOLD: '30' })).toEqual({ settings: { LIVE_THRESHOLD: '40', SEEDING_THRESHOLD: '30' } });
    expect(changeSettings({ SITE_URL: 'https://a.example' }, { SITE_URL: null })).toEqual({ settings: {} });
  });

  it('refuses names that are not settings, secrets included', () => {
    expect(changeSettings({}, { RCON_PASSWORD: 'x', NOPE: '1' })).toEqual({ problem: 'RCON_PASSWORD: is not a setting\nNOPE: is not a setting' });
  });
});

describe('webhookProblem', () => {
  const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
  const GUILD = '1552990539455144086';

  it("accepts a webhook in the community's own Discord server", async () => {
    const fetchFn = answer(200, { id: '111', guild_id: GUILD, channel_id: '5' });

    await expect(webhookProblem(ALERTS, GUILD, fetchFn)).resolves.toBeNull();
    expect(fetchFn).toHaveBeenCalledWith(ALERTS, expect.objectContaining({ headers: { accept: 'application/json' } }));
  });

  it('refuses a webhook in another Discord server, so alerts never go to another community', async () => {
    await expect(webhookProblem(ALERTS, GUILD, answer(200, { guild_id: '999' }))).resolves.toMatch(/another Discord server/);
  });

  it('refuses a webhook Discord does not know, and says to try again when Discord fails', async () => {
    await expect(webhookProblem(ALERTS, GUILD, answer(404, {}))).resolves.toMatch(/not a webhook Discord knows/);
    await expect(webhookProblem(ALERTS, GUILD, answer(500, {}))).resolves.toMatch(/try again/);
    await expect(webhookProblem(ALERTS, GUILD, vi.fn(async () => Promise.reject(new Error('down'))))).resolves.toMatch(/try again/);
  });
});

describe('setupReply', () => {
  it('names what was saved and the server it reached, never the values', () => {
    expect(setupReply({ ok: true, changed: ['RCON_URL', 'RCON_PASSWORD'], server: { name: 'UK_1', players: 3, maxPlayers: 100 } })).toBe(
      '✅ Saved, encrypted: RCON address, RCON password. Connected to **UK\\_1** (3/100 players): the bot checks it every minute from now on.',
    );
    expect(setupReply({ ok: true, changed: [], server: null })).toMatch(/^Nothing changed/);
    expect(setupReply({ ok: false, problems: ['RCON_URL: must be a public address'] })).toBe('❌ Nothing was saved:\n• RCON_URL: must be a public address');
  });
});
