import assert from "node:assert/strict";
import test from "node:test";
import { normalizeIdeaOrganization } from "../lib/idea-organizer-model.ts";
import { createOrganizeIdeaHandler } from "../netlify/functions/organize-idea.mts";

test("normalizes safe DeepSeek schema variants without inventing fields", () => {
  const result = normalizeIdeaOrganization({
    suggested_title: "整理任务看板",
    organized_text: "先恢复 AI，再验证截图流程。",
    analysis: {
      actions: ["恢复 AI", { text: "验证截图", certainty: "inferred" }, "恢复 AI"],
      times: [{ text: "明天", certainty: "uncertain" }],
      people: [],
      blockers: [],
      uncertainties: ["部署时间"],
      priority: { value: "高", certainty: "inferred", reason: "影响记录入口" },
    },
  }, { model: "deepseek-v4-pro", promptVersion: "memo-organizer-v3" });

  assert.equal(result.suggestedTitle, "整理任务看板");
  assert.equal(result.organizedText, "先恢复 AI，再验证截图流程。");
  assert.deepEqual(result.analysis.actions, [
    { text: "恢复 AI", certainty: "explicit" },
    { text: "验证截图", certainty: "inferred" },
  ]);
  assert.equal(result.analysis.priority.value, "high");
  assert.equal(result.meta.model, "deepseek-v4-pro");
});

test("rejects an AI response without an organized draft", () => {
  assert.throws(
    () => normalizeIdeaOrganization({ suggestedTitle: "只有标题" }),
    /没有返回可用的整理稿/,
  );
});

test("server function authenticates first and forwards only the current original text", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/auth/v1/user")) return Response.json({ id: "user-1" });
    return Response.json({
      choices: [{
        finish_reason: "stop",
        message: { content: JSON.stringify({
          suggestedTitle: "建议标题",
          organizedText: "整理后的文字",
          analysis: { actions: [], times: [], people: [], blockers: [], uncertainties: [], priority: { value: null } },
        }) },
      }],
    });
  };
  const handler = createOrganizeIdeaHandler({
    fetchImpl: fetchImpl as typeof fetch,
    env: {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "server-only-key",
      DEEPSEEK_API_KEY: "deepseek-server-key",
      DEEPSEEK_MODEL: "deepseek-v4-pro",
    },
  });
  const response = await handler(new Request("https://board.example/api/organize-idea", {
    method: "POST",
    headers: { Authorization: `Bearer ${"x".repeat(40)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ originalText: "只整理这一张卡片", ignored: "其他卡片" }),
  }));
  assert.equal(response.status, 200);
  const body = await response.json() as { organizedText: string; meta: { promptVersion: string } };
  assert.equal(body.organizedText, "整理后的文字");
  assert.equal(body.meta.promptVersion, "memo-organizer-v3");
  assert.equal(calls.length, 2);
  const deepSeekBody = JSON.parse(String(calls[1].init?.body)) as { messages: Array<{ role: string; content: string }> };
  assert.equal(deepSeekBody.messages.at(-1)?.content, "只整理这一张卡片");
  assert.doesNotMatch(JSON.stringify(deepSeekBody), /其他卡片|server-only-key/);
});

test("server function rejects requests without a login token before external calls", async () => {
  let calls = 0;
  const handler = createOrganizeIdeaHandler({
    fetchImpl: (async () => { calls += 1; return Response.json({}); }) as typeof fetch,
    env: {},
  });
  const response = await handler(new Request("https://board.example/api/organize-idea", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ originalText: "测试" }),
  }));
  assert.equal(response.status, 401);
  assert.equal(calls, 0);
});
