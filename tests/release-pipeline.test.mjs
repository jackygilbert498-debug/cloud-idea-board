import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
      args: ["/tools/npm-cli.js", "run", "verify:release"],
      sha: "0123456789abcdef",
      sentinel: "preserved",
      shell: false,
    }],
  });
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
      environment: { VITE_BUILD_SHA: "0123456789abcdef", npm_execpath: "C:\\\\tools\\\\npm-cli.js" },
      nodeExecutable: "C:\\\\tools\\\\node.exe",
      spawnVerification: (command, args, options) => {
        calls.push({ command, args, shell: options.shell });
        return { status: 0 };
      },
    });
    console.log(JSON.stringify({ status, calls }));
  `);

  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    status: 0,
    calls: [{
      command: "C:\\tools\\node.exe",
      args: ["C:\\tools\\npm-cli.js", "run", "verify:release"],
      shell: false,
    }],
  });
});

test("Netlify delegates to the non-recursive release runner command", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const netlifyConfig = readFileSync(new URL("../netlify.toml", import.meta.url), "utf8");

  assert.equal(packageJson.scripts["verify:netlify"], "node scripts/run-release-verification.mjs");
  assert.equal(packageJson.scripts["verify:release"], "npm run verify && npm run build:release && npm run test:artifact");
  assert.match(netlifyConfig, /command\s*=\s*"npm run verify:netlify"/);
});
