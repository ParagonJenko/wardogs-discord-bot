import type { SecretName } from './config.ts';
import type { SaveSecretsResult } from './setup.ts';
import type { Health, TenantRecord } from './tenants.ts';

// The operator's API, for adding communities and looking after them. It needs ADMIN_TOKEN (a Worker secret), only
// works over HTTPS, and never sends a secret back: secrets can be set, not read.

export type TenantView = {
  settings: Record<string, string>;
  // Which secrets are set; never what they are.
  secretsSet: SecretName[];
  health: Health;
  // The game server as the last check that reached it saw it.
  server: { name: string; seenAt: number } | null;
};

export type TenantAdmin = {
  view: () => Promise<TenantView>;
  saveSecrets: (values: Record<string, string>, by: string) => Promise<SaveSecretsResult>;
  saveSettings: (changes: Record<string, string | null>, by: string) => Promise<{ ok: true; settings: Record<string, string> } | { ok: false; problem: string }>;
  test: () => Promise<{ ok: true; server: { name: string; players: number; maxPlayers: number } } | { ok: false; problem: string }>;
  // Deletes everything the bot holds for the community.
  purge: () => Promise<void>;
};

export type AdminDeps = {
  token: string | undefined;
  registry: {
    list: () => Promise<TenantRecord[]>;
    put: (id: string, input: unknown) => Promise<{ record: TenantRecord } | { error: string }>;
    remove: (id: string) => Promise<void>;
  };
  tenant: (record: TenantRecord) => TenantAdmin;
  // Called after the communities change, so this Worker instance stops using what it had cached.
  changed: () => void;
  log: { info: (message: string) => void };
};

// A long random token: `openssl rand -base64 32`.
const MIN_TOKEN_LENGTH = 32;
const MAX_BODY_BYTES = 16 * 1024;
const BY = 'operator';

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const reply = (body: unknown, status = 200): Response => Response.json(body, { status, headers: HEADERS });

const encoder = new TextEncoder();

// Compares hashes of the two, byte by byte to the end, so the time taken says nothing about the token.
const sameToken = async (given: string, expected: string): Promise<boolean> => {
  const [a, b] = await Promise.all([given, expected].map(async (t) => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(t)))));
  let difference = 0;
  for (let i = 0; i < 32; i++) difference |= (a?.[i] ?? 0) ^ (b?.[i] ?? 0);
  return difference === 0;
};

const isLocal = (url: URL): boolean => url.hostname === 'localhost' || url.hostname === '127.0.0.1';

const readJson = async (request: Request): Promise<{ value: unknown } | { error: Response }> => {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return { error: reply({ error: 'Body too large' }, 413) };
  const text = await request.text();
  if (encoder.encode(text).length > MAX_BODY_BYTES) return { error: reply({ error: 'Body too large' }, 413) };
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: reply({ error: 'Body must be JSON' }, 400) };
  }
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isSecrets = (value: unknown): value is Record<string, string> => isObject(value) && Object.values(value).every((v) => typeof v === 'string');
const isSettings = (value: unknown): value is Record<string, string | null> =>
  isObject(value) && Object.values(value).every((v) => typeof v === 'string' || v === null);

const ROUTE = /^\/admin\/tenants(?:\/([^/]+)(?:\/(secrets|settings|test))?)?\/?$/;

export const handleAdmin = async (request: Request, deps: AdminDeps): Promise<Response> => {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' && !isLocal(url)) return reply({ error: 'HTTPS only' }, 403);
  if (deps.token === undefined || deps.token.length < MIN_TOKEN_LENGTH) {
    return reply({ error: `ADMIN_TOKEN is not set, or is shorter than ${MIN_TOKEN_LENGTH} characters` }, 503);
  }
  const given = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
  if (!(await sameToken(given, deps.token))) return reply({ error: 'Unauthorized' }, 401);

  const match = ROUTE.exec(url.pathname);
  if (match === null) return reply({ error: 'Not found' }, 404);
  const [, id, part] = match;
  const method = request.method;

  if (id === undefined) {
    if (method !== 'GET') return reply({ error: 'Method not allowed' }, 405);
    return reply({ tenants: await deps.registry.list() });
  }

  const find = async () => (await deps.registry.list()).find((t) => t.id === id);

  if (part === undefined && method === 'PUT') {
    const body = await readJson(request);
    if ('error' in body) return body.error;
    const result = await deps.registry.put(id, body.value);
    if ('error' in result) return reply({ error: result.error }, 400);
    deps.changed();
    deps.log.info(`[${id}] Community saved by the operator: ${JSON.stringify(result.record)}`);
    return reply({ tenant: result.record, ...(await deps.tenant(result.record).view()) });
  }

  const record = await find();
  if (record === undefined) return reply({ error: 'No such community' }, 404);
  const tenant = deps.tenant(record);

  if (part === undefined && method === 'GET') return reply({ tenant: record, ...(await tenant.view()) });

  if (part === undefined && method === 'DELETE') {
    // Spelling the id out again guards against deleting the wrong community by mistake.
    if (url.searchParams.get('confirm') !== id) return reply({ error: `Add ?confirm=${id} to delete this community and all its records` }, 400);
    // Suspended first, so no check starts while its records are deleted.
    await deps.registry.put(id, { status: 'suspended' });
    deps.changed();
    await tenant.purge();
    await deps.registry.remove(id);
    deps.changed();
    deps.log.info(`[${id}] Community deleted by the operator, with all its records`);
    return reply({ deleted: id });
  }

  if (part === 'secrets' && method === 'PUT') {
    const body = await readJson(request);
    if ('error' in body) return body.error;
    if (!isSecrets(body.value)) return reply({ error: 'Send an object of secret names and values' }, 400);
    const result = await tenant.saveSecrets(body.value, BY);
    return reply(result, result.ok ? 200 : 400);
  }

  if (part === 'settings' && method === 'PATCH') {
    const body = await readJson(request);
    if ('error' in body) return body.error;
    if (!isSettings(body.value)) return reply({ error: 'Send an object of setting names and values (null for the default)' }, 400);
    const result = await tenant.saveSettings(body.value, BY);
    return reply(result, result.ok ? 200 : 400);
  }

  if (part === 'test' && method === 'POST') {
    const result = await tenant.test();
    return reply(result, result.ok ? 200 : 502);
  }

  return reply({ error: 'Method not allowed' }, 405);
};
