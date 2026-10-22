# 向量与混合召回

知识召回支持 `keyword`、`vector`、`hybrid` 三种模式。向量来自部署方明确配置的 embedding 模型，通过归一化向量的点积计算余弦相似度。

## 配置独立服务

先配置原有数据库与消费者，再设置 embedding 服务的完整端点、模型名称及实际输出维度。支持返回浮点数组的 `/v1/embeddings` 兼容协议，例如本机 [Ollama 的兼容端点](https://docs.ollama.com/api/openai-compatibility)。以下模型名称和维度需要替换成实际部署值；维度配置用于核验响应，不会要求服务端自动缩减维度。

```powershell
$env:MEMORY_EMBEDDING_URL = 'http://127.0.0.1:11434/v1/embeddings'
$env:MEMORY_EMBEDDING_MODEL = 'your-embedding-model'
$env:MEMORY_EMBEDDING_DIMENSIONS = '1024'
# 仅在提供方要求时注入密钥；不要将真实密钥写入仓库。
# $env:MEMORY_EMBEDDING_API_KEY = '<private-key>'

# 新装和已有默认研发部署都显式运行，新增独立向量缓存表。
npm run admin -- init
npm start
```

不配置 embedding 时保持原有关键词模式；部分配置缺失会阻止服务启动。配置完整后，默认研发服务使用 `hybrid`，默认阈值为 `0.3`。`GET /v1/capabilities` 的 `retrieval` 显示实际配置。HTTPS 端点和本地回环 HTTP 可用；拒绝 URL 内的凭据、查询参数、片段及重定向。默认单次模型请求超时 10 秒，响应体最多 8 MiB，异常不会降级为成功的空召回。

只有默认研发服务读取上述环境变量。通过 `MEMORY_SERVICE_PROJECT_MODULE` 安装的业务项目需要在其自身装配中显式提供 `semanticSearch`，并实现下面的存储接口，不能假定环境变量会自动改造项目内部检索。

## 请求条件

`POST /v1/recall` 的示例正文：

```json
{
  "scope": "pipeline",
  "query": "上线前需要做哪些检查？",
  "maxBytes": 16384,
  "retrieval": {
    "mode": "vector",
    "minSimilarity": 0.65
  }
}
```

`POST /v1/use/prepare` 的 `recall` 使用同样的字段。仍需原有 Bearer 身份凭证；调用方不能传入向量、模型地址或自行决定 namespace。

| 模式 | 入选条件与排序 |
| --- | --- |
| `keyword` | 保持原有逻辑：读取 scope 下最多 100 条，正文包含完整 query 的优先；其他有效知识也可能补入。不调用 embedding。 |
| `vector` | 余弦相似度大于等于阈值的有效知识入选，按相似度降序。 |
| `hybrid` | 达到阈值，或正文包含完整 query 的知识入选；排序分为余弦相似度，加上文本命中的 `0.25` 加分。 |

阈值允许 `[-1, 1]`，缺省 `0.3`；不同模型需要单独校准。关键词模式不接受 `minSimilarity`，避免阈值被无声忽略。未配置模型却明确请求向量/混合模式，返回 `semantic_search_unavailable`（422）。

向量/混合模式中的有效安全约束绕过相关度过滤并完整保留，另外最多选择 12 条普通知识，同一 root 去重；关键词模式保持原有最多 100 条候选的范围。全部内容仍受 UTF-8 字节预算限制；安全约束放不下时返回 `budget_exceeded`，不会悄悄删除。最终交付继续使用固定快照和一次性凭证，向量命中不构成使用授权。

## 索引与权限

向量/混合模式按稳定 ID 游标遍历当前 namespace、scope 下的记录，不局限于最先的 100 条。只有已经审核、未到期、策略有效、来源版本和摘录一致且当前有来源权限的知识，才能用于文档 embedding。查询文本在召回授权通过后发送给模型。

文档输入为 `JSON.stringify([subject, content, conditions, counterexample])`；每次最多 32 条批量生成。安全约束直接保留，不需要生成文档向量。部署方配置模型意味着允许将查询和已核验知识的上述字段发送给该提供方；有本机保留要求时配置本地模型。

首次语义召回会为旧知识自动补齐缓存；重启后复用 PostgreSQL 中的向量。缓存按租户、项目、记录 ID、embedding 空间及文本摘要隔离，不影响知识正文、审核版本和历史。模型端点、模型名称、输出维度或输入正文变化后重新生成；密钥轮换不改变空间。若提供方在同一个模型名称下更新权重，需要使用新的模型标识或自定义 provider ID，避免混用空间。

来源变化、撤权、知识退役或过期后，即使缓存仍存在，也不能用于召回或交付。模型响应必须数量和维度一致、数值有限、非零；损坏缓存或无效模型响应会明确失败。

每批文档发送前及召回返回前重新核验权限和期限，避免慢模型请求期间到期的记录继续入选。排除诊断最多返回 8 条；更多候选被阻断时，`omissionSummary` 记录总数和报告数，`budget.truncated` 显式标记诊断截断，保证无效候选不会无限占据上下文预算。

本实现为 **精确扫描**：PostgreSQL 保存浮点数组，Node.js 计算相似度，不依赖 pgvector、独立向量数据库或近似索引。冷缓存需要生成当前 scope 的合格知识向量，耗时和事务持锁时间会增加；热缓存仍需遍历、核验并计算，成本随记录数和向量维度增长。大规模知识库需要后续加入数据库向量索引和后台索引任务。

## 自定义项目装配

```ts
import { createHttpEmbeddingProvider } from '@openzhiyu/memory/embeddings';

const semanticSearch = {
  provider: createHttpEmbeddingProvider({
    url: 'http://127.0.0.1:11434/v1/embeddings',
    model: 'your-embedding-model',
    dimensions: 1024,
  }),
  defaultMode: 'hybrid' as const,
  minSimilarity: 0.3,
};
// 将 semanticSearch 传入 createKnowledgeHost 的 installation，
// 或研发示例 createDevelopmentProject 的 options。
```

也可以提供 `EmbeddingProvider`，实现 `id`、`dimensions`、`embed(inputs)`；`id` 必须唯一标识模型空间。存储需提供 `KnowledgeTransaction.scan`（namespace/scope 隔离、ID 游标）和 `embeddings.get/put`（模型空间与输入摘要匹配）。仓库中的 PostgreSQL Adapter 已实现；不支持这些接口的 Adapter 会明确拒绝语义召回。

运行 `npm run check` 检查数值验证、语义命中、阈值、混合模式、缓存失效、权限和分页。`npm run test:integration` 使用隔离临时 PostgreSQL 库与合成 embedding 接收器验证持久化和 HTTP 服务，不调用真实外部模型。
