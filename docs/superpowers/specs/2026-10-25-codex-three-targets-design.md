# Codex 云端、Windows、Mac 统一任务入口

状态：按用户明确要求同时交付三种目标；替代此前仅云端方案。Mac 暂时无法操作，用户明确要求先准备安装包，真机配对与执行待其可操作时验证。

## 产品约束

- 手机和电脑复用现有 Supabase 登录。仅管理员配置的本人 user ID 能派发 Codex 任务。
- 发布必须选择执行位置：Codex 云端、已配对 Windows、已配对 Mac。目标提交后不变；设备离线排队，不转移到其他设备。
- 云端走官方 GitHub PR 评论委派 `@codex`，使用现有套餐；本地使用各设备已登录的 Codex CLI，同样不配置付费 API key。云端代发需要真实验收后才能标记可用。
- 电脑端使用跨平台 Python 3.11+ 标准库接收器，通过 HTTPS 主动轮询，无需公网入站端口。Web 端保持 React/TypeScript/Netlify/Supabase。
- 第一版任务：标题<=240字、描述<=20000字、验收要求<=4000字；项目由云端允许列表或接收器本机配置提供，任务只能引用项目 ID，不能传入可执行命令/本机路径。
- 默认在指定项目目录、workspace-write 沙箱执行，保留原始草稿和用户未提交变更；不做自动主分支合并或线上部署。
- 最新源码是当前目录的完整工作树，包括未提交 Emil 优化；不得用旧 HEAD 或外层 Cloudflare 工程覆盖。

## 信任与数据边界

设备使用一次性随机配对码（10分钟有效）关联本人账号。服务端返回专属随机 token，数据库只存 SHA-256；仅接收器持有原文，存放于项目外的个人配置目录。撤销后立即拒绝领取、续租和写入结果。前端永远得不到设备 token 或 token hash。

服务端仅在验证 Supabase 用户和 user ID 允许列表后创建任务、配对码、查询详情或撤销设备。浏览器没有写执行状态的权限。服务端数据库函数仅 service_role 可执行。

任务记录绑定 owner、targetKind、deviceId、projectId；本机项目 ID 映射在接收器配置里，真实路径不上传。领取事务同时验证 owner+device+project+排队状态，一次只领取一个任务，并生成 runToken 与90秒租约。每20秒续租/心跳。两个接收器进程不能领取同一任务；接收器自身使用操作系统文件锁防止重复实例。

运行结果只接受匹配 deviceId + runToken 的写回。租约中断时接收器停止自己启动的进程，服务端将不确定的任务标记 needs_attention；不自动重新执行。重启遇到未完成本机运行记录时先报告中断，不重新调用 Codex。撤销/取消同样停止该接收器拥有的进程，不影响用户其他 Codex 任务。

## 云端

后台配置 CODEX_GITHUB_TOKEN（本人 GitHub 身份、目标仓库有限权限）与 CODEX_CLOUD_PROJECTS。为每项任务创建确定性独立分支、需求文件和 PR，然后发布含任务ID标记的 @codex 评论。恢复先查远端已有资源；评论请求结果不确定时只核对，不盲目重复触发。公开仓库任务文字会公开，发布页展示这一事实。GitHub回复/提交/PR状态为证据，不将 HTTP 201 或表情当作完成。云端任务链接提供深入查看入口。

## UI

保留 Emil 配色与现有字体，增加 Codex 任务导航。内容左对齐：上方执行位置选择、项目选择和任务编辑，下方任务列表与详情。三种执行位置为清晰的选项，无虚构在线状态：未配对设备提示安装/配对，离线显示最近在线时间。详情固定显示指定位置、实际接收位置、开始时间、结果与错误；仅有真实回执后显示接收成功。

手机使用单列、输入字号16px、控件至少44px，保留系统缩放与可选择结果文字。配对码仅生成后展示一次；提供复制和平台安装说明。草稿按 userId 隔离。

## 固定 API 契约 v1

`POST /api/codex-tasks`，Supabase Bearer。action:

- `list` -> `{tasks,devices,cloudProjects,cloudEnabled}`。设备包含 id,name,platform,projects:[{id,label}],lastSeenAt,revokedAt；任务使用 camelCase。
- `create`，`{requestId,title,prompt,acceptance,targetKind:'cloud'|'device',deviceId:null|string,projectId}` -> `{task}`。requestId=UUID，在owner内幂等。
- `pair-code` -> `{code,expiresAt}`。
- `revoke-device`，`{deviceId}` -> `{ok:true}`。
- `cancel`，`{taskId}` -> `{task}`：queued直接cancelled，running设cancel_requested，云端只关闭平台派发/给原任务链接，不假装能停止云任务。
- `sync`，`{taskId}` -> `{task}`，从GitHub补查云端回执。

`POST /api/codex-runner`。pair无Bearer，其他使用设备专属Bearer。

- `pair`，`{code,name,platform:'windows'|'macos',projects:[{id,label}]}` -> `{deviceId,token}`。
- `heartbeat`，`{projects:[{id,label}]}` -> `{ok:true}`。
- `claim` -> `{task:null|{id,title,prompt,acceptance,projectId,runToken},leaseSeconds:90}`。
- `progress`，`{taskId,runToken,summary}` -> `{cancelRequested:boolean,leaseSeconds:90}`。
- `complete`，`{taskId,runToken,status:'succeeded'|'failed'|'cancelled'|'needs_attention',result,error,sessionId}` -> `{ok:true}`。result<=20000，error<=2000，summary<=2000。

失败统一 `{error:{code,message}}` + HTTP状态码。账号、设备和项目越权拒绝；不得由客户端冒充owner。

任务状态：queued,dispatching,submitted,acknowledged,running,succeeded,failed,cancel_requested,cancelled,needs_attention,result_ready,closed,merged。cloud只使用其适用子集。

## 接收器交付

`runner/receiver.py` 支持 `pair`、`run`、`doctor`、`install`、`uninstall`。pair参数 --server --code --name --project ID=ABS_PATH，可多项目。配置默认Windows LOCALAPPDATA/CloudIdeaBoard，Mac ~/.config/cloud-idea-board；--config可指定项目外目录。HTTPS为默认，测试仅允许显式localhost HTTP。Codex通过绝对二进制路径+参数数组启动，提示词走stdin，绝不shell拼接。

Mac安装创建当前用户LaunchAgent，Windows安装创建当前用户登录计划任务，不需管理员；非本人设备不注册。Mac产物先生成zip和README，不标为真机已验收。安装包不含账号/设备token、node_modules、用户草稿或其他项目文件。

## 验收

行为测试覆盖：跨设备不抢单、并发幂等领取、账号隔离、配对过期/一次性、撤销、旧runToken拒绝、失租不重复执行、路径白名单、无shell注入、结果大小限制、超时/取消、真实身份运行证据。React验证发布目标不变、错误回读、离线排队、手机无横向溢出。

三条路线分别记 implemented / verified / pending_external：Windows本机真实Codex执行；云端真实GitHub委派并收到任务回执与变更；Mac当前交付安装包与跨平台测试，待设备可操作后配对验收。不把其中一条的成功代替另两条。
