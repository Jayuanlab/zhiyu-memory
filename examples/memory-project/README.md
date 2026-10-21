# 独立研发项目：R / K / U 接入示例

这是一个独立 Node 项目消费者。实现只依赖通用记忆包、PostgreSQL Adapter 和 Node；不导入知语、Next.js、Work、Loop 或应用数据库。它没有知语旧表的共享租户权限；进程内和 G5 可选远程入口分开启动。

## 三层装配

| 层 | 文件 | 责任 |
| --- | --- | --- |
| 通用核心 | `packages/memory/src/knowledge.ts` | 候选、审核/修订、精确来源、召回、ContextPack 和服务端封装的出站 |
| 通用存储 Adapter | `packages/memory-postgres/src/knowledge.ts` | 带 namespace 的当前记录、只追加历史/审核、命令去重和事务审计 |
| 项目 Adapter | `knowledge-project.ts` | 认证会话、项目成员和来源权限、文档版本、登记消费者；组合已有观测 R client |
| 业务策略 | `policy.ts` | 构建日志 2 小时窗口、团队规则默认 90 天/最大 180 天复查；未知与运行日志不能作为长期理解准入 |

`initializeDevelopmentProject(sql)` 是新部署的显式初始化，不在请求中自动执行。项目自己从已认证登录会话调用 `issueAuthenticatedSession`；该服务端函数不能暴露给请求 JSON。`forSession(session)` 返回知识 client 及 `records` 观测 client。

知识 client 提供 `execute`、`read`、`evidence`、`recall`、`dispatch` 和实际能力声明。命令为 `interpretation.propose/review/revise/retire`，使用 `general-memory.v1-draft` 信封；具体字段以 `knowledge-contracts.ts` 和严格解析实现为准。它是独立的知识能力 facet，未替换知语旧 DTO，也未强迫观测 client 接受新命令。

候选固定 namespace、来源版本、Unicode code-point 摘录、条件与反例。审核需要当前版本、原因、显式证据确认及当前审核权限；修订创建新候选，旧版退役，保留历史且不延长原期限。到期后不能换 commandId 续期，需要新证据、显式提案和再次审核。文档版本覆盖实际正文、来源版本、时间与期限，正文在摘录以外变化也能阻断。

`read(current)` 是治理读取，不等于准入；历史回执也不证明当前有效。治理读取、回执查询和命令重放仍检查当前项目与来源权限，不能借历史结果读回已撤权的摘录。

`recall` 返回有界 ContextPack，区分理解、限制和固定来源证据；本示例没有权威 CI 当前状态，因此 `currentStates` 为空，不将旧构建日志当成当前状态。完整限制不能裁掉；正文裁剪显式标注，预算单位是 UTF-8 字节上界。

只有本次服务端签发且未被改写的 Pack 才能交给 `dispatch(pack, "demo.local-model")`。复制 JSON、其他项目 Pack 或未登记消费者都拒绝。每次调用重新核验记录、来源、期限、权限和审计提交，提交后才交给登记消费者。该消费者合同是一条逻辑模型请求：不得在 `send` 中隐式启动多轮/重试；需要多轮时逐次调用受保护入口。业务动作权限不随记忆传递。

准入、已交付和结果未知分别追加审计；交付或后续审计异常返回 `dispatch_outcome_unknown` 并携带 `admissionId`，不自动重发。用 `read({purpose: "use_receipt", receiptId: admissionId})` 查询历史使用结果；查询绑定当前 namespace 与 principal，不因知道 ID 就能读取其他项目或人的回执。只有 admitted 记录时只证明准入，不能据此推断未发送。已送出的正文不能撤回；核验承诺截止于交付准入，不承诺网络调用期间权威状态永不变化。

## 单独运行验收

先由测试管理者创建一个可删除的隔离 PostgreSQL 数据库，将连接通过 `MEMORY_DEMO_DATABASE_URL` 提供，再从仓库根目录运行：

```sh
node --import tsx examples/memory-project/acceptance.ts
node node_modules/typescript/bin/tsc -p packages/memory/tsconfig.json
```

验收入口强制使用 `zhiyu_test_<32位十六进制>` 名称的临时库，这是测试删除保护，不是运行时接入格式。它只初始化通用与示例表，不运行知语迁移；只发送合成内容到进程自己启动的 loopback HTTP 接收器，不调用真实模型。可用 `MEMORY_DEMO_RESULT` 指定 JSON 结果路径。数据库的创建与删除由外层测试管理者完成，运行时不会创建或删除用户数据库。

正向闭环和跨项目/跨租户、伪造身份、未注册来源、错误摘录、来源变化、撤权、到期、幂等、审计提交失败及恢复均在 `acceptance.ts` 验证。G5 的远程进程验收另见下文；本次没有部署公开多租户产品或新增管理 UI。

## G5 远程接入

在 G4 同一核心与研发 Adapter 上，`apps/service/main.ts` 提供独立 Node HTTP 入口，`apps/service/admin.ts` 提供本地管理员初始化、发证、改权和撤权。接入步骤、凭证保存、路由、状态对账与部署边界见 [远程接入协议](../../docs/protocol.md)。`service-acceptance.ts` 用两个独立进程共享新测试库，验证完整治理与最终使用，不依赖知语启动或应用迁移。上述 G4 进程内示例仍保持有效；跨进程不要序列化进程内证明。
