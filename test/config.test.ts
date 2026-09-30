import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

const required = {
  BATTLEMETRICS_SERVER_ID: '12345678',
  DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/111/abc-DEF_123',
};

describe('loadConfig', () => {
  it('applies the default thresholds and intervals', () => {
    expect(loadConfig(required)).toEqual({
      serverId: '12345678',
      webhookUrl: 'https://discord.com/api/webhooks/111/abc-DEF_123',
      roleId: undefined,
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

  it('rejects a missing server id', () => {
    expect(() => loadConfig({ DISCORD_WEBHOOK_URL: required.DISCORD_WEBHOOK_URL })).toThrow(
      /BATTLEMETRICS_SERVER_ID/,
    );
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
