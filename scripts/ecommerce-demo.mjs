import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  createCommercePool,
  initializeCommerceSchema,
} from '../dist/ecommerce/test-db.js';
import {
  CommerceService,
  workflowSummary,
} from '../dist/ecommerce/commerce-service.js';

// CLI demonstrator only. Human review here is explicit test orchestration, not an Agent tool.
if (!process.env.MINICLAW_ECOMMERCE_TEST_URL) {
  const config = JSON.parse(
    fs.readFileSync(
      new URL('../data/ecommerce-local/connection.json', import.meta.url),
      'utf8',
    ),
  );
  process.env.MINICLAW_ECOMMERCE_TEST_URL = config.url;
}
const pool = createCommercePool();
try {
  await initializeCommerceSchema(pool);
  const service = new CommerceService(pool);
  const workspace = `demo:${randomUUID()}`;
  await service.seed(workspace);
  let w = await service.start(workspace, 'demo-human', { sku: 'SKU-002' });
  w = await service.advance(workspace, w.state.workflow_id, w.revision);
  w = await service.advance(workspace, w.state.workflow_id, w.revision);
  w = await service.advance(workspace, w.state.workflow_id, w.revision);
  const unknownsBefore = w.state.investigate.investigate_result.unknowns;
  await service.setBusinessContext(workspace, 'demo-human', 'SKU-002', {
    source: 'explicit_demo_parameters',
    observed_at: new Date().toISOString(),
    inventory_policy: 'on_hand',
    reserved_stock: 0,
    inbound_stock: 0,
    other_channel_reserved: 0,
    sales_last_7d: 35,
    supplier_id: 'DEMO-SUPPLIER',
    lead_time_days: 3,
  });
  w = await service.refresh(workspace, w.state.workflow_id, w.revision);
  w = await service.advance(workspace, w.state.workflow_id, w.revision);
  w = await service.advance(workspace, w.state.workflow_id, w.revision);
  const approval = await service.propose(
    workspace,
    w.state.workflow_id,
    w.revision,
    { quantity: 70, supplier_id: 'DEMO-SUPPLIER', environment: 'test' },
  );
  const preview = await service.preview(workspace, approval.id);
  const approved = await service.review(
    workspace,
    'demo-human',
    approval.id,
    approval.revision,
    'approved',
    'Explicit local demonstration; 70 is a chosen test quantity, not an optimized model prediction',
  );
  const applied = await service.apply(
    workspace,
    approval.id,
    approved.revision,
    'demo-purchase',
    'test',
  );
  const replay = await service.apply(
    workspace,
    approval.id,
    approved.revision,
    'demo-purchase',
    'test',
  );
  const receipt = await service.receive(
    workspace,
    'demo-human',
    String(applied.purchase_order_id),
    'demo-arrival',
  );
  console.log(
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        environment: 'local_mysql_test',
        workspace,
        unknowns_before: unknownsBefore,
        workflow: workflowSummary(w),
        preview,
        approved,
        applied,
        replay_equal: isDeepStrictEqual(applied, replay),
        receipt,
        production_write_performed: false,
      },
      null,
      2,
    ),
  );
} finally {
  await pool.end();
}
