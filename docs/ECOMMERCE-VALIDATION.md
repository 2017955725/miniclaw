# 电商改造验证记录

## 2026-10-23 清理后的当前验证

- 选定相关回归：147 项通过，失败 0，跳过 0；其中真实 MySQL 集成 7 项通过。不是全仓测试。
- 宿主和 Agent Runner 已重新编译，Web TypeScript 与 Vite 生产构建通过；Vite 仍有已有的大 chunk 提示。
- 旧 JSON Adapter、查询/Workflow/审批 IPC、simulation/external 执行器及其编译产物已删除。旧 benchmark 脚本已删除，不再用旧计数作当前指标。
- Workspace Memory 不返回 retrievalTrace，不再产生召回诊断日志/界面事件；SOP 保留来源引用，去除召回统计。
- 新增固定阶段、非法顺序、跨 SKU 证据拒绝、记忆总预算和超长记录保留等验证。
- 独立 MySQL 测试实例启动后重新运行确定性演示：SKU-002 库存 80，采购 70 后库存仍 80，到货后 150；同采购键重试返回原回执。未进行生产写入。

当前测试摘要见 [清理后回归证据](ecommerce-evidence/cleanup-tests-2026-10-23.json)，实际执行输出见 [清理后采购与到货演示](ecommerce-evidence/demo-cleanup-2026-10-23.json)。测试只清理自己生成的测试工作区；演示生成独立 demo 工作区并保留记录。原来已有工作区和数据库历史没有清空。

初次回归因测试实例未启动在初始化连接时失败；启动项目专属的本地测试实例后重新得到上述零失败、零跳过结果，没有把失败或跳过计作通过。

本次没有调用真实模型验证语义理解与工具选择，也没有生产平台执行；没有迁移整个宿主 SQLite 到 MySQL，没有实现自动压缩既有长记忆的服务。详见 [当前架构与理解说明](ECOMMERCE-CURRENT-ARCHITECTURE.md)。

## 2026-10-21 历史验证（清理前）

以下结果属于当时的测试范围和源码版本，其中一部分旧测试现已删除，不能替代上面的当前验证。

验证日期：2026-10-21。本记录针对本地源码与独立 MySQL 8.0.44 测试实例，不代表生产上线或真实模型成功率。

## 已执行的检查

| 检查                                              | 实际结果                                                             | 边界                                            |
| ------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------- |
| 电商、MCP、Pi、Runtime、Workspace Memory 相关回归 | 228 项通过，失败 0，跳过 0                                           | 是选定相关测试集，不是全仓全部测试              |
| 真实 MySQL 集成                                   | 7 项通过，包含并发、回滚、新连接恢复                                 | 使用独立本地测试库，不使用现有 MySQL80 业务数据 |
| HTTP 路由                                         | 4 项通过，检查工作区权限、身份来源及越权拒绝                         | 登录依赖有 mock，不是浏览器真实登录端到端测试   |
| 电商页面 DOM                                      | 1 项通过，检查具体采购方案及审批理由                                 | happy-dom 组件测试，不代表完整浏览器交互已验收  |
| 宿主 TypeScript                                   | `tsc` 通过                                                           | 编译检查                                        |
| Agent Runner TypeScript                           | `tsc -p container/agent-runner/tsconfig.json` 通过                   | 新工具已编译；已有运行中的进程仍需重启          |
| Web TypeScript                                    | `tsc --noEmit -p web/tsconfig.json` 通过                             | 类型检查                                        |
| Web 生产构建                                      | `vite build --configLoader native` 通过                              | 存在大 chunk 体积警告，不影响本轮构建成功       |
| 确定性采购演示                                    | 库存 80 → 建采购单仍为 80 → 到货入库后 150                           | 70 是显式选择的测试数量，不是模型优化预测       |
| MySQL 进程停止、启动、恢复                        | 7 个 Workflow 历史版本恢复；原采购及收货键重试返回原回执，库存仍 150 | 正常停止与重启，不是断电或崩溃恢复测试          |

采购与到货过程的实际输出见 [演示证据](ecommerce-evidence/demo.json)，重启后的断言结果见 [恢复证据](ecommerce-evidence/restart.json)，测试计数见 [回归摘要](ecommerce-evidence/tests.json)。文件不包含数据库凭据。Workflow 的演示快照采集于采购前；采购、收货回执描述其后的写入，因此不要将其中旧库存当成当前库存。

## 关键业务不变量

- 未审批不建采购单；审批使用旧 revision 时不能覆盖新状态。
- 补充信息后重查同一个任务；旧审批失效，各历史版本保留。
- 库存或业务口径版本变化、数据过期、审批过期时拒绝执行。
- 已知零值不是未知；一项关键口径缺失也会阻止提交采购。
- 同幂等键同参数返回原回执；同键异参数拒绝；已执行审批换键不能再执行。
- 采购时增加在途量；到货时才增加库存并生成唯一流水。
- 在途量不能被人工改到未到货采购单总量以下。
- 采购或到货不会延长旧销量、供应商口径的观察时间。
- 在采购回执插入时注入故障，采购单、在途量及审批执行状态一起回滚。
- 不同工作区无法读取或修改彼此的任务；模型不能传入审批身份或完整伪造状态。
- `prod` 被拒绝；测试数据库只能连接本机专用命名的库。

## 复现方式

在项目根目录、同一个 PowerShell 窗口执行：

```powershell
. .\scripts\start-ecommerce-test.ps1
npm run ecommerce:test
npm run ecommerce:demo
```

本次相关回归测试集：

```powershell
npx vitest run tests/mcp tests/pi tests/runtime tests/ecommerce tests/routes-ecommerce.test.ts tests/routes-workspace-memory.test.ts tests/workspace-memory-runtime.test.ts
```

MySQL 集成测试在没有连接配置时明确 skip，本次是在数据库运行且可连接时得到零跳过结果。正常脚本可在本机离线使用；npm 依赖需预先安装。

## 本次没有验证的内容

没有调用真实模型评价工具选择与多轮成功率，没有运行真实 ERP/供应商/平台接口，没有真实用户、生产并发、经营收益或业务准确率数据。没有对 Milvus、Redis、向量召回或 LLM Wiki 做性能比较，因为本轮没有引入这些服务。实际部署、细粒度审批角色、部分收货、外部系统一致性和运维指标仍见 [生产化缺口](ECOMMERCE-UPGRADE.md#生产化还需要什么)。
