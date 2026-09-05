import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const SHA_PATTERN = /^[0-9a-f]{7,64}$/i;

export class ReleaseBuildShaError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseBuildShaError";
  }
}

function validateSha(value, source) {
  if (!SHA_PATTERN.test(value)) {
    throw new ReleaseBuildShaError(`${source} 必须是 7 至 64 位十六进制提交 SHA。`);
  }
  return value;
}

function readCurrentGitHead() {
  const result = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    encoding: "utf8",
    shell: false,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

/** Resolve one traceable SHA without ever interpolating it into a shell command. */
export function resolveReleaseBuildSha(environment, readGitHead = readCurrentGitHead) {
  const commitRef = environment.COMMIT_REF?.trim();
  if (commitRef) return validateSha(commitRef, "COMMIT_REF");

  const providedSha = environment.VITE_BUILD_SHA?.trim();
  if (providedSha) return validateSha(providedSha, "VITE_BUILD_SHA");

  const gitHead = readGitHead()?.trim();
  if (gitHead) return validateSha(gitHead, "git HEAD");

  throw new ReleaseBuildShaError("无法从 COMMIT_REF、VITE_BUILD_SHA 或 git HEAD 确定发布提交。");
}

/** Run the existing release gate and preserve its exit code for Netlify. */
export function runReleaseVerification({
  environment = process.env,
  nodeExecutable = process.execPath,
  readGitHead = readCurrentGitHead,
  spawnVerification = spawnSync,
} = {}) {
  const buildSha = resolveReleaseBuildSha(environment, readGitHead);
  const npmExecPath = environment.npm_execpath?.trim();
  if (!npmExecPath) throw new ReleaseBuildShaError("npm 执行入口不可用，请通过 npm run verify:netlify 启动。");
  const result = spawnVerification(nodeExecutable, [npmExecPath, "run", "verify:release"], {
    env: { ...environment, VITE_BUILD_SHA: buildSha },
    shell: false,
    stdio: "inherit",
  });

  if (result.error || !Number.isInteger(result.status)) {
    throw new ReleaseBuildShaError("无法启动发布验证子进程。");
  }
  return result.status;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invokedPath === import.meta.url) {
  try {
    process.exitCode = runReleaseVerification();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "发布验证启动失败。");
    process.exitCode = 1;
  }
}
