/**
 * 电商异常调查 Workflow
 *
 * Monitor → Detect → Investigate → Decide 四阶段流程编排
 */

import crypto from 'node:crypto';
import type {
  EcommerceWorkflowState,
  MonitorResult,
  DetectResult,
  InvestigateResult,
  DecideResult,
  EvidenceChainEntry,
} from './workflow-state.js';

/**
 * 创建新的 Workflow 实例（Monitor 阶段）
 */
export function createWorkflow(input: {
  workspaceJid: string;
  createdBy: string;
  monitorResult: MonitorResult;
}): EcommerceWorkflowState {
  const workflowId = `ecommerce_wf_${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  const monitorResult = input.monitorResult;

  const workflow: EcommerceWorkflowState = {
    workflow_id: workflowId,
    workspace_jid: input.workspaceJid,
    created_by: input.createdBy,
    created_at: now,
    current_stage: 'monitor',
    monitor: {
      executed_at: now,
      low_stock_count: monitorResult.low_stock_products.length,
      monitor_result: monitorResult,
    },
    evidence_chain: [
      {
        stage: 'monitor',
        timestamp: now,
        tool_calls: [
          {
            tool: 'commerce.queryProducts',
            params: {},
            result_summary: `检测到 ${monitorResult.low_stock_products.length} 个低库存商品`,
          },
        ],
        conclusion: `总商品数 ${monitorResult.total_products}，低库存商品 ${monitorResult.low_stock_products.length} 个`,
      },
    ],
  };

  return workflow;
}

/**
 * Detect 阶段：收集指定 SKU 的完整证据
 */
export function executeDetect(
  workflow: EcommerceWorkflowState,
  sku: string,
  suppliedEvidence: DetectResult,
): EcommerceWorkflowState {
  if (workflow.current_stage !== 'monitor') {
    throw new Error(
      `Cannot execute detect from stage: ${workflow.current_stage}`,
    );
  }

  const now = new Date().toISOString();
  if (
    suppliedEvidence.sku !== sku ||
    suppliedEvidence.product.sku !== sku ||
    suppliedEvidence.orders.some((order) => order.sku !== sku) ||
    suppliedEvidence.competitors.some((competitor) => competitor.sku !== sku)
  )
    throw new Error('Evidence SKU mismatch');
  const product = suppliedEvidence.product;
  const orders = suppliedEvidence.orders;
  const competitors = suppliedEvidence.competitors;

  // 计算数据采集时间范围
  const timestamps = [
    product.collected_at,
    ...orders.map((o) => o.collected_at),
    ...competitors.map((c) => c.collected_at),
  ];
  const earliest = timestamps.sort()[0];
  const latest = timestamps.sort().reverse()[0];

  const detectResult: DetectResult = {
    ...(suppliedEvidence.product_version
      ? { product_version: suppliedEvidence.product_version }
      : {}),
    ...(suppliedEvidence.business_context
      ? { business_context: suppliedEvidence.business_context }
      : {}),
    sku,
    product: {
      sku: product.sku,
      name: product.name,
      stock: product.stock,
      safety_stock: product.safety_stock,
      cost_price: product.cost_price,
      selling_price: product.selling_price,
      data_source: product.data_source,
      collected_at: product.collected_at,
    },
    orders: orders.map((o) => ({
      order_id: o.order_id,
      sku: o.sku,
      quantity: o.quantity,
      amount: o.amount,
      status: o.status,
      data_source: o.data_source,
      collected_at: o.collected_at,
      ...('placed_at' in o && o.placed_at
        ? { placed_at: String(o.placed_at) }
        : {}),
    })),
    competitors: competitors.map((c) => ({
      sku: c.sku,
      competitor_name: c.competitor_name,
      competitor_price: c.competitor_price,
      data_source: c.data_source,
      collected_at: c.collected_at,
    })),
    collected_at_range: {
      earliest,
      latest,
    },
  };

  const updatedWorkflow: EcommerceWorkflowState = {
    ...workflow,
    current_stage: 'detect',
    monitor: {
      ...workflow.monitor!,
      selected_sku: sku,
    },
    detect: {
      executed_at: now,
      sku,
      detect_result: detectResult,
    },
    evidence_chain: [
      ...workflow.evidence_chain,
      {
        stage: 'detect',
        timestamp: now,
        tool_calls: [
          {
            tool: 'commerce.queryProduct',
            params: { sku },
            result_summary: `商品 ${product.name}，库存 ${product.stock}，安全库存 ${product.safety_stock}`,
          },
          {
            tool: 'commerce.queryOrders',
            params: { sku },
            result_summary: `找到 ${orders.length} 条订单`,
          },
          {
            tool: 'commerce.queryCompetitors',
            params: { sku },
            result_summary: `找到 ${competitors.length} 条竞品价格`,
          },
        ],
        conclusion: `收集 ${sku} 的完整证据，数据时间范围：${earliest} 至 ${latest}`,
      },
    ],
  };

  return updatedWorkflow;
}

/**
 * Investigate 阶段：分析证据并分类为事实、推断和未知
 */
export function executeInvestigate(
  workflow: EcommerceWorkflowState,
): EcommerceWorkflowState {
  if (workflow.current_stage !== 'detect') {
    throw new Error(
      `Cannot execute investigate from stage: ${workflow.current_stage}`,
    );
  }

  if (!workflow.detect) {
    throw new Error('Detect stage result is missing');
  }

  const now = new Date().toISOString();
  const { product, orders, competitors, collected_at_range } =
    workflow.detect.detect_result;
  const context = workflow.detect.detect_result.business_context;

  // 确定事实
  const facts: string[] = [
    `商品 ${product.sku} ${product.name}，当前库存 ${product.stock}，安全库存 ${product.safety_stock}（数据来源：commerce.queryProduct，采集时间：${product.collected_at}）`,
  ];

  if (orders.length > 0) {
    const pendingOrders = orders.filter((o) => o.status === 'pending');
    if (pendingOrders.length > 0) {
      facts.push(
        `有 ${pendingOrders.length} 条 pending 订单，总数量 ${pendingOrders.reduce((sum, o) => sum + o.quantity, 0)} 件（数据来源：commerce.queryOrders，采集时间：${orders[0].collected_at}）`,
      );
    }
    facts.push(
      `共 ${orders.length} 条订单记录（数据来源：commerce.queryOrders，采集时间：${orders[0].collected_at}）`,
    );
  } else {
    facts.push('无订单记录（数据来源：commerce.queryOrders）');
  }

  if (competitors.length > 0) {
    facts.push(
      `竞品价格：${competitors.map((c) => `${c.competitor_name} ${c.competitor_price}元`).join('、')}，我方售价 ${product.selling_price}元（数据来源：commerce.queryCompetitors，采集时间：${competitors[0].collected_at}）`,
    );
  } else {
    facts.push('无竞品价格数据（数据来源：commerce.queryCompetitors）');
  }

  // 推断与分析
  const inferences: string[] = [];
  const gap = product.safety_stock - product.stock;

  if (gap > 0) {
    inferences.push(
      `推断：低于安全线的差值为 ${gap} 件，值得进一步评估补货（前提：安全库存设置合理；采购数量仍需人工评估）`,
    );
    inferences.push(
      `推断：可能面临缺货风险（前提：销量与交付周期需联合评估；近7天销量 ${context?.sales_last_7d ?? '未知'}，交付天数 ${context?.lead_time_days ?? '未知'}，在途量 ${context?.inbound_stock ?? '未知'}）`,
    );
  }

  facts.push(
    `数据采集时间范围为 ${collected_at_range.earliest} 至 ${collected_at_range.latest}（数据来源：Detect 证据；不同采集时间不代表同时刻业务快照）`,
  );

  // 未知信息
  const unknowns: string[] = [];
  if (orders.some((order) => !order.placed_at))
    unknowns.push('订单下单时间（只有数据采集时间）');
  if (
    !context?.inventory_policy ||
    (context.inventory_policy === 'on_hand' &&
      context.reserved_stock === undefined)
  )
    unknowns.push('库存扣减时机（无法判断 pending 订单是否已占用库存）');
  if (context?.sales_last_7d === undefined) unknowns.push('历史销售趋势');
  if (context?.inbound_stock === undefined) unknowns.push('在途补货计划');
  if (context?.other_channel_reserved === undefined)
    unknowns.push('其他渠道库存占用');
  if (context?.lead_time_days === undefined || !context?.supplier_id)
    unknowns.push('供应商和补货周期');
  if (Date.now() - Date.parse(product.collected_at) > 86_400_000)
    unknowns.push('商品库存数据超过24小时，需要刷新');
  if (context) {
    facts.push(
      `业务口径数据来源 ${context.source}，观察时间 ${context.observed_at}：${JSON.stringify(context)}`,
    );
    if (Date.now() - Date.parse(context.observed_at) > 86_400_000)
      unknowns.push('业务口径数据超过24小时，需要刷新');
  }

  const investigateResult: InvestigateResult = {
    facts,
    inferences,
    unknowns,
  };

  const updatedWorkflow: EcommerceWorkflowState = {
    ...workflow,
    current_stage: 'investigate',
    investigate: {
      executed_at: now,
      investigate_result: investigateResult,
    },
    evidence_chain: [
      ...workflow.evidence_chain,
      {
        stage: 'investigate',
        timestamp: now,
        tool_calls: [],
        conclusion: `分析证据：${facts.length} 条确定事实，${inferences.length} 条推断，${unknowns.length} 条未知信息`,
      },
    ],
  };

  return updatedWorkflow;
}

/**
 * Decide 阶段：基于 Investigate 结论输出建议
 */
export function executeDecide(
  workflow: EcommerceWorkflowState,
): EcommerceWorkflowState {
  if (workflow.current_stage !== 'investigate') {
    throw new Error(
      `Cannot execute decide from stage: ${workflow.current_stage}`,
    );
  }

  if (!workflow.investigate || !workflow.detect) {
    throw new Error('Investigate or Detect stage result is missing');
  }

  const now = new Date().toISOString();
  const { product } = workflow.detect.detect_result;
  const { facts, unknowns } = workflow.investigate.investigate_result;

  const gap = product.safety_stock - product.stock;
  const recommendations: DecideResult['recommendations'] = [];

  if (gap > 0) {
    recommendations.push({
      action: 'consider_restock',
      reason: `建议：库存低于安全线 ${gap} 件`,
      constraints: [
        ...(unknowns.length ? ['需要先补充调查中列出的未知信息'] : []),
        '需要人工评估补货数量',
        '须经人工审批后进入独立的受控执行链路',
      ],
    });

    if (unknowns.length > 0) {
      recommendations.push({
        action: 'investigate_further',
        reason: `建议：补充调查，当前仍有 ${unknowns.length} 项待确认；未知项数量不能代替执行前的关键字段校验`,
        constraints: [...unknowns],
      });
    }
  } else {
    recommendations.push({
      action: 'monitor',
      reason: '建议：当前库存充足，继续监控',
      constraints: [],
    });
  }

  const decideResult: DecideResult = {
    recommendations,
  };

  const updatedWorkflow: EcommerceWorkflowState = {
    ...workflow,
    current_stage: 'completed',
    decide: {
      executed_at: now,
      decide_result: decideResult,
    },
    evidence_chain: [
      ...workflow.evidence_chain,
      {
        stage: 'decide',
        timestamp: now,
        tool_calls: [],
        conclusion: `输出 ${recommendations.length} 条建议（仅供参考，需人工审批）`,
      },
    ],
  };

  return updatedWorkflow;
}
