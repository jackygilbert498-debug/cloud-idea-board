import assert from "node:assert/strict";
import test from "node:test";
import { normalizeIdeaOrganization } from "../lib/idea-organizer-model.ts";
import { createOrganizeIdeaHandler } from "../netlify/functions/organize-idea.mts";

const AUTH_TOKEN = "client-token-that-must-never-be-logged";
const SERVICE_KEY = "server-service-key-that-must-never-be-logged";
const DEEPSEEK_KEY = "deepseek-key-that-must-never-be-logged";
const ORIGINAL_TEXT = "这是不应进入日志的原始想法";
const BASE_ENV: NodeJS.ProcessEnv = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  DEEPSEEK_API_KEY: DEEPSEEK_KEY,
  DEEPSEEK_MODEL: "deepseek-v4-pro",
  AI_DAILY_QUOTA_LIMIT: "20",
  COMMIT_REF: "deploy-sha-123",
};
const SILENT_LOGGER = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
};

function ideaRequest(
  body: BodyInit = JSON.stringify({ originalText: ORIGINAL_TEXT }),
  headers: HeadersInit = {},
): Request {
  return new Request("https://board.example/api/organize-idea", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      "Content-Type": "application/json",
      "X-Nf-Request-Id": "request-123",
      ...headers,
    },
    body,
  });
}

function successfulDeepSeekResponse(): Response {
  return Response.json({
    choices: [{
      finish_reason: "stop",
      message: { content: JSON.stringify({
        suggestedTitle: "建议标题",
        organizedText: "整理后的文字",
        analysis: {
          actions: [],
          times: [],
          people: [],
          blockers: [],
          uncertainties: [],
          priority: { value: null },
        },
      }) },
    }],
  });
}

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

test("authenticates before parsing a malformed body", async () => {
  const calls: string[] = [];
  const handler = createOrganizeIdeaHandler({
    fetchImpl: (async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/v1/user")) {
        calls.push("auth");
        return Response.json({ id: "server-user-id" });
      }
      calls.push("unexpected");
      return successfulDeepSeekResponse();
    }) as typeof fetch,
    env: BASE_ENV,
    logger: SILENT_LOGGER,
  });

  const response = await handler(ideaRequest("{"));

  assert.deepEqual(calls, ["auth"]);
  assert.equal(response.status, 400);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "INVALID_JSON");
});

test("rejects unauthenticated requests before parsing the body", async () => {
  const handler = createOrganizeIdeaHandler({
    fetchImpl: (async () => new Response(null, { status: 401 })) as typeof fetch,
    env: BASE_ENV,
    logger: SILENT_LOGGER,
  });

  const response = await handler(ideaRequest("{"));

  assert.equal(response.status, 401);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "UNAUTHENTICATED");
});

test("rejects a missing bearer token before any external call", async () => {
  let calls = 0;
  const handler = createOrganizeIdeaHandler({
    fetchImpl: (async () => {
      calls += 1;
      return Response.json({});
    }) as typeof fetch,
    env: BASE_ENV,
    logger: SILENT_LOGGER,
  });

  const response = await handler(ideaRequest(undefined, { Authorization: "" }));

  assert.equal(response.status, 401);
  assert.equal(calls, 0);
});

test("rejects unsupported models before consuming quota or calling DeepSeek", async () => {
  const calls: string[] = [];
  const handler = createOrganizeIdeaHandler({
    fetchImpl: (async (input) => {
      const url = String(input);
      calls.push(url.endsWith("/auth/v1/user") ? "auth" : "unexpected");
      return Response.json({ id: "server-user-id" });
    }) as typeof fetch,
    env: { ...BASE_ENV, DEEPSEEK_MODEL: "deepseek-chat" },
    logger: SILENT_LOGGER,
  });

  const response = await handler(ideaRequest());

  assert.equal(response.status, 503);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "SERVER_NOT_CONFIGURED");
  assert.deepEqual(calls, ["auth"]);
});

test("calls auth, atomic user quota and DeepSeek in order with the supported thinking payload", async () => {
  const calls: string[] = [];
  let quotaBody: Record<string, unknown> | undefined;
  let quotaHeaders: Headers | undefined;
  let deepSeekBody: Record<string, unknown> | undefined;
  const handler = createOrganizeIdeaHandler({
    fetchImpl: (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/auth/v1/user")) {
        calls.push("auth");
        return Response.json({ id: "server-user-id" });
      }
      if (url.endsWith("/rest/v1/rpc/consume_ai_daily_quota")) {
        calls.push("quota");
        quotaBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        quotaHeaders = new Headers(init?.headers);
        return Response.json(1);
      }
      calls.push("deepseek");
      deepSeekBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return successfulDeepSeekResponse();
    }) as typeof fetch,
    env: BASE_ENV,
    logger: SILENT_LOGGER,
  });

  const response = await handler(ideaRequest(JSON.stringify({
    originalText: "只整理这一张卡片",
    userId: "attacker-selected-user",
    ignored: "其他卡片",
  })));

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["auth", "quota", "deepseek"]);
  assert.deepEqual(quotaBody, { p_user_id: "server-user-id", p_limit: 20 });
  assert.equal(quotaHeaders?.get("authorization"), `Bearer ${SERVICE_KEY}`);
  assert.notEqual(quotaHeaders?.get("authorization"), `Bearer ${AUTH_TOKEN}`);
  assert.equal(deepSeekBody?.model, "deepseek-v4-pro");
  assert.deepEqual(deepSeekBody?.thinking, { type: "enabled" });
  assert.equal(deepSeekBody?.reasoning_effort, "high");
  assert.deepEqual(deepSeekBody?.response_format, { type: "json_object" });
  assert.equal(deepSeekBody?.stream, false);
  assert.equal("temperature" in (deepSeekBody ?? {}), false);
  assert.equal("top_p" in (deepSeekBody ?? {}), false);
  const messages = deepSeekBody?.messages as Array<{ role: string; content: string }>;
  assert.equal(messages.at(-1)?.content, "只整理这一张卡片");
  assert.doesNotMatch(JSON.stringify(deepSeekBody), /其他卡片|server-service-key/);
});

test("returns an account quota 429 without calling DeepSeek", async () => {
  const calls: string[] = [];
  const handler = createOrganizeIdeaHandler({
    fetchImpl: (async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/v1/user")) {
        calls.push("auth");
        return Response.json({ id: "server-user-id" });
      }
      calls.push("quota");
      return Response.json({ message: "AI_DAILY_QUOTA_EXCEEDED" }, { status: 400 });
    }) as typeof fetch,
    env: BASE_ENV,
    logger: SILENT_LOGGER,
  });

  const response = await handler(ideaRequest());

  assert.equal(response.status, 429);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "AI_QUOTA_EXHAUSTED");
  assert.deepEqual(calls, ["auth", "quota"]);
});

test("distinguishes an upstream DeepSeek 429 from account quota exhaustion", async () => {
  const handler = createOrganizeIdeaHandler({
    fetchImpl: (async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/v1/user")) return Response.json({ id: "server-user-id" });
      if (url.endsWith("/rest/v1/rpc/consume_ai_daily_quota")) return Response.json(1);
      return Response.json({ error: "upstream detail must not escape" }, { status: 429 });
    }) as typeof fetch,
    env: BASE_ENV,
    logger: SILENT_LOGGER,
  });

  const response = await handler(ideaRequest());
  const body = await response.json() as { error: { code: string; message: string } };

  assert.equal(response.status, 429);
  assert.equal(body.error.code, "AI_RATE_LIMITED");
  assert.doesNotMatch(JSON.stringify(body), /upstream detail/);
});

test("classifies a DeepSeek timeout without leaking its internal error", async () => {
  const handler = createOrganizeIdeaHandler({
    fetchImpl: (async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/v1/user")) return Response.json({ id: "server-user-id" });
      if (url.endsWith("/rest/v1/rpc/consume_ai_daily_quota")) return Response.json(1);
      throw Object.assign(new Error("socket included sensitive upstream diagnostics"), { code: "ETIMEDOUT" });
    }) as typeof fetch,
    env: BASE_ENV,
    logger: SILENT_LOGGER,
  });

  const response = await handler(ideaRequest());
  const body = await response.json() as { error: { code: string; message: string } };

  assert.equal(response.status, 504);
  assert.equal(body.error.code, "AI_TIMEOUT");
  assert.doesNotMatch(JSON.stringify(body), /socket|diagnostics/);
});

test("distinguishes truncated and invalid DeepSeek JSON responses", async (t) => {
  const cases = [
    {
      name: "truncated",
      response: Response.json({ choices: [{ finish_reason: "length", message: { content: "{}" } }] }),
      code: "AI_RESPONSE_TRUNCATED",
    },
    {
      name: "invalid JSON",
      response: Response.json({ choices: [{ finish_reason: "stop", message: { content: "{not-json" } }] }),
      code: "AI_INVALID_RESPONSE",
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const handler = createOrganizeIdeaHandler({
        fetchImpl: (async (input) => {
          const url = String(input);
          if (url.endsWith("/auth/v1/user")) return Response.json({ id: "server-user-id" });
          if (url.endsWith("/rest/v1/rpc/consume_ai_daily_quota")) return Response.json(1);
          return fixture.response;
        }) as typeof fetch,
        env: BASE_ENV,
        logger: SILENT_LOGGER,
      });

      const response = await handler(ideaRequest());

      assert.equal(response.status, 502);
      assert.equal((await response.json() as { error: { code: string } }).error.code, fixture.code);
    });
  }
});

test("adds no-store and request ID headers to success and error responses", async (t) => {
  const cases = [
    { name: "success", body: JSON.stringify({ originalText: ORIGINAL_TEXT }), expectedStatus: 200 },
    { name: "malformed body", body: "{", expectedStatus: 400 },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const handler = createOrganizeIdeaHandler({
        fetchImpl: (async (input) => {
          const url = String(input);
          if (url.endsWith("/auth/v1/user")) return Response.json({ id: "server-user-id" });
          if (url.endsWith("/rest/v1/rpc/consume_ai_daily_quota")) return Response.json(1);
          return successfulDeepSeekResponse();
        }) as typeof fetch,
        env: BASE_ENV,
        logger: SILENT_LOGGER,
      });

      const response = await handler(ideaRequest(fixture.body));

      assert.equal(response.status, fixture.expectedStatus);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-request-id"), "request-123");
    });
  }
});

test("emits one structured log record containing only approved non-sensitive fields", async () => {
  const records: unknown[][] = [];
  const logger = {
    error: (...args: unknown[]) => records.push(args),
    warn: (...args: unknown[]) => records.push(args),
    info: (...args: unknown[]) => records.push(args),
  };
  const handler = createOrganizeIdeaHandler({
    fetchImpl: (async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/v1/user")) return Response.json({ id: "server-user-id", email: "secret@example.com" });
      if (url.endsWith("/rest/v1/rpc/consume_ai_daily_quota")) return Response.json(1);
      return successfulDeepSeekResponse();
    }) as typeof fetch,
    env: BASE_ENV,
    logger,
    now: (() => {
      const values = [1_000, 1_075];
      return () => values.shift() ?? 1_075;
    })(),
  });

  const response = await handler(ideaRequest());

  assert.equal(response.status, 200);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], [{
    event: "organize_idea",
    request_id: "request-123",
    deploy_sha: "deploy-sha-123",
    model: "deepseek-v4-pro",
    outcome: "success",
    status: 200,
    duration_ms: 75,
  }]);
  assert.deepEqual(Object.keys((records[0][0] as Record<string, unknown>)).sort(), [
    "deploy_sha",
    "duration_ms",
    "event",
    "model",
    "outcome",
    "request_id",
    "status",
  ]);
  assert.doesNotMatch(
    JSON.stringify(records),
    new RegExp([ORIGINAL_TEXT, AUTH_TOKEN, SERVICE_KEY, DEEPSEEK_KEY, "secret@example.com"].join("|")),
  );
});
