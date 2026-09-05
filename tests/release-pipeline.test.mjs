import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runReleaseVerification } from "../scripts/run-release-verification.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const validator = fileURLToPath(new URL("../scripts/validate-release-env.mjs", import.meta.url));
const releaseRunnerUrl = new URL("../scripts/run-release-verification.mjs", import.meta.url).href;

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

test("release env validator rejects a non-SHA build identity without echoing it", () => {
  const invalidValue = "not-a-sha; do-not-print";
  const result = runValidator({
    VITE_SUPABASE_URL: "https://test.supabase.co",
    VITE_SUPABASE_ANON_KEY: "test-public-key-with-more-than-20-characters",
    VITE_BUILD_SHA: invalidValue,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /VITE_BUILD_SHA/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /do-not-print/);
});

test("the public build release entry rejects an invalid SHA before building", () => {
  const npmExecPath = process.env.npm_execpath;
  assert.ok(npmExecPath, "test must run from the npm contract script");
  const result = spawnSync(process.execPath, [npmExecPath, "run", "build:release"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      COMMIT_REF: "",
      VITE_SUPABASE_URL: "https://test.supabase.co",
      VITE_SUPABASE_ANON_KEY: "test-public-key-with-more-than-20-characters",
      VITE_BUILD_SHA: "not-a-sha",
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /VITE_BUILD_SHA/);
});

function runReleaseRunnerHarness(source) {
  return spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: root,
    encoding: "utf8",
    env: {},
  });
}

test("release runner rejects a missing build SHA without printing environment values", () => {
  const result = runReleaseRunnerHarness(`
    const { resolveReleaseBuildSha } = await import(${JSON.stringify(releaseRunnerUrl)});
    try {
      resolveReleaseBuildSha({}, () => null);
    } catch (error) {
      console.log(JSON.stringify({ name: error.name, message: error.message }));
    }
  `);

  assert.equal(result.status, 0);
  const failure = JSON.parse(result.stdout.trim());
  assert.equal(failure.name, "ReleaseBuildShaError");
  assert.match(failure.message, /COMMIT_REF|VITE_BUILD_SHA|git HEAD/);
});

test("release runner rejects an invalid COMMIT_REF instead of falling back", () => {
  const result = runReleaseRunnerHarness(`
    const { resolveReleaseBuildSha } = await import(${JSON.stringify(releaseRunnerUrl)});
    try {
      resolveReleaseBuildSha({ COMMIT_REF: "abc; print-secret", VITE_BUILD_SHA: "0123456789abcdef" }, () => "fedcba9876543210");
    } catch (error) {
      console.log(JSON.stringify({ name: error.name, message: error.message }));
    }
  `);

  assert.equal(result.status, 0);
  const failure = JSON.parse(result.stdout.trim());
  assert.equal(failure.name, "ReleaseBuildShaError");
  assert.match(failure.message, /COMMIT_REF/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /print-secret/);
});

test("release runner gives a valid Netlify COMMIT_REF priority over local fallbacks", () => {
  const commitRef = "a".repeat(40);
  const result = runReleaseRunnerHarness(`
    const { resolveReleaseBuildSha } = await import(${JSON.stringify(releaseRunnerUrl)});
    const sha = resolveReleaseBuildSha(
      { COMMIT_REF: ${JSON.stringify(commitRef)}, VITE_BUILD_SHA: "bbbbbbbbbbbbbbbb" },
      () => "cccccccccccccccc"
    );
    console.log(sha);
  `);

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), commitRef);
});

test("release runner injects the selected SHA and propagates the verification child exit", () => {
  const result = runReleaseRunnerHarness(`
    const { runReleaseVerification } = await import(${JSON.stringify(releaseRunnerUrl)});
    const calls = [];
    const status = runReleaseVerification({
      environment: { VITE_BUILD_SHA: "0123456789abcdef", SENTINEL: "preserved", npm_execpath: "/tools/npm-cli.js" },
      nodeExecutable: "/tools/node",
      readGitHead: () => { throw new Error("git fallback must not run"); },
      spawnVerification: (command, args, options) => {
        calls.push({ command, args, sha: options.env.VITE_BUILD_SHA, sentinel: options.env.SENTINEL, shell: options.shell });
        return { status: 9 };
      },
    });
    console.log(JSON.stringify({ status, calls }));
  `);

  assert.equal(result.status, 0);
  const outcome = JSON.parse(result.stdout.trim());
  assert.deepEqual(outcome, {
    status: 9,
    calls: [{
      command: "/tools/node",
      args: ["/tools/npm-cli.js", "run", "verify"],
      sha: "0123456789abcdef",
      sentinel: "preserved",
      shell: false,
    }],
  });
});

test("release runner generates one shared build identity and uses non-recursive verification steps", async (t) => {
  const metadataDirectory = join(root, "generated", "release-contract-functions");
  rmSync(metadataDirectory, { recursive: true, force: true });
  t.after(() => rmSync(metadataDirectory, { recursive: true, force: true }));
  const beforeStatus = spawnSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" }).stdout;
  const calls = [];

  const status = runReleaseVerification({
    mode: "verify",
    metadataDirectory,
    environment: { VITE_BUILD_SHA: "0123456789abcdef", npm_execpath: "/tools/npm-cli.js" },
    nodeExecutable: "/tools/node",
    spawnVerification: (command, args, options) => {
      calls.push({ command, args, sha: options.env.VITE_BUILD_SHA, shell: options.shell });
      return { status: 0 };
    },
  });

  assert.equal(status, 0);
  assert.deepEqual(calls, [
    { command: "/tools/node", args: ["/tools/npm-cli.js", "run", "verify"], sha: "0123456789abcdef", shell: false },
    { command: "/tools/node", args: ["/tools/npm-cli.js", "run", "validate:release-env"], sha: "0123456789abcdef", shell: false },
    { command: "/tools/node", args: ["/tools/npm-cli.js", "run", "build"], sha: "0123456789abcdef", shell: false },
    { command: "/tools/node", args: ["/tools/npm-cli.js", "run", "test:artifact"], sha: "0123456789abcdef", shell: false },
  ]);
  assert.deepEqual(readdirSync(metadataDirectory).sort(), ["build-metadata.mjs", "organize-idea.mts"]);
  const metadataUrl = `${pathToFileURL(join(metadataDirectory, "build-metadata.mjs")).href}?test=${Date.now()}`;
  assert.equal((await import(metadataUrl)).BUILD_SHA, "0123456789abcdef");
  const entryUrl = `${pathToFileURL(join(metadataDirectory, "organize-idea.mts")).href}?test=${Date.now()}`;
  const generatedFunction = await import(entryUrl);
  const records = [];
  const previousWarn = console.warn;
  const previousCommitRef = process.env.COMMIT_REF;
  console.warn = (record) => records.push(record);
  process.env.COMMIT_REF = "runtime-value-must-be-ignored";
  try {
    const response = await generatedFunction.default(new Request("https://example.test/api/organize-idea", { method: "POST" }), { requestId: "release-contract-request" });
    assert.equal(response.status, 401);
  } finally {
    console.warn = previousWarn;
    if (previousCommitRef === undefined) delete process.env.COMMIT_REF;
    else process.env.COMMIT_REF = previousCommitRef;
  }
  assert.equal(records.length, 1);
  assert.equal(records[0].deploy_sha, "0123456789abcdef");
  const afterStatus = spawnSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" }).stdout;
  assert.equal(afterStatus, beforeStatus);
});

test("release runner restores previous function metadata when a child step fails", (t) => {
  const metadataDirectory = join(tmpdir(), `release-metadata-${process.pid}-${Date.now()}`);
  mkdirSync(metadataDirectory, { recursive: true });
  t.after(() => rmSync(metadataDirectory, { recursive: true, force: true }));
  const metadataPath = join(metadataDirectory, "build-metadata.mjs");
  const entryPath = join(metadataDirectory, "organize-idea.mts");
  const previousMetadata = 'export const BUILD_SHA = "feedface";\n';
  const previousEntry = "// previous generated entry\n";
  writeFileSync(metadataPath, previousMetadata, "utf8");
  writeFileSync(entryPath, previousEntry, "utf8");
  let observedSha = "";

  const status = runReleaseVerification({
    mode: "build",
    metadataDirectory,
    environment: { VITE_BUILD_SHA: "0123456789abcdef", npm_execpath: "/tools/npm-cli.js" },
    nodeExecutable: "/tools/node",
    spawnVerification: () => {
      const generated = readFileSync(metadataPath, "utf8");
      observedSha = generated.match(/[0-9a-f]{16}/)?.[0] ?? "";
      return { status: 7 };
    },
  });

  assert.equal(status, 7);
  assert.equal(observedSha, "0123456789abcdef");
  assert.equal(readFileSync(metadataPath, "utf8"), previousMetadata);
  assert.equal(readFileSync(entryPath, "utf8"), previousEntry);
  assert.equal(existsSync(`${metadataDirectory}-next`), false);
  assert.equal(existsSync(`${metadataDirectory}-previous`), false);
});

test("release runner falls back to git HEAD when Netlify and local SHA inputs are absent", () => {
  const gitHead = "d".repeat(40);
  const result = runReleaseRunnerHarness(`
    const { resolveReleaseBuildSha } = await import(${JSON.stringify(releaseRunnerUrl)});
    console.log(resolveReleaseBuildSha({}, () => ${JSON.stringify(gitHead)}));
  `);

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), gitHead);
});

test("release runner uses the npm CLI through Node on Windows without enabling a shell", () => {
  const result = runReleaseRunnerHarness(`
    const { runReleaseVerification } = await import(${JSON.stringify(releaseRunnerUrl)});
    const calls = [];
    const status = runReleaseVerification({
      mode: "build",
      environment: { VITE_BUILD_SHA: "0123456789abcdef", npm_execpath: "C:\\\\tools\\\\npm-cli.js" },
      nodeExecutable: "C:\\\\tools\\\\node.exe",
      spawnVerification: (command, args, options) => {
        calls.push({ command, args, shell: options.shell });
        return { status: 5 };
      },
    });
    console.log(JSON.stringify({ status, calls }));
  `);

  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    status: 5,
    calls: [{
      command: "C:\\tools\\node.exe",
      args: ["C:\\tools\\npm-cli.js", "run", "validate:release-env"],
      shell: false,
    }],
  });
});

test("Netlify delegates to the non-recursive release runner command", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const netlifyConfig = readFileSync(new URL("../netlify.toml", import.meta.url), "utf8");
  const workflow = readFileSync(new URL("../.github/workflows/verify.yml", import.meta.url), "utf8");

  assert.equal(packageJson.scripts["validate:release-env"], "node scripts/validate-release-env.mjs");
  assert.equal(packageJson.scripts["build:release"], "node scripts/run-release-verification.mjs --build");
  assert.equal(packageJson.scripts["verify:release"], "node scripts/run-release-verification.mjs --verify");
  assert.equal(packageJson.scripts["verify:netlify"], "node scripts/run-release-verification.mjs --verify");
  assert.match(netlifyConfig, /command\s*=\s*"npm run verify:netlify"/);
  assert.match(netlifyConfig, /directory\s*=\s*"generated\/netlify\/functions"/);
  assert.match(workflow, /VITE_BUILD_SHA:\s*\$\{\{\s*github\.sha\s*\}\}/);
});
