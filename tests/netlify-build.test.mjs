import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const dist = new URL("../dist/", import.meta.url);
const distPath = fileURLToPath(dist);

function resolveStaticFile(requestUrl) {
  try {
    const pathname = decodeURIComponent(new URL(requestUrl, "http://127.0.0.1").pathname);
    const requestedFile = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = resolve(distPath, requestedFile);
    const relativePath = relative(distPath, filePath);

    if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      return null;
    }

    return filePath;
  } catch {
    return null;
  }
}

function contentTypeFor(filePath) {
  if (extname(filePath) === ".js") return "application/javascript; charset=utf-8";
  if (extname(filePath) === ".css") return "text/css; charset=utf-8";
  if (extname(filePath) === ".html") return "text/html; charset=utf-8";
  return "application/octet-stream";
}

async function startStaticEntrypoint() {
  const server = createServer(async (request, response) => {
    const filePath = resolveStaticFile(request.url ?? "/");
    if (!filePath) {
      response.writeHead(404).end();
      return;
    }

    try {
      const content = await readFile(filePath);
      response.writeHead(200, { "Content-Type": contentTypeFor(filePath) }).end(content);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && ["ENOENT", "EISDIR"].includes(error.code)) {
        response.writeHead(404).end();
        return;
      }

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
    const origin = `http://127.0.0.1:${address.port}`;
    const entrypointResponse = await fetch(`${origin}/`);
    assert.equal(entrypointResponse.status, 200);

    const moduleResponse = await fetch(`${origin}${modulePath}`);
    assert.equal(moduleResponse.status, 200);
    assert.match(moduleResponse.headers.get("content-type") ?? "", /^application\/javascript(?:;|$)/);
    assert.ok((await moduleResponse.text()).includes(publicSupabaseUrl));

    const traversalResponse = await fetch(`${origin}/%2e%2e%2fpackage.json`);
    assert.equal(traversalResponse.status, 404);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
