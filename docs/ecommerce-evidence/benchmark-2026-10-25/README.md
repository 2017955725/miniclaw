# 当前版本指标重测说明

本次使用真实本地 MySQL，样本为程序生成的合成测试数据，不是真实商家业务数据。项目名保留“电商零售经营决策 Agent”。没有以目标百分比筛选样本或调整样本长度。样本规模在运行前设为 120 商品、60 调查任务；订单量分层为 0/1/5/20/80 条，每层 12 个任务，竞品量为 0/1/3/5 条。没有调用 LLM。

## 本次结果

| 指标 | 基线 | 当前方案 | 变化 |
|---|---:|---:|---:|
| 60 个任务中的固定工具调用步骤 | 360 | 240 | 减少 33.33% |
| 同样 4 阶段工具请求/响应的 UTF-8 字节 | 2,504,295 | 341,806 | 减少 86.35% |
| 上述载荷的估算 Token 总量 | 626,213 | 85,594 | 减少 86.33% |
| 精确通过证据/分析/建议一致性检查的任务 | — | 60/60 | 确定性校验 |

保存的数据库工作区：`benchmark:2026-10-25:f623172d-e04f-42af-b579-27c16454315a`。其中有 120 商品、2544 订单、270 竞品记录、60 Workflow 和 240 历史快照。此前两次调试失败也各生成独立 benchmark 工作区，没有计入结果；不清理或修改用户已有工作区。

## 1. 调用次数怎么来的

基线是本次显式实现的对照策略，不是声称恢复了旧版本程序，也不是观察真实大模型自行产生的调用次数。

```text
基线（每任务6步）：start → 查商品 → 查订单 → 查竞品 → Investigate → Decide
当前（每任务4步）：start → advance(Detect合并取证) → advance(Investigate) → advance(Decide)
```

基线在 MySQL 实际查询，当前通过 createCommerceTools.handler → dispatchCommerceCommand → CommerceService 执行。进程内桥接代替文件 IPC，没有测文件 IPC 延迟或真实 SDK Agent Loop。阶段数量一致，查询 SKU 和原始业务数据一致，两支调用同一组调查与决策规则。基线的独立查询工具只存在于基准程序，不重新接入产品。

当前 Detect 内部仍查询商品、订单和竞品三类表。减少的是模型需要逐个发起的工具调用步骤，不是 SQL 数量。360→240 是固定策略下的可核验结构差异，不是模型自主调用效率统计。

## 2. 上下文怎么测

从当前 MySQL 中取出同一任务 monitor/detect/investigate/completed 四份状态；每阶段分别构造：

- 对照：请求回传上一份完整 Workflow，响应返回当前完整 Workflow；
- 当前：请求只传 operation、workflow_id、expected_revision，响应使用实际 workflowSummary（首个 start 保留 next_cursor）。

每份 JSON 请求与响应分别序列化并计一次，再合计。两侧使用相同快照、相同序列化和同一估算方法。这里没有把原始整库商品全部倒给模型来人为放大基线。

估算方法复用仓库的 estimatePromptTokens：`max(ceil(UTF-8字节数/4), 非ASCII字符数)`。这不是 tokenizer 精确计数，也不是模型账单。结果只能写“工具交互载荷估算 Token”，不能写“模型总 Token”“会话峰值上下文”“Pi compaction 节省”或“回答质量提高”。系统提示词、工具定义、完整历史反复传输、模型输出和协议开销不在该统计范围内。

订单越多，完整证据重复传输越大，所以收益有分布：订单0/1/5/20/80条的分层降幅分别为71.13%/71.52%/76.47%/85.74%/94.46%。86.33%仅适用于本次固定样本总体，不是生产普遍结论。

## 3. 正确性与限制

逐任务断言原始 Detect 商品/订单/竞品证据完全一致，Investigate 三类信息与 Decide 建议完全一致，证据链包含4阶段，返回摘要与MySQL权威字段一致。完整证据保留并可查。

摘要没有把完整订单列表交给模型，因此以上断言证明业务服务结果一致，不证明模型看到摘要后与看到明细后的语义分析能力一致。后者需要同模型、同提示词、多次真实运行及答案评分另测。

现有相关回归重新执行：`ecommerce-controlled`、`ecommerce-workflow-state`、`ecommerce-prompt-assembly`、`ecommerce-mysql.integration` 共4文件22测试通过。没有将2026-10-23的147项当成本次新跑数量。

## 4. 复现

脚本随结果保存为 ecommerce-benchmark.ts。它通过 Node 24 原生运行，加载当前已编译的 dist 模块；报告记录源码和执行模块各自 SHA-256。修改源码后先按项目构建方式更新后端与 Runner 编译产物。

项目根目录执行：

```powershell
node scripts/ecommerce-local.mjs start
$env:COMMERCE_BENCH_PROJECT = (Get-Location).Path
$env:COMMERCE_BENCH_OUTPUT = Join-Path (Get-Location).Path 'docs/ecommerce-evidence/benchmark-2026-10-25'
node scripts/ecommerce-benchmark.ts
```

每次生成独立工作区，不重置已有库存。连接信息只从 gitignored connection.json 或环境读取，结果不含密码。

## 5. 旧指标怎么处理

用户报告此前跑通过180→120和42,000→5,520。当前备份package.json仍能证明曾有benchmark:ecommerce入口，但本次未找到旧脚本与逐任务结果，不能从入口还原原统计口径。因此旧数字标为“用户报告的历史结果，旧原始证据待找回”，不判定为虚假，也不替换进当前版本实验。当前使用本次新样本实测结果。不能为复刻旧数字反向调整样本。
