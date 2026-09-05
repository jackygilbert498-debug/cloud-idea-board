import { validateReleaseBuildSha } from "./release-sha.mjs";

const required = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "VITE_BUILD_SHA"];
const missing = required.filter((name) => !process.env[name]?.trim());

if (missing.length) {
  console.error(`发布配置缺失：${missing.join(", ")}`);
  process.exitCode = 1;
} else {
  try {
    validateReleaseBuildSha(process.env.VITE_BUILD_SHA.trim(), "VITE_BUILD_SHA");
  } catch {
    console.error("发布配置无效：VITE_BUILD_SHA 必须是提交 SHA。");
    process.exitCode = 1;
  }
}
