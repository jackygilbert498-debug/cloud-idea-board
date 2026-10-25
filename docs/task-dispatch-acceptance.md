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

## 后续自主推进：独立预览部署与线上核对

用户随后授权休息期间继续推进，无需普通步骤逐项确认。本轮已部署到原 Netlify 站点内的独立验收别名：

[Codex 验收预览](https://codex-acceptance--fy-cloud-idea-board.netlify.app/)，deploy ID `6add330919bacbc7c5f4b111`，源码提交 `04a0504`。

- 线上 HTML 和 JavaScript 均200，构建包包含新 Codex 入口；浏览器显示真实登录页，390/1440宽度无横向溢出、无未捕获异常。没有使用示例 fixture 冒充线上账号。
- 线上 `/codex-receiver.zip` 返回200、`application/zip`、93,494字节，文件头 `50-4B-03-04`，SHA-256与上文完全相同。
- 新用户 API 未登录时401 `UNAUTHENTICATED`；接收器 API 因缺启用配置返回503 `SERVER_NOT_CONFIGURED`。这是明确未开通，不是三端在线验收通过。
- 原有固定 Preview 与新验收站的已有 AI 接口，在使用明确无效的诊断登录令牌时均返回503 `AUTH_UNAVAILABLE`，没有调用付费 AI。只能确认当前验证链路不可用，不能据此断言 Supabase 项目暂停、密钥错误或数据库故障。
- Netlify管理API确认生产 deploy仍为 `6a9d185535536d37cccd0966`，未覆盖生产；固定 Preview也没有替换为未开通版本。
- 再次完整验证：Node14、Vitest49、构建集成3、Python34均通过，typecheck与ESLint通过。
- 官方CLI的 `codex cloud list --json --limit 5` 成功返回空列表；环境选择器仅有全局筛选项，没有该仓库的可用环境ID。因此没有伪造ENV_ID或发起重复云任务。
- Supabase集成在目录中可用但未连接；没有可用管理令牌、SQL管理会话或数据库密码，不能自主执行DDL。已准备连接入口，未声称已安装或授权。

已建立本对话的有界自动跟进（每小时，最多8次）：只在真实连接/回执变化后继续安全步骤，无变化保持安静，不重复相同阻塞或触发评论。自动跟进不代替本人授权，也不代表当前网页已经能自动接单。

## 本人登录后的线上数据库验收

2026-10-25 后续操作：本人已登录 Supabase Dashboard。实际项目处于暂停，已恢复原免费项目，没有升级、购买或更换项目。此后的 SQL Editor 管理会话真实可用，前述“尚未取得管理会话”记录属于历史状态。

- 迁移前导出原卡片和附件元数据 CSV 到本机 Downloads，44,227字节，SHA-256 `a84c7a14a023187f12ece40c80e81453c4b9a4c44f411250afabf158e1268763`；解析确认45张卡片、15条附件元数据。此备份不包含 Storage 图片二进制，不上传 Git。
- 完整执行已审查的 `20261025_codex_tasks.sql` 事务，观察到 `Success. No rows returned`。
- 迁移前后卡片45、附件15；整表内容指纹分别保持 `149a9ad059ba937e62265a5eca6e3550`、`36c372db5d6c16a6b514952ff874b1f2`，没有改写原看板数据。
- 新表/RPC存在，三张新表均开启RLS；`authenticated` 对任务表 SELECT 和用户RPC EXECUTE 均为false。首次本人任务列表为空，符合尚未配对的状态。
- 本人原应用账号有44张卡片和全部附件，另一个example.com测试账号仅1张卡片。服务端仅允许原应用账号，不向全部登录账号开放远程执行。
- 16:57:33（北京时间）云端PR #2仍无Bot回复、review、reaction或指定新增句子；云端继续关闭。该路线不因数据库迁移成功而自动记为通过。
- 本轮重新运行全部100项自动化测试（14+49+3+34）、类型检查、lint和diff检查通过；没有新功能代码改动。
- Windows安装准备已完成：ZIP无覆盖解压至 `%LOCALAPPDATA%\CloudIdeaBoardReceiver`，7个文件哈希逐个匹配；Python3.13.15、原生Codex0.163及ChatGPT登录可用。仍未创建配对令牌或自启任务，不冒称线上接单已通过。
- Netlify管理API经有界直连/现有代理检查仍遇TLS/EOF；CLI设置尝试退出0但无写入回执，读回deploy-preview白名单仍无值，不能据此开通任务服务。已打开真实GitHub `Authorize Netlify Auth` 登录确认页（仅只读邮箱权限）供本人操作，未自动同意新OAuth授权。
- 原固定Preview登录态仍真实有效，恢复后显示44条本人记录；没有复制Cookie或用户Token去验收域名。隔离验收地址本轮在内置浏览器出现连接关闭，未声称已完成新的线上部署或认证验收。原Preview和production均未覆盖。
