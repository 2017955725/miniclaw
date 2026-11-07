/**
 * 电商 Workflow 状态定义
 *
 * Monitor → Detect → Investigate → Decide 四阶段异常调查流程的状态和证据存储。
 */

export type WorkflowStage =
  | 'monitor'
  | 'detect'
  | 'investigate'
  | 'decide'
  | 'completed'
  | 'failed';

export interface MonitorResult {
  timestamp: string;
  total_products: number;
  low_stock_products: Array<{
    sku: string;
    name: string;
    stock: number;
    safety_stock: number;
    gap: number;
  }>;
}

export interface DetectResult {
  sku: string;
  product_version?: number;
  /** Trusted business-system inputs, not values inferred by the model. */
  business_context?: {
    source: string;
    observed_at: string;
    inventory_policy?: 'available_net_of_reservations' | 'on_hand';
    reserved_stock?: number;
    inbound_stock?: number;
    other_channel_reserved?: number;
    sales_last_7d?: number;
    supplier_id?: string;
    lead_time_days?: number;
  };
  product: {
    sku: string;
    name: string;
    stock: number;
    safety_stock: number;
    cost_price: number;
    selling_price: number;
    data_source: string;
    collected_at: string;
  };
  orders: Array<{
    order_id: string;
    sku: string;
    quantity: number;
    amount: number;
    status: string;
    data_source: string;
    collected_at: string;
    placed_at?: string;
  }>;
  competitors: Array<{
    sku: string;
    competitor_name: string;
    competitor_price: number;
    data_source: string;
    collected_at: string;
  }>;
  collected_at_range: {
    earliest: string;
    latest: string;
  };
}

export interface InvestigateResult {
  facts: string[]; // 确定事实（带来源和时间）
  inferences: string[]; // 推断（带前提条件）
  unknowns: string[]; // 未知信息
}

export interface DecideResult {
  recommendations: Array<{
    action: 'monitor' | 'consider_restock' | 'investigate_further';
    reason: string;
    constraints: string[];
  }>;
  no_action_reasons?: string[];
}

export interface EvidenceChainEntry {
  stage: WorkflowStage;
  timestamp: string;
  tool_calls: Array<{
    tool: string;
    params: Record<string, unknown>;
    result_summary: string;
  }>;
  conclusion: string;
}

export interface EcommerceWorkflowState {
  workflow_id: string;
  workspace_jid: string;
  created_by: string;
  created_at: string;
  current_stage: WorkflowStage;

  monitor?: {
    executed_at: string;
    low_stock_count: number;
    selected_sku?: string;
    monitor_result: MonitorResult;
  };

  detect?: {
    executed_at: string;
    sku: string;
    detect_result: DetectResult;
  };

  investigate?: {
    executed_at: string;
    investigate_result: InvestigateResult;
  };

  decide?: {
    executed_at: string;
    decide_result: DecideResult;
  };

  evidence_chain: EvidenceChainEntry[];
}
