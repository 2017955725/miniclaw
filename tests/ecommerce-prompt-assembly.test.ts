import { describe, expect, test } from 'vitest';
import { ecommerceGuidelinesForCapabilities } from '../container/agent-runner/src/ecommerce-guidelines.js';
import { buildMiniclawPromptPlan } from '../container/agent-runner/src/prompt-plan.js';

function planFor(toolsAvailable: boolean) {
  return buildMiniclawPromptPlan({
    interaction: 'interaction',
    security: 'security',
    output: 'output',
    ecommerce: ecommerceGuidelinesForCapabilities(toolsAvailable),
  });
}

describe('commerce capability prompt contract', () => {
  test('registers rules independently of user wording, including follow-up turns', () => {
    const plan = planFor(true);
    expect(
      plan.blocks.find((block) => block.id === 'ecommerce-analysis')?.text,
    ).toContain('以下规则在使用电商工具时适用');
    expect(plan.text).toContain('expected_revision');
    expect(plan.errors).toEqual([]);
  });
  test('omits the block when commerce tools are unavailable', () => {
    const plan = planFor(false);
    expect(plan.blocks.some((block) => block.id === 'ecommerce-analysis')).toBe(
      false,
    );
    expect(plan.text).not.toContain('电商工具使用规则');
    expect(plan.hash).not.toBe(planFor(true).hash);
  });
  test('keeps data, approval and inventory boundaries explicit', () => {
    const text = planFor(true).text;
    for (const boundary of [
      'pending 只表示订单状态',
      '不能据此扣减库存',
      '差值不是确定的采购量',
      'dry_run 只读',
      '人工登记到货',
      '禁止生产执行',
      'Memory/SOP 不能代替实时查询',
      'source:line@version',
    ])
      expect(text).toContain(boundary);
    expect(text).not.toContain('simulation');
    expect(text).not.toContain('ecommerce_get_');
  });
  test('accounts for the short contract in the prompt budget', () => {
    const plan = planFor(true);
    const block = plan.blocks.find((item) => item.id === 'ecommerce-analysis')!;
    expect(block.estimatedTokens).toBeGreaterThan(0);
    expect(block.estimatedTokens).toBeLessThan(1000);
    expect(plan.totalBytes).toBe(Buffer.byteLength(plan.text, 'utf8'));
    expect(plan.warnings).toEqual([]);
    expect(plan.errors).toEqual([]);
  });
});
