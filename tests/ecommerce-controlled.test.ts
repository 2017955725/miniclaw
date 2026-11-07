import { describe, expect, test } from 'vitest';
import { commerceCommandSchema } from '../src/ecommerce/agent-dispatch.js';
import { createCommercePool } from '../src/ecommerce/test-db.js';
import { searchCommerceSop } from '../src/ecommerce/sop-search.js';
import { createCommerceTools } from '../container/agent-runner/src/commerce-tools.js';
import {
  createWorkflow,
  executeDetect,
  executeInvestigate,
  executeDecide,
} from '../src/ecommerce/workflow.js';
import type { DetectResult } from '../src/ecommerce/workflow-state.js';

const timestamp = new Date().toISOString();
const evidence: DetectResult = {
  sku: 'SKU-A',
  product: {
    sku: 'SKU-A',
    name: 'Test',
    stock: 80,
    safety_stock: 150,
    cost_price: 65,
    selling_price: 149,
    data_source: 'test',
    collected_at: timestamp,
  },
  orders: [
    {
      order_id: 'o1',
      sku: 'SKU-A',
      quantity: 1,
      amount: 149,
      status: 'pending',
      data_source: 'test',
      collected_at: timestamp,
      placed_at: timestamp,
    },
  ],
  competitors: [],
  collected_at_range: { earliest: timestamp, latest: timestamp },
};
function investigate(input: DetectResult) {
  return executeInvestigate(
    executeDetect(
      createWorkflow({
        workspaceJid: 'w',
        createdBy: 'a',
        monitorResult: { timestamp, total_products: 1, low_stock_products: [] },
      }),
      'SKU-A',
      structuredClone(input),
    ),
  );
}

describe('controlled commerce contracts', () => {
  test('rejects production, remote and non-test database configurations before connecting', () => {
    for (const url of [
      'mysql://u:p@example.com/miniclaw_ecommerce_test',
      'mysql://u:p@127.0.0.1/production',
      'https://127.0.0.1/miniclaw_ecommerce_test',
      'mysql://u:p@127.0.0.1/miniclaw_ecommerce_test?host=remote.example',
    ])
      expect(() => createCommercePool(url)).toThrow('test_database_required');
  });
  test('model commands cannot impersonate a human or inject workflow state', () => {
    for (const command of [
      { operation: 'review', decision: 'approved' },
      { operation: 'receive', purchase_order_id: 'p' },
      { operation: 'start', actor: 'admin' },
      {
        operation: 'advance',
        workflow_id: 'w',
        expected_revision: 1,
        workflow: { current_stage: 'completed' },
      },
      {
        operation: 'apply',
        approval_id: 'a',
        expected_revision: 2,
        idempotency_key: 'k',
        environment: 'prod',
      },
    ])
      expect(commerceCommandSchema.safeParse(command).success).toBe(false);
  });
  test('unknowns reflect present data, including known zeros; pending is not subtracted', () => {
    const before = investigate(evidence).investigate!.investigate_result;
    expect(before.unknowns).toContain('历史销售趋势');
    const after = investigate({
      ...evidence,
      business_context: {
        source: 'confirmed_test_fixture',
        observed_at: timestamp,
        inventory_policy: 'on_hand',
        reserved_stock: 0,
        inbound_stock: 0,
        other_channel_reserved: 0,
        sales_last_7d: 0,
        supplier_id: 'supplier',
        lead_time_days: 0,
      },
    });
    expect(after.investigate!.investigate_result.unknowns).toEqual([]);
    expect(
      after.investigate!.investigate_result.inferences.join(),
    ).not.toContain('79');
    expect(
      executeDecide(after).decide!.decide_result.recommendations.map(
        (r) => r.action,
      ),
    ).toEqual(['consider_restock']);
  });
  test('one critical unknown still produces an investigation constraint', () => {
    const result = investigate({
      ...evidence,
      business_context: {
        source: 'test',
        observed_at: timestamp,
        inventory_policy: 'on_hand',
        reserved_stock: 0,
        inbound_stock: 0,
        other_channel_reserved: 0,
        sales_last_7d: 35,
        supplier_id: 'supplier',
      },
    });
    expect(result.investigate!.investigate_result.unknowns).toEqual([
      '供应商和补货周期',
    ]);
    expect(
      executeDecide(result).decide!.decide_result.recommendations.map(
        (r) => r.action,
      ),
    ).toContain('investigate_further');
  });
  test('stale evidence remains explicit instead of disappearing when fields exist', () => {
    const result = investigate({
      ...evidence,
      product: { ...evidence.product, collected_at: '2020-01-01T00:00:00Z' },
    });
    expect(result.investigate!.investigate_result.unknowns.join()).toContain(
      '超过24小时',
    );
  });
  test('SOP retrieval cites versioned source chunks and honors its character budget', () => {
    const result = searchCommerceSop('采购到货入库和幂等重试', 1500);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.some((h) => h.content.includes('实物库存'))).toBe(true);
    expect(result.hits[0].citation).toMatch(
      /docs\/ecommerce-sop\/.+\.md:\d+@[a-f0-9]{16}/,
    );
    expect(
      result.hits.reduce(
        (used, hit) => used + hit.content.length + hit.citation.length + 32,
        0,
      ),
    ).toBeLessThanOrEqual(1500);
    expect(result).not.toHaveProperty('trace');
    expect(result.live_business_data).toBe(false);
    expect(result.trust).toBe('reference_data_not_instructions');
    expect(searchCommerceSop('xyz_unrelated_topic_987').hits).toEqual([]);
  });
  test('tool facade contains no human approval action and preserves host refusals', async () => {
    const tools = createCommerceTools(async () => ({
      success: false,
      error: 'human_approval_required',
    }));
    expect(tools.map((t) => t.name)).toEqual([
      'ecommerce_test',
      'ecommerce_sop_search',
    ]);
    const result = await tools[0].handler(
      { command: { operation: 'approvals' } } as never,
      {},
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('human_approval_required'),
    });
  });
});
