# 通用记忆核心

只依赖 Node 标准库的 TypeScript 核心。进程内观测入口为 createMemoryHost，知识治理入口为 createKnowledgeHost；http.ts 提供认证 HTTP 服务和远程客户端。完整部署、接口与限制见[项目 README](../../README.md) 和[远程协议](../../docs/protocol.md)。

| 导出 | 内容 |
| --- | --- |
| index / host / ports | 观测保存、精确读取、幂等、身份和存储接口 |
| policy / sources | 宿主安装的纯业务策略与来源注册 |
| governance / context | 事务命令、依赖判定、候选选择和字节预算 |
| use | 进程内不可序列化的使用作用域与来源证明 |
| knowledge / knowledge-contracts | 候选审核修订、固定证据、召回、远程使用凭证 |
| http | HTTP 入口与不自动重试的远程客户端 |

## 必须保留的不变量

- namespace 为 tenantId + projectId，由受信认证结果提供；principal 相同不意味着跨项目共享。
- 同一命令同内容返回原回执；同 ID 异体冲突。相同来源事件不能靠新 commandId 覆盖或续期。
- 读取、回执恢复和重试都重新检查当前权限。审计提交失败时不返回成功。
- 原文精确摘录采用 Unicode code points、左闭右开，保持 CRLF 与 emoji。来源版本错误时不返回正文。
- 分类 eligible 仅是策略建议，不能绕过来源核验、审核、期限或硬拒绝。
- ContextPack 的限制完整保留；预算不足明确拒绝。辅助内容裁剪显式标注，单位为 UTF-8 字节上界。
- 治理读取和展示用 JSON 不提供使用准入。进程内 proof 不可序列化；跨进程交付必须使用服务端固定快照的一次性凭证。
- 准入、交付、结果未知分别审计；消费者异常不自动重试。只保护登记消费者，不接管业务动作授权。

宿主安装真实身份、存储、来源、领域策略和登记消费者。参考[研发 Adapter](../../examples/memory-project/knowledge-project.ts)、[隔离数据库验收](../../examples/memory-project/acceptance.ts)和[跨进程验收](../../examples/memory-project/service-acceptance.ts)。当前协议为 general-memory.v1-draft；类型与严格解析器定义实际支持的字段。
