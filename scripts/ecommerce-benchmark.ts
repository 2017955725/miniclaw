// @ts-nocheck
/** Deterministic engineering benchmark. No LLM calls or invented provider usage. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const project = path.resolve(process.env.COMMERCE_BENCH_PROJECT || 'C:/Users/20179/miniclaw-main');
const output = path.resolve(process.env.COMMERCE_BENCH_OUTPUT || 'outputs/commerce-benchmark');
const runtimePath = (relative) => relative.startsWith('src/')
  ? relative.replace(/^src\//, 'dist/').replace(/\.ts$/, '.js')
  : relative.replace('/src/', '/dist/').replace(/\.ts$/, '.js');
const load = (relative) => import(pathToFileURL(path.join(project, runtimePath(relative))).href);
const { createCommercePool, initializeCommerceSchema, rows } = await load('src/ecommerce/test-db.ts');
const { CommerceService, workflowSummary } = await load('src/ecommerce/commerce-service.ts');
const { dispatchCommerceCommand } = await load('src/ecommerce/agent-dispatch.ts');
const { createCommerceTools } = await load('container/agent-runner/src/commerce-tools.ts');
const { createWorkflow, executeDetect, executeInvestigate, executeDecide } = await load('src/ecommerce/workflow.ts');
const { estimatePromptTokens } = await load('container/agent-runner/src/prompt-plan.ts');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => JSON.stringify(value);
const measure = (value) => {
  const text = json(value);
  return { bytes: Buffer.byteLength(text), estimated_tokens: estimatePromptTokens(text) };
};
const add = (values) => values.reduce((a, b) => ({ bytes: a.bytes + b.bytes, estimated_tokens: a.estimated_tokens + b.estimated_tokens }), { bytes: 0, estimated_tokens: 0 });
const reduction = (before, after) => Number(((1 - after / before) * 100).toFixed(2));
const timestamp = new Date().toISOString();
const workspace = `benchmark:${timestamp.slice(0, 10)}:${randomUUID()}`;
const ordersCounts = [0, 1, 5, 20, 80];
const competitorsCounts = [0, 1, 3, 5];
const products = [], orders = [], competitors = [], tasks = [];
for (let i = 0; i < 120; i++) {
  const sku = `BENCH-${String(i + 1).padStart(4, '0')}`;
  const stock = i % 4 === 0 ? 0 : i % 4 === 1 ? 40 : i % 4 === 2 ? 100 : 180;
  const context = i % 3 === 0 ? null : {
    source: 'synthetic_benchmark_fixture', observed_at: timestamp,
    inventory_policy: 'on_hand', reserved_stock: 0, inbound_stock: i % 5 * 5,
    other_channel_reserved: 0, sales_last_7d: i % 11 * 3,
    supplier_id: 'BENCH-SUPPLIER', ...(i % 3 === 1 ? {} : { lead_time_days: 3 }),
  };
  products.push({ sku, name: `测试商品-${String(i + 1).padStart(4, '0')}`, category: ['数码', '家居', '服饰'][i % 3], stock, safety_stock: 100, cost_cents: 6500, price_cents: 14900, version: 1, source: 'synthetic_benchmark_fixture', collected_at: timestamp, context_json: context });
  const n = ordersCounts[i % ordersCounts.length];
  for (let j = 0; j < n; j++) orders.push({ order_id: `${sku}-ORDER-${String(j).padStart(3, '0')}`, sku, quantity: j % 4 + 1, amount: 149 * (j % 4 + 1), status: j % 3 === 0 ? 'pending' : 'completed', data_source: 'synthetic_benchmark_fixture', collected_at: timestamp, ...(i % 3 === 0 ? {} : { placed_at: timestamp }) });
  for (let j = 0; j < competitorsCounts[i % competitorsCounts.length]; j++) competitors.push({ sku, competitor_name: `测试竞品-${j + 1}`, competitor_price: 135 + j * 3, data_source: 'synthetic_benchmark_fixture', collected_at: timestamp });
  if (i < 60) tasks.push({ task_id: `task-${String(i + 1).padStart(3, '0')}`, sku, query: `调查 ${sku} 的库存、订单和竞品，给出带约束的补货建议`, order_count: n, competitor_count: competitorsCounts[i % 4] });
}
const fixture = { dataset_kind: 'synthetic', generated_at: timestamp, products, orders, competitors, tasks };
const configPath = path.join(project, 'data/ecommerce-local/connection.json');
const connectionUrl = process.env.MINICLAW_ECOMMERCE_TEST_URL || JSON.parse(fs.readFileSync(configPath, 'utf8')).url;
const pool = createCommercePool(connectionUrl);
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'fixture.json'), JSON.stringify(fixture, null, 2));
const tracePath = path.join(output, 'traces.jsonl');
fs.writeFileSync(tracePath, '');
const trace = (value) => fs.appendFileSync(tracePath, `${json(value)}\n`);
async function insert(table, columns, records) {
  for (let offset = 0; offset < records.length; offset += 200) {
    const batch = records.slice(offset, offset + 200);
    const placeholders = batch.map(() => `(${columns.map(() => '?').join(',')})`).join(',');
    await pool.execute(`INSERT INTO ${table}(${columns.join(',')}) VALUES ${placeholders}`, batch.flat());
  }
}
try {
  await initializeCommerceSchema(pool);
  await insert('ec_products', ['workspace', 'sku', 'name', 'category', 'stock', 'safety_stock', 'cost_cents', 'price_cents', 'version', 'source', 'collected_at', 'context_json'], products.map(p => [workspace, p.sku, p.name, p.category, p.stock, p.safety_stock, p.cost_cents, p.price_cents, 1, p.source, timestamp, p.context_json ? json(p.context_json) : null]));
  await insert('ec_orders', ['workspace', 'order_id', 'sku', 'payload'], orders.map(o => [workspace, o.order_id, o.sku, json(o)]));
  await insert('ec_competitors', ['workspace', 'sku', 'competitor', 'payload'], competitors.map(c => [workspace, c.sku, c.competitor_name, json(c)]));
  const service = new CommerceService(pool);
  const results = [];
  const currentTrace = [];
  let activeTask;
  const tools = createCommerceTools(async command => {
    const result = await dispatchCommerceCommand(workspace, 'benchmark-human', command, service);
    currentTrace.push({ task_id: activeTask, command, result });
    return result;
  });
  const tool = tools.find(t => t.name === 'ecommerce_test');
  async function invoke(command) {
    const args = { command };
    const result = await tool.handler(args, undefined);
    assert.equal(Boolean(result.isError), false, `tool failed ${json(command)}`);
    return JSON.parse(result.content[0].text);
  }
  for (const task of tasks) {
    activeTask = task.task_id;
    const baseline = [];
    const call = async (name, input, run) => {
      const result = await run(); baseline.push({ name, input, result }); return result;
    };
    const mon = await call('start', { sku: task.sku }, () => service.monitor(workspace, { sku: task.sku }));
    const initial = createWorkflow({ workspaceJid: workspace, createdBy: 'benchmark-human', monitorResult: mon });
    initial.monitor.selected_sku = task.sku;
    const product = await call('query_product', { sku: task.sku }, async () => {
      const [p] = await rows(pool, 'SELECT * FROM ec_products WHERE workspace=? AND sku=?', [workspace, task.sku]);
      return { product: { sku: p.sku, name: p.name, stock: p.stock, safety_stock: p.safety_stock, cost_price: p.cost_cents / 100, selling_price: p.price_cents / 100, data_source: p.source, collected_at: p.collected_at }, product_version: p.version, ...(p.context_json ? { business_context: p.context_json } : {}) };
    });
    const os = await call('query_orders', { sku: task.sku }, async () => (await rows(pool, 'SELECT payload FROM ec_orders WHERE workspace=? AND sku=? ORDER BY order_id LIMIT 101', [workspace, task.sku])).map(o => o.payload));
    const cs = await call('query_competitors', { sku: task.sku }, async () => (await rows(pool, 'SELECT payload FROM ec_competitors WHERE workspace=? AND sku=? ORDER BY competitor LIMIT 51', [workspace, task.sku])).map(c => c.payload));
    const detected = executeDetect(initial, task.sku, { sku: task.sku, ...product, orders: os, competitors: cs, collected_at_range: { earliest: timestamp, latest: timestamp } });
    const investigated = await call('investigate', { workflow_id: initial.workflow_id }, async () => executeInvestigate(detected));
    const completed = await call('decide', { workflow_id: initial.workflow_id }, async () => executeDecide(investigated));
    const startIndex = currentTrace.length;
    let compact = await invoke({ operation: 'start', sku: task.sku });
    const snapshots = [await service.getWorkflow(workspace, compact.workflow_id)];
    for (let i = 0; i < 3; i++) {
      compact = await invoke({ operation: 'advance', workflow_id: compact.workflow_id, expected_revision: compact.revision });
      snapshots.push(await service.getWorkflow(workspace, compact.workflow_id));
    }
    const calls = currentTrace.slice(startIndex);
    const final = snapshots.at(-1).state;
    assert.deepEqual(final.detect.detect_result, detected.detect.detect_result);
    assert.deepEqual(final.investigate.investigate_result, completed.investigate.investigate_result);
    assert.deepEqual(final.decide.decide_result, completed.decide.decide_result);
    assert.equal(final.evidence_chain.length, 4);
    assert.equal(final.detect.detect_result.orders.length, task.order_count);
    assert.equal(final.detect.detect_result.competitors.length, task.competitor_count);
    const contexts = snapshots.map((snapshot, i) => {
      const fullResponse = { revision: snapshot.revision, state: snapshot.state };
      const compactResponse = workflowSummary({ ...snapshot, ...(i === 0 ? { next_cursor: calls[i].result.next_cursor } : {}) });
      assert.deepEqual(JSON.parse(json(compactResponse)), JSON.parse(json(calls[i].result)));
      assert.deepEqual(compactResponse.analysis, snapshot.state.investigate?.investigate_result);
      assert.deepEqual(compactResponse.recommendations, snapshot.state.decide?.decide_result.recommendations);
      assert.deepEqual(compactResponse.product, snapshot.state.detect?.detect_result.product);
      const fullRequest = i === 0 ? { operation: 'start', sku: task.sku } : { operation: 'advance', workflow_id: snapshot.state.workflow_id, expected_revision: snapshots[i - 1].revision, workflow: snapshots[i - 1].state };
      return { stage: snapshot.state.current_stage, full_request: fullRequest, compact_request: calls[i].command, full_response: fullResponse, compact_response: compactResponse };
    });
    const before = add(contexts.flatMap(c => [measure(c.full_request), measure(c.full_response)]));
    const after = add(contexts.flatMap(c => [measure(c.compact_request), measure(c.compact_response)]));
    results.push({ ...task, baseline_calls: baseline.length, current_calls: calls.length, full_state_payload: before, compact_payload: after, equivalent_analysis: true, evidence_available_in_mysql: true });
    trace({ task, baseline_calls: baseline, current_calls: calls, context_comparison: contexts });
  }
  const totals = {
    tasks: results.length,
    baseline_calls: results.reduce((n, r) => n + r.baseline_calls, 0),
    current_calls: results.reduce((n, r) => n + r.current_calls, 0),
    full_state_payload: add(results.map(r => r.full_state_payload)),
    compact_payload: add(results.map(r => r.compact_payload)),
    equivalent_tasks: results.filter(r => r.equivalent_analysis).length,
  };
  const report = {
    benchmark: 'current_mysql_deterministic_v1', generated_at: new Date().toISOString(), workspace,
    dataset: { kind: 'synthetic', products: products.length, orders: orders.length, competitors: competitors.length, tasks: tasks.length, fixture_sha256: sha(fs.readFileSync(path.join(output, 'fixture.json'))) },
    protocol: {
      calls: 'Counterfactual engineering comparison: split product/orders/competitors calls (6 incl. shared start/investigate/decide) versus current start + advance x3 (4). Baseline adapters are benchmark-only, not a restored production implementation. No stochastic LLM policy or SQL query reduction is claimed.',
      context: 'Paired ablation using the SAME 4 authoritative snapshots: full-state request/response versus ID+revision requests and actual workflowSummary responses. Sum serialized JSON payloads once per event. Excludes system prompt, tool schemas, history retransmission, provider envelopes and model output.',
      tokens: 'Estimated tokens using the repository estimatePromptTokens (max of ceil(UTF8 bytes/4) and non-ASCII character count). NOT tokenizer counts, billed tokens, SDK compaction savings or total session input.',
      correctness: 'Exact equality of raw Detect evidence, facts/inferences/unknowns and recommendations; 4 Evidence Chain entries; expected order/competitor counts; compact fields match authoritative state. DOES NOT evaluate semantic answer quality or autonomous model tool selection.',
      sql: 'Actual MySQL I/O for both branches. Current Detect still executes three domain SELECTs. No reduction in SQL count or latency claim.',
    },
    source_sha256: Object.fromEntries(['src/ecommerce/commerce-service.ts', 'src/ecommerce/workflow.ts', 'src/ecommerce/agent-dispatch.ts', 'container/agent-runner/src/commerce-tools.ts', 'container/agent-runner/src/prompt-plan.ts'].map(p => [p, sha(fs.readFileSync(path.join(project, p)))])),
    runtime_sha256: Object.fromEntries(['src/ecommerce/commerce-service.ts', 'src/ecommerce/workflow.ts', 'src/ecommerce/agent-dispatch.ts', 'container/agent-runner/src/commerce-tools.ts', 'container/agent-runner/src/prompt-plan.ts'].map(p => [runtimePath(p), sha(fs.readFileSync(path.join(project, runtimePath(p))))])),
    totals,
    reductions: { tool_boundary_calls_pct: reduction(totals.baseline_calls, totals.current_calls), serialized_payload_bytes_pct: reduction(totals.full_state_payload.bytes, totals.compact_payload.bytes), estimated_payload_tokens_pct: reduction(totals.full_state_payload.estimated_tokens, totals.compact_payload.estimated_tokens) },
    per_task: results,
    production_write_performed: false, llm_invoked: false,
  };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: path.join(output, 'report.json'), workspace, dataset: report.dataset, totals, reductions: report.reductions, llm_invoked: false }, null, 2));
} finally { await pool.end(); }
