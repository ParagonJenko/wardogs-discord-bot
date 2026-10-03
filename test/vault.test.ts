import { describe, expect, it } from 'vitest';
import { masterKeys, parseMasterKey, seal, unseal } from '../src/vault.ts';

const keyText = (fill: number): string => Buffer.alloc(32, fill).toString('base64');
const KEY_A = keyText(1);
const KEY_B = keyText(2);
const secrets = { RCON_URL: 'http://203.0.113.10:7776', RCON_PASSWORD: 'hunter2' };

describe('masterKeys', () => {
  it('needs a 32-byte base64 key', () => {
    expect(() => masterKeys({})).toThrow(/TENANT_SECRETS_KEY is not set/);
    expect(() => masterKeys({ TENANT_SECRETS_KEY: 'short' })).toThrow(/32 bytes/);
    expect(() => masterKeys({ TENANT_SECRETS_KEY: Buffer.alloc(16).toString('base64') })).toThrow(/32 bytes/);
    expect(parseMasterKey(KEY_A)?.length).toBe(32);
  });

  it('reads earlier keys for rotation, and refuses a bad one', () => {
    expect(masterKeys({ TENANT_SECRETS_KEY: KEY_B, TENANT_SECRETS_KEY_PREVIOUS: `${KEY_A}, ` }).previous).toHaveLength(1);
    expect(() => masterKeys({ TENANT_SECRETS_KEY: KEY_B, TENANT_SECRETS_KEY_PREVIOUS: 'nope' })).toThrow(/PREVIOUS/);
  });
});

describe('seal and unseal', () => {
  const keys = masterKeys({ TENANT_SECRETS_KEY: KEY_A });

  it('round-trips, without the plain text anywhere in what is stored', async () => {
    const sealed = await seal(keys, 'alpha', secrets);

    expect(JSON.stringify(sealed)).not.toContain('hunter2');
    expect(JSON.stringify(sealed)).not.toContain('203.0.113.10');
    await expect(unseal(keys, 'alpha', sealed)).resolves.toEqual({ values: secrets, stale: false });
  });

  it('uses a fresh IV every time', async () => {
    const [one, two] = await Promise.all([seal(keys, 'alpha', secrets), seal(keys, 'alpha', secrets)]);
    expect(one.iv).not.toBe(two.iv);
    expect(one.data).not.toBe(two.data);
  });

  it("never opens one community's secrets as another's", async () => {
    const sealed = await seal(keys, 'alpha', secrets);
    await expect(unseal(keys, 'beta', sealed)).rejects.toThrow(/could not be decrypted for this community/);
  });

  it('refuses secrets that were changed', async () => {
    const sealed = await seal(keys, 'alpha', secrets);
    const bytes = Buffer.from(sealed.data, 'base64');
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    await expect(unseal(keys, 'alpha', { ...sealed, data: bytes.toString('base64') })).rejects.toThrow(/could not be decrypted/);
    await expect(unseal(keys, 'alpha', { nope: true })).rejects.toThrow(/not in a form/);
  });

  it('opens secrets sealed with an earlier key, and says to seal them again', async () => {
    const sealed = await seal(keys, 'alpha', secrets);
    const rotated = masterKeys({ TENANT_SECRETS_KEY: KEY_B, TENANT_SECRETS_KEY_PREVIOUS: KEY_A });

    await expect(unseal(rotated, 'alpha', sealed)).resolves.toEqual({ values: secrets, stale: true });
    await expect(unseal(masterKeys({ TENANT_SECRETS_KEY: KEY_B }), 'alpha', sealed)).rejects.toThrow(/key that is not set/);
  });
});
