import { describe, expect, test, vi } from 'vitest';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createAdaptorServer } from '@hono/node-server';
import { createServer as createViteServer } from '../web/node_modules/vite/dist/node/index.js';
import webConfig from '../web/vite.config.js';
const { service } = vi.hoisted(() => ({
  service: {
    listApprovals: vi.fn(async () => []),
    listPurchaseOrders: vi.fn(async () => []),
    review: vi.fn(async (...args: unknown[]) => ({
      actor: args[1],
      status: 'approved',
    })),
    seed: vi.fn(async () => ({ environment: 'test' })),
    setBusinessContext: vi.fn(async () => ({})),
    receive: vi.fn(async () => ({ status: 'received' })),
  },
}));
vi.mock('../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => {
    const user = c.req.header('x-test-user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    c.set('user', { id: user, role: 'member' });
    return next();
  },
}));
vi.mock('../src/db.js', () => ({
  getRegisteredGroup: (jid: string) =>
    jid === 'web:alice'
      ? { created_by: 'alice', folder: 'alice', name: 'Alice' }
      : undefined,
}));
vi.mock('../src/web-context.js', () => ({
  canAccessGroup: (user: { id: string }, group: { created_by: string }) =>
    user.id === group.created_by,
}));
vi.mock('../src/ecommerce/commerce-service.js', () => ({
  getCommerceService: async () => service,
  workflowSummary: (value: unknown) => value,
}));
import routes from '../src/routes/ecommerce.js';

const root = '/workspaces/web%3Aalice';
function request(
  path: string,
  body?: unknown,
  user: string | null = 'alice',
  origin?: string,
) {
  return routes.request(root + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(user ? { 'x-test-user': user } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(origin ? { origin } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
describe('human ecommerce routes', () => {
  test('same-origin writes pass through the actual Vite proxy while foreign origins remain blocked', async () => {
    const backend = createAdaptorServer({ fetch: routes.fetch });
    backend.listen(0, '127.0.0.1');
    await once(backend, 'listening');
    const target = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
    const configuredProxy = webConfig.server!.proxy!['/api'];
    const proxyOptions =
      typeof configuredProxy === 'string'
        ? configuredProxy.replace(/https?:\/\/[^/]+/, target)
        : { ...configuredProxy, target };
    const vite = await createViteServer({
      configFile: false,
      root: process.cwd(),
      server: {
        middlewareMode: true,
        hmr: false,
        watch: null,
        proxy: { '/workspaces': proxyOptions },
      },
    });
    const frontend = createHttpServer(vite.middlewares);
    try {
      frontend.listen(0, '127.0.0.1');
      await once(frontend, 'listening');
      const frontendUrl = `http://127.0.0.1:${(frontend.address() as AddressInfo).port}`;
      for (const [origin, status] of [
        [frontendUrl, 200],
        ['https://attacker.example', 403],
      ] as const) {
        const response = await fetch(`${frontendUrl}${root}/seed`, {
          method: 'POST',
          headers: {
            origin,
            'content-type': 'application/json',
            'x-test-user': 'alice',
          },
          body: '{}',
        });
        expect({
          status: response.status,
          body: await response.json(),
        }).toEqual(
          status === 200
            ? { status: 200, body: { environment: 'test' } }
            : { status: 403, body: { error: 'cross_origin_write_rejected' } },
        );
      }
    } finally {
      await vite.close();
      await Promise.all([
        new Promise<void>((resolve, reject) =>
          frontend.close((error) => (error ? reject(error) : resolve())),
        ),
        new Promise<void>((resolve, reject) =>
          backend.close((error) => (error ? reject(error) : resolve())),
        ),
      ]);
    }
  });
  test('requires an authenticated user and an owned workspace', async () => {
    expect((await request('/approvals', undefined, null)).status).toBe(401);
    expect((await request('/approvals', undefined, 'mallory')).status).toBe(
      404,
    );
    expect((await request('/approvals')).status).toBe(200);
  });
  test('review identity is derived from the session and forged identity is rejected', async () => {
    const input = {
      expected_revision: 1,
      decision: 'approved',
      reason: 'checked test purchase',
    };
    expect(
      (
        await request('/approvals/a1/review', {
          ...input,
          reviewed_by: 'admin',
        })
      ).status,
    ).toBe(400);
    const response = await request('/approvals/a1/review', input);
    expect(response.status).toBe(200);
    expect(service.review).toHaveBeenLastCalledWith(
      'web:alice',
      'alice',
      'a1',
      1,
      'approved',
      'checked test purchase',
    );
  });
  test('rejects cross-origin writes and model-side review commands', async () => {
    expect(
      (await request('/seed', {}, 'alice', 'https://attacker.example')).status,
    ).toBe(403);
    expect(
      (
        await request('/command', {
          operation: 'review',
          approval_id: 'a1',
          decision: 'approved',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request('/command', {
          operation: 'apply',
          approval_id: 'a1',
          expected_revision: 1,
          idempotency_key: 'a',
          environment: 'prod',
        })
      ).status,
    ).toBe(400);
  });
  test('test arrival actor also comes from the human session', async () => {
    const result = await request('/purchase-orders/po1/receive', {
      idempotency_key: 'receipt-1',
    });
    expect(result.status).toBe(200);
    expect(service.receive).toHaveBeenLastCalledWith(
      'web:alice',
      'alice',
      'po1',
      'receipt-1',
    );
  });
});
