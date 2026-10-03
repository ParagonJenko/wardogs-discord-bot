import { describe, expect, it, vi } from 'vitest';
import { handleAdmin, type TenantAdmin } from '../src/admin.ts';
import { applyTenantInput, DEFAULT_LIMITS, type TenantRecord } from '../src/tenants.ts';

const TOKEN = 'a'.repeat(40);
const NOW = 1_790_000_000_000;
const alpha: TenantRecord = {
  id: 'alpha',
  guildId: '1552990539455144086',
  name: 'Alpha',
  status: 'active',
  limits: DEFAULT_LIMITS,
  createdAt: NOW,
  updatedAt: NOW,
};

const setup = (token: string | undefined = TOKEN) => {
  let tenants: TenantRecord[] = [alpha];
  const admin: { [K in keyof TenantAdmin]: ReturnType<typeof vi.fn> } = {
    view: vi.fn(async () => ({ settings: {}, secretsSet: ['RCON_URL'], health: { failures: 0, nextCheckAt: 0 }, server: null })),
    saveSecrets: vi.fn(async () => ({ ok: true, changed: ['RCON_PASSWORD'], server: null })),
    saveSettings: vi.fn(async () => ({ ok: true, settings: { LIVE_THRESHOLD: '40' } })),
    test: vi.fn(async () => ({ ok: false, problem: 'RCON rejected the password (401)' })),
    purge: vi.fn(async () => undefined),
  };
  const deps = {
    token,
    registry: {
      list: vi.fn(async () => tenants),
      put: vi.fn(async (id: string, input: unknown) => {
        const result = applyTenantInput(tenants, id, input, NOW, 25);
        if ('record' in result) tenants = [...tenants.filter((t) => t.id !== id), result.record];
        return result;
      }),
      remove: vi.fn(async (id: string) => {
        tenants = tenants.filter((t) => t.id !== id);
      }),
    },
    tenant: vi.fn((_record: TenantRecord) => admin as unknown as TenantAdmin),
    changed: vi.fn(),
    log: { info: vi.fn() },
  };
  const call = (path: string, init: RequestInit & { auth?: string | null; base?: string } = {}) => {
    const { auth = TOKEN, base = 'https://bot.example.com', ...rest } = init;
    const headers = new Headers(rest.headers);
    if (auth !== null) headers.set('authorization', `Bearer ${auth}`);
    return handleAdmin(new Request(`${base}${path}`, { ...rest, headers }), deps);
  };
  return { deps, admin, call, tenants: () => tenants };
};

describe('handleAdmin', () => {
  it('refuses requests without the token, with the wrong one, or when no long token is set', async () => {
    expect((await setup().call('/admin/tenants', { auth: null })).status).toBe(401);
    expect((await setup().call('/admin/tenants', { auth: 'b'.repeat(40) })).status).toBe(401);
    expect((await setup().call('/admin/tenants', { auth: TOKEN.slice(1) })).status).toBe(401);
    expect((await setup('').call('/admin/tenants')).status).toBe(503);
    expect((await setup('short').call('/admin/tenants', { auth: 'short' })).status).toBe(503);
  });

  it('only answers over HTTPS, except locally', async () => {
    expect((await setup().call('/admin/tenants', { base: 'http://bot.example.com' })).status).toBe(403);
    expect((await setup().call('/admin/tenants', { base: 'http://localhost:8787' })).status).toBe(200);
  });

  it('lists the communities, and never caches the answer', async () => {
    const response = await setup().call('/admin/tenants');

    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ tenants: [alpha] });
  });

  it('adds a community, and forgets what this instance had cached', async () => {
    const { call, deps, tenants } = setup();

    const response = await call('/admin/tenants/beta', { method: 'PUT', body: JSON.stringify({ guildId: '1552990539455144087', name: 'Beta' }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tenant: { id: 'beta', name: 'Beta', status: 'active' }, secretsSet: ['RCON_URL'] });
    expect(tenants().map((t) => t.id)).toEqual(['alpha', 'beta']);
    expect(deps.changed).toHaveBeenCalled();
  });

  it('refuses a community that would share a Discord server, a body that is not JSON, and one too large', async () => {
    const { call } = setup();

    expect((await call('/admin/tenants/beta', { method: 'PUT', body: JSON.stringify({ guildId: alpha.guildId }) })).status).toBe(400);
    expect((await call('/admin/tenants/beta', { method: 'PUT', body: '{nope' })).status).toBe(400);
    expect((await call('/admin/tenants/beta', { method: 'PUT', body: JSON.stringify({ name: 'x'.repeat(20_000) }) })).status).toBe(413);
  });

  it('sets secrets without sending any back', async () => {
    const { call, admin } = setup();

    const response = await call('/admin/tenants/alpha/secrets', { method: 'PUT', body: JSON.stringify({ RCON_PASSWORD: 'hunter2' }) });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(admin.saveSecrets).toHaveBeenCalledWith({ RCON_PASSWORD: 'hunter2' }, 'operator');
    expect(text).not.toContain('hunter2');
    expect((await call('/admin/tenants/alpha/secrets', { method: 'PUT', body: JSON.stringify({ RCON_PASSWORD: 5 }) })).status).toBe(400);
  });

  it('changes settings, null putting one back to its default', async () => {
    const { call, admin } = setup();

    const response = await call('/admin/tenants/alpha/settings', { method: 'PATCH', body: JSON.stringify({ LIVE_THRESHOLD: '40', SITE_URL: null }) });

    expect(response.status).toBe(200);
    expect(admin.saveSettings).toHaveBeenCalledWith({ LIVE_THRESHOLD: '40', SITE_URL: null }, 'operator');
  });

  it('tests the connection to the game server', async () => {
    const response = await setup().call('/admin/tenants/alpha/test', { method: 'POST' });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ ok: false, problem: 'RCON rejected the password (401)' });
  });

  it('deletes a community only when its id is spelled out again, suspending it before its records go', async () => {
    const { call, admin, deps, tenants } = setup();

    expect((await call('/admin/tenants/alpha', { method: 'DELETE' })).status).toBe(400);
    expect(admin.purge).not.toHaveBeenCalled();

    const response = await call('/admin/tenants/alpha?confirm=alpha', { method: 'DELETE' });

    expect(response.status).toBe(200);
    expect(deps.registry.put).toHaveBeenCalledWith('alpha', { status: 'suspended' });
    expect(deps.registry.put.mock.invocationCallOrder[0]).toBeLessThan(admin.purge.mock.invocationCallOrder[0] ?? 0);
    expect(tenants()).toEqual([]);
  });

  it('answers 404 for a community or path it does not know', async () => {
    const { call } = setup();

    expect((await call('/admin/tenants/nobody')).status).toBe(404);
    expect((await call('/admin/other')).status).toBe(404);
    expect((await call('/admin/tenants', { method: 'POST' })).status).toBe(405);
  });
});
