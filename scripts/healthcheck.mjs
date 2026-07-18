#!/usr/bin/env node
/**
 * 本地健康检查：验证 Vite + Netlify 插件是否把 NETLIFY_DB_URL 注入到函数运行时。
 *
 * 用法：
 *   node scripts/healthcheck.mjs          # 默认 http://localhost:5174
 *   node scripts/healthcheck.mjs 5180
 *
 * 退出码：
 *   0 = 全部通过
 *   1 = 至少一项失败（会打印中文诊断）
 *
 * 这个脚本用于在 `npm run dev` 之后快速确认本地后端是否真的可用，
 * 避免“界面显示 Pro 但 API 仍按免费限流”或“上传 500”这类隐性回归。
 */
const port = process.argv[2] ?? "5174";
const base = `http://localhost:${port}`;

const checks = [
  { name: "资源列表 GET /api/resources", path: "/api/resources" },
  { name: "复习队列 GET /api/reviews", path: "/api/reviews" },
  { name: "工作区 GET /api/workspace", path: "/api/workspace" },
];

let failed = 0;

for (const check of checks) {
  try {
    const res = await fetch(`${base}${check.path}`);
    const body = await res.text();
    const ok = res.ok && !/NETLIFY_DB_URL|Failed to parse body/i.test(body);
    if (ok) {
      console.log(`✓ ${check.name} → ${res.status}`);
    } else {
      failed += 1;
      console.error(`✗ ${check.name} → ${res.status}`);
      console.error(`  body: ${body.slice(0, 300)}`);
      if (/NETLIFY_DB_URL/i.test(body)) {
        console.error(
          "  诊断：本地数据库未注入到函数运行时。请重启 `npm run dev`；若仍失败，删除 `.netlify/db` 后重启。",
        );
      }
    }
  } catch (error) {
    failed += 1;
    console.error(`✗ ${check.name} → 连接失败：${error instanceof Error ? error.message : error}`);
    console.error(`  诊断：Vite dev server 未在 ${base} 监听，或端口被占用。`);
  }
}

if (failed > 0) {
  console.error(`\n健康检查未通过：${failed} 项失败。`);
  process.exit(1);
}
console.log("\n本地后端健康检查通过。");
