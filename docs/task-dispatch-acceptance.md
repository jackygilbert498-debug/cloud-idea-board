# Codex 三端任务入口验收

验收日期：2026-10-25。源码：`C:\Users\zfy20\Downloads\任务看板\线上源码_Emil优化`，功能分支 `codex/three-target-task-dispatch`。基于 `42043a7` 及另一台设备交付的完整未提交 Emil 优化继续开发，没有用旧版本覆盖它。

2026-10-26补录：Windows后台01:15只读复核仍为Running；云端实际入口为本人登录后的 [Codex云端设置](https://chatgpt.com/settings/codex-cloud)。单仓库 Install & Authorize 已推进到 GitHub 本人邮箱身份验证，尚无授权成功回执、可选目标仓库或环境；PR#2仍无真实Codex回复/新提交。没有代读验证码、复制广泛凭据或打开cloud开关。现有PR路线尚缺自动后台最终结果收集，不能把新环境连接当成网站自动执行验收。具体剩余工作及桌面TAR范围见 [交接说明](handoff.md)。

交接增量验证：新增14项真实Git/TAR测试；连同原112项，共126项通过，typecheck/lint/diff-check通过。独立只读评审发现文件/目录前缀冲突，已复现RED并统一修复创建器与验证器，覆盖双顺序及大小写变体；补验真实竞争发布、已有校验文件、缺失/额外成员与大小上限。全部可达Git历史常见凭据扫描通过。最终TAR及外部SHA-256、实际解压和bundle克隆结果在桌面输出目录交付回执单独记录，避免把待生成产物提前记作成功。本次没有修改应用/接收器运行时代码。

## 交付与实际运行分开记录

| 路线 | 已交付 | 实际证据 | 尚未完成 |
| --- | --- | --- | --- |
| 手机网页 | 三端选择、项目白名单、幂等发布、记录/结果、配对及撤销 | 真实原账号网页登录、配对、发布Windows任务并读回结果；390/1024/1440无横向溢出，手机输入16px，按钮至少44px | 未在物理手机实测，桌面窄屏不代替真机验收 |
| Windows | 已合法配对，当前用户隐藏后台运行，登录自启已配置 | 网页任务B前台执行成功、D由计划任务后台执行成功，均有真实Codex session及持久回执；任务C排队取消后未执行 | 未实测重启/注销后恢复；网络间歇TLS失败会重试，不承诺零延迟 |
| Mac | 同一 ZIP、LaunchAgent 描述与安装/恢复说明 | 跨平台描述、进程控制和异常恢复的自动化测试 | 用户明确暂时无法操作，真机配对/后台启动/任务执行均为 pending_external |
| 云端 | 服务端 GitHub PR 委派、持久检查点、防重复评论、真实回执查询 | 本人 GitHub 身份创建独立 Draft PR #2，发布一次有界 `@codex` 任务 | 尚无 Codex 回复、反应或分支修改；保持关闭，不能记为可用 |

云端验收 PR：[cloud-idea-board #2](https://github.com/jackygilbert498-debug/cloud-idea-board/pull/2)。最新只读查询为2026-10-25 18:07:18（北京时间），仍无Codex回复，只有种子提交，分支HEAD为 `8167890adf4c54591ec0568e55d03059b6c7319d`；指定文档仍为awaiting。没有重复发送触发，没有合并或部署该验收PR。

## 本轮真实 Windows 端到端验收

本人原账号登录验收站并明确同意“让这台电脑接任务”后，才生成一次性配对码并在本机隐藏输入消费。设备 `e874c09a-7965-4214-912d-aecf934c4b4c`、名称“本机Windows”，仅项目board映射到本仓库。没有搬运Cookie、ChatGPT凭据或广泛GitHub凭据。

| 真实任务 | 任务ID | 结果与证据 |
| --- | --- | --- |
| A：首次安全失败 | `e675ebf9-002f-42ea-aae0-5037c2701f0e` | needs_attention；doctor网络检查总退出1被旧守卫拒绝；无Codex会话、无项目改动。保留失败记录。 |
| B：网页→前台→网页 | `942a3a63-e028-41f7-b280-58fcc7365faa` | succeeded；17:52:52—17:53:57；session `01a1727a-416a-73f3-b2bd-9a57dc65555d`；`BOARD_ONLINE_ACCEPTANCE_OK`、正确项目/分支、干净工作区、零改动。 |
| C：排队取消 | `86071de1-cc94-4c9a-bb44-fc25cbf52874` | cancelled；无startedAt、actualDeviceId或session，未启动执行器。 |
| D：网页→后台→网页 | `33f6fd4c-8516-4759-997d-36c17bd1f141` | succeeded；17:58:48—18:00:03；session `01a1727f-b8dd-75e0-b51f-fcff56e88428`；`BOARD_BACKGROUND_ACCEPTANCE_OK`、正确项目/分支、干净工作区、零改动。 |

时间均为2026-10-25北京时间。B、D实际设备ID与指定Windows一致；现有Supabase任务表持久回执，不是fixture/API伪造。D完成后复核原45卡片/15附件，原内容指纹均未变。

后台任务 `CloudIdeaBoard-32eea75e68cb` 为Interactive当前用户、Limited、Hidden、IgnoreNew，已启动并观察Running；Python313的pythonw父进程为调度服务svchost，没有前台接收器。无需终端窗口，但电脑须开机、不休眠、Windows用户保持登录并联网。关机/注销不会自动转交Mac或云端，固定设备任务留队等待；未进行真实重启验收。

MSIX物理配置目录 `C:\Users\zfy20\AppData\Local\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\CloudIdeaBoard` 的ACL为受保护且仅当前用户。安装版本在同一LocalCache/Local下 `CloudIdeaBoardReceiver\releases\9ebebb467748\codex-receiver\runner`。管理/卸载须用此物理配置，勿混用旧逻辑路径哈希。令牌不进入命令行、Git或安装包。

## 自动化与独立审查

- 最新Node14项、Vitest58项、构建集成3项、Python37项，共112项通过；类型检查、全量ESLint及diff检查通过。
- Python包含本地HTTP→子进程→完成写回完整协议测试。最新ZIP97,857字节，SHA-256 `9ebebb46774832636af7f2a652a02d0e5820479ad8e74feb6ea744f04f836dbd`，7文件逐个匹配源码；版本化安装未覆盖旧包。
- 现场TDD修复doctor聚合退出码误判：只接受退出0/1，仍要求六项配置/ChatGPT认证正向字段；未知退出、损坏/过大JSON、API key或错误provider均拒绝。独立审查无新增问题，没有改用API计费。
- UI修复完成设备任务残留旧“executing”摘要的问题，9个新增回归保留结果/错误、运行中进度及云端警告。
- 独立只读审查UI增量为0 Critical/Important/Minor。最终源码提交 `323f5acf90d2e23b79b2c40bcd5da23cfb45adaa` 已推送PR #3功能分支；文档补录可以有后续提交，不影响该部署源码。
- 生产构建会自动生成可下载 ZIP，集成测试核实 ZIP 文件头、模块清单及内容与源码相符，而不是 SPA fallback HTML。
- 后端测试使用真实 PGlite PostgreSQL 引擎验证迁移/权限/领取/写回；PGlite 是单连接测试，不称为线上多连接并发压力验收。
- 独立审查发现并修复云端失败后取消仍可派发、Mac 强杀遗留运行后继续领单、Unicode长度单位不一致、API/provider计费路径覆盖及最终回答脱敏边界。修复均增加行为回归。
- Mac 遗留运行不凭 PID 盲杀；接收器保持人工处理锁，本机确认旧会话停止后才能 `recover --confirm-stopped`。
- 脱敏是常见格式保护，不是对任意自由文本不含秘密的数学保证；不上传原始工具流/stderr，仍须避免在最终回答中主动包含敏感内容。

## 最终隔离发布与在线复核

部署 `6addd6be977708183598dacc` 已ready，独立API确认原site正确、context=branch-deploy、branch=codex-acceptance、published_at=null；生产仍为 `6a9d185535536d37cccd0966`，原固定Preview未覆盖。

已通过真实原账号浏览器重新加载新入口 `index-_XeCpLuL.js`：D保持“执行完成”，执行结果保留，过时心跳摘要不再显示；任务B/C/A记录均保留，Windows显示在线。浏览器实际下载最新ZIP至Downloads，97857字节、SHA256与上文一致。最终Windows计划任务再次读取为Running。截图保留在本机工作附件 `codex-windows-background-accepted.png`（不含配对码或凭据，不加入Git）。

部署使用已通过完整构建测试的dist（CLI --no-build），并非把参数--context误当作云端context保证；实际context以独立API及真实登录后任务列表成功为准。一次旧CLI构建尝试为Deploy canceled，不称其远端编译失败，也不替代最终ready回执。

## 外部启用门槛

1. 原Supabase项目已通过本人真实SQL Editor登录完成增量事务迁移，数据指纹和权限复核通过，不重跑迁移。
2. Netlify仅branch-deploy/deploy-preview配置本人允许名单和cloud=false；只在独立验收站通过Windows真实链路，原production与固定Preview未覆盖。
3. 云端还需本人账号的目标仓库连接、最小权限 GitHub 运行时凭据及真实 Codex 回执。没有把本机 gh 广泛凭据或 ChatGPT 凭据复制到服务器。
4. 安装包不包含 Python/Codex 运行时，也没有真实 Mac 登录信息。操作步骤见 [部署与配对说明](codex-task-setup.md)。

Windows已通过本轮真实在线/后台验收；云端和Mac仍有上述门槛，不能声称三端全完成。以下为历史记录，旧“未登录/迁移/配对”不代表当前状态。

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

## Netlify 配置阻塞恢复

随后本人尝试登录时实际回调为 `Invalid state key`；从官方入口重新发起后提示邮箱已有账户，未执行重置密码、关联GitHub或新建账号。现有本机Netlify管理授权独立恢复可用，无需绕过网页登录保护。

- 当前账户只读能力为Free、`env_var_scopes.included=false`。仅Functions的细分作用域创建被403拒绝；[官方作用域说明](https://docs.netlify.com/build/environment-variables/overview/#scopes)确认细分作用域需要Pro/Enterprise，默认值作用于全部scope。
- 只对两项非秘密配置采用默认scope，POST返回201，独立GET验证新增本人`CODEX_ALLOWED_USER_IDS`和`CODEX_CLOUD_ENABLED=false`，context恰为branch-deploy、deploy-preview。没有production/dev/all-context值，其余8项配置摘要完全一致，无付费或凭据权限变化。
- 只读部署元数据确认旧隔离alias属于branch-deploy，branch=codex-acceptance。CLI的`--context`仅决定构建环境，不单独决定云端Functions上下文；新部署须再读实际context并核实运行时RPC。
- 本轮100项自动化测试、类型检查、lint和diff检查再次通过；独立验收登录页已正常打开，等待本人原看板账号登录，不跨域搬运登录令牌。
- 新隔离部署 `6addcb63e499348be21c550e` 已ready，独立API核对context=branch-deploy、branch=codex-acceptance、published_at=null；生产仍为 `6a9d185535536d37cccd0966`，固定Preview未覆盖。
- 真实运行时探针：匿名用户list为401 `UNAUTHENTICATED`；随机不存在的设备Bearer claim为401 `DEVICE_UNAUTHORIZED`（不再是配置缺失503）。后者证明函数启用配置、运行时服务密钥和真实数据库RPC链路可用，未知设备在任何写入前被拒绝；不等于本人登录和配对已验收。
- 新站HTML200、入口`index-D615VfDs.js`，线上ZIP93,494字节、SHA-256与既有安装包一致。Windows真实配对/网页任务/会话回执仍等待验收站本人登录，未创建私人配置或自启任务。
