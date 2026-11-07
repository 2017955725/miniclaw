/** Authoritative, restart-safe test commerce service. No model-supplied state or identity. */
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'mysql2/promise';
import { z } from 'zod';
import { testProducts, testOrders, testCompetitors } from './test-fixture.js';
import {
  createWorkflow,
  executeDetect,
  executeInvestigate,
  executeDecide,
} from './workflow.js';
import type {
  DetectResult,
  EcommerceWorkflowState,
  MonitorResult,
} from './workflow-state.js';
import {
  createCommercePool,
  initializeCommerceSchema,
  rows,
  transaction,
  type Sql,
} from './test-db.js';

const id = z.string().trim().min(1).max(96);
const skuSchema = z.string().trim().min(1).max(80);
const revisionSchema = z.number().int().positive();
export const businessContextSchema = z
  .object({
    source: z.string().trim().min(1).max(160),
    observed_at: z.iso.datetime(),
    inventory_policy: z
      .enum(['available_net_of_reservations', 'on_hand'])
      .optional(),
    reserved_stock: z.number().int().min(0).max(1e7).optional(),
    inbound_stock: z.number().int().min(0).max(1e7).optional(),
    other_channel_reserved: z.number().int().min(0).max(1e7).optional(),
    sales_last_7d: z.number().int().min(0).max(1e7).optional(),
    supplier_id: skuSchema.optional(),
    lead_time_days: z.number().int().min(0).max(365).optional(),
  })
  .strict()
  .refine(
    (value) => Date.parse(value.observed_at) <= Date.now() + 60_000,
    'Future observation is invalid',
  );

type ProductRow = {
  sku: string;
  name: string;
  category: string | null;
  cost_cents: number;
  price_cents: number;
  stock: number;
  safety_stock: number;
  version: number;
  source: string;
  collected_at: string;
  context_json: DetectResult['business_context'] | null;
};
type WorkflowRow = { revision: number; state_json: EcommerceWorkflowState };
export type RestockSpec = {
  environment: 'test';
  sku: string;
  quantity: number;
  supplier_id: string;
  unit_cost_cents: number;
  total_cost_cents: number;
  workflow_revision: number;
  product_version: number;
};
export type ApprovalRow = {
  id: string;
  workflow_id: string;
  revision: number;
  status: string;
  spec: RestockSpec;
  history: Array<{
    actor: string;
    decision: string;
    reason: string;
    at: string;
  }>;
  created_at: string;
  expires_at: string;
};
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const now = () => new Date().toISOString();
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class CommerceService {
  constructor(readonly pool: Pool) {}
  private async product(db: Sql, workspace: string, sku: string, lock = false) {
    const [p] = await rows<ProductRow>(
      db,
      `SELECT * FROM ec_products WHERE workspace=? AND sku=?${lock ? ' FOR UPDATE' : ''}`,
      [workspace, sku],
    );
    assert(p, 'product_not_found');
    return p;
  }
  private async workflow(
    db: Sql,
    workspace: string,
    workflowId: string,
    lock = false,
  ) {
    const [w] = await rows<WorkflowRow>(
      db,
      `SELECT revision,state_json FROM ec_workflows WHERE workspace=? AND id=?${lock ? ' FOR UPDATE' : ''}`,
      [workspace, id.parse(workflowId)],
    );
    assert(w, 'workflow_not_found');
    return w;
  }
  private async approval(
    db: Sql,
    workspace: string,
    approvalId: string,
    lock = false,
  ) {
    const [a] = await rows<ApprovalRow>(
      db,
      `SELECT * FROM ec_approvals WHERE workspace=? AND id=?${lock ? ' FOR UPDATE' : ''}`,
      [workspace, id.parse(approvalId)],
    );
    assert(a, 'approval_not_found');
    return a;
  }
  private checkRevision(actual: number, expected: number) {
    assert(
      actual === revisionSchema.parse(expected),
      'revision_conflict: reload before changing state',
    );
  }
  private async save(
    db: Sql,
    workspace: string,
    w: WorkflowRow,
    state: EcommerceWorkflowState,
  ) {
    assert(
      state.evidence_chain.length <= 100,
      'workflow_history_limit: start a new investigation',
    );
    await db.execute(
      'INSERT INTO ec_workflow_versions(workspace,id,revision,state_json,created_at) VALUES(?,?,?,?,?)',
      [
        workspace,
        state.workflow_id,
        w.revision + 1,
        JSON.stringify(state),
        now(),
      ],
    );
    await db.execute(
      'UPDATE ec_workflows SET revision=revision+1,state_json=? WHERE workspace=? AND id=? AND revision=?',
      [JSON.stringify(state), workspace, state.workflow_id, w.revision],
    );
    return { revision: w.revision + 1, state };
  }
  async getWorkflow(workspace: string, workflowId: string) {
    const w = await this.workflow(this.pool, workspace, workflowId);
    return { revision: w.revision, state: w.state_json };
  }
  async workflowHistory(workspace: string, workflowId: string) {
    await this.workflow(this.pool, workspace, workflowId);
    return rows<WorkflowRow & { created_at: string }>(
      this.pool,
      'SELECT revision,state_json,created_at FROM ec_workflow_versions WHERE workspace=? AND id=? ORDER BY revision DESC LIMIT 100',
      [workspace, workflowId],
    );
  }
  async monitor(
    workspace: string,
    input: {
      sku?: string;
      category?: string;
      limit?: number;
      after_sku?: string;
    } = {},
  ): Promise<MonitorResult & { next_cursor: string | null }> {
    const query = z
      .object({
        sku: skuSchema.optional(),
        category: z.string().max(80).optional(),
        limit: z.number().int().min(1).max(100).default(25),
        after_sku: skuSchema.optional(),
      })
      .strict()
      .parse(input);
    const clauses = ['workspace=?'];
    const params: Array<string | number> = [workspace];
    if (query.sku) {
      clauses.push('sku=?');
      params.push(query.sku);
    }
    if (query.category) {
      clauses.push('category=?');
      params.push(query.category);
    }
    const [count] = await rows<{ n: number }>(
      this.pool,
      `SELECT COUNT(*) n FROM ec_products WHERE ${clauses.join(' AND ')}`,
      params,
    );
    if (query.sku) assert(Number(count.n) > 0, 'product_not_found');
    clauses.push('is_low_stock=1');
    if (query.after_sku) {
      clauses.push('sku>?');
      params.push(query.after_sku);
    }
    // LIMIT is a validated integer; mysql2/MySQL versions differ on prepared LIMIT bindings.
    const found = await rows<ProductRow>(
      this.pool,
      `SELECT sku,name,stock,safety_stock FROM ec_products WHERE ${clauses.join(' AND ')} ORDER BY sku LIMIT ${query.limit + 1}`,
      params,
    );
    const page = found.slice(0, query.limit);
    return {
      timestamp: now(),
      total_products: Number(count.n),
      next_cursor: found.length > query.limit ? page.at(-1)!.sku : null,
      low_stock_products: page.map((p) => ({
        sku: p.sku,
        name: p.name,
        stock: p.stock,
        safety_stock: p.safety_stock,
        gap: p.safety_stock - p.stock,
      })),
    };
  }
  async start(
    workspace: string,
    actor: string,
    input: {
      sku?: string;
      category?: string;
      limit?: number;
      after_sku?: string;
    },
  ) {
    const monitorResult = await this.monitor(workspace, input);
    const state = createWorkflow({
      workspaceJid: workspace,
      createdBy: actor,
      monitorResult,
    });
    if (input.sku) state.monitor!.selected_sku = input.sku;
    state.evidence_chain[0].tool_calls[0] = {
      tool: 'commerce_monitor',
      params: { ...input, environment: 'test' },
      result_summary: `范围内商品 ${monitorResult.total_products}；本页低库存 ${monitorResult.low_stock_products.length}`,
    };
    state.evidence_chain[0].conclusion =
      '按给定范围完成一次检查；不是持续后台告警。低库存结果分页，next_cursor 可继续查询。';
    await transaction(this.pool, async (db) => {
      await db.execute(
        'INSERT INTO ec_workflows(workspace,id,revision,state_json) VALUES(?,?,1,?)',
        [workspace, state.workflow_id, JSON.stringify(state)],
      );
      await db.execute(
        'INSERT INTO ec_workflow_versions(workspace,id,revision,state_json,created_at) VALUES(?,?,1,?,?)',
        [workspace, state.workflow_id, JSON.stringify(state), now()],
      );
    });
    return { revision: 1, state, next_cursor: monitorResult.next_cursor };
  }
  private async evidence(
    db: Sql,
    workspace: string,
    sku: string,
  ): Promise<DetectResult> {
    const p = await this.product(db, workspace, sku, true);
    const orders = (
      await rows<{ payload: DetectResult['orders'][number] }>(
        db,
        'SELECT payload FROM ec_orders WHERE workspace=? AND sku=? ORDER BY order_id LIMIT 101',
        [workspace, sku],
      )
    ).map((o) => o.payload);
    const competitors = (
      await rows<{ payload: DetectResult['competitors'][number] }>(
        db,
        'SELECT payload FROM ec_competitors WHERE workspace=? AND sku=? ORDER BY competitor LIMIT 51',
        [workspace, sku],
      )
    ).map((c) => c.payload);
    assert(
      orders.length <= 100 && competitors.length <= 50,
      'evidence_budget_exceeded: add an aggregate adapter instead of silently truncating evidence',
    );
    const timestamps = [
      p.collected_at,
      ...orders.map((o) => o.collected_at),
      ...competitors.map((c) => c.collected_at),
    ].sort();
    return {
      sku,
      product_version: p.version,
      product: {
        sku,
        name: p.name,
        cost_price: p.cost_cents / 100,
        selling_price: p.price_cents / 100,
        stock: p.stock,
        safety_stock: p.safety_stock,
        data_source: p.source,
        collected_at: p.collected_at,
      },
      orders,
      competitors,
      ...(p.context_json ? { business_context: p.context_json } : {}),
      collected_at_range: {
        earliest: timestamps[0],
        latest: timestamps.at(-1)!,
      },
    };
  }
  async advance(
    workspace: string,
    workflowId: string,
    expectedRevision: number,
    sku?: string,
  ) {
    return transaction(this.pool, async (db) => {
      const w = await this.workflow(db, workspace, workflowId, true);
      this.checkRevision(w.revision, expectedRevision);
      const state = w.state_json;
      let next: EcommerceWorkflowState;
      if (state.current_stage === 'monitor') {
        const target = skuSchema.parse(sku ?? state.monitor?.selected_sku);
        assert(
          !state.monitor?.selected_sku || state.monitor.selected_sku === target,
          'workflow_sku_mismatch',
        );
        next = executeDetect(
          state,
          target,
          await this.evidence(db, workspace, target),
        );
      } else if (state.current_stage === 'detect')
        next = executeInvestigate(state);
      else if (state.current_stage === 'investigate')
        next = executeDecide(state);
      else
        throw new Error('invalid_stage: completed workflows require refresh');
      return this.save(db, workspace, w, next);
    });
  }
  async refresh(
    workspace: string,
    workflowId: string,
    expectedRevision: number,
  ) {
    return transaction(this.pool, async (db) => {
      const w = await this.workflow(db, workspace, workflowId, true);
      this.checkRevision(w.revision, expectedRevision);
      const sku = w.state_json.monitor?.selected_sku;
      assert(sku, 'sku_required');
      const { detect: _d, investigate: _i, decide: _c, ...base } = w.state_json;
      const next = executeDetect(
        { ...base, current_stage: 'monitor' },
        sku,
        await this.evidence(db, workspace, sku),
      );
      await db.execute(
        "UPDATE ec_approvals SET status='superseded',revision=revision+1,history=JSON_ARRAY_APPEND(history,'$',JSON_OBJECT('actor','workflow_service','decision','superseded','reason','Workflow evidence refreshed','at',?)) WHERE workspace=? AND workflow_id=? AND status IN ('pending','approved','more_info_needed')",
        [now(), workspace, workflowId],
      );
      return this.save(db, workspace, w, next);
    });
  }
  /** Trusted human/API data supplementation, source attributed by the caller. */
  async setBusinessContext(
    workspace: string,
    actor: string,
    sku: string,
    context: unknown,
  ) {
    const parsed = businessContextSchema.parse(context);
    return transaction(this.pool, async (db) => {
      await this.product(db, workspace, skuSchema.parse(sku), true);
      const [open] = await rows<{ total: string | number }>(
        db,
        "SELECT COALESCE(SUM(quantity),0) total FROM ec_purchase_orders WHERE workspace=? AND sku=? AND status='ordered'",
        [workspace, sku],
      );
      assert(
        (parsed.inbound_stock ?? 0) >= Number(open.total),
        'inbound_below_open_purchase_orders',
      );
      const stored = {
        ...parsed,
        source: `${parsed.source}; confirmed_by=${actor}`,
      };
      await db.execute(
        'UPDATE ec_products SET context_json=?,version=version+1 WHERE workspace=? AND sku=?',
        [JSON.stringify(stored), workspace, sku],
      );
      return { sku, context: stored, requires_workflow_refresh: true };
    });
  }
  async propose(
    workspace: string,
    workflowId: string,
    expectedRevision: number,
    input: unknown,
  ) {
    const specInput = z
      .object({
        quantity: z.number().int().min(1).max(100_000),
        supplier_id: skuSchema,
        environment: z.literal('test'),
      })
      .strict()
      .parse(input);
    return transaction(this.pool, async (db) => {
      const w = await this.workflow(db, workspace, workflowId, true);
      this.checkRevision(w.revision, expectedRevision);
      assert(
        w.state_json.current_stage === 'completed',
        'workflow_not_completed',
      );
      assert(
        w.state_json.decide?.decide_result.recommendations.some(
          (r) => r.action === 'consider_restock',
        ),
        'restock_not_recommended',
      );
      const p = await this.product(
        db,
        workspace,
        w.state_json.detect!.sku,
        true,
      );
      const evidence = w.state_json.detect!.detect_result;
      assert(
        evidence.product_version === p.version &&
          evidence.product.collected_at === p.collected_at &&
          hash(evidence.business_context ?? null) === hash(p.context_json),
        'stale_evidence: refresh workflow',
      );
      assert(
        Date.now() - Date.parse(p.collected_at) < 86_400_000,
        'stale_product: refresh source data',
      );
      const ctx = p.context_json;
      assert(
        ctx && Date.now() - Date.parse(ctx.observed_at) < 86_400_000,
        'fresh_business_context_required',
      );
      assert(
        ctx.inventory_policy &&
          (ctx.inventory_policy !== 'on_hand' ||
            ctx.reserved_stock !== undefined) &&
          ctx.inbound_stock !== undefined &&
          ctx.other_channel_reserved !== undefined &&
          ctx.sales_last_7d !== undefined &&
          ctx.lead_time_days !== undefined,
        'business_inputs_missing',
      );
      assert(ctx.supplier_id === specInput.supplier_id, 'supplier_mismatch');
      const spec: RestockSpec = {
        ...specInput,
        sku: p.sku,
        unit_cost_cents: p.cost_cents,
        total_cost_cents: p.cost_cents * specInput.quantity,
        workflow_revision: w.revision,
        product_version: p.version,
      };
      assert(spec.total_cost_cents <= 100_000_000, 'test_budget_exceeded');
      const approvalId = `ec_ap_${randomUUID()}`;
      const created = now();
      const expires = new Date(Date.now() + 30 * 60_000).toISOString();
      await db.execute(
        "INSERT INTO ec_approvals(workspace,id,workflow_id,status,spec,history,created_at,expires_at) VALUES(?,?,?,'pending',?,'[]',?,?)",
        [
          workspace,
          approvalId,
          workflowId,
          JSON.stringify(spec),
          created,
          expires,
        ],
      );
      return this.approval(db, workspace, approvalId);
    });
  }
  async listApprovals(workspace: string) {
    return rows<ApprovalRow>(
      this.pool,
      'SELECT * FROM ec_approvals WHERE workspace=? ORDER BY created_at DESC,id LIMIT 100',
      [workspace],
    );
  }
  async listPurchaseOrders(workspace: string) {
    return rows<{
      id: string;
      sku: string;
      quantity: number;
      supplier_id: string;
      status: string;
      cost_cents: number;
    }>(
      this.pool,
      'SELECT id,sku,quantity,supplier_id,status,cost_cents FROM ec_purchase_orders WHERE workspace=? ORDER BY created_at DESC,id LIMIT 100',
      [workspace],
    );
  }
  async preview(workspace: string, approvalId: string) {
    const a = await this.approval(this.pool, workspace, approvalId);
    return {
      mode: 'dry_run',
      environment: 'test',
      preview_only: true,
      database_write_performed: false,
      approval: a,
      effect:
        'Creates purchase order; stock changes ONLY on a separate test goods receipt.',
    };
  }
  /** Called ONLY from authenticated human HTTP routes, never from model dispatch. */
  async review(
    workspace: string,
    actor: string,
    approvalId: string,
    expectedRevision: number,
    decision: string,
    reason: string,
  ) {
    const input = z
      .object({
        decision: z.enum(['approved', 'rejected', 'more_info_needed']),
        reason: z.string().trim().min(1).max(1000),
      })
      .parse({ decision, reason });
    const first = await this.approval(this.pool, workspace, approvalId);
    return transaction(this.pool, async (db) => {
      const w = await this.workflow(db, workspace, first.workflow_id, true);
      const a = await this.approval(db, workspace, approvalId, true);
      this.checkRevision(a.revision, expectedRevision);
      assert(
        ['pending', 'more_info_needed'].includes(a.status),
        'invalid_approval_transition',
      );
      assert(
        a.spec.workflow_revision === w.revision && a.expires_at > now(),
        'approval_stale_or_expired',
      );
      const history = [...a.history, { actor, ...input, at: now() }];
      await db.execute(
        'UPDATE ec_approvals SET status=?,revision=revision+1,history=? WHERE workspace=? AND id=?',
        [input.decision, JSON.stringify(history), workspace, approvalId],
      );
      return this.approval(db, workspace, approvalId);
    });
  }
  async apply(
    workspace: string,
    approvalId: string,
    expectedRevision: number,
    key: string,
    environment: string,
  ) {
    assert(
      environment === 'test',
      'environment_disabled: production execution is not implemented',
    );
    id.parse(key);
    revisionSchema.parse(expectedRevision);
    const first = await this.approval(this.pool, workspace, approvalId);
    const fingerprint = hash({ approvalId, expectedRevision, environment });
    return transaction(this.pool, async (db) => {
      const w = await this.workflow(db, workspace, first.workflow_id, true);
      const a = await this.approval(db, workspace, approvalId, true);
      const [previous] = await rows<{
        fingerprint: string;
        result_json: Record<string, unknown>;
      }>(
        db,
        'SELECT fingerprint,result_json FROM ec_executions WHERE workspace=? AND request_key=?',
        [workspace, key],
      );
      if (previous) {
        assert(previous.fingerprint === fingerprint, 'idempotency_conflict');
        return previous.result_json;
      }
      const [already] = await rows<{
        result_json: Record<string, unknown>;
        fingerprint: string;
      }>(
        db,
        'SELECT result_json,fingerprint FROM ec_executions WHERE workspace=? AND approval_id=?',
        [workspace, approvalId],
      );
      if (already)
        throw new Error(
          'approval_already_executed: retry using the original idempotency key',
        );
      this.checkRevision(a.revision, expectedRevision);
      assert(a.status === 'approved', 'human_approval_required');
      assert(
        a.spec.workflow_revision === w.revision && a.expires_at > now(),
        'approval_stale_or_expired',
      );
      const p = await this.product(db, workspace, a.spec.sku, true);
      assert(
        p.version === a.spec.product_version,
        'stale_product_version: refresh and approve a new proposal',
      );
      assert(
        Date.now() - Date.parse(p.collected_at) < 86_400_000 &&
          p.context_json &&
          Date.now() - Date.parse(p.context_json.observed_at) < 86_400_000,
        'stale_source_data',
      );
      const purchaseOrderId = `ec_po_${randomUUID()}`;
      await db.execute(
        "INSERT INTO ec_purchase_orders(workspace,id,approval_id,sku,quantity,cost_cents,supplier_id,status,created_at) VALUES(?,?,?,?,?,?,?,'ordered',?)",
        [
          workspace,
          purchaseOrderId,
          approvalId,
          a.spec.sku,
          a.spec.quantity,
          a.spec.total_cost_cents,
          a.spec.supplier_id,
          now(),
        ],
      );
      // Inbound is live business state and must move atomically with the purchase order.
      const context = {
        ...p.context_json,
        inbound_stock: (p.context_json?.inbound_stock ?? 0) + a.spec.quantity,
      };
      await db.execute(
        'UPDATE ec_products SET context_json=?,version=version+1 WHERE workspace=? AND sku=?',
        [JSON.stringify(context), workspace, p.sku],
      );
      const result = {
        mode: 'apply',
        environment: 'test',
        status: 'purchase_order_created',
        purchase_order_id: purchaseOrderId,
        sku: p.sku,
        quantity: a.spec.quantity,
        stock: p.stock,
        test_database_write_performed: true,
        production_write_performed: false,
      };
      await db.execute(
        'INSERT INTO ec_executions(workspace,request_key,approval_id,fingerprint,result_json) VALUES(?,?,?,?,?)',
        [workspace, key, approvalId, fingerprint, JSON.stringify(result)],
      );
      await db.execute(
        "UPDATE ec_approvals SET status='executed',revision=revision+1,history=JSON_ARRAY_APPEND(history,'$',JSON_OBJECT('actor','controlled_test_service','decision','executed','reason',?,'at',?)) WHERE workspace=? AND id=?",
        [purchaseOrderId, now(), workspace, approvalId],
      );
      return result;
    });
  }
  /** Test arrival event. Not exposed as an autonomous model tool. Full receipt only. */
  async receive(
    workspace: string,
    actor: string,
    purchaseOrderId: string,
    key: string,
  ) {
    id.parse(purchaseOrderId);
    id.parse(key);
    return transaction(this.pool, async (db) => {
      const [po] = await rows<{
        sku: string;
        quantity: number;
        status: string;
      }>(
        db,
        'SELECT * FROM ec_purchase_orders WHERE workspace=? AND id=? FOR UPDATE',
        [workspace, purchaseOrderId],
      );
      assert(po, 'purchase_order_not_found');
      const [previous] = await rows<{
        purchase_order_id: string;
        result_json: Record<string, unknown>;
      }>(
        db,
        'SELECT purchase_order_id,result_json FROM ec_receipts WHERE workspace=? AND request_key=?',
        [workspace, key],
      );
      if (previous) {
        assert(
          previous.purchase_order_id === purchaseOrderId,
          'idempotency_conflict',
        );
        return previous.result_json;
      }
      const [already] = await rows<{ result_json: Record<string, unknown> }>(
        db,
        'SELECT result_json FROM ec_receipts WHERE workspace=? AND purchase_order_id=?',
        [workspace, purchaseOrderId],
      );
      if (already)
        throw new Error(
          'purchase_order_already_received: retry using the original idempotency key',
        );
      assert(po.status === 'ordered', 'invalid_purchase_order_status');
      const p = await this.product(db, workspace, po.sku, true);
      const stock = p.stock + po.quantity;
      assert(stock <= 10_000_000, 'inventory_limit_exceeded');
      assert(
        p.context_json && (p.context_json.inbound_stock ?? 0) >= po.quantity,
        'inbound_inventory_inconsistent',
      );
      const context = {
        ...p.context_json,
        inbound_stock: p.context_json.inbound_stock! - po.quantity,
      };
      await db.execute(
        'UPDATE ec_products SET stock=?,version=version+1,collected_at=?,context_json=? WHERE workspace=? AND sku=?',
        [stock, now(), JSON.stringify(context), workspace, po.sku],
      );
      await db.execute(
        "UPDATE ec_purchase_orders SET status='received' WHERE workspace=? AND id=?",
        [workspace, purchaseOrderId],
      );
      const ledgerId = `ec_il_${randomUUID()}`;
      await db.execute(
        'INSERT INTO ec_inventory_ledger(workspace,id,purchase_order_id,sku,delta,stock_before,stock_after,actor,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        [
          workspace,
          ledgerId,
          purchaseOrderId,
          po.sku,
          po.quantity,
          p.stock,
          stock,
          actor,
          now(),
        ],
      );
      const result = {
        status: 'received',
        environment: 'test',
        purchase_order_id: purchaseOrderId,
        sku: po.sku,
        stock_before: p.stock,
        stock_after: stock,
        ledger_id: ledgerId,
        test_database_write_performed: true,
      };
      await db.execute(
        'INSERT INTO ec_receipts(workspace,request_key,purchase_order_id,result_json) VALUES(?,?,?,?)',
        [workspace, key, purchaseOrderId, JSON.stringify(result)],
      );
      return result;
    });
  }
  /** Explicit fixture import, insert-only. Never resets stock of existing products. */
  async seed(workspace: string) {
    return transaction(this.pool, async (db) => {
      const timestamp = now();
      for (const p of testProducts)
        await db.execute(
          'INSERT IGNORE INTO ec_products(workspace,sku,name,category,cost_cents,price_cents,stock,safety_stock,source,collected_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
          [
            workspace,
            p.sku,
            p.name,
            p.category ?? null,
            Math.round(p.cost_price * 100),
            Math.round(p.selling_price * 100),
            p.stock,
            p.safety_stock,
            'local_test_fixture',
            timestamp,
          ],
        );
      for (const o of testOrders)
        await db.execute(
          'INSERT IGNORE INTO ec_orders(workspace,order_id,sku,payload) VALUES(?,?,?,?)',
          [
            workspace,
            o.order_id,
            o.sku,
            JSON.stringify({
              ...o,
              data_source: 'local_test_fixture',
              collected_at: timestamp,
            }),
          ],
        );
      for (const c of testCompetitors)
        await db.execute(
          'INSERT IGNORE INTO ec_competitors(workspace,sku,competitor,payload) VALUES(?,?,?,?)',
          [
            workspace,
            c.sku,
            c.competitor_name,
            JSON.stringify({
              ...c,
              data_source: 'local_test_fixture',
              collected_at: timestamp,
            }),
          ],
        );
      return {
        environment: 'test',
        source: 'local_test_fixture',
        import_mode: 'insert_missing_only',
        business_context: 'not fabricated; supply explicitly',
      };
    });
  }
}

let configured: Promise<CommerceService> | undefined;
export function getCommerceService(): Promise<CommerceService> {
  return (configured ??= (async () => {
    const pool = createCommercePool();
    try {
      await initializeCommerceSchema(pool);
      return new CommerceService(pool);
    } catch (error) {
      await pool.end();
      configured = undefined;
      throw error;
    }
  })().catch((error) => {
    configured = undefined;
    throw error;
  }));
}

/** Compact model view: authoritative full evidence stays in MySQL and authenticated UI. */
export function workflowSummary(result: {
  revision: number;
  state: EcommerceWorkflowState;
  next_cursor?: string | null;
}) {
  const s = result.state;
  return {
    workflow_id: s.workflow_id,
    revision: result.revision,
    current_stage: s.current_stage,
    sku: s.monitor?.selected_sku,
    monitor: s.monitor?.monitor_result,
    analysis: s.investigate?.investigate_result,
    recommendations: s.decide?.decide_result.recommendations,
    product: s.detect?.detect_result.product,
    evidence_count: s.evidence_chain.length,
    evidence_time_range: s.detect?.detect_result.collected_at_range,
    next_cursor: result.next_cursor,
    evidence_detail:
      'Full evidence available through authenticated workflow view; never substitute memory for live stock.',
  };
}
