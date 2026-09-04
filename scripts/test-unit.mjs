import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Set the timezone before Node starts: date-grouping tests must behave identically
// on Windows and Unix, without shell-specific environment assignments or globs.
const root = fileURLToPath(new URL("../", import.meta.url));
const files = readdirSync(new URL("../tests/", import.meta.url))
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => `tests/${name}`);
if (files.length === 0) throw new Error("No unit tests found");
const result = spawnSync(process.execPath, ["--experimental-strip-types", "--test", ...files], {
  cwd: root,
  env: { ...process.env, TZ: "Asia/Shanghai" },
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
