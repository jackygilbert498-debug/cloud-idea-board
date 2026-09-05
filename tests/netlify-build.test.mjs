import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";

const root = new URL("../", import.meta.url);
const dist = new URL("../dist/", import.meta.url);

async function startStaticEntrypoint() {
  const server = createServer(async (request, response) => {
    if (request.url !== "/" && request.url !== "/index.html") {
      response.writeHead(404).end();
      return;
    }

    try {
      const indexHtml = await readFile(new URL("index.html", dist));
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(indexHtml);
    } catch {
      response.writeHead(500).end();
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

test("ships a runnable static entrypoint with the configured public Supabase URL", async () => {
  const publicSupabaseUrl = process.env.VITE_SUPABASE_URL;
  const publicBuildSha = process.env.VITE_BUILD_SHA;
  assert.ok(publicSupabaseUrl, "artifact test requires VITE_SUPABASE_URL from the release build");
  assert.ok(publicBuildSha, "artifact test requires VITE_BUILD_SHA from the release build");

  const indexHtml = await readFile(new URL("dist/index.html", root), "utf8");
  const modulePath = indexHtml.match(/<script\b(?=[^>]*\btype="module")[^>]*\bsrc="([^"]+)"[^>]*><\/script>/)?.[1];

  assert.match(indexHtml, new RegExp(`<meta\\s+name="build-sha"\\s+content="${publicBuildSha}"\\s*/?>`));
  assert.ok(modulePath?.startsWith("/assets/"), "built entrypoint must reference an emitted module");
  const moduleSource = await readFile(new URL(`../dist${modulePath}`, import.meta.url), "utf8");
  assert.ok(moduleSource.includes(publicSupabaseUrl), "built module must contain the configured Supabase URL");

  const server = await startStaticEntrypoint();
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    assert.equal(response.status, 200);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
