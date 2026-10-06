import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

const required = {
  RCON_URL: 'http://203.0.113.10:7776',
  RCON_PASSWORD: 'secret',
  DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/111/abc-DEF_123',
};

describe('loadConfig', () => {
  it('applies the default thresholds and intervals', () => {
    expect(loadConfig(required)).toEqual({
      rconUrl: 'http://203.0.113.10:7776',
      rconPassword: 'secret',
      webhookUrl: 'https://discord.com/api/webhooks/111/abc-DEF_123',
      statusWebhookUrl: undefined,
      modLogWebhookUrl: undefined,
      griefAlerts: true,
      steamAlerts: true,
      roleId: undefined,
      inviteCode: undefined,
      siteUrl: undefined,
      serverId: undefined,
      pollIntervalMs: 60_000,
      rules: { seeding: 1, live: 20, lowPop: 20, cooldownMs: 600_000, graceMs: 300_000 },
      quietHours: { start: 21, end: 6, timeZone: 'Europe/London' },
      busyThreshold: 97,
      scoreToWin: 100,
      seedMinutes: 10,
      vip: null,
      matchMessages: null,
      seedingMessages: { everyMs: 300_000, siteHost: null },
      roundups: { hour: 17, webhookUrl: 'https://discord.com/api/webhooks/111/abc-DEF_123' },
      rotationHour: 5,
    });
  });

  it('starts each day\'s map rotation at ROTATION_HOUR (UTC)', () => {
    expect(loadConfig({ ...required, ROTATION_HOUR: '0' }).rotationHour).toBe(0);
    expect(() => loadConfig({ ...required, ROTATION_HOUR: '24' })).toThrow(/ROTATION_HOUR/);
  });

  it('reads the night, in its time zone, when the alerts ping nobody, off when it starts and ends at the same hour', () => {
    expect(loadConfig({ ...required, QUIET_START_HOUR: '0', QUIET_END_HOUR: '6', QUIET_TIME_ZONE: 'UTC' }).quietHours).toEqual({
      start: 0,
      end: 6,
      timeZone: 'UTC',
    });
    expect(loadConfig({ ...required, QUIET_START_HOUR: '3', QUIET_END_HOUR: '3' }).quietHours).toBeNull();
    expect(() => loadConfig({ ...required, QUIET_END_HOUR: '24' })).toThrow(/QUIET_END_HOUR/);
    expect(() => loadConfig({ ...required, QUIET_TIME_ZONE: 'Middle/Earth' })).toThrow(/QUIET_TIME_ZONE/);
  });

  it('posts roundups to their own channel when one is set, at the hour given, or not at all', () => {
    const url = 'https://discord.com/api/webhooks/333/roundup-Token_9';
    expect(loadConfig({ ...required, DISCORD_ROUNDUP_WEBHOOK_URL: url, ROUNDUP_HOUR: '9' }).roundups).toEqual({ hour: 9, webhookUrl: url });
    expect(loadConfig({ ...required, ROUNDUPS: 'off' }).roundups).toBeNull();
    expect(() => loadConfig({ ...required, ROUNDUP_HOUR: '24' })).toThrow(/ROUNDUP_HOUR/);
    expect(() => loadConfig({ ...required, DISCORD_ROUNDUP_WEBHOOK_URL: 'https://example.com/hook' })).toThrow(
      /DISCORD_ROUNDUP_WEBHOOK_URL/,
    );
  });

  it('posts high-risk Steam accounts to the moderation log unless STEAM_ALERTS is off', () => {
    expect(loadConfig({ ...required, STEAM_ALERTS: 'off' }).steamAlerts).toBe(false);
    expect(() => loadConfig({ ...required, STEAM_ALERTS: 'no' })).toThrow(/STEAM_ALERTS/);
  });

  it('reads the webhook for the live status, which must be a Discord webhook too', () => {
    const url = 'https://discord.com/api/webhooks/222/status-Token_9';
    expect(loadConfig({ ...required, DISCORD_STATUS_WEBHOOK_URL: url }).statusWebhookUrl).toBe(url);
    expect(() => loadConfig({ ...required, DISCORD_STATUS_WEBHOOK_URL: 'https://example.com/hook' })).toThrow(
      /DISCORD_STATUS_WEBHOOK_URL/,
    );
  });

  it('reads the website address for links in Discord posts', () => {
    expect(loadConfig({ ...required, SITE_URL: 'https://gaminginit.com' }).siteUrl).toBe('https://gaminginit.com');
    expect(() => loadConfig({ ...required, SITE_URL: 'gaminginit' })).toThrow(/SITE_URL/);
    expect(() => loadConfig({ ...required, SITE_URL: 'javascript:alert(1)' })).toThrow(/SITE_URL/);
  });

  it('reads the winning score whether or not in-game messages are on', () => {
    expect(loadConfig({ ...required, SCORE_TO_WIN: '150' }).scoreToWin).toBe(150);
  });

  it('turns on in-game messages when there is a website to point players at, unless they are off', () => {
    expect(loadConfig({ ...required, SITE_URL: 'https://gaminginit.com/' }).matchMessages).toEqual({
      siteHost: 'gaminginit.com',
      scoreToWin: 100,
    });
    expect(loadConfig({ ...required, SITE_URL: 'https://gaminginit.com', SCORE_TO_WIN: '150' }).matchMessages?.scoreToWin).toBe(150);
    expect(loadConfig({ ...required, SITE_URL: 'https://gaminginit.com', MATCH_MESSAGES: 'off' }).matchMessages).toBeNull();
    expect(loadConfig(required).matchMessages).toBeNull();
  });

  it('sends seeding messages every 5 minutes by default, with or without a website, unless set to 0', () => {
    expect(loadConfig({ ...required, SITE_URL: 'https://gaminginit.com/' }).seedingMessages).toEqual({
      everyMs: 300_000,
      siteHost: 'gaminginit.com',
    });
    expect(loadConfig({ ...required, SEEDING_MESSAGE_MINUTES: '10' }).seedingMessages).toEqual({ everyMs: 600_000, siteHost: null });
    expect(loadConfig({ ...required, SEEDING_MESSAGE_MINUTES: '0' }).seedingMessages).toBeNull();
    expect(() => loadConfig({ ...required, SEEDING_MESSAGE_MINUTES: '-1' })).toThrow(/SEEDING_MESSAGE_MINUTES/);
  });

  it('turns on automatic VIP when VIP_SEED_DAYS is set', () => {
    const config = loadConfig({ ...required, VIP_SEED_DAYS: '3', VIP_SEED_MINUTES: '15' });

    expect(config.seedMinutes).toBe(15);
    expect(config.vip).toEqual({ seedDays: 3, seedMinutes: 15, windowDays: 7, lengthDays: 7 });
    expect(loadConfig({ ...required, VIP_SEED_DAYS: '0' }).vip).toBeNull();
    expect(() => loadConfig({ ...required, VIP_SEED_DAYS: '8' })).toThrow(/VIP_SEED_DAYS/);
  });

  it('reads overrides from the environment', () => {
    const config = loadConfig({
      ...required,
      DISCORD_ROLE_ID: '987654321',
      SEEDING_THRESHOLD: '5',
      LIVE_THRESHOLD: '40',
      LOW_POP_THRESHOLD: '30',
      POLL_INTERVAL_SECONDS: '120',
      ALERT_COOLDOWN_MINUTES: '0',
      DROP_GRACE_MINUTES: '2',
      BUSY_THRESHOLD: '60',
    });

    expect(config.roleId).toBe('987654321');
    expect(config.pollIntervalMs).toBe(120_000);
    expect(config.rules).toEqual({ seeding: 5, live: 40, lowPop: 30, cooldownMs: 0, graceMs: 120_000 });
    expect(config.busyThreshold).toBe(60);
  });

  it('treats blank values as unset, as left by a copied .env.example', () => {
    const config = loadConfig({ ...required, DISCORD_ROLE_ID: '', LIVE_THRESHOLD: '' });

    expect(config.roleId).toBeUndefined();
    expect(config.rules.live).toBe(20);
  });

  it('keeps only the code from a Discord invite link', () => {
    for (const link of ['https://discord.gg/wardogs-UK', 'discord.gg/wardogs-UK/', 'https://discord.com/invite/wardogs-UK', 'wardogs-UK']) {
      expect(loadConfig({ ...required, DISCORD_INVITE: link }).inviteCode).toBe('wardogs-UK');
    }
  });

  it("keeps the server's ID for Join by ID, trimmed", () => {
    expect(loadConfig({ ...required, SERVER_ID: ' 2615de90-da95-4950-913a-246b1db49237 ' }).serverId).toBe(
      '2615de90-da95-4950-913a-246b1db49237',
    );
    expect(() => loadConfig({ ...required, SERVER_ID: '2615de90 da95' })).toThrow(/SERVER_ID/);
  });

  it('rejects a Discord invite that is not an invite link', () => {
    expect(() => loadConfig({ ...required, DISCORD_INVITE: 'https://example.com/join' })).toThrow(/DISCORD_INVITE/);
  });

  it('rejects a missing RCON password', () => {
    expect(() => loadConfig({ ...required, RCON_PASSWORD: undefined })).toThrow(/RCON_PASSWORD/);
  });

  it('rejects an RCON URL that is not http(s)://host:port', () => {
    expect(() => loadConfig({ ...required, RCON_URL: 'not an address' })).toThrow(/RCON_URL/);
    expect(() => loadConfig({ ...required, RCON_URL: 'http://203.0.113.10:7776/v1/status' })).toThrow(/RCON_URL/);
  });

  it('tidies an RCON address pasted with quotes, spaces or no http://', () => {
    for (const pasted of ['"http://203.0.113.10:31105"', ' http://203.0.113.10:31105\n', '203.0.113.10:31105', "'203.0.113.10:31105'"]) {
      expect(loadConfig({ ...required, RCON_URL: pasted }).rconUrl).toBe('http://203.0.113.10:31105');
    }
  });

  it('accepts an https RCON URL behind a proxy', () => {
    expect(loadConfig({ ...required, RCON_URL: 'https://rcon.example.com' }).rconUrl).toBe('https://rcon.example.com');
  });

  it('rejects a webhook URL that is not a Discord webhook', () => {
    expect(() => loadConfig({ ...required, DISCORD_WEBHOOK_URL: 'https://example.com/hook' })).toThrow(
      /DISCORD_WEBHOOK_URL/,
    );
  });

  it('rejects a low-pop threshold above the live threshold', () => {
    expect(() => loadConfig({ ...required, LIVE_THRESHOLD: '20', LOW_POP_THRESHOLD: '25' })).toThrow(
      /LOW_POP_THRESHOLD/,
    );
  });

  it('rejects a seeding threshold at or above the live threshold', () => {
    expect(() => loadConfig({ ...required, SEEDING_THRESHOLD: '20' })).toThrow(/SEEDING_THRESHOLD/);
  });
});
