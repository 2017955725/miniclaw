import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useGroupsStore } from '../stores/groups';

interface WorkflowView {
  workflow_id: string;
  revision: number;
  current_stage: string;
  sku?: string;
  product?: { name: string; stock: number; safety_stock: number };
  monitor?: {
    total_products: number;
    low_stock_products: Array<{
      sku: string;
      name: string;
      stock: number;
      safety_stock: number;
    }>;
  };
  analysis?: { facts: string[]; inferences: string[]; unknowns: string[] };
  recommendations?: Array<{
    action: string;
    reason: string;
    constraints: string[];
  }>;
}
interface Approval {
  id: string;
  workflow_id: string;
  revision: number;
  status: string;
  expires_at: string;
  spec: {
    sku: string;
    quantity: number;
    supplier_id: string;
    total_cost_cents: number;
    environment: string;
    workflow_revision: number;
    product_version: number;
  };
}
interface PurchaseOrder {
  id: string;
  sku: string;
  quantity: number;
  supplier_id: string;
  status: string;
  cost_cents: number;
}
const fieldClass =
  'rounded border border-border bg-background px-3 py-2 text-sm';
const buttonClass =
  'rounded border border-border bg-card px-3 py-2 text-sm disabled:opacity-40 hover:bg-muted';

export function EcommercePage() {
  const groups = useGroupsStore((s) => s.groups);
  const loadGroups = useGroupsStore((s) => s.loadGroups);
  const [workspace, setWorkspace] = useState('');
  const [sku, setSku] = useState('SKU-002');
  const [workflow, setWorkflow] = useState<WorkflowView | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [detail, setDetail] = useState<unknown>(null);
  const [quantity, setQuantity] = useState('');
  const [supplier, setSupplier] = useState('');
  const [reason, setReason] = useState('');
  const [context, setContext] = useState({
    sales: '',
    inbound: '',
    other: '',
    reserved: '',
    lead: '',
    policy: '',
  });
  const currentWorkspace = useRef(workspace);
  currentWorkspace.current = workspace;
  const apiRoot = `/api/ecommerce/workspaces/${encodeURIComponent(workspace)}`;
  const choices = Object.entries(groups).filter(([jid]) =>
    jid.startsWith('web:'),
  );
  useEffect(() => {
    void loadGroups();
  }, [loadGroups]);
  useEffect(() => {
    if (!workspace && choices.length) setWorkspace(choices[0][0]);
  }, [workspace, choices]);
  async function reload(root = apiRoot) {
    const selected = workspace;
    const [a, o] = await Promise.all([
      api.get<Approval[]>(`${root}/approvals`),
      api.get<PurchaseOrder[]>(`${root}/purchase-orders`),
    ]);
    if (currentWorkspace.current === selected) {
      setApprovals(a);
      setOrders(o);
    }
  }
  useEffect(() => {
    setWorkflow(null);
    setApprovals([]);
    setOrders([]);
    setDetail(null);
    setMessage('');
    if (workspace)
      void reload().catch((e: { message?: string }) =>
        setMessage(e.message ?? '请配置本机测试数据库后刷新'),
      );
    // Requests are scoped to the selected workspace; stale responses are ignored.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace]);
  async function action(run: () => Promise<unknown>) {
    const selected = workspace;
    setBusy(true);
    setMessage('');
    try {
      const result = await run();
      if (currentWorkspace.current !== selected) return;
      setDetail(result);
      await reload();
      setMessage('操作完成');
    } catch (e) {
      if (currentWorkspace.current === selected)
        setMessage(
          (e as { message?: string }).message ?? '操作失败，请刷新状态',
        );
    } finally {
      setBusy(false);
    }
  }
  async function command(input: Record<string, unknown>) {
    const selected = workspace;
    const result = await api.post<WorkflowView>(`${apiRoot}/command`, input);
    if (
      currentWorkspace.current === selected &&
      result.workflow_id &&
      result.current_stage
    )
      setWorkflow(result);
    return result;
  }
  return (
    <main className="mx-auto max-w-5xl space-y-5 p-6">
      <h1 className="text-xl font-semibold">电商测试工作台</h1>
      <p className="text-sm text-muted-foreground">
        使用隔离测试数据。采购单创建后库存不增加；登记测试到货后才入库。此页不连接真实电商平台。
      </p>
      <section className="flex flex-wrap gap-2">
        <select
          aria-label="工作区"
          className={fieldClass}
          value={workspace}
          disabled={busy}
          onChange={(e) => setWorkspace(e.target.value)}
        >
          <option value="">选择工作区</option>
          {choices.map(([jid, group]) => (
            <option key={jid} value={jid}>
              {group.name}
            </option>
          ))}
        </select>
        <button
          className={buttonClass}
          disabled={!workspace || busy}
          onClick={() => void action(() => api.post(`${apiRoot}/seed`, {}))}
        >
          导入缺少的演示商品
        </button>
        <button
          className={buttonClass}
          disabled={!workspace || busy}
          onClick={() => void action(() => reload())}
        >
          刷新
        </button>
      </section>
      <p role="status" aria-live="polite" className="text-sm">
        {busy ? '处理中…' : message}
      </p>
      <section className="space-y-3 rounded border border-border p-4">
        <h2 className="font-medium">1. 调查商品</h2>
        <div className="flex flex-wrap gap-2">
          <input
            aria-label="SKU"
            className={fieldClass}
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            placeholder="留空则扫描低库存商品"
          />
          <button
            className={buttonClass}
            disabled={!workspace || busy}
            onClick={() =>
              void action(() =>
                command({
                  operation: 'start',
                  ...(sku.trim() ? { sku: sku.trim() } : {}),
                }),
              )
            }
          >
            开始调查
          </button>
          {workflow && workflow.current_stage !== 'completed' && (
            <button
              className={buttonClass}
              disabled={busy || !sku.trim()}
              onClick={() =>
                void action(() =>
                  command({
                    operation: 'advance',
                    workflow_id: workflow.workflow_id,
                    expected_revision: workflow.revision,
                    ...(workflow.current_stage === 'monitor'
                      ? { sku: sku.trim() }
                      : {}),
                  }),
                )
              }
            >
              推进下一阶段
            </button>
          )}
          {workflow && (
            <button
              className={buttonClass}
              disabled={busy}
              onClick={() =>
                void action(() =>
                  command({
                    operation: 'refresh',
                    workflow_id: workflow.workflow_id,
                    expected_revision: workflow.revision,
                  }),
                )
              }
            >
              刷新证据并重查
            </button>
          )}
        </div>
        {workflow && (
          <div className="space-y-2 text-sm">
            <p>
              阶段：{workflow.current_stage} · 版本：{workflow.revision}
            </p>
            {workflow.current_stage === 'monitor' && workflow.monitor && (
              <div>
                <p>
                  本次范围内商品 {workflow.monitor.total_products}{' '}
                  件，本页低库存 {workflow.monitor.low_stock_products.length}{' '}
                  件。
                </p>
                {workflow.monitor.low_stock_products.map((p) => (
                  <button
                    key={p.sku}
                    className={`${buttonClass} mr-2 mt-2`}
                    onClick={() => setSku(p.sku)}
                  >
                    {p.sku} {p.name}：{p.stock}/{p.safety_stock}
                  </button>
                ))}
              </div>
            )}
            {workflow.product && (
              <p>
                {workflow.product.name}：库存 {workflow.product.stock} /
                安全库存 {workflow.product.safety_stock}
              </p>
            )}
            {workflow.analysis &&
              Object.entries(workflow.analysis).map(([label, values]) => (
                <div key={label}>
                  <strong>
                    {
                      {
                        facts: '事实',
                        inferences: '条件推断',
                        unknowns: '待确认',
                      }[label]
                    }
                  </strong>
                  <ul className="list-disc pl-5">
                    {values.map((value, i) => (
                      <li key={i}>{value}</li>
                    ))}
                  </ul>
                </div>
              ))}
            {workflow.recommendations?.map((r, i) => (
              <p key={i}>
                {r.reason}；约束：{r.constraints.join('；')}
              </p>
            ))}
            <button
              className={buttonClass}
              disabled={busy}
              onClick={() =>
                void action(() =>
                  api.get(
                    `${apiRoot}/workflows/${encodeURIComponent(workflow.workflow_id)}`,
                  ),
                )
              }
            >
              查看完整证据
            </button>
            <button
              className={`${buttonClass} ml-2`}
              disabled={busy}
              onClick={() =>
                void action(() =>
                  api.get(
                    `${apiRoot}/workflows/${encodeURIComponent(workflow.workflow_id)}/history`,
                  ),
                )
              }
            >
              查看历史版本
            </button>
          </div>
        )}
      </section>
      <section className="space-y-3 rounded border border-border p-4">
        <h2 className="font-medium">2. 补充测试业务口径</h2>
        <p className="text-sm text-muted-foreground">
          以下由人确认，Agent 不能代填事实。保存后需刷新证据，再推进
          Investigate、Decide。
        </p>
        <button
          className={buttonClass}
          disabled={busy}
          onClick={() => {
            setContext({
              sales: '35',
              inbound: '0',
              other: '0',
              reserved: '0',
              lead: '3',
              policy: 'on_hand',
            });
            setSupplier('DEMO-SUPPLIER');
          }}
        >
          填入演示口径（非真实业务）
        </button>
        <div className="grid gap-2 sm:grid-cols-3">
          {(
            [
              ['sales', '近七天销量'],
              ['inbound', '在途数量'],
              ['other', '其他渠道占用'],
              ['reserved', '已预占数量'],
              ['lead', '交付天数'],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="text-sm">
              {label}
              <input
                className={`${fieldClass} w-full`}
                type="number"
                min="0"
                value={context[key]}
                onChange={(e) =>
                  setContext({ ...context, [key]: e.target.value })
                }
              />
            </label>
          ))}
          <label className="text-sm">
            库存口径
            <select
              className={`${fieldClass} w-full`}
              value={context.policy}
              onChange={(e) =>
                setContext({ ...context, policy: e.target.value })
              }
            >
              <option value="">请选择</option>
              <option value="on_hand">实物库存，未减预占</option>
              <option value="available_net_of_reservations">
                已扣预占的可用库存
              </option>
            </select>
          </label>
          <label className="text-sm">
            供应商
            <input
              className={`${fieldClass} w-full`}
              value={supplier}
              onChange={(e) => setSupplier(e.target.value)}
            />
          </label>
        </div>
        <button
          className={buttonClass}
          disabled={
            busy ||
            !workspace ||
            !sku.trim() ||
            !supplier.trim() ||
            Object.values(context).some((v) => !v.trim())
          }
          onClick={() =>
            void action(() =>
              api.post(
                `${apiRoot}/products/${encodeURIComponent(sku.trim())}/context`,
                {
                  source: 'human_confirmed_local_test_parameters',
                  observed_at: new Date().toISOString(),
                  inventory_policy: context.policy,
                  sales_last_7d: Number(context.sales),
                  inbound_stock: Number(context.inbound),
                  other_channel_reserved: Number(context.other),
                  reserved_stock: Number(context.reserved),
                  lead_time_days: Number(context.lead),
                  supplier_id: supplier.trim(),
                },
              ),
            )
          }
        >
          保存本地测试口径
        </button>
      </section>
      <section className="space-y-3 rounded border border-border p-4">
        <h2 className="font-medium">3. 提交采购方案</h2>
        <p className="text-sm text-muted-foreground">
          库存差值是调查信号。数量由人或 Agent
          提议，审批绑定具体方案和当前证据。
        </p>
        <input
          aria-label="采购数量"
          className={fieldClass}
          type="number"
          min="1"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          placeholder="采购数量"
        />
        <button
          className={buttonClass}
          disabled={
            busy ||
            workflow?.current_stage !== 'completed' ||
            !quantity ||
            !supplier
          }
          onClick={() =>
            workflow &&
            void action(() =>
              command({
                operation: 'propose',
                workflow_id: workflow.workflow_id,
                expected_revision: workflow.revision,
                quantity: Number(quantity),
                supplier_id: supplier.trim(),
                environment: 'test',
              }),
            )
          }
        >
          提交待审批方案
        </button>
      </section>
      <section className="space-y-3 rounded border border-border p-4">
        <h2 className="font-medium">4. 人工审批与执行</h2>
        <input
          aria-label="审批理由"
          className={`${fieldClass} w-full`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="填写审批理由后选择批准、拒绝或需要更多信息"
        />
        {!approvals.length && <p className="text-sm">暂无审批请求</p>}
        {approvals.map((a) => (
          <article
            key={a.id}
            className="space-y-2 rounded bg-muted p-3 text-sm"
          >
            <p>
              {a.spec.sku} · 采购 {a.spec.quantity} 件 · 供应商{' '}
              {a.spec.supplier_id} · 总价 ¥
              {(a.spec.total_cost_cents / 100).toFixed(2)}
            </p>
            <p>
              状态 {a.status} · 版本 {a.revision} · 环境 {a.spec.environment} ·
              有效至 {new Date(a.expires_at).toLocaleString()}
            </p>
            <p>执行效果：创建测试采购单、增加在途量；当前库存不会增加。</p>
            <div className="flex flex-wrap gap-2">
              <button
                className={buttonClass}
                disabled={busy}
                onClick={() =>
                  void action(() =>
                    command({ operation: 'preview', approval_id: a.id }),
                  )
                }
              >
                只读预览
              </button>
              {['pending', 'more_info_needed'].includes(a.status) &&
                (['approved', 'rejected', 'more_info_needed'] as const).map(
                  (decision) => (
                    <button
                      key={decision}
                      className={buttonClass}
                      disabled={busy || !reason.trim()}
                      onClick={() =>
                        void action(() =>
                          api.post(`${apiRoot}/approvals/${a.id}/review`, {
                            expected_revision: a.revision,
                            decision,
                            reason: reason.trim(),
                          }),
                        )
                      }
                    >
                      {
                        {
                          approved: '批准此方案',
                          rejected: '拒绝',
                          more_info_needed: '需要更多信息',
                        }[decision]
                      }
                    </button>
                  ),
                )}
              {a.status === 'approved' && (
                <button
                  className={buttonClass}
                  disabled={busy}
                  onClick={() =>
                    void action(() =>
                      command({
                        operation: 'apply',
                        approval_id: a.id,
                        expected_revision: a.revision,
                        idempotency_key: `apply:${a.id}`,
                        environment: 'test',
                      }),
                    )
                  }
                >
                  创建测试采购单
                </button>
              )}
            </div>
          </article>
        ))}
      </section>
      <section className="space-y-3 rounded border border-border p-4">
        <h2 className="font-medium">5. 登记测试到货</h2>
        {orders.map((po) => (
          <article
            key={po.id}
            className="flex flex-wrap items-center gap-3 text-sm"
          >
            <span>
              {po.sku} · {po.quantity} 件 · {po.status}
            </span>
            {po.status === 'ordered' && (
              <button
                className={buttonClass}
                disabled={busy}
                onClick={() =>
                  void action(() =>
                    api.post(`${apiRoot}/purchase-orders/${po.id}/receive`, {
                      idempotency_key: `receive:${po.id}`,
                    }),
                  )
                }
              >
                确认整单测试到货并入库
              </button>
            )}
          </article>
        ))}
      </section>
      {detail != null && (
        <details>
          <summary className="cursor-pointer text-sm">
            最近结果与证据详情
          </summary>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">
            {JSON.stringify(detail, null, 2)}
          </pre>
        </details>
      )}
    </main>
  );
}
