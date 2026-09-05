import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const validator = fileURLToPath(new URL("../scripts/validate-release-env.mjs", import.meta.url));

function runValidator(environment) {
  return spawnSync(process.execPath, [validator], {
    cwd: root,
    encoding: "utf8",
    env: environment,
  });
}

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
