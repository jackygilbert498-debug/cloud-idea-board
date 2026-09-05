const required = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "VITE_BUILD_SHA"];
const missing = required.filter((name) => !process.env[name]?.trim());

if (missing.length) {
  console.error(`发布配置缺失：${missing.join(", ")}`);
  process.exitCode = 1;
}
