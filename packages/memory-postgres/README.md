# PostgreSQL 存储适配层

为通用记忆核心提供 PostgreSQL 实现，不依赖知语旧表、应用迁移或全局连接。宿主提供 postgres.js 连接、真实身份、事务内授权及固定版本来源读取。

| 文件 | 职责 |
| --- | --- |
| src/index.ts | 观测、命令幂等、读取/操作回执与原文不可改写保护 |
| src/knowledge.ts | 候选/历史/命令/审计、namespace 查询、一次性使用凭证、分页扫描和向量缓存 |
| src/service-identity.ts | 身份令牌摘要、权限纪元、撤销与管理员事件 |

显式执行独立项目的 npm run admin -- init 初始化通用表和当前示例 Adapter 表；普通请求不运行建表。IF NOT EXISTS 不代替任意旧表的升级兼容检查。业务项目的成员、来源和授权表由项目 Adapter 提供，不属于通用知识 schema。

向量检索使用 `general_memory_embeddings_g6` 保存浮点数组，键包含 tenant/project/record/space，读取还匹配输入摘要；旧部署启用前重新执行显式 init 新建该缓存表。不需要安装数据库扩展，余弦相似度由通用核心计算。缓存不改变知识正文与审核历史，模型或输入变化时按需重建，见[向量检索说明](../../docs/semantic-search.md)。

命令与来源使用事务锁；唯一键和查询包含 tenant/project，回执还绑定 principal。关键精确读取与授权在事务中锁定，审计提交后才返回成功。远程使用凭证的消费与准入审计原子提交，再调用登记消费者；提交成功后崩溃属于可能已发送，需要状态对账。

数据库管理员是可信部署者。HTTP 调用方不拥有 SQL 权限，不能凭 namespace 过滤声称数据库对任意 SQL 用户安全。默认建议使用独立数据库；备份、恢复和未来 schema 迁移由部署方安排。

运行 npm run test:integration 验证真实 PostgreSQL 并发、事务失败、共享租户隔离、撤权、期限与锁等待场景。测试仅创建并删除受名称保护的临时库，连接设置见[项目 README](../../README.md)。
