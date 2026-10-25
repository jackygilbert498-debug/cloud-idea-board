import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("ships a Netlify SPA entrypoint with the memo workflow capabilities", async () => {
  const [netlifyConfig, viteConfig, app, board, media, organizer, aiFunction, model, dataLayer, schema, migration, aiMigration, ownerMigration] = await Promise.all([
    readFile(new URL("netlify.toml", root), "utf8"),
    readFile(new URL("vite.config.ts", root), "utf8"),
    readFile(new URL("src/App.tsx", root), "utf8"),
    readFile(new URL("app/components/IdeaBoard.tsx", root), "utf8"),
    readFile(new URL("app/components/AttachmentMedia.tsx", root), "utf8"),
    readFile(new URL("app/components/IdeaOrganizer.tsx", root), "utf8"),
    readFile(new URL("netlify/functions/organize-idea.mts", root), "utf8"),
    readFile(new URL("lib/board-model.ts", root), "utf8"),
    readFile(new URL("lib/supabase-board.ts", root), "utf8"),
    readFile(new URL("supabase/schema.sql", root), "utf8"),
    readFile(new URL("supabase/migrations/20260824_memo_flow.sql", root), "utf8"),
    readFile(new URL("supabase/migrations/20260824_restore_ai_organizer.sql", root), "utf8"),
    readFile(new URL("supabase/migrations/20260906_attachment_owner_integrity.sql", root), "utf8"),
  ]);
  assert.match(netlifyConfig, /publish\s*=\s*"dist"/);
  assert.match(netlifyConfig, /to\s*=\s*"\/index\.html"/);
  assert.match(netlifyConfig, /directory\s*=\s*"netlify\/functions"/);
  assert.match(viteConfig, /@vitejs\/plugin-react/);
  assert.doesNotMatch(viteConfig, /cloudflare:workers|sites-vite-plugin|\.openai/);
  assert.match(app, /signInWithPassword/);
  assert.match(app, /登录状态检查超时/);
  assert.match(model, /DONE_BOARD_LIMIT = 3/);
  assert.match(model, /groupArchiveCards/);
  assert.match(board, /card\.stage !== "done"/);
  assert.match(board, /pendingFiles/);
  assert.match(board, /clipboardData\.items/);
  assert.match(board, /undoAction/);
  assert.match(board, /本机草稿/);
  assert.match(media, /截图加载失败/);
  assert.match(media, /clearAttachmentUrlCache/);
  assert.match(media, /wasPinching/);
  assert.match(organizer, /AI 梳理/);
  assert.match(organizer, /采用整理稿/);
  assert.match(aiFunction, /DEEPSEEK_API_KEY/);
  assert.match(aiFunction, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(aiFunction, /rateLimit/);
  assert.doesNotMatch(aiFunction, /sb_secret_|sk-[A-Za-z0-9]/);
  assert.match(dataLayer, /getBoardAttachmentUrl/);
  assert.match(dataLayer, /reorderBoardAttachments/);
  assert.match(dataLayer, /validateBoardAttachment/);
  assert.match(dataLayer, /select\("\*, attachments\(\*\)"\)/);
  assert.match(dataLayer, /\.select\("\*"\)\.single\(\)/);
  assert.match(board, /commitCard\(applyCardPatch\(before, effectivePatch\), false\)/);
  assert.match(board, /nextStageSortOrder\(cardsRef\.current, stage\)/);
  assert.match(board, /if \(canSyncInBackground\) onClose\(\)/);
  assert.match(board, /保存超时，内容已保留在本机草稿中/);
  const mutationBody = board.slice(board.indexOf("const mutate ="), board.indexOf("const uploadFiles ="));
  assert.doesNotMatch(mutationBody, /await load\(/, "single-card saves must not reload the entire board");
  assert.match(schema, /enable row level security/);
  assert.match(schema, /storage\.buckets/);
  assert.match(migration, /completed_at/);
  assert.match(migration, /previous_stage/);
  assert.match(migration, /sort_order/);
  assert.match(aiMigration, /original_text/);
  assert.match(aiMigration, /ai_analysis/);
  assert.match(ownerMigration, /attachments_enforce_card_owner/);
  const globalHeaders = netlifyConfig.slice(netlifyConfig.indexOf('for = "/*"'));
  assert.match(globalHeaders, /X-Content-Type-Options\s*=\s*"nosniff"/);
  assert.match(globalHeaders, /Referrer-Policy\s*=\s*"strict-origin-when-cross-origin"/);
  assert.match(globalHeaders, /Content-Security-Policy\s*=/);
  assert.match(globalHeaders, /frame-ancestors 'none'/);
  assert.match(globalHeaders, /connect-src 'self' https:\/\/\*\.supabase\.co wss:\/\/\*\.supabase\.co/);
  await access(new URL("dist/index.html", root));
});

test("production bundle excludes the isolated design fixture", async () => {
  const html = await readFile(new URL("dist/index.html", root), "utf8");
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /interactive-widget=resizes-content/);
  assert.doesNotMatch(html, /user-scalable=no|maximum-scale=1/);
  const script = html.match(/src="(\/assets\/[^"<>]+\.js)"/)?.[1];
  assert.ok(script, "production entrypoint must reference its built JavaScript");
  const bundle = await readFile(new URL(`dist${script}`, root), "utf8");
  assert.doesNotMatch(bundle, /design-qa-isolated|ui-fixture|这是本地示例/);
});

test("production serves the current portable receiver package, not an SPA fallback", async () => {
  const archive = await readFile(new URL("dist/codex-receiver.zip", root));
  assert.equal(archive.readUInt32LE(0), 0x04034b50);
  for (const file of ["receiver.py", "receiver_core.py", "codex_executor.py", "receiver_install.py"]) {
    assert.ok(archive.includes(Buffer.from(`codex-receiver/runner/${file}`)));
    const source = await readFile(new URL(`runner/${file}`, root));
    assert.ok(archive.includes(source), `${file} in the downloadable ZIP must match current source`);
  }
  assert.ok(archive.includes(Buffer.from("codex-receiver/README.md")));
});
