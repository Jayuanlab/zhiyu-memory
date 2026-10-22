# Windows 本机记忆服务

本机实例使用独立 PostgreSQL、后台 Node.js 记忆服务和真实 CPU embedding 模型。项目身份为 `local / memory-lab`，不会接管已有项目的数据或身份。默认研发来源适配层用于这次本机验证，其他业务接入仍按项目适配流程完成。

## 端口和模型

| 资源 | 地址或位置 |
| --- | --- |
| 记忆服务 | `http://127.0.0.1:3642`，通过 Bearer 认证调用 |
| 本地向量模型 | `http://127.0.0.1:11434/v1/embeddings`，健康检查 `/health` |
| 验收接收端 | `http://127.0.0.1:3643/model`，仅确认交付，不调用聊天模型 |
| 独立数据库 | Docker 容器 `zhiyu-memory-local-postgres`，回环端口 5433 |
| 数据卷 | `zhiyu-memory-local-postgres-data`，停止应用时保留 |
| Skill profile | `private/local-memory/skill-profile.json` |
| 身份与部署配置 | `private/local-memory/`，已限制为当前用户和 SYSTEM 访问 |
| 运行日志与进程状态 | 同一私有目录中的日志、`service-status.json` 和 `local-processes.json` |

模型为 [Xenova/paraphrase-multilingual-MiniLM-L12-v2](https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2)，使用 Transformers.js 3.8.1、ONNX Runtime CPU 和 q8 权重，输出 384 维向量。mean pooling 后归一化；模型文件缓存在 `.runtime/embedding/cache`。首次下载使用机器已有的网络代理配置，文本推理在本机进行。

## 启动和停止

启动 Docker Desktop 后，在仓库根目录运行：

```powershell
npm run local:start
```

启动器以隐藏窗口运行模型、验收接收端和记忆监督进程，按顺序等待就绪；重复启动会复用已记录且身份匹配的进程。已有端口被未登记进程占用时拒绝覆盖。监督进程对记忆工作进程进行退避重启；未注册系统开机启动任务，重启电脑后重新执行上述命令。

停止本次部署的应用进程：

```powershell
npm run local:stop
```

停止器核对 PID、创建时间和脚本路径，只停止本次记录的进程，保留数据库、模型缓存、身份和历史记录。若数据库被手动停止，可用 `docker start zhiyu-memory-local-postgres` 恢复后再启动应用。

## 使用已配置的 Skill

先查看能力：

```powershell
npm run local:memory -- capabilities
```

封装脚本从私有身份文件读取凭证，仅在 Skill 子进程环境中注入 `ZHIYU_MEMORY_TOKEN`，不在命令参数或输出中显示令牌。`--config` 明确绑定当前 profile，包含实际服务地址、预期 namespace、standard 模式及超时。普通身份 `local-agent` 具有提案、读取、回执、召回、使用和修订权限；审核身份 `local-reviewer` 单独持有审核权限。初次签发期限为 30 天，实际期限保存在私有凭证文件；到期或撤销后由本机管理员重新发证，不能靠换 ID 绕过。

将召回条件保存为 UTF-8 JSON 文件，例如 `private/local-memory/recall.json`：

```json
{
  "scope": "local-memory-test",
  "query": "新功能上线前应做哪些验证，发布失败后怎么退回旧版？",
  "maxBytes": 16384,
  "retrieval": {"mode": "vector", "minSimilarity": 0.3}
}
```

```powershell
npm run local:memory -- request /v1/recall --body-file private/local-memory/recall.json
```

测试 scope 只包含明确创建的合成发布、备份和绿植规则，不是项目实际业务政策。需要保存真实知识时准备实际来源、权限和业务分类，再按 [智能体使用说明](agent-guide.md) 提案及审核。将本仓库提供给智能体后，`AGENTS.md` 会指明上述调用封装和配置；其他项目需要自己的 profile，不自动复用此 namespace。

## 实际验收

```powershell
npm run local:test
```

验收通过已安装 Skill 发出真实 HTTP 请求，用独立提案和审核身份保存中文知识，检查候选不可召回、审核后可用、同命令重试复用回执、语义检索、混合检索、阈值过滤和持久化向量缓存。报告与请求正文保存在 `.runtime/local-memory-test/<本次运行ID>/`，不保存令牌或数据库密码。

测试查询采用与知识正文不同的表达，确认不依赖完整文本包含。报告里的阈值针对本次合成语料校准，不代表所有业务或所有模型的默认阈值。q8 动态量化可能随批次形状产生小幅差异，验收分别生成查询与文档向量，并用实际持久化向量核对结果。

重复验收会在测试 scope 保留新的合成来源、知识和审计历史。失败报告也保留，不删除或改写历史以制造成功。使用 `/v1/read` 查看历史与当前状态；已过期或撤权的知识仍会被召回与交付检查阻断。

## 在另一台 Windows 机器重建

需要 Node.js 24、npm、Docker Desktop 和可下载公开模型的网络。先将仓库的 `skills/zhiyu-memory` 整个目录安装到 `~/.codex/skills/zhiyu-memory`；如果设置了 `CODEX_HOME`，则安装到 `$CODEX_HOME/skills/zhiyu-memory`。调用封装和验收脚本都从该位置加载 Skill 客户端，已有同名 Skill 时先核对版本再更新。

在仓库根目录运行 `npm ci`，再安装隔离模型运行时并下载：

```powershell
npm install --prefix .runtime/embedding --no-audit --no-fund --ignore-scripts @huggingface/transformers@3.8.1
node --use-env-proxy scripts/local-embedding-server.mjs --download-only
npm run local:setup
```

setup 只为固定本机独立数据库生成随机口令，初始化 schema、成员和私有凭证；已有配置不会覆盖，已有凭证会核对身份。首次 setup 后应为 `private/local-memory` 设置仅本机操作员可访问的 Windows ACL，再执行 `local:start`。不要将 `private/`、`.runtime/` 中的凭证、数据库数据或模型缓存提交到 Git。
