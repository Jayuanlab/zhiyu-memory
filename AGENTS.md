# 智能体文档入口

接入或调用本项目的记忆服务时，先阅读 [智能体使用说明](docs/agent-guide.md)。其中定义能力发现、原始记录、知识提案与审核、向量召回、受控交付及异常恢复的调用方式。

需要可安装、可复用的技能时使用 [skills/zhiyu-memory](skills/zhiyu-memory/SKILL.md)，其脚本和参考文档可独立复制到宿主技能目录。

为传统或已有项目评估、设计或实施记忆接入时，使用独立的 [zhiyu-memory-onboarding](skills/zhiyu-memory-onboarding/SKILL.md)。它按业务场景梳理来源、权限、生命周期和改造点，第一版支持评估、规划和单场景实施；评估请求不授权改造业务代码，实施请求应推进到实际验证，并区分本地测试与真实服务联调。

服务地址、认证工具、身份、允许的 scope 和登记消费者由接入项目提供。阅读文档不代表服务已经部署或项目适配已经完成。

本仓库的本机实例配置位于 `private/local-memory/skill-profile.json`，预期 namespace 为 `local / memory-lab`，服务地址为 `http://127.0.0.1:3642`。使用 `node scripts/local-memory.mjs capabilities` 或 `node scripts/local-memory.mjs request <路由> --body-file <UTF-8请求文件>` 调用；该封装从私有文件注入身份，智能体无需读取令牌正文。仅在执行已有审核任务时使用 `--reviewer` 身份。`local-memory-test` scope 内是合成验收样本，不能当成用户真实项目的业务规则。运行及测试见 [本机部署说明](docs/local-runtime.md)。

修改服务协议时同步更新该说明、[远程协议](docs/protocol.md)和相关示例；具体字段以 `packages/memory/src` 中的类型与严格解析器为准。
