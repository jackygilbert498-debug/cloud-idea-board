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
};
const FUNCTION_CONTEXT = { requestId: "trusted-context-request-123" };
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
      ...headers,
    },
    body,
  });
}

function successfulDeepSeekResponse(): Response {
  return Response.json({
    choices: [{
      finish_reason: "stop",
      message: {
        reasoning_content: "reasoning-content-that-must-never-be-logged",
        content: JSON.stringify({
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
        }),
      },
    }],
  });
}

function responseWithJsonFailure(reason: unknown): Response {
  const response = new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  Object.defineProperty(response, "json", {
    value: async () => { throw reason; },
  });
  return response;
}

function jsonBodyWithUtf8Size(size: number): string {
  const prefix = '{"originalText":"边界","padding":"';
  const suffix = '"}';
  const paddingLength = size - Buffer.byteLength(prefix + suffix);
  assert.ok(paddingLength >= 0);
  const body = `${prefix}${"x".repeat(paddingLength)}${suffix}`;
  assert.equal(Buffer.byteLength(body), size);
  return body;
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

test("rejects missing, understated, or invalid content lengths by actual UTF-8 body bytes", async (t) => {
  const cases: Array<{ name: string; body: string; headers: HeadersInit; status: number; code: string }> = [
    { name: "missing length", body: jsonBodyWithUtf8Size(100_001), headers: {}, status: 413, code: "PAYLOAD_TOO_LARGE" },
    { name: "understated length", body: jsonBodyWithUtf8Size(100_001), headers: { "Content-Length": "10" }, status: 413, code: "PAYLOAD_TOO_LARGE" },
    { name: "invalid length with an oversized body", body: jsonBodyWithUtf8Size(120_019), headers: { "Content-Length": "not-a-number" }, status: 413, code: "PAYLOAD_TOO_LARGE" },
    { name: "invalid length", body: JSON.stringify({ originalText: "合法正文" }), headers: { "Content-Length": "not-a-number" }, status: 400, code: "INVALID_CONTENT_LENGTH" },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const calls: string[] = [];
      const handler = createOrganizeIdeaHandler({
        fetchImpl: (async (input) => {
          const url = String(input);
          if (url.endsWith("/auth/v1/user")) {
            calls.push("auth");
            return Response.json({ id: "server-user-id" });
          }
          calls.push(url.includes("consume_ai_daily_quota") ? "quota" : "deepseek");
          return url.includes("consume_ai_daily_quota") ? Response.json(1) : successfulDeepSeekResponse();
        }) as typeof fetch,
        env: BASE_ENV,
        logger: SILENT_LOGGER,
      });

      const response = await handler(ideaRequest(fixture.body, fixture.headers));

      assert.equal(response.status, fixture.status);
      assert.equal((await response.json() as { error: { code: string } }).error.code, fixture.code);
      assert.deepEqual(calls, ["auth"]);
    });
  }
});

test("accepts a valid JSON request at the exact 100000-byte UTF-8 boundary", async () => {
  const body = jsonBodyWithUtf8Size(100_000);
  const calls: string[] = [];
  const handler = createOrganizeIdeaHandler({
    fetchImpl: (async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/v1/user")) {
        calls.push("auth");
        return Response.json({ id: "server-user-id" });
      }
      if (url.includes("consume_ai_daily_quota")) {
        calls.push("quota");
        return Response.json(1);
      }
      calls.push("deepseek");
      return successfulDeepSeekResponse();
    }) as typeof fetch,
    env: BASE_ENV,
    logger: SILENT_LOGGER,
  });

  const response = await handler(ideaRequest(body, { "Content-Length": "100000" }));

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["auth", "quota", "deepseek"]);
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

test("maps an auth response-body abort to availability without logging diagnostics", async () => {
  const records: unknown[][] = [];
  const logger = {
    error: (...args: unknown[]) => records.push(args),
    warn: (...args: unknown[]) => records.push(args),
    info: (...args: unknown[]) => records.push(args),
  };
  const diagnostic = `${AUTH_TOKEN}:${SERVICE_KEY}:auth-body-aborted`;
  const handler = createOrganizeIdeaHandler({
    fetchImpl: (async () => responseWithJsonFailure(new DOMException(diagnostic, "AbortError"))) as typeof fetch,
    env: BASE_ENV,
    logger,
  });

  const response = await handler(ideaRequest());

  assert.equal(response.status, 503);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "AUTH_UNAVAILABLE");
  assert.equal((records[0][0] as { outcome: string }).outcome, "auth_unavailable");
  assert.doesNotMatch(JSON.stringify(records), new RegExp(`${AUTH_TOKEN}|${SERVICE_KEY}|auth-body-aborted`));
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
  assert.equal(quotaHeaders?.get("apikey"), SERVICE_KEY);
  assert.equal(deepSeekBody?.model, "deepseek-v4-pro");
  assert.deepEqual(deepSeekBody?.thinking, { type: "enabled" });
  assert.equal(deepSeekBody?.reasoning_effort, "high");
  assert.deepEqual(deepSeekBody?.response_format, { type: "json_object" });
  assert.equal(deepSeekBody?.stream, false);
  assert.equal(deepSeekBody?.max_tokens, 8_000);
  assert.equal("temperature" in (deepSeekBody ?? {}), false);
  assert.equal("top_p" in (deepSeekBody ?? {}), false);
  const messages = deepSeekBody?.messages as Array<{ role: string; content: string }>;
  assert.equal(messages.at(-1)?.content, "只整理这一张卡片");
  assert.doesNotMatch(JSON.stringify(deepSeekBody), /其他卡片|server-service-key/);
});

test("uses service-key-compatible quota auth while preserving the user JWT", async (t) => {
  const cases = [
    { name: "new secret key", serviceKey: "sb_secret_current-service-key", quotaAuthorization: null },
    {
      name: "legacy JWT key",
      serviceKey: "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signature",
      quotaAuthorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signature",
    },
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      let authHeaders: Headers | undefined;
      let quotaHeaders: Headers | undefined;
      const records: unknown[][] = [];
      const handler = createOrganizeIdeaHandler({
        fetchImpl: (async (input, init) => {
          const url = String(input);
          if (url.endsWith("/auth/v1/user")) {
            authHeaders = new Headers(init?.headers);
            return Response.json({ id: "server-user-id" });
          }
          if (url.endsWith("/rest/v1/rpc/consume_ai_daily_quota")) {
            quotaHeaders = new Headers(init?.headers);
            if (quotaHeaders.get("authorization") !== fixture.quotaAuthorization) {
              return Response.json({ message: "wrong quota auth" }, { status: 403 });
            }
            return Response.json(1);
          }
          return successfulDeepSeekResponse();
        }) as typeof fetch,
        env: { ...BASE_ENV, SUPABASE_SERVICE_ROLE_KEY: fixture.serviceKey },
        logger: {
          error: (...args: unknown[]) => records.push(args),
          warn: (...args: unknown[]) => records.push(args),
          info: (...args: unknown[]) => records.push(args),
        },
      });

      const response = await handler(ideaRequest());

      assert.equal(response.status, 200);
      assert.equal(authHeaders?.get("apikey"), fixture.serviceKey);
      assert.equal(authHeaders?.get("authorization"), `Bearer ${AUTH_TOKEN}`);
      assert.equal(quotaHeaders?.get("apikey"), fixture.serviceKey);
      assert.equal(quotaHeaders?.get("authorization"), fixture.quotaAuthorization);
      assert.equal(JSON.stringify(records).includes(fixture.serviceKey), false);
    });
  }
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

test("fails closed when a successful quota RPC does not return a consumed count", async (t) => {
  const cases: Array<{ name: string; response: () => Response }> = [
    { name: "null", response: () => Response.json(null) },
    { name: "empty string", response: () => Response.json("") },
    { name: "numeric string", response: () => Response.json("1") },
    { name: "zero", response: () => Response.json(0) },
    { name: "above limit", response: () => Response.json(21) },
    { name: "fractional", response: () => Response.json(1.5) },
    {
      name: "invalid JSON",
      response: () => new Response("{", { status: 200, headers: { "Content-Type": "application/json" } }),
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      let deepSeekCalls = 0;
      const handler = createOrganizeIdeaHandler({
        fetchImpl: (async (input) => {
          const url = String(input);
          if (url.endsWith("/auth/v1/user")) return Response.json({ id: "server-user-id" });
          if (url.endsWith("/rest/v1/rpc/consume_ai_daily_quota")) return fixture.response();
          deepSeekCalls += 1;
          return successfulDeepSeekResponse();
        }) as typeof fetch,
        env: BASE_ENV,
        logger: SILENT_LOGGER,
      });

      const response = await handler(ideaRequest());

      assert.equal(response.status, 503);
      assert.equal((await response.json() as { error: { code: string } }).error.code, "AI_QUOTA_UNAVAILABLE");
      assert.equal(deepSeekCalls, 0);
    });
  }
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

test("maps a DeepSeek response-body timeout to AI timeout without logging diagnostics", async () => {
  const calls: string[] = [];
  const records: unknown[][] = [];
  const logger = {
    error: (...args: unknown[]) => records.push(args),
    warn: (...args: unknown[]) => records.push(args),
    info: (...args: unknown[]) => records.push(args),
  };
  const diagnostic = `${DEEPSEEK_KEY}:${ORIGINAL_TEXT}:deepseek-body-timeout`;
  const handler = createOrganizeIdeaHandler({
    fetchImpl: (async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/v1/user")) {
        calls.push("auth");
        return Response.json({ id: "server-user-id" });
      }
      if (url.endsWith("/rest/v1/rpc/consume_ai_daily_quota")) {
        calls.push("quota");
        return Response.json(1);
      }
      calls.push("deepseek");
      return responseWithJsonFailure(new DOMException(diagnostic, "TimeoutError"));
    }) as typeof fetch,
    env: BASE_ENV,
    logger,
  });

  const response = await handler(ideaRequest());

  assert.equal(response.status, 504);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "AI_TIMEOUT");
  assert.deepEqual(calls, ["auth", "quota", "deepseek"]);
  assert.equal((records[0][0] as { outcome: string }).outcome, "ai_timeout");
  assert.doesNotMatch(JSON.stringify(records), new RegExp(`${DEEPSEEK_KEY}|${ORIGINAL_TEXT}|deepseek-body-timeout`));
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

test("classifies an invalid outer DeepSeek response as invalid JSON", async () => {
  const handler = createOrganizeIdeaHandler({
    fetchImpl: (async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/v1/user")) return Response.json({ id: "server-user-id" });
      if (url.endsWith("/rest/v1/rpc/consume_ai_daily_quota")) return Response.json(1);
      return new Response("{", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch,
    env: BASE_ENV,
    logger: SILENT_LOGGER,
  });

  const response = await handler(ideaRequest());

  assert.equal(response.status, 502);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "AI_INVALID_RESPONSE");
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

      const response = await handler(ideaRequest(fixture.body), FUNCTION_CONTEXT);

      assert.equal(response.status, fixture.expectedStatus);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-request-id"), "trusted-context-request-123");
    });
  }
});

test("never trusts a client request ID header and generates a server UUID without context", async () => {
  const records: unknown[][] = [];
  const logger = {
    error: (...args: unknown[]) => records.push(args),
    warn: (...args: unknown[]) => records.push(args),
    info: (...args: unknown[]) => records.push(args),
  };
  const handler = createOrganizeIdeaHandler({
    fetchImpl: (async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/v1/user")) return Response.json({ id: "server-user-id" });
      if (url.endsWith("/rest/v1/rpc/consume_ai_daily_quota")) return Response.json(1);
      return successfulDeepSeekResponse();
    }) as typeof fetch,
    env: BASE_ENV,
    logger,
  });

  const response = await handler(ideaRequest(undefined, { "X-Nf-Request-Id": AUTH_TOKEN }));
  const requestId = response.headers.get("x-request-id") ?? "";

  assert.match(requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.notEqual(requestId, AUTH_TOKEN);
  assert.doesNotMatch(JSON.stringify(records), new RegExp(AUTH_TOKEN));
});

test("caps each fetch by its phase limit and the remaining end-to-end deadline", async () => {
  let clock = 0;
  const budgets: number[] = [];
  const handler = createOrganizeIdeaHandler({
    fetchImpl: (async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/v1/user")) {
        clock = 8_000;
        return Response.json({ id: "server-user-id" });
      }
      if (url.endsWith("/rest/v1/rpc/consume_ai_daily_quota")) {
        clock = 13_000;
        return Response.json(1);
      }
      return successfulDeepSeekResponse();
    }) as typeof fetch,
    env: BASE_ENV,
    logger: SILENT_LOGGER,
    now: () => clock,
    timeoutSignal: (milliseconds: number) => {
      budgets.push(milliseconds);
      return new AbortController().signal;
    },
  });

  const response = await handler(ideaRequest(), FUNCTION_CONTEXT);

  assert.equal(response.status, 200);
  assert.deepEqual(budgets, [8_000, 5_000, 25_000]);
  assert.ok(budgets.reduce((total, budget) => total + budget, 0) <= 38_000);
});

test("returns a safe JSON timeout before starting another phase after the deadline", async () => {
  let clock = 0;
  const calls: string[] = [];
  const records: unknown[][] = [];
  const logger = {
    error: (...args: unknown[]) => records.push(args),
    warn: (...args: unknown[]) => records.push(args),
    info: (...args: unknown[]) => records.push(args),
  };
  const handler = createOrganizeIdeaHandler({
    fetchImpl: (async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/v1/user")) {
        calls.push("auth");
        clock = 38_000;
        return Response.json({ id: "server-user-id" });
      }
      calls.push("unexpected");
      return Response.json(1);
    }) as typeof fetch,
    env: BASE_ENV,
    logger,
    now: () => clock,
    timeoutSignal: () => new AbortController().signal,
  });

  const response = await handler(ideaRequest(), FUNCTION_CONTEXT);
  const body = await response.json() as { error: { code: string } };

  assert.equal(response.status, 504);
  assert.equal(body.error.code, "AI_TIMEOUT");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-request-id"), "trusted-context-request-123");
  assert.deepEqual(calls, ["auth"]);
  assert.equal((records[0][0] as { outcome: string }).outcome, "ai_timeout");
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
    buildSha: "0123456789abcdef",
    logger,
    now: (() => {
      const values = [1_000, 1_075];
      return () => values.shift() ?? 1_075;
    })(),
  });

  const response = await handler(ideaRequest(), FUNCTION_CONTEXT);

  assert.equal(response.status, 200);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], [{
    event: "organize_idea",
    request_id: "trusted-context-request-123",
    deploy_sha: "0123456789abcdef",
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
    new RegExp([
      ORIGINAL_TEXT,
      AUTH_TOKEN,
      SERVICE_KEY,
      DEEPSEEK_KEY,
      "secret@example.com",
      "reasoning-content-that-must-never-be-logged",
    ].join("|")),
  );
});
