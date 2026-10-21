# 安装项目适配层与监督部署

默认入口继续装配仓库中的研发示例。生产接入已有项目时，通过受保护环境指定绝对路径 MEMORY_SERVICE_PROJECT_MODULE；该模块导出 createInstalledMemoryProject，返回 capabilities、ready、close 和显式 operations 映射。每个 operation 具有服务身份 permission 与 call(identity, input)。HTTP 调用方不能注册模块、切 namespace、安装消费者或传入任意函数名。

执行 `node --import tsx apps/service/init-project.ts` 初始化独立身份与只追加传输审计库，不能用示例 init 冒充项目业务迁移。数据库连接来自 MEMORY_SERVICE_DATABASE_URL。身份通过原管理员 CLI 签发；allowed 使用安装模块要求的 project.read / project.write / project.use 子集。来源与业务主记录的实际存储由安装模块明确声明。

安装模式提供认证的 POST /v1/project/call，正文为 `{operation,input}`；capabilities 返回安装能力，其他未安装 facet 明确 404。安装模式预算为 1 MiB；默认研发服务仍为 256 KiB。每次操作在独立身份事务中重验权限，并持有身份共享锁直到项目调用结束。拒绝、撤销和期限优先于允许。

开始审计先提交，项目自身负责业务事务与命令幂等；身份库和业务库之间没有分布式事务。项目操作可能已提交而传输响应或尾部审计失败，此时返回 failed_or_unknown，不能自动重发。传输审计只记录身份、操作和结果状态，不保存正文或令牌；原业务回执才是业务写入的核对依据。身份锁准入不承诺已交付内容可撤回。

运行 `node scripts/supervise.mjs <私有部署JSON路径>` 启动监督进程，JSON 结构为 `{env:{...}}`。目录必须限制 ACL；配置、日志和状态不提交 Git。进程监督提供重启退避、启动超时、心跳、最近退出状态和停止文件；service-status.json 记录进程和时间，service-stop.json 请求显式停止。该脚本本身不注册操作系统开机任务；由项目启动器或运维托管系统启动它。

知语本机兼容部署将独立身份/传输审计保存在 zhiyu_memory_service 库；知语项目模块继续使用其已有业务主记录，未复制历史数据到研发示例表。桌面 owner 统一读写/回执、旧候选审核修订与 owner runtime recall 走服务调用。实际 SDK 的非序列化证明、来源最终核验和 Work/Loop lease 留在实际运行进程的项目适配层；owner chat 额外通过远程 project.use 检查。部分旧管理列表、治理工具和业务原始观测生产者仍通过项目本地适配层处理；不能宣称所有 SQL 已迁移到独立进程或独立库。

回退由知语本机管理员显式切换连接配置，读写同一主记录，无双写同步。远程失败不静默切换；远程身份撤销不等于撤销知语本地 owner 登录身份。若要停用用户的所有入口，需同时处理项目身份和本地登录权限。
