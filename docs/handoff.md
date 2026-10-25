# 任务看板交接：先读这里

交接日期：2026-10-26，北京时间。本交接不是“三端全部开通”的声明。

## 当前能用到哪一步

| 目标 | 当前结论 | 实际边界 |
| --- | --- | --- |
| Windows | 已通过真实网页派单、前台执行、隐藏后台执行与结果回传 | 电脑须开机、不休眠、用户登录并联网；未做真实重启/注销恢复验收 |
| Mac | 跨平台接收端源码安装包已交付 | 未在 Mac 上配对或执行，不能写成真机通过 |
| 云端 | 尚未开通，开关保持 false | GitHub 正在要求本人邮箱二次验证；环境、服务端有限凭据和真实执行回执仍未通过 |
| 手机网页 | 入口和窄屏回归已实现 | 没有物理手机验收；桌面模拟不代替真机 |

使用新入口：[独立验收站](https://codex-acceptance--fy-cloud-idea-board.netlify.app/)，用原看板账号登录，进入“Codex 任务”，选择 Windows 和“任务看板”。固定设备任务不会因离线转交其他电脑或云端。不要把“已发布”当成“已完成”。原生产和固定 Preview 均保留，尚未用本功能分支覆盖。

完整真实任务 ID、Codex session、数据库指纹和部署证据见 [验收记录](task-dispatch-acceptance.md)。Windows 后台任务于2026-10-26 01:15再次只读确认 Running；本轮未再发布测试任务或改动正常后台。

## 源码与线上资源

- 当前活跃源码：`C:\Users\zfy20\Downloads\任务看板\线上源码_Emil优化`。外层 Downloads/任务看板 内另有历史工程、依赖和缓存，本包不把它们误当作当前部署源码混入。
- 唯一工作分支：`codex/three-target-task-dispatch`；[交付 PR #3](https://github.com/jackygilbert498-debug/cloud-idea-board/pull/3)，不自动合并 main。
- 线上功能源码提交：`323f5acf90d2e23b79b2c40bcd5da23cfb45adaa`；后续只补充交接脚本、测试和文档，不冒称已部署新的功能版本。最终归档源码提交以包内 `manifest.json` 的 `source_commit` 为准。
- Netlify：site `658ed361-e3be-44b1-915d-83402e475b3c`，名称 `fy-cloud-idea-board`；隔离部署 `6addd6be977708183598dacc`，branch-deploy/codex-acceptance。原生产 `6a9d185535536d37cccd0966` 未覆盖。
- Supabase：原项目 `svpzcbcyuudrizutyovk` 已恢复并执行增量事务迁移；原45卡片、15附件及内容指纹保持不变。不要重新执行 `schema.sql`、重新建库或无故重做迁移。
- 环境变量名和占位说明见 [配置模板](environment-template.txt)。真实值留在原服务/本机，不随交接包转移。

## 云端到底还差什么

本轮已确认本人 ChatGPT Pro 登录；在实际界面找到 [设置 → Codex 云端](https://chatgpt.com/settings/codex-cloud)。这才是本账号当前的环境入口，旧的 code-review 深链不是发布任务入口。

已把 GitHub App 安装表单限定为 `jackygilbert498-debug/cloud-idea-board` 一个仓库。用户委托继续该具体动作后，点击 Install & Authorize；GitHub 随后显示 **Confirm access / Verify via email**。没有取得成功授权回执，没有读取邮箱验证码或绕过身份验证。正确的本人验证页面已留在浏览器，不需要重置账号。此后仓库搜索仍未找到目标仓库，开始设置按钮不可用，未编造环境 ID。

剩余工作不是简单“网页登录一次”就全部完成：

1. 本人通过 GitHub 的邮箱身份验证后，确认该仓库实际出现在云端环境选择器，再完成环境设置与发布。
2. 用原有验收 [PR #2](https://github.com/jackygilbert498-debug/cloud-idea-board/pull/2) 核实真实 Codex 任务回复、指定文档修改和提交。2026-10-26 01:15只读查询仍只有原人工评论、一个种子提交，无 Codex review/回复；HEAD 仍为 `8167890adf4c54591ec0568e55d03059b6c7319d`。不要重复发送 `@codex`。
3. 现有网站委派器需要单独的、只针对目标仓库的服务器 GitHub 用户凭据。OpenAI 自己的 GitHub App 连接不等于把可复用凭据交给 Netlify；不能提取它、复制本机广泛 gh 令牌或搬运 ChatGPT 登录文件。新凭据必须由本人按最小范围提供，不购买或改用 API 计费。
4. 现有实现是 GitHub PR 委派路线，不是直接调用新版云端任务 API。官方将非 review 的 `@codex` 委派归为 legacy cloud chat；新版环境连通不能替代这条路线的真实验收。[官方说明](https://learn.chatgpt.com/docs/third-party/github)
5. 目前 GitHub 状态同步由显式 sync 请求触发，只将已识别的官方 Bot 回执记作 acknowledged；没有独立后台 webhook/定时结果收集，也不把 PR 合并或任意评论猜成执行成功。若要手机关闭后自动收集最终结果，仍需实现可信回执校验、恢复与最终状态同步，并补集成和线上验收。不得只打开开关就声称完成。

因此云端保持 `CODEX_CLOUD_ENABLED=false`。Mac 也保持 pending_external，不把 Windows 成功冒充三端成功。

## 已安装的 Windows：不要重配对

设备 `e874c09a-7965-4214-912d-aecf934c4b4c`，名称“本机 Windows”；后台计划任务 `CloudIdeaBoard-32eea75e68cb`。它只接收本人账号、本设备、允许的项目任务。任务 B、D 的实际输出分别为 `BOARD_ONLINE_ACCEPTANCE_OK` 和 `BOARD_BACKGROUND_ACCEPTANCE_OK`；C排队取消、未执行，A安全失败记录保留。

受保护配置物理路径：

`C:\Users\zfy20\AppData\Local\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\CloudIdeaBoard`

已安装程序目录：

`C:\Users\zfy20\AppData\Local\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\CloudIdeaBoardReceiver\releases\9ebebb467748\codex-receiver`

不要复制配置到仓库、压缩包或其他设备。不要另装第二个后台或把恢复出的新路径当作已配对路径。迁移项目路径前，应先确认没有在途任务，再按接收端说明显式更新映射；仅解压交接包不会改变已运行接收器。

只读状态命令：

```powershell
Get-ScheduledTask -TaskName 'CloudIdeaBoard-32eea75e68cb'
```

需要停用时，网页撤销设备授权；本机卸载仅移除对应计划任务、保留配置。不要在正常后台运行时执行下列卸载示例。若明确决定卸载，在上述已安装程序目录，使用同一物理配置目录：

```powershell
python runner/receiver.py uninstall --config 'C:\Users\zfy20\AppData\Local\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\CloudIdeaBoard'
```

Mac 的首次安装/配对及异常恢复按 [接收端说明](../runner/README.md) 操作；ZIP不包含 Python 或 Codex 运行时。

## TAR 包包含什么

解压根目录固定为 `board-handoff/`：

- `source/`：最终提交的完整源码、锁文件、测试、迁移和文档，逐字节读取 Git 对象；不受本机换行和 Git export-ignore/export-subst 影响。
- `repository.bundle`：当前功能分支及全部可达 Git 历史。打包前扫描历史中常见凭据格式及私密路径，包含已删除历史文件的检查；拒绝浅克隆，并在全新空仓库实际克隆/fsck验证后才发布。不是 `.git` 配置/远端凭据的复制。
- `packages/codex-receiver.zip`：Windows/Mac通用源码安装包，97,857字节，SHA-256 `9ebebb46774832636af7f2a652a02d0e5820479ad8e74feb6ea744f04f836dbd`。
- `evidence/`：不含令牌/配对码的本机验收截图，供核对而非替代真实回执。
- `backup/board-metadata-before-migration.csv`：**2026-10-25迁移前**的45卡片/15附件元数据，44,227字节，SHA-256 `a84c7a14a023187f12ece40c80e81453c4b9a4c44f411250afabf158e1268763`。不是当前全库备份，不含任务表、Auth用户、Storage图片二进制；不要把它自动导入线上。此CSV包含私人看板内容，只在本机交接，不上传Git。
- `manifest.json`：源码提交、分支、时间和每个文件的字节数/SHA-256。外部 `.tar.sha256` 校验整个 TAR。

不包含 `.env*`、账号/设备配置、Cookie、原始日志、node_modules、机器本地 Netlify 状态、运行时及其他设备登录凭据。原有未跟踪 `error.log` 留在原位置，不删除、不提交、不导出。格式扫描不能保证识别任意自由文本秘密，私人元数据包也不是可公开发布的安装包。

## 校验和恢复

桌面“看板交接”目录同时提供本说明、TAR、校验文件和 `verify_handoff.py`。先核对 `.tar.sha256` 中的哈希；校验文件应来自本次可信交接，若攻击者能同时改写TAR和清单，自校验不能提供数字签名真实性。

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath '.\任务看板交接_20261026.tar'
python -X utf8 -B .\verify_handoff.py verify '.\任务看板交接_20261026.tar'
```

验证器只读取，不提取文件；拒绝路径穿越、链接、大小异常、重复/大小写碰撞、清单缺失及内容不匹配。验证通过后，在新建空目录解压，勿覆盖原工作目录：

```powershell
New-Item -ItemType Directory -Path '.\恢复检查'
tar -xf '.\任务看板交接_20261026.tar' -C '.\恢复检查'
git clone -b codex/three-target-task-dispatch '.\恢复检查\board-handoff\repository.bundle' '.\恢复源码'
git -C '.\恢复源码' rev-parse HEAD
```

克隆后原文件字节以 Git 对象/`source/`为准，工作区可能受目标机器换行配置影响。这个包不包含外部图片对象/服务凭据，离线解压不会恢复 Supabase/Netlify 账号，更不会自动配对第二台电脑。

## 本次交接取舍与审查

- 沿用本人指定的原目录和功能分支，不新建/切换 Windows 接收器映射；代价是没有额外工作副本隔离，因此只修改交接工具、测试和文档。
- 按Git原始对象导出，不执行本机换行或导出过滤；代价是恢复工作区可能与原始对象换行形式不同，但提交字节可核对、源码不遗漏。
- 将发布竞争、已有校验文件和大小/成员边界的覆盖视作必要验收，增加真实本地测试，代价仅是测试耗时。
- 云端本人身份/Mac真机无法替代，已验收历史运行时不重新扩改；代价是外部门槛及此前未覆盖的旧问题可能仍存在，不能据本轮交接宣称三端完成。
- 凭据检查限已知格式，代价是仍须人工谨慎对待任意自由文本和私人元数据。最终产物还要单独实际解压和克隆，不能只凭工具测试认为归档已成功。

独立审查发现并修复文件/目录前缀冲突，回归已验证两种输入顺序和大小写折叠。首次实际恢复又发现源仓库是浅克隆、bundle缺少父提交；已从原仓库只读获取完整历史，不改工作区，并加入浅克隆拒绝及发布前空仓库克隆/fsck。首次未通过归档明确留为失败检查记录，不当作最终交付。新增浅克隆回归已观察RED→GREEN；最后产物的源码提交、外部SHA-256及实际恢复结果见桌面交付回执，本说明不包含自引用的最终TAR哈希。

最终新鲜自动化验证127项通过（原112+交接15），typecheck、lint及diff检查通过。首次失败留档及恢复副本明确标记，最终恢复副本为“恢复验证_最终”；勿混用两次结果。

## 开发与验证

项目原本是 React/TypeScript + Vite + Netlify Functions，沿用现有栈；接收器与交接工具用 Python 标准库，没有为打包引入第三方依赖。

```text
npm ci
npm test
npm run typecheck
npm run lint
python -X utf8 -B -m unittest discover -s runner -p "test_*.py"
python -X utf8 -B -m unittest discover -s tests -p "test_handoff.py"
```

构建需要原环境的前端公开 Supabase 配置；服务端密钥仅设置在 Netlify，禁止写入构建源码。新环境按模板由本人在原服务补值。任何“全部完成/可生产发布”结论都需先补完上表未通过项目；本次不自动合并、切换生产、升级套餐或重复配对。
