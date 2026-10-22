# Zhiyu Memory 调用参考

本参考针对 `general-memory.v1-draft` 标准接口及 `general-memory.project.http.v1` 安装模式。每次以实际服务的 capabilities 和宿主项目配置为准。这里的 ID、来源引用、namespace 和时间示例需要替换为真实值。

## 脚本与连接

Node.js 客户端只依赖标准库。参数为 `--config 项目配置.json`，加以下一项操作：

| 操作 | 其他参数 | 行为 |
| --- | --- | --- |
| `capabilities` | 无 | GET `/v1/capabilities`，核对 namespace 和模式 |
| `request 路由` | `--body-file 请求.json` | POST 允许的普通接口，打印 JSON 响应 |
| `prepare` | `--body-file 请求.json --use-file 新私有文件.json` | 保存绑定当前服务与 namespace 的使用凭证，只打印脱敏后的凭证信息和 Pack |
| `dispatch` | `--use-file 私有文件.json` | 同一使用文件只尝试一次，发出前持久化标记 |
| `status` | `--use-file 私有文件.json` | 使用原 credential、consumerId、purpose 查询交付状态 |

profile 字段为 `baseUrl/tokenEnv/expectedNamespace`，可选 `mode`（standard 默认，或 installed）及 `timeoutMs`（默认 20000，最大 120000）。`expectedNamespace` 含 tenantId 和 projectId。tokenEnv 是宿主已设置的环境变量名，值为服务签发的身份令牌。密钥不放在 profile、命令行或正文里。

所有业务请求之前先核对 capabilities。标准模式取 `namespace`；installed 模式取顶层 tenantId/projectId。模式和预期项目不一致时客户端不发送后续 POST。脚本的超时是整个 HTTP 响应的上限；冷向量缓存可能需要更久，可按项目情况调整。服务拒绝重定向；普通模式请求体上限 256 KiB、installed 模式 1 MiB，脚本响应体上限 8 MiB。

`--use-file`、其临时文件及 `.lock` 放在宿主保护的目录；POSIX 文件模式不能替代 Windows 目录 ACL。交付尝试后即使失败也保留尝试标记，避免客户端不知道是否发出时重复交付。锁文件或尝试状态异常时核对宿主任务与接收端，不通过删文件绕过。

## 原始记录 R

POST `/v1/records/commands`：

```json
{
  "protocolVersion": "general-memory.v1-draft",
  "kind": "observation.append",
  "commandId": "<稳定命令ID>",
  "payload": {
    "source": {"sourceId": "<已登记来源>", "externalId": "<真实事件ID>"},
    "observedAt": "2026-10-21T08:00:00Z",
    "content": "发布前必须运行测试。"
  }
}
```

observedAt 使用事件实际时间。source 可选 version；payload 可选 extensions。保存成功检查 status 为 committed，保留 receipt、ref、commandId 及完整请求；精确读取向 `/v1/records/query` 发送 `{purpose:"current",ref:保存响应的 ref.record}`。结果不明时用同一路由的 `{purpose:"receipt",commandId}` 核对。

原始记录不会自动提炼、审核或进入向量召回。默认研发装配只有 `demo.build` 原始来源；K 使用 `demo.document`，其文档和授权须由项目适配层提供。不存在通用 HTTP 上传文档或注册来源接口，R 的 source 也不能直接当作 K 的 sources。

## 长期知识 K

POST `/v1/commands` 统一使用 `{protocolVersion,kind,commandId,payload}`，protocolVersion 为 `general-memory.v1-draft`。支持的 kind 只有：

| kind | payload |
| --- | --- |
| `interpretation.propose` | recordType、scope、subject、content、conditions、counterexample、tags、sources；可选 reviewBy |
| `interpretation.review` | id、expectedVersion、decision（accept/reject）、reason；accept 需真实 evidenceConfirmed:true |
| `interpretation.revise` | id、expectedVersion、reason、content、conditions、counterexample、sources |
| `interpretation.retire` | id、expectedVersion、reason |

字符串为非空，tags 为数组。每条提案须有 1 至 8 个真实来源引用。审核需要 review 权限，修订和退役需要 revise 权限；不要假定写入凭证具有审核权限。

### 来源引用

KnowledgeSourceRef 的完整结构如下，示例引用全文“发布前必须运行测试。”的 10 个 Unicode code points：

```json
{
  "namespace": {"tenantId": "<当前租户>", "projectId": "<当前项目>"},
  "sourceId": "<已登记知识来源>",
  "id": "<真实来源文档ID>",
  "version": "<来源适配层返回的完整版本>",
  "range": {"start": 0, "end": 10, "unit": "unicode_code_points"},
  "quote": "发布前必须运行测试。"
}
```

引用 namespace 与认证项目一致，不用于切换身份；顶层命令不传 namespace。range 左闭右开，摘录等于 `Array.from(原文).slice(start,end).join("")`，保持原始换行及 emoji。version 由来源适配层提供，不能猜成 v1；默认示例版本覆盖完整正文、版本、时间和期限。

### 提案与审核示例

按真实来源替换各占位符后，可提交以下完整提案命令：

```json
{
  "protocolVersion": "general-memory.v1-draft",
  "kind": "interpretation.propose",
  "commandId": "<稳定提案命令ID>",
  "payload": {
    "recordType": "team_rule",
    "scope": "pipeline",
    "subject": "生产发布前检查",
    "content": "发布前必须运行测试。",
    "conditions": "进行生产发布时适用。",
    "counterexample": "仅修改文档且不进行发布。",
    "tags": ["team-rule"],
    "sources": [{
      "namespace": {"tenantId": "<当前租户>", "projectId": "<当前项目>"},
      "sourceId": "<已登记知识来源>",
      "id": "<真实来源文档ID>",
      "version": "<来源适配层返回的完整版本>",
      "range": {"start": 0, "end": 10, "unit": "unicode_code_points"},
      "quote": "发布前必须运行测试。"
    }]
  }
}
```

默认研发策略只对真实 team-rule 接受长期候选，默认 90 天复查、最大 180 天；其他知识类型由项目策略定义，不改标签绕过分类。

命令返回 `{status:"committed",outcome,receipt,replayed}`，记录在 receipt.record 或 outcome，没有顶层 record。通常提案状态为 candidate；去重可能返回已有记录，按实际状态处理。审核必须基于当前 ID 和 version，例如：

```json
{
  "protocolVersion": "general-memory.v1-draft",
  "kind": "interpretation.review",
  "commandId": "<稳定审核命令ID>",
  "payload": {
    "id": "<receipt.record.id>",
    "expectedVersion": "<receipt.record.version>",
    "decision": "accept",
    "reason": "已核对当前原文、条件与反例。",
    "evidenceConfirmed": true
  }
}
```

实际核验且权限通过后，确认 receipt.record.status 为 verified。历史回执不能证明当前有效。修订创建新 candidate，旧条目立即 superseded；新版本需再次审核，并继承原 reviewBy，不自动续期。带 previousId 的修订候选直接 reject 会返回 revision_required。

读取当前状态：POST `/v1/read`，正文 `{purpose:"current",id}`，返回 `{status:"ok",record,receiptId,useSemantics:"governance_only"}` 或 `{status:"not_found"}`。知识命令回执使用同一路由的 `{purpose:"receipt",commandId}`。固定来源摘录核验使用 POST `/v1/evidence` 的 `{ref:完整来源引用}`。

## 召回与上下文

POST `/v1/recall`：

```json
{
  "scope": "pipeline",
  "query": "上线前需要做哪些检查？",
  "maxBytes": 16384,
  "retrieval": {"mode": "hybrid", "minSimilarity": 0.5}
}
```

maxBytes 为 UTF-8 字节上界，范围 512 至 65536。Pack 中 budget.maxTokens 的单位仍是 budget.unit 所示的字节上界。检索模式须由 capabilities.retrieval.modes 支持：

- keyword：scope 下最多 100 条候选，正文包含完整 query 的优先，未命中的有效知识也可能补入；不接受 minSimilarity。
- vector：普通知识的余弦相似度达到阈值才入选。
- hybrid：达到阈值，或正文完整文本命中；排序分为余弦相似度加文本命中的 0.25。

阈值允许 [-1,1]，默认 0.3，按实际模型选择。未配置模型明确请求语义模式时返回 semantic_search_unavailable。合格知识首次语义召回时生成并缓存向量；候选、失效来源和原始记录不会因此获得召回资格。

Pack 本体含 constraints、interpretations、historicalEvidence、currentStates、omissions、openQuestions、budget，诊断被限额时另含 omissionSummary。保留全部 constraints；理解 conditions/counterexample，检查截断标记。默认 currentStates 为空，历史证据不能当当前业务状态。语义模式保留全部有效约束及最多 12 条普通知识；约束预算不足会明确失败。

## 受控交付 U

通过专用 prepare 子命令把下列 JSON 送到 `/v1/use/prepare`，不要先单独 recall 再上传 Pack：

```json
{
  "recall": {
    "scope": "pipeline",
    "query": "上线前需要做哪些检查？",
    "maxBytes": 16384,
    "retrieval": {"mode": "hybrid", "minSimilarity": 0.5}
  },
  "consumerId": "<已登记消费者>",
  "purpose": "release-check"
}
```

响应 `{pack,use}`，use 含 credential、consumerId、purpose、expiresAt、packHash。脚本将凭证保存到私有文件并绑定服务地址、namespace，控制台只展示脱敏元数据。purpose 用于绑定和审计，不是自动传给模型的任务正文；接收者如何组合 Pack 与任务由项目网关负责。

dispatch/status 子命令从文件读取 credential、consumerId、purpose，分别调用 `/v1/use/dispatch`、`/v1/use/status`。使用凭证 60 秒、单次使用，绑定原身份和固定服务端快照。dispatch 请求不能添加 Pack 或 URL；最终核验通过后才交给登记消费者。空 Pack 交付返回 empty_context。

普通召回 JSON 仅供检查，服务外自行发送的链路不受 U 最终核验和审计保护。dispatched 只说明消费者返回成功，模型采纳或业务效果需另外确认。

## 异常与恢复

| 情况 | 处理 |
| --- | --- |
| R/K 命令网络结果不明 | 查询原 commandId 的回执，或同 ID 同正文重放；脚本不自动重试 |
| idempotency_conflict | 检查原请求和回执，不盲目换 ID 重复动作 |
| version_conflict | 读取当前版本，重新决策；变更后的命令是新操作 |
| 401 或 403 | 按当前身份停止相应操作，由宿主处理凭证或真实授权 |
| source_changed/evidence_mismatch/source_expired/expired/policy_changed | 获取当前依据，再按项目流程提案、修订和审核 |
| policy_rejected/unsupported_source/unsupported_capability | 检查真实策略和登记能力，不能伪造来源或类型 |
| budget_exceeded | 在允许范围内调整预算或由项目处理，保留完整约束 |
| 读取或模型提供方故障 | 报告不可用，不解释成空记忆；按宿主有限重试策略处理 |
| dispatch 响应丢失、超时、dispatch_outcome_unknown | 用原使用文件查询 status；不要自动重发或另行 prepare |

status 的 state 为 issued、expired、admitted、dispatched 或 outcome_unknown，并含 admissionId。issued 仍可能有请求在途；admitted/outcome_unknown 可能已经发送，需要核对消费者；expired 也要先核清先前请求。历史使用审计可向 `/v1/read` 发送 `{purpose:"use_receipt",receiptId:admissionId}`。

## 已安装项目模式

profile 的 mode 设为 installed。GET capabilities 返回 `protocol:"general-memory.project.http.v1"`、顶层 tenantId/projectId 和 project 能力声明。只通过 `request /v1/project/call --body-file ...` 调用宿主明确提供的 `{operation,input}`。不要猜操作名，标准 R/K/U 路由在此模式下不可用。

该模式项目业务库与身份审计库之间没有分布式事务，操作响应丢失或结果未知时按模块的业务回执核对，不能自动重发。向量能力也由安装模块自身提供，不能仅设置默认服务的 embedding 环境变量就声称已启用。
