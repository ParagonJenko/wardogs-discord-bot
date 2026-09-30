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
      roleId: undefined,
      inviteCode: undefined,
      pollIntervalMs: 60_000,
      rules: { seeding: 1, live: 20, lowPop: 20, cooldownMs: 600_000 },
    });
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
    });

    expect(config.roleId).toBe('987654321');
    expect(config.pollIntervalMs).toBe(120_000);
    expect(config.rules).toEqual({ seeding: 5, live: 40, lowPop: 30, cooldownMs: 0 });
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

  it('rejects a Discord invite that is not an invite link', () => {
    expect(() => loadConfig({ ...required, DISCORD_INVITE: 'https://example.com/join' })).toThrow(/DISCORD_INVITE/);
  });

  it('rejects a missing RCON password', () => {
    expect(() => loadConfig({ ...required, RCON_PASSWORD: undefined })).toThrow(/RCON_PASSWORD/);
  });

  it('rejects an RCON URL that is not http(s)://host:port', () => {
    expect(() => loadConfig({ ...required, RCON_URL: '203.0.113.10:7776' })).toThrow(/RCON_URL/);
    expect(() => loadConfig({ ...required, RCON_URL: 'http://203.0.113.10:7776/v1/status' })).toThrow(/RCON_URL/);
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
