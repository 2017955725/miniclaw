import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Pool } from 'mysql2/promise';
import {
  createCommercePool,
  initializeCommerceSchema,
  rows,
} from '../src/ecommerce/test-db.js';
import { CommerceService } from '../src/ecommerce/commerce-service.js';

const configPath = new URL(
  '../data/ecommerce-local/connection.json',
  import.meta.url,
);
const url: string | undefined =
  process.env.MINICLAW_ECOMMERCE_TEST_URL ??
  (fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, 'utf8')).url
    : undefined);
// Missing infrastructure is an explicit skip, never an in-memory fake success.
describe.skipIf(!url)('local MySQL commerce integration', () => {
  let pool: Pool;
  let service: CommerceService;
  const workspaces: string[] = [];
  const context = () => ({
    source: 'explicit_integration_test_parameters',
    observed_at: new Date().toISOString(),
    inventory_policy: 'on_hand',
    reserved_stock: 0,
    inbound_stock: 0,
    other_channel_reserved: 0,
    sales_last_7d: 35,
    supplier_id: 'DEMO-SUPPLIER',
    lead_time_days: 3,
  });
  async function fixture(withContext = true) {
    const workspace = `test:${randomUUID()}`;
    workspaces.push(workspace);
    await service.seed(workspace);
    if (withContext)
      await service.setBusinessContext(
        workspace,
        'human-test',
        'SKU-002',
        context(),
      );
    let w = await service.start(workspace, 'human-test', { sku: 'SKU-002' });
    let advanced = await service.advance(
      workspace,
      w.state.workflow_id,
      w.revision,
    );
    advanced = await service.advance(
      workspace,
      w.state.workflow_id,
      advanced.revision,
    );
    advanced = await service.advance(
      workspace,
      w.state.workflow_id,
      advanced.revision,
    );
    return { workspace, ...advanced };
  }
  async function proposal(
    workspace: string,
    workflowId: string,
    revision: number,
  ) {
    return service.propose(workspace, workflowId, revision, {
      quantity: 70,
      supplier_id: 'DEMO-SUPPLIER',
      environment: 'test',
    });
  }
  beforeAll(async () => {
    pool = createCommercePool(url);
    await initializeCommerceSchema(pool);
    service = new CommerceService(pool);
  });
  afterAll(async () => {
    for (const workspace of workspaces)
      for (const table of [
        'ec_inventory_ledger',
        'ec_receipts',
        'ec_purchase_orders',
        'ec_executions',
        'ec_approvals',
        'ec_workflow_versions',
        'ec_workflows',
        'ec_competitors',
        'ec_orders',
        'ec_products',
      ])
        await pool.execute(`DELETE FROM ${table} WHERE workspace=?`, [
          workspace,
        ]);
    await pool?.end();
  });
  test('SKU scope, indexed low-stock pagination and tenant isolation', async () => {
    const f = await fixture();
    expect(
      (await service.monitor(f.workspace, { sku: 'SKU-002' })).total_products,
    ).toBe(1);
    expect(
      (await service.monitor(f.workspace, { sku: 'SKU-001' }))
        .low_stock_products,
    ).toEqual([]);
    const page = await service.monitor(f.workspace, { limit: 1 });
    expect(page.low_stock_products[0].sku).toBe('SKU-002');
    expect(page.next_cursor).toBe('SKU-002');
    expect(
      (
        await service.monitor(f.workspace, {
          limit: 1,
          after_sku: page.next_cursor!,
        })
      ).low_stock_products[0].sku,
    ).toBe('SKU-005');
    await expect(
      service.getWorkflow('other-workspace', f.state.workflow_id),
    ).rejects.toThrow('workflow_not_found');
    await expect(
      service.monitor(f.workspace, { sku: "' OR 1=1 --" }),
    ).rejects.toThrow('product_not_found');
  });
  test('authoritative workflow survives a new service connection and rejects outdated transitions', async () => {
    const f = await fixture();
    await expect(
      service.advance(f.workspace, f.state.workflow_id, 1),
    ).rejects.toThrow('revision_conflict');
    const restartedPool = createCommercePool(url);
    try {
      const restored = await new CommerceService(restartedPool).getWorkflow(
        f.workspace,
        f.state.workflow_id,
      );
      expect(restored.revision).toBe(4);
      expect(restored.state.current_stage).toBe('completed');
      expect(restored.state.evidence_chain).toHaveLength(4);
      const history = await service.workflowHistory(
        f.workspace,
        f.state.workflow_id,
      );
      expect(history.map((h) => h.revision)).toEqual([4, 3, 2, 1]);
      expect(history.at(-1)!.state_json.current_stage).toBe('monitor');
    } finally {
      await restartedPool.end();
    }
  });
  test('missing data blocks proposal; human supplementation and refresh resume the same task', async () => {
    const f = await fixture(false);
    await expect(
      proposal(f.workspace, f.state.workflow_id, f.revision),
    ).rejects.toThrow('fresh_business_context_required');
    const before = f.state.investigate!.investigate_result.unknowns;
    await service.setBusinessContext(
      f.workspace,
      'human-test',
      'SKU-002',
      context(),
    );
    let refreshed = await service.refresh(
      f.workspace,
      f.state.workflow_id,
      f.revision,
    );
    refreshed = await service.advance(
      f.workspace,
      f.state.workflow_id,
      refreshed.revision,
    );
    refreshed = await service.advance(
      f.workspace,
      f.state.workflow_id,
      refreshed.revision,
    );
    expect(refreshed.state.workflow_id).toBe(f.state.workflow_id);
    expect(
      refreshed.state.investigate!.investigate_result.unknowns.length,
    ).toBeLessThan(before.length);
    expect(
      (await proposal(f.workspace, f.state.workflow_id, refreshed.revision))
        .status,
    ).toBe('pending');
  });
  test('dry-run is read-only, human approval is mandatory and simultaneous reviews conflict', async () => {
    const f = await fixture();
    const a = await proposal(f.workspace, f.state.workflow_id, f.revision);
    const preview = await service.preview(f.workspace, a.id);
    expect(preview.database_write_performed).toBe(false);
    await expect(
      service.apply(f.workspace, a.id, a.revision, 'unapproved', 'test'),
    ).rejects.toThrow('human_approval_required');
    expect(await service.listPurchaseOrders(f.workspace)).toEqual([]);
    const reviews = await Promise.allSettled([
      service.review(
        f.workspace,
        'alice',
        a.id,
        1,
        'approved',
        'confirmed test purchase',
      ),
      service.review(
        f.workspace,
        'bob',
        a.id,
        1,
        'rejected',
        'competing old review',
      ),
    ]);
    expect(reviews.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(reviews.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
  test('real test writes, concurrent retries, restart recovery and receipt idempotency', async () => {
    const f = await fixture();
    const observedAt =
      f.state.detect!.detect_result.business_context!.observed_at;
    const a = await proposal(f.workspace, f.state.workflow_id, f.revision);
    const approved = await service.review(
      f.workspace,
      'human-test',
      a.id,
      1,
      'approved',
      'explicit test quantity 70',
    );
    const [one, two] = await Promise.all([
      service.apply(
        f.workspace,
        a.id,
        approved.revision,
        'purchase-key',
        'test',
      ),
      service.apply(
        f.workspace,
        a.id,
        approved.revision,
        'purchase-key',
        'test',
      ),
    ]);
    expect(one).toEqual(two);
    expect(one.stock).toBe(80);
    expect(await service.listPurchaseOrders(f.workspace)).toHaveLength(1);
    await expect(
      service.setBusinessContext(
        f.workspace,
        'human-test',
        'SKU-002',
        context(),
      ),
    ).rejects.toThrow('inbound_below_open_purchase_orders');
    await expect(
      service.apply(
        f.workspace,
        a.id,
        approved.revision,
        'different-key',
        'test',
      ),
    ).rejects.toThrow('approval_already_executed');
    await expect(
      service.apply(
        f.workspace,
        a.id,
        approved.revision + 1,
        'purchase-key',
        'test',
      ),
    ).rejects.toThrow('idempotency_conflict');
    const reopenedPool = createCommercePool(url);
    try {
      const reopened = new CommerceService(reopenedPool);
      expect(
        await reopened.apply(
          f.workspace,
          a.id,
          approved.revision,
          'purchase-key',
          'test',
        ),
      ).toEqual(one);
    } finally {
      await reopenedPool.end();
    }
    const purchaseOrderId = String(one.purchase_order_id);
    const [receipt, again] = await Promise.all([
      service.receive(
        f.workspace,
        'warehouse-test',
        purchaseOrderId,
        'receipt-key',
      ),
      service.receive(
        f.workspace,
        'warehouse-test',
        purchaseOrderId,
        'receipt-key',
      ),
    ]);
    expect(receipt).toEqual(again);
    expect(receipt.stock_before).toBe(80);
    expect(receipt.stock_after).toBe(150);
    await expect(
      service.receive(
        f.workspace,
        'warehouse-test',
        purchaseOrderId,
        'new-receipt-key',
      ),
    ).rejects.toThrow('already_received');
    const [p] = await rows<{
      stock: number;
      context_json: { inbound_stock: number; observed_at: string };
    }>(
      pool,
      'SELECT stock,context_json FROM ec_products WHERE workspace=? AND sku=?',
      [f.workspace, 'SKU-002'],
    );
    expect(p.stock).toBe(150);
    expect(p.context_json.inbound_stock).toBe(0);
    // Procurement/receipt must not make historical sales or supplier data fresh again.
    expect(p.context_json.observed_at).toBe(observedAt);
    const [ledger] = await rows<{ n: number }>(
      pool,
      'SELECT COUNT(*) n FROM ec_inventory_ledger WHERE workspace=?',
      [f.workspace],
    );
    expect(Number(ledger.n)).toBe(1);
  });
  test('changed business data, refreshed workflows, expired approval and production mode cannot execute', async () => {
    const f = await fixture();
    const a = await proposal(f.workspace, f.state.workflow_id, f.revision);
    const approved = await service.review(
      f.workspace,
      'human-test',
      a.id,
      1,
      'approved',
      'test',
    );
    await expect(
      service.apply(
        f.workspace,
        a.id,
        approved.revision,
        'prod-attempt',
        'prod',
      ),
    ).rejects.toThrow('environment_disabled');
    await service.setBusinessContext(f.workspace, 'human-test', 'SKU-002', {
      ...context(),
      inbound_stock: 5,
    });
    await expect(
      service.apply(
        f.workspace,
        a.id,
        approved.revision,
        'changed-data',
        'test',
      ),
    ).rejects.toThrow('stale_product_version');
    await service.refresh(f.workspace, f.state.workflow_id, f.revision);
    expect((await service.listApprovals(f.workspace))[0].status).toBe(
      'superseded',
    );
    const fresh = await fixture();
    const a2 = await proposal(
      fresh.workspace,
      fresh.state.workflow_id,
      fresh.revision,
    );
    const approved2 = await service.review(
      fresh.workspace,
      'human-test',
      a2.id,
      1,
      'approved',
      'test',
    );
    await pool.execute(
      'UPDATE ec_approvals SET expires_at=? WHERE workspace=? AND id=?',
      ['2020-01-01T00:00:00.000Z', fresh.workspace, a2.id],
    );
    await expect(
      service.apply(
        fresh.workspace,
        a2.id,
        approved2.revision,
        'expired',
        'test',
      ),
    ).rejects.toThrow('expired');
  });
  test('a failed commit rolls back the purchase order and inbound inventory together', async () => {
    const f = await fixture();
    const a = await proposal(f.workspace, f.state.workflow_id, f.revision);
    const approved = await service.review(
      f.workspace,
      'human-test',
      a.id,
      1,
      'approved',
      'test',
    );
    // Force a failure after the purchase order and product update, at execution-record insertion.
    const original = pool.getConnection.bind(pool);
    const fakePool = {
      getConnection: async () => {
        const connection = await original();
        const execute = connection.execute.bind(connection);
        return new Proxy(connection, {
          get(target, property) {
            if (property === 'execute')
              return (sql: string, params: unknown[]) => {
                if (sql.startsWith('INSERT INTO ec_executions'))
                  throw new Error('injected_write_failure');
                return execute(sql, params as never);
              };
            const value = Reflect.get(target, property);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
      execute: pool.execute.bind(pool),
    } as unknown as Pool;
    await expect(
      new CommerceService(fakePool).apply(
        f.workspace,
        a.id,
        approved.revision,
        'rollback',
        'test',
      ),
    ).rejects.toThrow('injected_write_failure');
    expect(await service.listPurchaseOrders(f.workspace)).toEqual([]);
    const [p] = await rows<{ context_json: { inbound_stock: number } }>(
      pool,
      'SELECT context_json FROM ec_products WHERE workspace=? AND sku=?',
      [f.workspace, 'SKU-002'],
    );
    expect(p.context_json.inbound_stock).toBe(0);
    expect((await service.listApprovals(f.workspace))[0].status).toBe(
      'approved',
    );
  });
});
