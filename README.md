# Zhiyu Memory · 独立记忆服务

面向智能体和业务项目的可追溯记忆服务。它保存原始观测，将有依据、经审核的理解作为长期知识，按任务生成有界 ContextPack，并在交给登记消费者前重新核验来源、权限和期限。

智能体接入与调用请先阅读 [记忆服务智能体使用说明](docs/agent-guide.md)，了解能力发现、写入审核、向量召回、受控交付和失败恢复。仓库的 [AGENTS.md](AGENTS.md) 提供文档入口；部署与项目适配继续按下文进行。

也可使用仓库内的 [zhiyu-memory Skill](skills/zhiyu-memory/SKILL.md)：整个目录可复制到宿主技能目录，包含独立 Node.js 调用脚本、项目配置模板和协议参考，不依赖仓库运行路径。配置当前项目的服务地址、预期 namespace 和凭证环境变量后，可用 `$zhiyu-memory` 发起记忆任务；服务部署和来源接入仍需先完成。

Windows 本机实例的启动、停止、Skill 配置和真实模型验收见 [本机部署说明](docs/local-runtime.md)。本机方案使用独立 Docker PostgreSQL 与本地多语言 ONNX 模型，配置和凭证保存在忽略目录中。

传统项目首次接入可使用独立的 [zhiyu-memory-onboarding Skill](skills/zhiyu-memory-onboarding/SKILL.md)：评估业务场景与记忆机会、设计来源和权限适配、实施验证单个场景。使用示例和能力范围见 [项目接入 Skill](docs/memory-onboarding.md)，日常记忆读写仍使用 `zhiyu-memory`。

从知语项目提取，独立安装、独立 Node 进程运行、使用自己的 PostgreSQL 数据库；运行不需要知语、Next.js、Brain、Work 或 Loop。当前为 **0.1.0 / v1-draft**，保留 `@openzhiyu/memory` 包名便于追溯，尚未发布 npm 包。知语现有部署继续使用本地 Adapter，此仓库的创建不会自动切换它。

## 为什么需要它

消息、日报、检查点和行情快照通常是有时效的运行记录。只有提炼出的规则、偏好或经验满足来源、适用条件、审核与复查要求，才应进入长期知识。召回到一条记忆也不代表它仍然有效，更不代表它授予了业务动作权限。

本项目把保存、理解、使用分开治理：

| 层 | 保存什么 | 如何使用 |
| --- | --- | --- |
| 原始观测 R | 来源标识、原文、时间、固定版本和写入回执 | 精确读取、幂等保存；不会自动成为长期知识 |
| 知识治理 K | 候选、适用条件、反例、审核、修订与依赖 | 来源变更、撤权、退役或到期时阻断使用，历史仍可追溯 |
| 上下文使用 U | 固定 ContextPack、使用凭证、准入与交付审计 | 最终重验后单次交付登记消费者；结果未知时对账，不自动重发 |

预算单位为 **UTF-8 字节上界**。完整安全限制不能被裁剪；限制本身放不下时明确拒绝。辅助内容裁剪必须显式标记。知语页面的自适应预算选择属于其项目 Adapter，此独立服务的 HTTP 召回使用显式 `maxBytes`。

## 架构与责任

```mermaid
flowchart LR
  Client[其他项目 / Node 客户端] --> HTTP[认证 HTTP 入口]
  Admin[本地管理员 CLI] --> Auth[身份凭证 / 权限纪元]
  HTTP --> Auth
  HTTP --> Core[通用核心：观测 / 审核修订 / 依赖 / 召回]
  Project[项目适配：身份成员 / 来源版本与权限] --> Core
  Policy[业务策略：分类 / 准入 / 复查期限] --> Core
  Core --> DB[(独立 PostgreSQL)]
  Core --> Pack[固定 ContextPack / 一次性使用凭证]
  Pack --> Gate[出站重验 / 原子准入]
  Auth --> Gate
  Project --> Gate
  Gate --> Consumer[登记消费者]
  Consumer --> Audit[交付 / 结果未知回执]
  Audit --> DB
```

通用核心定义协议和安全不变量；项目适配层提供真实身份、成员、可核验来源与登记消费者；业务策略层决定该项目哪些内容可长期保留、多久复查。仅满足 JSON 存储格式不足以完成接入。

当前默认装配使用研发项目示例：`demo_dev_*` 成员/文档/授权表、`demo.document` 来源与 `demo.local-model` 消费者。其他项目替换这些实现，沿用核心接口和测试。完整源码入口见下表。

| 路径 | 职责 |
| --- | --- |
| `packages/memory/src` | 协议、观测、策略、治理、ContextPack、使用准入、HTTP 客户端/服务端 |
| `packages/memory-postgres/src` | namespace 隔离存储、事务、幂等回执、身份及使用凭证 |
| `apps/service/main.ts` | 独立进程装配与启动；当前只监听回环地址 |
| `apps/service/admin.ts` | 本地初始化、发证、改权、撤权 |
| `examples/memory-project/knowledge-project.ts` | 可替换的项目 Adapter 与显式建表入口 |
| `examples/memory-project/policy.ts` | 研发项目示例策略，不作为所有业务的默认规则 |
| `examples/memory-project/*acceptance.ts` | 真实 PostgreSQL、隔离租户、跨进程完整验收 |

## 快速开始

需要 Node.js **22.19+**（CI 使用 24）、npm 和 PostgreSQL **16+**。使用独立数据库；管理员先建立空库与专用账号，再注入连接。`.env.example` 只说明配置，程序不会自动加载 `.env`。

```powershell
git clone https://github.com/Jayuanlab/zhiyu-memory.git
cd zhiyu-memory
npm ci
npm run check

# 按本地 PostgreSQL 设置替换示例连接，勿提交真实凭据。
$env:MEMORY_SERVICE_DATABASE_URL = 'postgres://memory:change-me@127.0.0.1:5432/memory'
$env:MEMORY_SERVICE_PORT = '3640'
$env:MEMORY_SERVICE_CONSUMER_URL = 'http://127.0.0.1:3641/model'
npm run admin -- init
npm run demo:seed
```

`init` 显式建立通用表和示例 Adapter 表，不运行知语迁移。`demo:seed` 只为合成演示建立一个无审核权限的成员，并把一小时身份凭证写入 `private/demo-credential.json`，不输出令牌。目录被 Git 忽略；Windows 请使用仅当前操作员可访问的目录 ACL。重复 seed 会因凭证文件已存在而拒绝覆盖；到期后由管理员撤销旧凭证并归档旧文件后再签发。

保持环境配置，在三个终端分别运行：

```powershell
# 终端 A：合成接收器，不调用模型或业务工具
npm run demo:receiver

# 终端 B：环境变量与上面的初始化终端相同
npm start

# 终端 C：保存一条中文观测、精确读取，并验证重复提交只产生同一个回执
npm run demo:client
```

服务输出 `{"ready":true,"port":3640,...}` 表示必需表已存在且监听成功。缺少连接、消费者或表时不会报告 ready。终端 C 成功返回 `saved/exactRead/idempotentRetry: true`。这一步验证原始观测闭环；审核、修订、召回和最终使用由下面的完整验收覆盖，不把原始观测自动升格为长期知识。

Linux/macOS 用 `export NAME=value` 注入相同环境。停止服务使用 Ctrl+C。演示接收器只是核对交付的本地端点，不是管理界面或生产模型网关。

## 跑通完整闭环

提供有创建和删除临时数据库权限的 **测试专用** PostgreSQL 管理连接：

```powershell
$env:MEMORY_TEST_ADMIN_URL = 'postgres://test_admin:change-me@127.0.0.1:5432/postgres'
npm run test:integration
```

测试管理脚本分别建立随机 `zhiyu_test_<32位十六进制>` 临时库；用真实 SQL、多个独立服务进程和本地合成消费者，验证候选准入、人工审核、修订、依赖变化、召回、ContextPack、跨进程幂等、共享租户隔离、身份/来源撤权、到期、锁等待期间到期、重启和交付结果未知。结束时删除临时库，结果位于忽略的 `.runtime/`。不使用日常数据库，不调用真实模型。

`npm run check` 包括 TypeScript、核心单元测试、应用依赖隔离和文档 UTF-8 检查。GitHub Actions 为每次 push/PR 运行相同检查和隔离数据库验收；流程不上传构建产物。当前直接通过 tsx 执行 TypeScript，没有生成历史构建目录。

## 其他项目如何接入

1. 为项目配置受信身份认证，绑定 `tenantId/projectId/principalId`；namespace 由服务端确定，不信任请求体。
2. 实现项目成员授权和来源读取：当前版本、完整正文、授权、时间、期限必须可重新核验。未注册来源不得通过。
3. 实现业务分类/准入/生命周期策略。运行记录与长期知识分开，未知内容不能默认长期准入。
4. 登记受保护的消费者和固定交付位置；客户端不能自行提供 URL 或可替换的 Pack。
5. 显式初始化数据库，给提案者和审核者签发最小权限身份凭证，并验证隔离与失效场景。

审核入口为认证的 `interpretation.review` 命令，当前没有独立审核 UI；产品应在自己的审核页面展示来源、适用条件、反例和当前版本。修订创建新候选并保留历史。停用由退役命令、来源/成员撤权或身份撤销控制。运行记录的分类期限由项目策略处理，通用核心不擅自清理业务事实。

## HTTP 与客户端

所有请求使用 `Authorization: Bearer <身份凭证>`，POST 为 UTF-8 JSON，最大 256 KiB。拒绝未知字段、环境浏览器身份和 Origin 请求；客户端用于受信服务端调用，不将令牌放入浏览器前端。

| 路由 | 用途 |
| --- | --- |
| GET `/v1/capabilities` | 实际启用的能力、来源、策略和消费者 |
| POST `/v1/records/commands`、`/v1/records/query` | 观测保存、精确读取与回执 |
| POST `/v1/commands` | `interpretation.propose/review/revise/retire` |
| POST `/v1/read`、`/v1/evidence` | 治理读取、固定来源版本摘录与回执 |
| POST `/v1/recall` | 按 scope/query/maxBytes 获取展示用 ContextPack |
| POST `/v1/use/prepare` | 为服务端固定快照签发短期一次性使用凭证 |
| POST `/v1/use/dispatch`、`/v1/use/status` | 出站重验、交付和状态对账 |

```typescript
import { createRemoteMemoryClient } from './packages/memory/src/http';

const client = createRemoteMemoryClient('http://127.0.0.1:3640', privateToken);
const { pack, use } = await client.request('/v1/use/prepare', {
  recall: { scope: 'pipeline', query: 'retry', maxBytes: 16384 },
  consumerId: 'demo.local-model', purpose: 'ci-review',
});
// pack 供展示；实际交付内容取自服务端固定快照。
await client.request('/v1/use/dispatch', {
  credential: use.credential, consumerId: use.consumerId, purpose: use.purpose,
});
```

此例需要事先准备并审核通过的知识、来源授权与使用权限。只有序列化 Pack 不具备出站权限。客户端不自动重试交付；遇到 `dispatch_outcome_unknown`，按原凭证和 `admissionId` 查询状态，避免重复发送。

详细命令、身份管理与恢复流程见 [远程接入协议](docs/protocol.md)，[项目 Adapter 示例](examples/memory-project/README.md) 和 [提取与验证说明](docs/extraction.md)。TypeScript 类型和严格解析器是具体字段的依据。

## 向量与混合检索

可通过 `MEMORY_EMBEDDING_URL`、`MEMORY_EMBEDDING_MODEL`、`MEMORY_EMBEDDING_DIMENSIONS` 配置 embedding 服务，按需注入 `MEMORY_EMBEDDING_API_KEY`。默认研发服务配置后启用混合召回；未配置时保持原有关键词模式。调用方可在 `/v1/recall` 或 `/v1/use/prepare` 的召回参数中传入 `retrieval: { mode: "vector", minSimilarity: 0.65 }`，按余弦相似度过滤知识。

向量缓存保存在 PostgreSQL，旧知识首次语义召回时自动补齐；模型或正文变化后重新生成。向量/混合模式分页遍历 scope，保留审核、来源、权限、到期核验和完整安全约束。当前使用精确扫描，无需 pgvector；首次构建缓存和大范围召回会增加耗时。初始化升级、配置、模式差异和自定义项目接入见 [向量检索说明](docs/semantic-search.md)。

## 身份与运行边界

已有业务项目的兼容部署可安装受信项目模块，并使用独立身份/传输审计库；见[项目安装与监督部署](docs/installed-projects.md)。此模式按安装模块声明实际覆盖范围，不能把默认研发示例的表直接作为已有项目的数据迁移。

- 身份令牌为随机 256 位，数据库仅存摘要；绑定 namespace、principal、允许/拒绝权限、期限及权限纪元。`denied` 优先。
- 本地 `npm run admin -- issue <私有JSON文件>` 发证；`permissions` 改权；`revoke` 撤权。字段见协议。HTTP 不提供管理后门，发证也不会自动授予项目来源权限。
- 使用凭证绑定快照、身份纪元、消费者和用途，60 秒到期、一次性消费。最终事务核验、审计提交成功后才发送。
- 数据库管理员属于受信边界。当前为 namespace 过滤与受控事务隔离，不宣称向不可信 SQL 用户开放数据库安全隔离。
- U 保护已登记的知识 Pack 交付。原始观测精确读取属于 R；调用方在服务外私自发送已读内容的链路不受此网关保护。
- 默认服务仅监听 `127.0.0.1`，默认消费者仅允许本地回环 HTTP。跨机器部署需受控 TLS 反向代理，并由项目安装层登记消费者；还需安排备份恢复、凭证保管、日志告警和进程托管。
- 不包含自动模型提炼、内置 embedding 模型、管理前端或知语业务数据迁移；向量检索需显式配置 embedding 提供方。恢复授权不会复活旧使用凭证；已交付的内容不能撤回。

## 来源与许可

本项目从 [Jayuanlab/zhiyu](https://github.com/Jayuanlab/zhiyu) 的已验证通用记忆实现提取，来源提交与逐文件摘要见 [extraction.json](docs/extraction.json)。仅复制明确列出的源码、测试和协议；不包含日常数据库、配置密钥、运行证据原文或知语构建产物。保留上游 Apache-2.0 [LICENSE](LICENSE)。
