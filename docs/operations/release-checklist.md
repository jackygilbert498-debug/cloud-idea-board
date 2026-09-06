# 云端构思板发布检查清单

本清单用于从唯一公开 GitHub 发布源推进一次可追溯发布。每一步都填写 `PASS`、`FAIL` 或 `pending_external`，并附脱敏证据；空白、口头确认和本地近似测试都不算 PASS。任何阻断步骤为 `FAIL` 或 `pending_external` 时停止生产发布。

## 发布记录

- 候选 commit SHA：
- 分支 / PR：
- 操作人和时间（含时区）：
- 固定预览 URL（不含 token）：
- 预览 deploy ID：
- 生产 URL：
- 生产 deploy ID：
- 上一个已知正常 deploy / SHA：

## 1. 冻结唯一发布源

- [ ] 确认候选来自公开 GitHub 仓库，记录 remote、分支、完整 SHA 和 `git status --short`。
- [ ] 确认本地历史 `C:\Users\zfy20\Desktop\任务看板\云端部署` 未参与构建、未修改，继续只读保留。
- [ ] 确认 `.nvmrc`、CI 与 Netlify 均使用受校验的 Node.js `22.23.2` 发布工具链，并从锁文件运行 `npm.cmd ci`；依赖安装失败不能沿用旧 `node_modules` 判 PASS。
- [ ] 以公开、无权限测试配置运行 `npm.cmd run verify:release`，记录 lint、typecheck、unit、regression、contracts、build、artifact 的退出码和测试计数。Netlify 随后必须单独通过 `npm run verify:netlify`，不能用本地命令替代平台构建。
- [ ] 运行 `npm.cmd audit --omit=dev --audit-level=low --registry=https://registry.npmjs.org`；任何达到阈值的生产依赖问题都阻断发布。
- [ ] 运行 `git grep -Il -E "(sk-[A-Za-z0-9]{20,}|sb_secret_[A-Za-z0-9_-]{20,}|service_role.{0,20}[A-Za-z0-9_-]{40,})" -- . ":!package-lock.json"`；预期无文件名输出，Git exit 1 表示没有 tracked 匹配。若输出任何文件，立即停止且不得把匹配内容复制到证据。
- [ ] 上述 install、release verification、audit、tracked secret scan 全部有独立证据；任一未执行、失败或无法授权时，本步骤不得填写 PASS。
- 状态：`PASS / FAIL / pending_external`
- 证据：

## 2. 备份并完成数据库迁移

- [ ] 记录执行前备份标识、schema/migration 状态和恢复负责人，不记录数据库密码或用户数据。
- [ ] 全新数据库只执行 `supabase/schema.sql`；已有数据库按 `20260824_memo_flow.sql` → `20260824_restore_ai_organizer.sql` → `202609050001_product_stabilization.sql` 顺序执行。
- [ ] 先完成数据库核对，再允许部署代码；失败时确认事务结果并停止发布。
- 状态：`PASS / FAIL / pending_external`
- 证据：

## 3. 真实双会话并发门禁（生产阻断）

必须连接已迁移的预览 PostgreSQL/Supabase，使用至少两个彼此独立的网络 session/connection 发起竞争事务。PGlite、单连接串行调用或 mock 不能替代本门禁。

- [ ] 焦点：同一用户并发获取焦点或转移 active owner 后，最终未归档 focus 卡不超过 3 条。
- [ ] 额度：同一用户同一 UTC 日并发调用额度 RPC，恰好 `p_limit` 次成功，所有超额调用均拒绝。
- [ ] 附件：reorder 与 `pending → ready`、`ready → deleting` 或 metadata delete 竞争时无死锁；最终 ready ID 集合完整，按 `sort_order → created_at → id` 的稳定排序与某个合法串行执行结果一致。允许删除留下间隔或并发上传得到相同 `sort_order`，不得把连续/唯一误记为产品不变量。
- [ ] 记录脱敏的 session 数、事务开始/完成时间、成功/失败分类和最终查询；不记录连接串、token、user ID 或内容。
- 状态：`PASS / FAIL / pending_external`
- 证据：

## 4. 环境名称、scope 与 context 审计

- [ ] 核对 `VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY`、`VITE_BUILD_SHA`、`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL`、`AI_DAILY_QUOTA_LIMIT` 共 8 个名称，无拼写变体。
- [ ] 浏览器变量只在 Builds；服务角色和 DeepSeek key 标为 secret 且只在 Functions；其余服务端变量只在 Functions。
- [ ] Production、受信任的 Deploy Previews、受信任的 Branch deploys 按用途配置；不向未知 fork 预览暴露 secret；`VITE_BUILD_SHA` 不长期静态保存。Netlify 构建期合法 `COMMIT_REF` 同时注入前端与唯一 Function 源码，Function 运行时不依赖该变量。
- [ ] 发布模型为 `deepseek-v4-flash`，额度未显式设置时接受默认 20。
- [ ] Supabase Redirect URL 精确包含生产和固定预览 origin，没有不必要通配。
- 状态：`PASS / FAIL / pending_external`
- 证据（只记存在性/scope/context，不记值）：

## 5. 固定预览构建与发布

- [ ] 从冻结候选 SHA 创建固定预览 alias；记录 build/deploy SHA，确认不是临时未固定 URL。
- [ ] Netlify 运行 `npm run verify:netlify`，wrapper 使用构建期 `COMMIT_REF` 生成前端/Function 共用 SHA；验证、构建或 artifact 任一失败都阻断部署。
- [ ] 检查安全响应头、`index.html` no-cache、静态 asset immutable cache、SPA 深链接和 Function no-store/request ID。
- 状态：`PASS / FAIL / pending_external`
- 证据：

## 6. 认证后桌面与 393px 验收

- [ ] 桌面真实浏览器：默认保持登录；取消后只用当前页面的 sessionStorage，复制标签页仅继承初始快照且后续登录/退出不串事件；只记邮箱不存密码；账号页邮箱/会话/短 SHA、修改密码与三个退出入口正确。
- [ ] 桌面业务链：创建、正常保存自动关弹层、超时待核对与迟到结果、刷新、焦点上限、AI 梳理/采用、附件上传/排序/查看/下载/删除/恢复。
- [ ] 393px：导航/阶段/编辑/查看器、44px 触控目标、16px 输入、弹层双向焦点/Escape/恢复、移动图片粘贴提示和无文字丢失。
- [ ] 清缓存退出只删除当前账号；普通/全局退出不误删。检查 console error、失败 network 和可访问名称。
- 状态：`PASS / FAIL / pending_external`
- 证据（浏览器/viewport/步骤/结果，禁止账号与内容）：

## 7. Push、review 与 merge

- [ ] 完整 review 候选 diff，确认 Critical/Important 为零；重新运行受影响门禁。
- [ ] Push 候选分支，通过受保护 PR/review 路径 merge；记录 merge SHA，并证明产物来源仍是已验收候选。
- [ ] 如果 merge 产生不同 SHA，重新构建固定预览并重做需要绑定产物 SHA 的验收，不得沿用旧证据。
- 状态：`PASS / FAIL / pending_external`
- 证据：

## 8. 同一 SHA 生产发布

- [ ] 生产 deploy 的 commit SHA 与最终已验收 SHA 完全一致；账号页短 SHA、HTML build meta 和平台 deploy metadata 一致。
- [ ] 重跑生产 smoke 与关键认证链路；记录 HTTP、桌面、393px、附件和 AI 结果。
- [ ] 发布后不再创建改变产物的“补文档”提交；最终 handoff 记录 SHA、deploy ID、URL、测试计数和所有 `pending_external`。
- 状态：`PASS / FAIL / pending_external`
- 证据：

## 9. 回滚准备与触发

- [ ] 发布前确认上一个已知正常 Netlify deploy 可恢复，并记录负责人和触发条件。
- [ ] 若生产 smoke、认证、RLS、附件或 AI 出现阻断问题，停止继续发布并回滚 Netlify 到该 deploy。
- [ ] 不用破坏性 SQL 回滚增量迁移；数据库异常先隔离写入并按已审核恢复方案处理。
- [ ] 回滚后重新验证站点和数据边界，将本次状态记为 FAIL，保留脱敏证据并创建后续修复事项。
- 状态：`PASS / FAIL / pending_external`
- 证据：
