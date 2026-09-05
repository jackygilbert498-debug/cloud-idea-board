import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ReleaseBuildShaError, validateReleaseBuildSha } from "./release-sha.mjs";

export { ReleaseBuildShaError } from "./release-sha.mjs";

function readCurrentGitHead() {
  const result = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    encoding: "utf8",
    shell: false,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

const defaultMetadataDirectory = resolve(fileURLToPath(new URL("../generated/functions/", import.meta.url)));
const functionSource = fileURLToPath(new URL("../netlify/functions/organize-idea.mts", import.meta.url));
const buildShaMarker = 'const RELEASE_BUILD_SHA = "development"; // RELEASE_BUILD_SHA_INJECTION';

function stageGeneratedFunctions(buildSha, metadataDirectory) {
  const nextDirectory = `${metadataDirectory}-next`;
  const previousDirectory = `${metadataDirectory}-previous`;
  mkdirSync(dirname(metadataDirectory), { recursive: true });

  // Recover a prior interrupted directory swap before preparing this build.
  if (existsSync(previousDirectory)) {
    rmSync(metadataDirectory, { recursive: true, force: true });
    renameSync(previousDirectory, metadataDirectory);
  }
  rmSync(nextDirectory, { recursive: true, force: true });
  mkdirSync(nextDirectory, { recursive: true });

  const source = readFileSync(functionSource, "utf8");
  if (source.split(buildShaMarker).length !== 2) {
    throw new ReleaseBuildShaError("Function 构建身份标记缺失或不唯一。");
  }
  writeFileSync(
    `${nextDirectory}/organize-idea.mts`,
    source.replace(
      buildShaMarker,
      `const RELEASE_BUILD_SHA = ${JSON.stringify(buildSha)}; // RELEASE_BUILD_SHA_INJECTION`,
    ),
    "utf8",
  );

  if (existsSync(metadataDirectory)) renameSync(metadataDirectory, previousDirectory);
  try {
    renameSync(nextDirectory, metadataDirectory);
  } catch (error) {
    if (existsSync(previousDirectory)) renameSync(previousDirectory, metadataDirectory);
    throw error;
  }

  let active = true;
  return {
    commit() {
      if (!active) return;
      rmSync(previousDirectory, { recursive: true, force: true });
      active = false;
    },
    rollback() {
      if (!active) return;
      rmSync(metadataDirectory, { recursive: true, force: true });
      if (existsSync(previousDirectory)) renameSync(previousDirectory, metadataDirectory);
      rmSync(nextDirectory, { recursive: true, force: true });
      active = false;
    },
  };
}

/** Resolve one traceable SHA without ever interpolating it into a shell command. */
export function resolveReleaseBuildSha(environment, readGitHead = readCurrentGitHead) {
  const commitRef = environment.COMMIT_REF?.trim();
  if (commitRef) return validateReleaseBuildSha(commitRef, "COMMIT_REF");

  const providedSha = environment.VITE_BUILD_SHA?.trim();
  if (providedSha) return validateReleaseBuildSha(providedSha, "VITE_BUILD_SHA");

  const gitHead = readGitHead()?.trim();
  if (gitHead) return validateReleaseBuildSha(gitHead, "git HEAD");

  throw new ReleaseBuildShaError("无法从 COMMIT_REF、VITE_BUILD_SHA 或 git HEAD 确定发布提交。");
}

/** Run the existing release gate and preserve its exit code for Netlify. */
export function runReleaseVerification({
  mode = "verify",
  environment = process.env,
  metadataDirectory = defaultMetadataDirectory,
  nodeExecutable = process.execPath,
  readGitHead = readCurrentGitHead,
  spawnVerification = spawnSync,
} = {}) {
  const buildSha = resolveReleaseBuildSha(environment, readGitHead);
  const npmExecPath = environment.npm_execpath?.trim();
  if (!npmExecPath) throw new ReleaseBuildShaError("npm 执行入口不可用，请通过 npm run verify:netlify 启动。");
  const steps = mode === "build"
    ? ["validate:release-env", "build"]
    : mode === "verify"
      ? ["verify", "validate:release-env", "build", "test:artifact"]
      : null;
  if (!steps) throw new ReleaseBuildShaError("未知的发布验证模式。");

  const generated = stageGeneratedFunctions(buildSha, metadataDirectory);
  try {
    for (const step of steps) {
      const result = spawnVerification(nodeExecutable, [npmExecPath, "run", step], {
        env: { ...environment, VITE_BUILD_SHA: buildSha },
        shell: false,
        stdio: "inherit",
      });
      if (result.error || !Number.isInteger(result.status)) {
        throw new ReleaseBuildShaError("无法启动发布验证子进程。");
      }
      if (result.status !== 0) {
        generated.rollback();
        return result.status;
      }
    }
    generated.commit();
    return 0;
  } catch (error) {
    generated.rollback();
    throw error;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invokedPath === import.meta.url) {
  try {
    const mode = process.argv[2] === "--build" ? "build" : process.argv[2] === "--verify" ? "verify" : null;
    if (!mode) throw new ReleaseBuildShaError("请使用 --build 或 --verify 启动发布验证。");
    process.exitCode = runReleaseVerification({ mode });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "发布验证启动失败。");
    process.exitCode = 1;
  }
}
