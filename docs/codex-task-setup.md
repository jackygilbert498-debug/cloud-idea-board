# Codex 任务入口：部署与启用

本入口支持三种明确目标：Codex 云端、指定 Windows、指定 Mac。选择电脑后，即使该电脑离线，也只在那台电脑排队，不自动改到云端或另一台电脑。网页中“已发布”不等于 Codex 已接收或完成。

## 1. 新增数据库能力

保留现有 Supabase 项目和看板数据；不要重新执行 `schema.sql`。备份后，在该项目 SQL Editor **完整执行**：

`supabase/migrations/20261025_codex_tasks.sql`

这是可重复执行的事务迁移，新增 `codex_devices`、`codex_pair_codes`、`codex_tasks` 和配套函数，不删除现有看板卡片或附件。配对操作会替换本人尚未使用的旧配对码。迁移不直接给浏览器数据库权限，只有 Netlify 服务端可调用执行函数。

可用以下只读 SQL 核实迁移与权限：

```sql
select to_regclass('public.codex_tasks') as tasks,
       to_regprocedure('public.codex_user_action(uuid,text,jsonb)') as user_action,
       to_regprocedure('public.codex_runner_action(text,text,jsonb)') as runner_action;
select has_function_privilege('authenticated',
       'public.codex_user_action(uuid,text,jsonb)', 'EXECUTE') as browser_can_execute;
```

前三列应存在，`browser_can_execute` 应为 `false`。本地 PGlite 测试不代替这一步线上核实，也不等于真实 PostgreSQL 多连接压力测试。

## 2. Netlify 服务器配置

保留现有 `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY` 和前端 Supabase 公开配置。新增以下变量，覆盖实际发布环境（固定 Preview 也要覆盖相应上下文）：

| 变量 | 用途 |
| --- | --- |
| `CODEX_ALLOWED_USER_IDS` | 本人 Supabase 用户 UUID；多个用逗号分隔，不是邮箱或 GitHub ID |
| `CODEX_CLOUD_ENABLED` | 默认 `false`，完成真实云端验收后才设 `true` |
| `CODEX_CLOUD_PROJECTS` | 云端项目允许列表，JSON 数组，示例见下 |
| `CODEX_GITHUB_TOKEN` | 本人 GitHub 身份、仅目标仓库的有限权限凭据；只在服务器保存 |

```json
[{"id":"board","label":"任务看板","repository":"jackygilbert498-debug/cloud-idea-board","baseBranch":"main","isPublic":true}]
```

不要将本机 gh 的广泛权限令牌直接搬到服务器，不要把 ChatGPT 登录文件、服务密钥或设备 token 放进前端、仓库或任务描述。GitHub 凭据需支持目标仓库分支/需求文件、PR 与委派评论的操作；按 GitHub 的最小仓库权限授权并可随时撤销。公开仓库的任务文字也会公开，页面会提示。

仅启用 Windows/Mac 接收时，不需要 `CODEX_GITHUB_TOKEN`，云端保持关闭即可。缺失允许用户配置时，任务 API 会拒绝服务，不会让任意看板账号远程执行代码。

## 3. 云端账号连接与验收

官方文档目前将非 review 的 `@codex` PR 评论委派归为 legacy cloud chat。它依赖仓库连接、账号权限与套餐可用性，不是通用公开任务创建 API：

- [官方 GitHub 集成说明](https://learn.chatgpt.com/docs/third-party/github#give-codex-other-tasks)
- [官方 legacy 云端环境说明](https://learn.chatgpt.com/docs/environments/cloud-environment)

应从本人已登录的 Codex 界面确认仓库/集成设置。官方文档给出的 `chatgpt.com/settings/code-review` 是代码审查设置深链，不是本看板或发布任务页面；本轮未得到可用的登录后设置页，因此不把该深链当作已经验证的操作入口。

本项目已建立独立的 [云端验收 PR #2](https://github.com/jackygilbert498-debug/cloud-idea-board/pull/2)，只请求修改一份验收文档。不要重复发送未知结果的评论。必须看到真实 Codex 回复、指定文件变更及测试/提交证据后，才能把此账号的云端路线记为 verified。没有回执时保留待开通状态，不回退到付费 API。

平台取消只阻止后续派发。已经交给 GitHub/Codex 的在途请求不能撤回，也不代表云端执行已被停止；请打开原 PR/云任务核实。

## 4. Windows 和 Mac 各配对一次

运行 `npm run package:receiver` 生成 `public/codex-receiver.zip`，生产 `npm run build` 会自动重新生成并发布该文件。ZIP 是源码安装包，需目标设备已有 Python 3.11+ 和原生 Codex CLI，不含账号凭据或运行时。

从网页下载后，按 [接收端说明](../runner/README.md) 在各设备操作：先用 ChatGPT 登录，生成网页一次性配对码，映射本机项目，再运行 `doctor`、前台接收验收，最后安装当前用户登录自启。Mac 当前不可操作，安装包先交付；不能据此记为真机已验收。

项目真实路径只存在那台电脑的私人配置里。接收器固定官方 ChatGPT 登录与 OpenAI provider，不自动改写本机 Codex 设置。自定义计费/provider 配置不满足套餐约束时会拒绝执行，不会偷偷换用 API。

## 5. 验收顺序

1. `npm test`、`npm run typecheck`、`npm run lint`、Python 接收端测试全通过。
2. 完成线上迁移、允许用户配置，重新部署正确 Netlify 站点。
3. Windows 配对后，从手机选 Windows 发布只读任务，核对指定设备 ID、真实 session、最终结果。断网、重启和撤销分别检查。
4. 云端完成上文 PR 真实验收后，再启用云端项目。
5. Mac 可操作时按安装包说明配对，再做同等真机验收；电脑睡眠/关机不能运行本机任务。

没有完成的路线必须保留 `pending_external`，不能用单元测试或另一条路线的成功替代。
