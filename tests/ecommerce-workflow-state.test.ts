import { describe, expect, test } from 'vitest';
import {
  createWorkflow,
  executeDetect,
  executeInvestigate,
  executeDecide,
} from '../src/ecommerce/workflow.js';
import type { DetectResult } from '../src/ecommerce/workflow-state.js';

function fixture(stock = 80) {
  const timestamp = new Date().toISOString();
  const state = createWorkflow({
    workspaceJid: 'test:workflow',
    createdBy: 'tester',
    monitorResult: {
      timestamp,
      total_products: 1,
      low_stock_products:
        stock < 150
          ? [
              {
                sku: 'SKU-002',
                name: 'Test',
                stock,
                safety_stock: 150,
                gap: 150 - stock,
              },
            ]
          : [],
    },
  });
  const evidence: DetectResult = {
    sku: 'SKU-002',
    product_version: 1,
    product: {
      sku: 'SKU-002',
      name: 'Test',
      stock,
      safety_stock: 150,
      cost_price: 65,
      selling_price: 149,
      data_source: 'local_test_fixture',
      collected_at: timestamp,
    },
    orders: [],
    competitors: [],
    collected_at_range: { earliest: timestamp, latest: timestamp },
  };
  return { state, evidence };
}

describe('MySQL-backed workflow stage functions', () => {
  test('appends stage results and evidence without overwriting an earlier snapshot', () => {
    const { state, evidence } = fixture();
    const before = structuredClone(state);
    const detected = executeDetect(state, evidence.sku, evidence);
    const investigated = executeInvestigate(detected);
    const completed = executeDecide(investigated);
    expect(state).toEqual(before);
    expect([
      state.current_stage,
      detected.current_stage,
      investigated.current_stage,
      completed.current_stage,
    ]).toEqual(['monitor', 'detect', 'investigate', 'completed']);
    expect(completed.evidence_chain.map((entry) => entry.stage)).toEqual([
      'monitor',
      'detect',
      'investigate',
      'decide',
    ]);
    expect(completed.monitor).toBeDefined();
    expect(completed.detect).toBeDefined();
    expect(completed.investigate).toBeDefined();
    expect(
      completed.decide!.decide_result.recommendations.map(
        (item) => item.action,
      ),
    ).toEqual(['consider_restock', 'investigate_further']);
  });
  test('rejects skipped, repeated, and out-of-order transitions', () => {
    const { state, evidence } = fixture();
    expect(() => executeInvestigate(state)).toThrow(
      'Cannot execute investigate',
    );
    expect(() => executeDecide(state)).toThrow('Cannot execute decide');
    const detected = executeDetect(state, evidence.sku, evidence);
    expect(() => executeDetect(detected, evidence.sku, evidence)).toThrow(
      'Cannot execute detect',
    );
    const completed = executeDecide(executeInvestigate(detected));
    expect(() => executeDecide(completed)).toThrow('Cannot execute decide');
  });
  test('rejects another SKU in the evidence rather than mixing business data', () => {
    const { state, evidence } = fixture();
    expect(() => executeDetect(state, 'OTHER', evidence)).toThrow(
      'Evidence SKU mismatch',
    );
    expect(() =>
      executeDetect(state, evidence.sku, {
        ...evidence,
        product: { ...evidence.product, sku: 'OTHER' },
      }),
    ).toThrow('Evidence SKU mismatch');
    expect(() =>
      executeDetect(state, evidence.sku, {
        ...evidence,
        orders: [
          {
            order_id: 'o1',
            sku: 'OTHER',
            quantity: 1,
            amount: 149,
            status: 'pending',
            data_source: 'test',
            collected_at: evidence.product.collected_at,
          },
        ],
      }),
    ).toThrow('Evidence SKU mismatch');
  });
  test('sufficient stock still completes the investigation with a monitor recommendation', () => {
    const { state, evidence } = fixture(200);
    const completed = executeDecide(
      executeInvestigate(executeDetect(state, evidence.sku, evidence)),
    );
    expect(completed.current_stage).toBe('completed');
    expect(
      completed.decide!.decide_result.recommendations.map(
        (item) => item.action,
      ),
    ).toEqual(['monitor']);
  });
});
