# Codex 三端任务入口验收

验收日期：2026-10-25。源码：`C:\Users\zfy20\Downloads\任务看板\线上源码_Emil优化`，功能分支 `codex/three-target-task-dispatch`。基于 `42043a7` 及另一台设备交付的完整未提交 Emil 优化继续开发，没有用旧版本覆盖它。

## 交付与实际运行分开记录

| 路线 | 已交付 | 实际证据 | 尚未完成 |
| --- | --- | --- | --- |
| 手机网页 | 三端选择、项目白名单、幂等发布、记录/结果、配对及撤销 | 本地隔离 fixture 浏览器发布到指定 Windows；390/1024/1440 无横向溢出，手机输入16px，按钮至少44px | 真实手机和线上登录后的设备配对端到端 |
| Windows | Python 接收器、私人令牌、续租/取消、进程树隔离、用户登录自启安装 | 真实本机 Codex ChatGPT 登录，指定项目只读调用成功返回 `RECEIVER_SMOKE_OK cloud-idea-board-netlify`，session `01a17002-be6b-7141-8e58-27386262367d` | 线上接收器配对和安装后台；没有代替用户安装常驻任务 |
| Mac | 同一 ZIP、LaunchAgent 描述与安装/恢复说明 | 跨平台描述、进程控制和异常恢复的自动化测试 | 用户明确暂时无法操作，真机配对/后台启动/任务执行均为 pending_external |
| 云端 | 服务端 GitHub PR 委派、持久检查点、防重复评论、真实回执查询 | 本人 GitHub 身份创建独立 Draft PR #2，发布一次有界 `@codex` 任务 | 尚无 Codex 回复、反应或分支修改；保持关闭，不能记为可用 |

云端验收 PR：[cloud-idea-board #2](https://github.com/jackygilbert498-debug/cloud-idea-board/pull/2)。截至 2026-10-25 06:25（北京时间）查询，仍只有原始委派评论，分支 HEAD 为 `8167890adf4c54591ec0568e55d03059b6c7319d`。没有重复发送触发，没有合并或部署该验收 PR。

## 自动化与独立审查

- Node 单元测试14项、Vitest行为回归49项、构建集成3项通过；TypeScript 类型检查与全量 ESLint 通过。
- Python 接收器34项测试通过，包含本地 HTTP→子进程→完成写回的完整协议测试。最终 ZIP 为93,494字节，SHA-256 `50d3a2c66a7fad5b48e5dd0e16c186850ca1980a707cf6588eea1acb7507c28e`；此哈希仅对应本轮源码。
- 生产构建会自动生成可下载 ZIP，集成测试核实 ZIP 文件头、模块清单及内容与源码相符，而不是 SPA fallback HTML。
- 后端测试使用真实 PGlite PostgreSQL 引擎验证迁移/权限/领取/写回；PGlite 是单连接测试，不称为线上多连接并发压力验收。
- 独立审查发现并修复云端失败后取消仍可派发、Mac 强杀遗留运行后继续领单、Unicode长度单位不一致、API/provider计费路径覆盖及最终回答脱敏边界。修复均增加行为回归。
- Mac 遗留运行不凭 PID 盲杀；接收器保持人工处理锁，本机确认旧会话停止后才能 `recover --confirm-stopped`。
- 脱敏是常见格式保护，不是对任意自由文本不含秘密的数学保证；不上传原始工具流/stderr，仍须避免在最终回答中主动包含敏感内容。

## 外部启用门槛

1. 新增 SQL 迁移需要项目数据库管理权限。当前未取得可用的 Supabase 管理登录，线上迁移没有执行或验证；服务端 service role 并不等于 SQL DDL 权限。本机直连探针出现 TLS/EOF，不能据此推断线上数据库已迁移或故障。
2. Netlify 尚无 `CODEX_ALLOWED_USER_IDS` 等任务启用配置。没有配置时拒绝派发，不放开给任意登录用户。
3. 云端还需本人账号的目标仓库连接、最小权限 GitHub 运行时凭据及真实 Codex 回执。没有把本机 gh 广泛凭据或 ChatGPT 凭据复制到服务器。
4. 安装包不包含 Python/Codex 运行时，也没有真实 Mac 登录信息。操作步骤见 [部署与配对说明](codex-task-setup.md)。

以上不满足时，只能交付 implemented 的代码和安装包，不能声称三端全部上线验收完成。
