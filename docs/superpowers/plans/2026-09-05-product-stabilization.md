# 云端构思板产品稳定化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让当前个人云端构思板具备可追溯发布、可信保存、可选择设备会话、并发数据约束、可恢复附件操作和真实验收。

**Architecture:** 保留 React 19 + Vite + Supabase + Netlify + DeepSeek 架构。发布层用统一 `verify:release`，客户端把认证存储、设备缓存和云端写入结果分层，数据库通过一份增量迁移承担并发不变量、幂等键、附件状态和 AI 配额。

**Tech Stack:** TypeScript 5.9、React 19、Vitest/jsdom、Node test runner、PGlite、Supabase Postgres/Auth/Storage、Netlify Functions、GitHub Actions。

**Spec:** `docs/superpowers/specs/2026-09-05-product-stabilization-design.md`

## Global Constraints

- 公开 GitHub 仓库是唯一发布源；不得修改、重置或清理历史 `C:\Users\zfy20\Desktop\任务看板` 脏工作树。
- 不读取、输出、提交或记录 `.env`、Supabase service key、DeepSeek key、token、用户原文和签名 URL。
- 所有行为变更先写失败测试并确认 RED，再写最小实现，最后确认 GREEN。
- 数据库改动只允许加列、函数、触发器、策略、索引和安全回填；不得删除用户数据。
- 个人账号页不引入团队、管理员、profile 或成员权限模型。
- 登录页默认保持登录；保存邮箱但绝不保存密码，密码只使用浏览器 `autocomplete`。
- 界面保留现有蓝灰、轻量、安静的构思板视觉，不进行无关重构。
- 外部 Supabase/Netlify/DeepSeek 验收若无法执行必须标记 `pending_external`，不得写成通过。

---

### Task 1: 唯一发布源与自动质量门禁

**Files:**
- Create: `.nvmrc`
- Create: `.github/workflows/verify.yml`
- Create: `scripts/validate-release-env.mjs`
- Create: `tests/release-pipeline.test.mjs`
- Modify: `package.json`
- Modify: `netlify.toml`
- Modify: `tests/netlify-build.test.mjs`

**Interfaces:**
- Produces: `npm run verify`、`npm run build:release`、`npm run verify:release`；`validate-release-env.mjs` 以退出码表达发布配置是否完整。
- Produces: `VITE_BUILD_SHA` 注入浏览器，Netlify 和 CI 固定 Node 22。

- [ ] **Step 1: Write the failing release-gate tests**

```js
test("release env validator rejects a missing Supabase configuration", () => {
  const result = runValidator({});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /VITE_SUPABASE_URL/);
});

test("release env validator accepts public build values", () => {
  const result = runValidator({
    VITE_SUPABASE_URL: "https://test.supabase.co",
    VITE_SUPABASE_ANON_KEY: "test-public-key-with-more-than-20-characters",
    VITE_BUILD_SHA: "0123456789abcdef",
  });
  assert.equal(result.status, 0);
});
```

- [ ] **Step 2: Run the contract tests and verify RED**

Run: `node --test tests/release-pipeline.test.mjs`

Expected: FAIL because `scripts/validate-release-env.mjs` and the new package scripts do not exist.

- [ ] **Step 3: Implement the release validator and scripts**

```js
const required = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "VITE_BUILD_SHA"];
const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length) {
  console.error(`发布配置缺失：${missing.join(", ")}`);
  process.exitCode = 1;
}
```

Set package scripts to this non-recursive graph:

```json
{
  "typecheck": "tsc --noEmit --incremental false",
  "test:contracts": "node --test tests/release-pipeline.test.mjs",
  "test:artifact": "node --test tests/netlify-build.test.mjs",
  "verify": "npm run lint && npm run typecheck && npm run test:unit && npm run test:regression && npm run test:contracts",
  "build:release": "node scripts/validate-release-env.mjs && vite build",
  "verify:release": "npm run verify && npm run build:release && npm run test:artifact"
}
```

- [ ] **Step 4: Add CI, Node pin and global Netlify headers**

GitHub Actions must run `npm ci`, `npm run verify:release` with non-secret public test values, and `npm audit --omit=dev --audit-level=low`. Netlify build command becomes `npm run verify:release`; add full-site `nosniff`, strict referrer, `DENY` framing, CSP `frame-ancestors 'none'`, HSTS and a permissions policy that disables camera, microphone, geolocation and payment.

- [ ] **Step 5: Replace source-regex artifact assertions with runnable outcomes**

The artifact test must read `dist/index.html`, resolve the emitted module path, assert the configured Supabase test URL occurs in the built module and fetch a temporary static server entrypoint with HTTP 200. It must not assert implementation symbol names.

- [ ] **Step 6: Verify GREEN and commit**

Run: `node --test tests/release-pipeline.test.mjs`

Run: `$env:VITE_SUPABASE_URL='https://test.supabase.co'; $env:VITE_SUPABASE_ANON_KEY='test-public-key-with-more-than-20-characters'; $env:VITE_BUILD_SHA='0123456789abcdef'; npm.cmd run verify:release`

Expected: all commands exit 0 and the built JavaScript contains the configured public URL.

Commit: `build: enforce release quality gates`

---

### Task 2: 可重跑数据库迁移与并发不变量

**Files:**
- Create: `supabase/migrations/202609050001_product_stabilization.sql`
- Create: `tests/schema-stabilization.spec.ts`
- Modify: `supabase/schema.sql`
- Modify: `tests/migration-repeatability.spec.ts`

**Interfaces:**
- Produces columns: `cards.client_request_id uuid`、`attachments.state text`、`attachments.updated_at timestamptz`。
- Produces RPCs: `public.reorder_attachments(p_card_id bigint, p_attachment_ids uuid[])` and `public.consume_ai_daily_quota(p_user_id uuid, p_limit integer)`.
- Produces trigger semantics: same-user focus acquisition is serialized before counting.

- [ ] **Step 1: Write failing PGlite migration tests**

```ts
test("the complete schema and every migration can run twice", async () => {
  await installAuthAndStorageFixtures(db, ALICE_ID);
  await db.exec(schema);
  await db.exec(schema);
  await db.exec(memoMigration);
  await db.exec(memoMigration);
  await db.exec(aiMigration);
  await db.exec(aiMigration);
  await db.exec(stabilizationMigration);
  await db.exec(stabilizationMigration);
});

test("a fourth active focus is rejected", async () => {
  await seedThreeFocusedCards(db, ALICE_ID);
  await expect(db.exec(insertFourthFocus)).rejects.toThrow(/最多保留 3 条/);
});
```

Also assert that an attachment cannot change to a card owned by another fixture user, ready attachment IDs reorder atomically, and quota call `limit + 1` is rejected.

- [ ] **Step 2: Run the database tests and verify RED**

Run: `npx.cmd vitest run tests/migration-repeatability.spec.ts tests/schema-stabilization.spec.ts`

Expected: FAIL on duplicate policies, missing stabilization migration/RPCs and the unlocked focus path.

- [ ] **Step 3: Make the complete schema safely repeatable without rewriting history**

The complete schema and new stabilization migration start with:

```sql
begin;
select pg_advisory_xact_lock(hashtextextended('cloud-memo-board/schema-migrations', 0));
```

Constraint lookup includes `conrelid = 'public.<table>'::regclass`; every policy is deterministically recreated with `drop policy if exists` followed by `create policy`; the new migration ends with `commit`. Keep the two already published 20260824 migration files byte-for-byte unchanged; their repeatability tests remain as historical compatibility evidence.

- [ ] **Step 4: Add the stabilization migration**

The focus trigger obtains:

```sql
perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 0));
```

Attachment insert/update policies require both the owning card and `split_part(object_key, '/', 1) = auth.uid()::text`. Add `state` constrained to `pending|ready|deleting`, timestamps, the set-validating reorder RPC, `(user_id, client_request_id)` uniqueness, and an `ai_usage_daily(day,user_id,count)` table plus atomic quota RPC. Revoke quota RPC from public/anonymous/authenticated and grant it only to service role.

- [ ] **Step 5: Verify GREEN and commit**

Run: `npx.cmd vitest run tests/migration-repeatability.spec.ts tests/schema-stabilization.spec.ts`

Expected: all database tests pass twice without data reset.

Commit: `fix: enforce database consistency invariants`

---

### Task 3: DeepSeek 配置、用户额度与结构化日志

**Files:**
- Modify: `netlify/functions/organize-idea.mts`
- Modify: `tests/idea-organizer.test.ts`
- Modify: `部署说明.md`

**Interfaces:**
- `verifyUser(...)` returns `{ id: string }`.
- `validatedModel(env)` returns `"deepseek-v4-flash" | "deepseek-v4-pro"` or throws `SERVER_NOT_CONFIGURED`.
- Handler dependencies add `logger?: Pick<Console, "error" | "warn" | "info">` and `now?: () => number` for deterministic behavior tests.
- Supabase RPC consumes quota after authentication and before the DeepSeek request.

- [ ] **Step 1: Add failing handler behavior tests**

```ts
test("authenticates before parsing a malformed body", async () => {
  const calls: string[] = [];
  const response = await handler(malformedRequest, instrumentedDependencies(calls));
  assert.deepEqual(calls, ["auth"]);
  assert.equal(response.status, 400);
});

test("rejects unsupported models before calling DeepSeek", async () => {
  const response = await handler(validRequest, deps({ DEEPSEEK_MODEL: "deepseek-chat" }));
  assert.equal(response.status, 503);
  assert.equal(deepseekCalls, 0);
});
```

Add separate tests for auth → quota → DeepSeek order, exhausted quota, 429, timeout, truncated/invalid JSON, request ID response header, and logs that omit original text/token/key.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm.cmd run test:unit`

Expected: new order/model/quota/log tests fail against the current handler.

- [ ] **Step 3: Implement the minimal server changes**

```ts
type VerifiedUser = { id: string };
type SupportedModel = "deepseek-v4-flash" | "deepseek-v4-pro";
const SUPPORTED_MODELS = new Set<SupportedModel>(["deepseek-v4-flash", "deepseek-v4-pro"]);
```

Authenticate, parse, consume quota, then request AI. Emit one structured record containing only `event`, `request_id`, `deploy_sha`, `model`, `outcome`, `status`, and `duration_ms`. Preserve current safe Chinese error messages and `Cache-Control: no-store`.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npm.cmd run test:unit`

Run: `npm.cmd run lint`

Expected: all unit tests and lint pass with no logged secrets.

Commit: `fix: harden AI request boundaries`

---

### Task 4: 可恢复附件操作与幂等创建

**Files:**
- Create: `tests/supabase-board.spec.ts`
- Modify: `lib/types.ts`
- Modify: `lib/supabase-board.ts`
- Modify: `app/components/IdeaBoard.tsx`

**Interfaces:**
- `AttachmentRecord.state` is `"pending" | "ready" | "deleting"`.
- `createBoardCard(..., clientRequestId: string, knownSortOrder?: number)` upserts/selects by the stable request ID.
- `reconcileBoardAttachments()` repairs stale non-ready rows owned by the current user.
- `reorderBoardAttachments(cardId, ids)` calls the database RPC once.

- [ ] **Step 1: Write failing data-layer tests with a complete Supabase boundary fake**

```ts
test("upload exposes only ready metadata and compensates a failed object write", async () => {
  await expect(uploadBoardAttachment(7, image)).rejects.toThrow(/上传失败/);
  expect(fakeDb.attachments.filter((item) => item.state === "ready")).toHaveLength(0);
});

test("reorder is one atomic RPC", async () => {
  await reorderBoardAttachments(7, [A_ID, B_ID]);
  expect(fakeClient.rpcCalls).toEqual([{ name: "reorder_attachments", args: { p_card_id: 7, p_attachment_ids: [A_ID, B_ID] } }]);
});
```

Add cases for ready transition, deleting transition/revert, stale pending/deleting reconciliation and repeated card create with one request UUID producing one row.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx.cmd vitest run tests/supabase-board.spec.ts`

Expected: FAIL because state/reconciliation/RPC/idempotency interfaces do not exist.

- [ ] **Step 3: Implement attachment state transitions and create idempotency**

Map only `ready` attachments into visible cards. Upload sequence is metadata pending → object upload → metadata ready; delete sequence is metadata deleting → object delete → metadata delete, with ready rollback if object deletion fails. Reconciliation only touches non-ready rows older than 15 minutes. Use one `rpc("reorder_attachments", ...)` call.

Card creation inserts `client_request_id`; on a duplicate response it selects the existing row by request ID. Editor/composer retains one UUID for a retry instead of generating a new one.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npx.cmd vitest run tests/supabase-board.spec.ts`

Run: `npm.cmd run typecheck`

Expected: focused tests and typecheck pass.

Commit: `fix: make storage operations recoverable`

---

### Task 5: 保存待核对状态与并发操作计数

**Files:**
- Create: `lib/operation-state.ts`
- Create: `tests/operation-state.test.ts`
- Modify: `lib/types.ts`
- Modify: `lib/local-state.ts`
- Modify: `app/components/IdeaBoard.tsx`
- Modify: `tests/account-isolation.spec.tsx`

**Interfaces:**
- `waitForInitialOutcome<T>(completion, timeoutMs)` returns `{ state: "confirmed", value } | { state: "pending" }` without cancelling `completion`.
- Card saves return `{ card: CardRecord; state: "confirmed" | "pending" }`.
- `SyncState` adds `checking`; each card has a mutation version and pending confirmation marker.

- [ ] **Step 1: Write failing operation-state tests**

```ts
test("timeout reports pending while preserving late success", async () => {
  const deferred = createDeferred<string>();
  const initial = await waitForInitialOutcome(deferred.promise, 1);
  assert.deepEqual(initial, { state: "pending" });
  deferred.resolve("saved");
  await assert.doesNotReject(deferred.promise);
});
```

Add cases for immediate success, immediate failure, late failure rollback, stale mutation response ignored and two concurrent operations keeping the activity count nonzero until both finish.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --experimental-strip-types --test tests/operation-state.test.ts`

Expected: FAIL because `operation-state.ts` does not exist.

- [ ] **Step 3: Implement pure operation monitoring, then integrate the board**

```ts
export type InitialOutcome<T> =
  | { state: "confirmed"; value: T }
  | { state: "pending" };
```

On timeout keep the optimistic card and draft, set `checking`, attach late success/failure handlers to the same promise, and never resubmit from “重新核对”. Clear the per-card draft only after confirmed success. Replace the single `saving` setter pattern with increment/decrement helpers.

- [ ] **Step 4: Verify GREEN and commit**

Run: `node --experimental-strip-types --test tests/operation-state.test.ts`

Run: `npx.cmd vitest run tests/account-isolation.spec.tsx`

Expected: all focused state and component tests pass.

Commit: `fix: reconcile ambiguous cloud saves`

---

### Task 6: 可选择会话与个人账号页

**Files:**
- Create: `app/components/AccountPanel.tsx`
- Create: `tests/auth-storage.spec.ts`
- Create: `tests/account-panel.spec.tsx`
- Modify: `lib/supabase-client.ts`
- Modify: `lib/local-state.ts`
- Modify: `src/App.tsx`
- Modify: `app/components/IdeaBoard.tsx`
- Modify: `app/globals.css`

**Interfaces:**
- `AuthStorageMode = "persistent" | "session"`.
- `configureSupabaseAuthMode(mode)` returns the active client using `localStorage` or `sessionStorage`.
- `readRememberedEmail()` / `setRememberedLogin(email, remember)` never touch password fields.
- `clearUserLocalState(userId)` removes only that user’s board/draft keys.
- `onSignOut({ scope, clearLocalData })` returns a promise and reports failure without local deletion.

- [ ] **Step 1: Write failing auth/storage and account component tests**

```ts
test("clearing Alice leaves Bob and unrelated storage intact", () => {
  clearUserLocalState("alice");
  assert.equal(localStorage.getItem(boardCacheKey("alice")), null);
  assert.notEqual(localStorage.getItem(boardCacheKey("bob")), null);
  assert.equal(localStorage.getItem("unrelated"), "keep");
});
```

Component tests assert the default checked login option, remembered email, browser-managed password copy, current email, password validation, ordinary logout, global logout, clear-device logout and remote failure preserving local data.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx.cmd vitest run tests/auth-storage.spec.ts`

Run: `npx.cmd vitest run tests/account-panel.spec.tsx tests/account-isolation.spec.tsx`

Expected: FAIL because session selection, scoped clear and account page do not exist.

- [ ] **Step 3: Implement storage selection and account UI**

```ts
export type AuthStorageMode = "persistent" | "session";
export type SignOutRequest = { scope: "local" | "global"; clearLocalData: boolean };
```

Recreate the Supabase client before login when mode changes; `persistent` uses `localStorage`, `session` uses `sessionStorage`. The account page is a fourth main view and reuses the current layout language. It does not expose service-role operations or a user list.

- [ ] **Step 4: Verify GREEN and commit**

Run the two focused commands from Step 2, then `npm.cmd run typecheck` and `npm.cmd run lint`.

Expected: all commands exit 0.

Commit: `feat: add personal account controls`

---

### Task 7: 弹层焦点、移动输入与视觉可读性

**Files:**
- Create: `lib/use-modal-focus.ts`
- Create: `tests/modal-focus.spec.tsx`
- Modify: `app/components/IdeaBoard.tsx`
- Modify: `app/components/AttachmentMedia.tsx`
- Modify: `src/App.tsx`
- Modify: `app/globals.css`

**Interfaces:**
- `useModalFocus({ containerRef, initialFocusRef, onClose, active })` implements initial focus, Tab wrap, Escape and focus restoration.
- Mobile stage filters use `aria-pressed`; navigation menu exposes `aria-expanded` and `aria-controls`.

- [ ] **Step 1: Write failing real-DOM interaction tests**

```tsx
test("modal focus stays inside and returns to its opener", async () => {
  opener.focus();
  await openDialog();
  expect(document.activeElement).toBe(firstField);
  pressTabFrom(lastButton);
  expect(document.activeElement).toBe(firstField);
  pressEscape();
  expect(document.activeElement).toBe(opener);
});
```

Add tests for image viewer nesting, menu state, loading `role=status`, named file input, Windows paste copy and mobile paste feedback without silent loss.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx.cmd vitest run tests/modal-focus.spec.tsx`

Expected: focus escapes the dialogs and the new semantics are absent.

- [ ] **Step 3: Implement focus behavior and surgical UI changes**

Use the approved palette tokens. Raise ordinary helper text to at least 12px, mobile inputs to 16px, primary mobile targets to 44px; remove fixed `⌘V` copy in favor of platform-neutral “粘贴”; keep reduced-motion behavior and existing layout identity.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npx.cmd vitest run tests/modal-focus.spec.tsx`

Run: `npm.cmd run lint`

Expected: focused tests and lint pass without accessibility warnings.

Commit: `fix: improve accessible capture flows`

---

### Task 8: 文档、全量验证、预览迁移与生产发布

**Files:**
- Modify: `README.md`
- Modify: `部署说明.md`
- Create: `docs/operations/release-checklist.md`

**Interfaces:**
- Produces one operator checklist for DB migration → environment → preview → browser acceptance → production → rollback.
- Produces final commit SHA and deployed URL evidence.

- [ ] **Step 1: Update operator documentation**

Document the canonical repository, exact environment variable names/scopes, SQL migration order, AI quota default, session semantics, non-sensitive log fields, preview-first deployment and rollback. Correct the obsolete statement that re-running memo migration resets attachment order.

- [ ] **Step 2: Commit the operator documentation**

Commit: `docs: finalize release operations`

- [ ] **Step 3: Run fresh local verification**

Run: `npm.cmd ci`

Run with safe public test values: `npm.cmd run verify:release`

Run: `npm.cmd audit --omit=dev --audit-level=low --registry=https://registry.npmjs.org`

Run: `git grep -Il -E "(sk-[A-Za-z0-9]{20,}|sb_secret_[A-Za-z0-9_-]{20,}|service_role.{0,20}[A-Za-z0-9_-]{40,})" -- . ":!package-lock.json"`

Expected: no filenames are printed; Git exit 1 means no matching tracked secret value.

- [ ] **Step 4: Review the complete branch**

Generate one diff package from merge base to HEAD. Review spec compliance, security, race behavior, migration safety, tests, accessibility and deployment configuration. Resolve all Critical/Important findings and rerun affected tests.

- [ ] **Step 5: Apply database migration and configure preview**

Record migration state without printing values; apply `202609050001_product_stabilization.sql` once through the authorized Supabase channel; set `DEEPSEEK_MODEL=deepseek-v4-flash` and required public/function variables with correct Netlify scopes. If authorization is unavailable, mark these steps `pending_external` and do not claim the feature deployed.

- [ ] **Step 6: Deploy fixed preview and perform browser acceptance**

Deploy the exact verified `dist` plus functions to a fixed preview alias. Verify HTTP headers, SPA route, login, remembered/non-remembered session, account controls, create/save/refresh, delayed save reconciliation, focus limit, screenshot lifecycle, AI organize/adopt, logout retention and logout clear at desktop and 393px mobile. Check console and network failures.

- [ ] **Step 7: Publish without reviving the historical snapshot**

After preview passes, push `codex/product-stabilization`, merge through the reviewed path, and update production Netlify from the same commit. Leave `任务看板\云端部署` unchanged as a preserved historical snapshot; document that future edits and deployments happen from the canonical repository instead of recreating manual synchronization.

- [ ] **Step 8: Final production verification**

Repeat the full local suite, production smoke and authenticated browser acceptance against the final URL. Record exact pass counts, commit SHA, deploy ID, URL and any `pending_external` items in the handoff; do not create a post-deploy code commit that differs from the deployed SHA.
