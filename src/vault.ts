// Each community's secrets (the RCON address and password, and its Discord webhooks) are encrypted before they are
// stored. The master key is a Worker secret, never stored with the data. Each community gets its own key, derived
// from the master key and its id, and the community's id is bound into every ciphertext too, so secrets stored for
// one community can never be read as another's, even if they were copied across.

export type Sealed = { v: 1; kid: string; iv: string; data: string };

// The key new secrets are sealed with, and earlier keys that can still open what they sealed, while it is re-sealed.
export type MasterKeys = { current: Uint8Array<ArrayBuffer>; previous: Uint8Array<ArrayBuffer>[] };

const KEY_BYTES = 32;
const IV_BYTES = 12;
const SALT = 'wardogs-discord-bot/tenant-secrets/v1';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

const fromBase64 = (text: string): Uint8Array<ArrayBuffer> | null => {
  try {
    return Uint8Array.from(atob(text.trim()), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
};

const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

// A master key is 32 random bytes in base64: `openssl rand -base64 32`.
export const parseMasterKey = (value: unknown): Uint8Array<ArrayBuffer> | null => {
  if (typeof value !== 'string') return null;
  const bytes = fromBase64(value);
  return bytes !== null && bytes.length === KEY_BYTES ? bytes : null;
};

// TENANT_SECRETS_KEY, and any earlier keys (comma-separated) in TENANT_SECRETS_KEY_PREVIOUS while rotating.
export const masterKeys = (env: Record<string, unknown>): MasterKeys => {
  const current = parseMasterKey(env['TENANT_SECRETS_KEY']);
  if (current === null) throw new Error('TENANT_SECRETS_KEY is not set, or is not 32 bytes of base64 (openssl rand -base64 32)');
  const previous = String(env['TENANT_SECRETS_KEY_PREVIOUS'] ?? '')
    .split(',')
    .filter((part) => part.trim() !== '')
    .map((part) => {
      const key = parseMasterKey(part);
      if (key === null) throw new Error('TENANT_SECRETS_KEY_PREVIOUS must be 32-byte base64 keys, comma-separated');
      return key;
    });
  return { current, previous };
};

// Which master key sealed a value: the start of its SHA-256, which says nothing about the key itself.
const keyId = async (master: Uint8Array<ArrayBuffer>): Promise<string> =>
  hex(await crypto.subtle.digest('SHA-256', master)).slice(0, 16);

const tenantKey = async (master: Uint8Array<ArrayBuffer>, tenantId: string): Promise<CryptoKey> => {
  const base = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(SALT), info: encoder.encode(`tenant:${tenantId}`) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
};

const additionalData = (tenantId: string) => encoder.encode(`tenant:${tenantId}`);

export const seal = async (keys: MasterKeys, tenantId: string, values: Record<string, string>): Promise<Sealed> => {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: additionalData(tenantId) },
    await tenantKey(keys.current, tenantId),
    encoder.encode(JSON.stringify(values)),
  );
  return { v: 1, kid: await keyId(keys.current), iv: toBase64(iv), data: toBase64(new Uint8Array(data)) };
};

const isSealed = (raw: unknown): raw is Sealed => {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return r['v'] === 1 && typeof r['kid'] === 'string' && typeof r['iv'] === 'string' && typeof r['data'] === 'string';
};

// `stale` is true when an earlier master key sealed them: seal them again with the current one.
export const unseal = async (
  keys: MasterKeys,
  tenantId: string,
  sealed: unknown,
): Promise<{ values: Record<string, string>; stale: boolean }> => {
  if (!isSealed(sealed)) throw new Error('Stored secrets are not in a form this version can read');
  const candidates = [keys.current, ...keys.previous];
  const ids = await Promise.all(candidates.map(keyId));
  const index = ids.indexOf(sealed.kid);
  const master = candidates[index];
  if (master === undefined) throw new Error('Stored secrets were sealed with a key that is not set (TENANT_SECRETS_KEY_PREVIOUS?)');
  const iv = fromBase64(sealed.iv);
  const data = fromBase64(sealed.data);
  if (iv === null || data === null) throw new Error('Stored secrets are damaged');
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: additionalData(tenantId) }, await tenantKey(master, tenantId), data);
  } catch {
    // Wrong community, or changed: the GCM tag does not match.
    throw new Error('Stored secrets could not be decrypted for this community');
  }
  const parsed: unknown = JSON.parse(decoder.decode(plain));
  if (typeof parsed !== 'object' || parsed === null || Object.values(parsed).some((v) => typeof v !== 'string')) {
    throw new Error('Stored secrets are damaged');
  }
  return { values: parsed as Record<string, string>, stale: index !== 0 };
};
