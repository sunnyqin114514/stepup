import { drizzle } from "drizzle-orm/netlify-db";
import * as schema from "./schema";

/**
 * 本地开发时，若 Netlify Vite 插件未把 NETLIFY_DB_URL 注入到函数运行时
 * （常见于 dev server 长时间运行后本地 pglite 连接失效），drizzle() 会抛出
 * "NETLIFY_DB_URL environment variable is not set"。
 *
 * 这里在模块加载阶段捕获并暴露一个明确的中文错误，让上层 API 能返回
 * 友好提示，而不是把原始堆栈直接吐给前端。
 */
function createDb() {
  try {
    return drizzle({ schema });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "数据库初始化失败";
    console.error("[db] Drizzle 初始化失败：", message);
    if (/NETLIFY_DB_URL/i.test(message)) {
      throw new Error(
        "本地数据库未就绪：请重启 `npm run dev` 让 Netlify 插件重新启动本地 Postgres；若仍未恢复，删除 `.netlify/db` 后重启。",
      );
    }
    throw error;
  }
}

export const db = createDb();
