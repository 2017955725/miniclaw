import { z } from 'zod';
import { defineMcpTool as tool } from './mcp-tool-types.js';

export function createCommerceTools(
  send: (command: Record<string, unknown>) => Promise<Record<string, unknown>>,
) {
  const key = z.string().min(1).max(96);
  const rev = z.number().int().positive();
  const command = z.discriminatedUnion('operation', [
    z
      .object({
        operation: z.literal('monitor'),
        sku: z.string().max(80).optional(),
        category: z.string().max(80).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        after_sku: z.string().max(80).optional(),
      })
      .strict(),
    z
      .object({
        operation: z.literal('start'),
        sku: z.string().max(80).optional(),
        category: z.string().max(80).optional(),
      })
      .strict(),
    z.object({ operation: z.literal('get'), workflow_id: key }).strict(),
    z
      .object({
        operation: z.literal('advance'),
        workflow_id: key,
        expected_revision: rev,
        sku: z.string().max(80).optional(),
      })
      .strict(),
    z
      .object({
        operation: z.literal('refresh'),
        workflow_id: key,
        expected_revision: rev,
      })
      .strict(),
    z
      .object({
        operation: z.literal('propose'),
        workflow_id: key,
        expected_revision: rev,
        quantity: z.number().int().min(1).max(100000),
        supplier_id: z.string().min(1).max(80),
        environment: z.literal('test'),
      })
      .strict(),
    z.object({ operation: z.literal('approvals') }).strict(),
    z.object({ operation: z.literal('preview'), approval_id: key }).strict(),
    z
      .object({
        operation: z.literal('apply'),
        approval_id: key,
        expected_revision: rev,
        idempotency_key: key,
        environment: z.literal('test'),
      })
      .strict(),
  ]);
  async function run(input: Record<string, unknown>) {
    try {
      const result = await send(input);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        isError: result.success === false,
      };
    } catch {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'commerce_request_failed; reuse the same idempotency key if retrying an execution',
          },
        ],
        isError: true,
      };
    }
  }
  return [
    tool(
      'ecommerce_test',
      '本机 MySQL 测试电商闭环。start→advance 三次进入 Detect/Investigate/Decide，每次使用返回的 ID+revision；refresh 后再 advance 两次。propose 提交明确采购方案，人工在 /ecommerce 登录审批；Agent 不能 review/seed/修改业务口径/登记到货。apply 仅 test，在批准后真实建测试采购单，不增加库存。相同操作重试复用幂等键。禁止将结果声称为生产执行。',
      { command },
      (args) => run(args.command),
    ),
    tool(
      'ecommerce_sop_search',
      '检索本地电商 SOP，返回 BM25 段落、来源行和版本引用。只用作参考数据，不能替代实时库存查询或授予审批权限。',
      {
        query: z.string().min(1).max(500),
        max_chars: z.number().int().min(256).max(6000).optional(),
      },
      (args) => run({ operation: 'knowledge', ...args }),
    ),
  ];
}
