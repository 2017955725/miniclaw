import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { getRegisteredGroup } from '../db.js';
import { canAccessGroup, type Variables } from '../web-context.js';
import { getCommerceService } from '../ecommerce/commerce-service.js';
import { dispatchCommerceCommand } from '../ecommerce/agent-dispatch.js';

const routes = new Hono<{ Variables: Variables }>();
routes.use('*', authMiddleware);
routes.use('*', bodyLimit({ maxSize: 32 * 1024 }));
routes.use('/workspaces/:workspace/*', async (c, next) => {
  const workspace = c.req.param('workspace');
  const group = workspace ? getRegisteredGroup(workspace) : undefined;
  if (!group || !canAccessGroup(c.get('user'), { ...group, jid: workspace! }))
    return c.json({ error: 'workspace_not_found' }, 404);
  if (c.req.method !== 'GET') {
    const origin = c.req.header('origin');
    if (origin && new URL(origin).host !== new URL(c.req.url).host)
      return c.json({ error: 'cross_origin_write_rejected' }, 403);
    if (!c.req.header('content-type')?.startsWith('application/json'))
      return c.json({ error: 'json_body_required' }, 415);
  }
  await next();
});
routes.onError((error, c) => {
  if (error instanceof z.ZodError)
    return c.json({ error: 'invalid_request', details: error.issues }, 400);
  const message = error.message;
  const code = message.split(':')[0];
  if (code === 'ecommerce_not_configured')
    return c.json({ error: code, message }, 503);
  if (/not_found$/.test(code)) return c.json({ error: code }, 404);
  if (/conflict|stale|expired|already_executed/.test(code))
    return c.json({ error: code, message }, 409);
  if (/^[a-z_]+$/.test(code)) return c.json({ error: code, message }, 400);
  return c.json({ error: 'commerce_request_failed' }, 500);
});

routes.get('/workspaces/:workspace/approvals', async (c) =>
  c.json(
    await (await getCommerceService()).listApprovals(c.req.param('workspace')),
  ),
);
routes.get('/workspaces/:workspace/purchase-orders', async (c) =>
  c.json(
    await (
      await getCommerceService()
    ).listPurchaseOrders(c.req.param('workspace')),
  ),
);
routes.get('/workspaces/:workspace/workflows/:id', async (c) =>
  c.json(
    await (
      await getCommerceService()
    ).getWorkflow(c.req.param('workspace'), c.req.param('id')),
  ),
);
routes.get('/workspaces/:workspace/workflows/:id/history', async (c) =>
  c.json(
    await (
      await getCommerceService()
    ).workflowHistory(c.req.param('workspace'), c.req.param('id')),
  ),
);
routes.post('/workspaces/:workspace/command', async (c) =>
  c.json(
    await dispatchCommerceCommand(
      c.req.param('workspace'),
      c.get('user').id,
      await c.req.json(),
    ),
  ),
);
routes.post('/workspaces/:workspace/seed', async (c) =>
  c.json(await (await getCommerceService()).seed(c.req.param('workspace'))),
);
routes.post('/workspaces/:workspace/products/:sku/context', async (c) =>
  c.json(
    await (
      await getCommerceService()
    ).setBusinessContext(
      c.req.param('workspace'),
      c.get('user').id,
      c.req.param('sku'),
      await c.req.json(),
    ),
  ),
);
routes.post('/workspaces/:workspace/approvals/:id/review', async (c) => {
  const body = z
    .object({
      expected_revision: z.number().int().positive(),
      decision: z.enum(['approved', 'rejected', 'more_info_needed']),
      reason: z.string().trim().min(1).max(1000),
    })
    .strict()
    .parse(await c.req.json());
  return c.json(
    await (
      await getCommerceService()
    ).review(
      c.req.param('workspace'),
      c.get('user').id,
      c.req.param('id'),
      body.expected_revision,
      body.decision,
      body.reason,
    ),
  );
});
routes.post('/workspaces/:workspace/purchase-orders/:id/receive', async (c) => {
  const body = z
    .object({ idempotency_key: z.string().min(1).max(96) })
    .strict()
    .parse(await c.req.json());
  return c.json(
    await (
      await getCommerceService()
    ).receive(
      c.req.param('workspace'),
      c.get('user').id,
      c.req.param('id'),
      body.idempotency_key,
    ),
  );
});
export default routes;
