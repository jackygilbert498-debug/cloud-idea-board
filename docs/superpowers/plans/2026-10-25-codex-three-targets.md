# Codex Three Targets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for each implementation task; independent components use isolated file ownership and a fresh whole-change review before delivery.

**Goal:** 在手机网页统一发布至Codex云端、Windows或Mac，固定路由、真实回执、结果可回看。
**Architecture:** Netlify鉴权与派发，Supabase持久任务/设备/一次配对；Python接收器只领取自己的本机项目。云端走本人GitHub身份的官方PR委派。
**Tech Stack:** Existing React/TypeScript/Netlify/Supabase; Python3.11+ standard library.
**Spec:** docs/superpowers/specs/2026-10-25-codex-three-targets-design.md

## Global Constraints

- 使用现有套餐，不上传本机ChatGPT凭据，不增加付费API路径。
- 保留全部Emil工作树；Mac只准备安装包（用户当前无法操作）。
- 固定owner/device/project；离线排队，不自动跨端迁移或重执行失租任务。
- API字段和长度严格遵守Spec v1；设备token服务端仅存hash。
- 改动仅限新入口和所需数据/执行机制，既有看板保持原有行为。

## Review Focus

- 发布请求响应丢失：同requestId恢复已有任务，不重复触发。
- 接收器重启/断网：已有执行不能被当新任务再运行。
- 用户切换：草稿、设备、任务全部隔离。
- 凭据撤销或设备冒用：旧token和runToken均拒绝，不泄漏配置。
- 云端GitHub成功但Codex未接收：保持等待/需处理，不虚报执行。

### Task 1: 保全基线与云端能力验证
Files: docs/superpowers/specs/*; docs/task-dispatch-acceptance.md.
- [ ] 保存完整当前工作树基线到新功能分支；恢复Windows依赖，运行既有tests/typecheck/lint。
- [ ] 用本人GitHub身份建立独立验收PR，发布只改验收文档的@codex请求；核实回执与实际代码。
- [ ] 记录配置缺口；云端缺口不阻塞独立的电脑接收器开发。

### Task 2: 持久协议、服务端与云端派发
Files: lib/codex-task-model.ts; netlify/functions/codex-tasks.mts; netlify/functions/codex-runner.mts; netlify/functions/_codex/*; supabase/migrations/20261025_codex_tasks.sql; tests/codex-*.spec.ts.
Interfaces: Spec v1 API response shapes; export types CodexTask, CodexDevice, CodexProject, CodexTaskOverview, CreateCodexTaskInput.
- [ ] 先写配对、owner拒绝、跨设备领取、并发去重、旧租约拒绝、撤销测试，运行看到失败。
- [ ] 实现增量幂等迁移、原子领取/续租/完成函数，所有函数只service_role授权。
- [ ] 实现两个依赖可注入Netlify handler：Supabase鉴权、允许userId、输入/大小验证、短超时、错误脱敏。
- [ ] 实现幂等GitHub分支/PR/委派评论与状态补查；服务端凭据不进入前端。
- [ ] 运行TS行为+PGlite实际迁移测试通过；提交本任务文件。

### Task 3: Windows/macOS标准库接收器
Files: runner/receiver.py; runner/test_receiver.py; runner/README.md; scripts/package-receiver.mjs.
Interfaces: consumes Spec v1 runner API; no directDB credentials or service role.
- [ ] 先写路径白名单、stdin传递、非shell调用、重复实例、取消、续租丢失、重启恢复测试，运行失败。
- [ ] 实现HTTP客户端、个人凭据存储、一次配对、OS文件锁、持久运行日志、Codex JSON事件、20秒续租与90秒lease。
- [ ] 实现用户级Windows计划任务和MacLaunchAgent安装/卸载；不安装未配对配置。
- [ ] 运行Python行为测试；本机真实Codex最小任务；生成无凭据Windows/Mac通用zip。

### Task 4: 手机和桌面UI
Files: lib/codex-task-api.ts; app/components/CodexTasks.tsx; app/components/IdeaBoard.tsx; app/globals.css; tests/codex-tasks-ui.spec.tsx; tests/fixtures/codex-api.ts; tests/ui-preview.config.ts.
Interfaces: consumes model+API v1; CodexTasks({userId:string}) inside authenticated app.
- [ ] 先写选择固定target/project、重复点击、取消/错误、配对与账号隔离行为测试并运行失败。
- [ ] 实现目标/项目/表单/列表详情/配对入口、准确离线和云端状态、公共仓库提示。
- [ ] 小范围接入导航与移动菜单；手机快速记事框只在原看板显示。
- [ ] 接入fixture，浏览器验证390/1024/1440尺寸与可访问性，运行测试通过。

### Task 5: 集成、独立审查与真实边界
- [ ] 全量npm tests/typecheck/lint、Python tests、生产build、diff检查。
- [ ] 新鲜上下文审查安全边界、并发/失租恢复和原看板回归，修复重要问题。
- [ ] 若服务器缺迁移/专属授权，交付可运行代码和准确设置步骤，不能误报上线完成。
- [ ] 记录Windows、云端、Mac各自证据；Mac标pending_external并提供安装包。
