import { z } from 'zod';
import {
  getCommerceService,
  workflowSummary,
  type CommerceService,
} from './commerce-service.js';
import { searchCommerceSop } from './sop-search.js';

const key = z.string().min(1).max(96);
const rev = z.number().int().positive();
export const commerceCommandSchema = z.discriminatedUnion('operation', [
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
  z
    .object({
      operation: z.literal('knowledge'),
      query: z.string().min(1).max(500),
      max_chars: z.number().int().min(256).max(6000).optional(),
    })
    .strict(),
]);

/** Identity is supplied by verified IPC or authenticated HTTP, never from args. */
export async function dispatchCommerceCommand(
  workspace: string,
  actor: string,
  raw: unknown,
  injected?: CommerceService,
) {
  const input = commerceCommandSchema.parse(raw);
  if (input.operation === 'knowledge')
    return searchCommerceSop(input.query, input.max_chars);
  const service = injected ?? (await getCommerceService());
  switch (input.operation) {
    case 'monitor': {
      const { operation: _, ...scope } = input;
      return service.monitor(workspace, scope);
    }
    case 'start':
      return workflowSummary(
        await service.start(workspace, actor, {
          sku: input.sku,
          category: input.category,
        }),
      );
    case 'get':
      return workflowSummary(
        await service.getWorkflow(workspace, input.workflow_id),
      );
    case 'advance':
      return workflowSummary(
        await service.advance(
          workspace,
          input.workflow_id,
          input.expected_revision,
          input.sku,
        ),
      );
    case 'refresh':
      return workflowSummary(
        await service.refresh(
          workspace,
          input.workflow_id,
          input.expected_revision,
        ),
      );
    case 'propose':
      return service.propose(
        workspace,
        input.workflow_id,
        input.expected_revision,
        {
          quantity: input.quantity,
          supplier_id: input.supplier_id,
          environment: input.environment,
        },
      );
    case 'approvals':
      return service.listApprovals(workspace);
    case 'preview':
      return service.preview(workspace, input.approval_id);
    case 'apply':
      return service.apply(
        workspace,
        input.approval_id,
        input.expected_revision,
        input.idempotency_key,
        input.environment,
      );
  }
}
