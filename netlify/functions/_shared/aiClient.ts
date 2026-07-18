import OpenAI from "openai";
import dotenv from "dotenv";

// 加载 .env 文件（本地开发用；生产环境由 Netlify 注入）
dotenv.config();

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEEPSEEK_MODEL = "deepseek-chat";

const NETLIFY_MODEL = "gpt-4o-mini";

export type AiClient = {
  client: OpenAI;
  model: string;
};

// 创建 AI 客户端：
// 1. 优先使用 DEEPSEEK_API_KEY（本地开发用用户自己的 key）
// 2. 否则用默认 OpenAI 构造（部署到 Netlify 后由 AI Gateway 自动注入 key）
export function createAiClient(): AiClient {
  const deepseekKey =
    (typeof Netlify !== "undefined" && Netlify.env?.get?.("DEEPSEEK_API_KEY")) ||
    (typeof process !== "undefined" && process.env?.DEEPSEEK_API_KEY) ||
    undefined;

  if (deepseekKey) {
    return {
      client: new OpenAI({
        apiKey: deepseekKey,
        baseURL: DEEPSEEK_BASE_URL,
      }),
      model: DEEPSEEK_MODEL,
    };
  }

  // 走 Netlify AI Gateway（生产部署后自动激活）
  return {
    client: new OpenAI(),
    model: NETLIFY_MODEL,
  };
}

// ===== Origin 鉴权（防止外部滥用） =====
// 设计原则：
// 1. 本地开发（Vite / Netlify Dev）：完全跳过 Origin 检查，避免 localhost 端口变化导致 403
// 2. 生产环境：只允许 Netlify 部署域名 + 手动配置的额外域名
// 3. 紧急开关：设置环境变量 DISABLE_ORIGIN_CHECK=true 可完全关闭

function isDevEnvironment(): boolean {
  // Vite dev server
  if (typeof process !== "undefined" && process.env?.NODE_ENV === "development") {
    return true;
  }
  // Netlify Dev
  if (typeof process !== "undefined" && process.env?.NETLIFY_DEV === "true") {
    return true;
  }
  // 用户在 .env 里设的紧急开关
  if (typeof process !== "undefined" && process.env?.DISABLE_ORIGIN_CHECK === "true") {
    return true;
  }
  return false;
}

export function checkOrigin(req: Request): boolean {
  // dev 环境完全跳过
  if (isDevEnvironment()) return true;

  const origin = req.headers.get("origin");
  if (!origin) return false;

  // 生产环境：允许 Netlify 部署域名
  if (origin.endsWith(".netlify.app")) return true;
  // 允许 vercel preview 等
  if (origin.endsWith(".vercel.app")) return true;

  // 额外允许的域名（通过环境变量配置，多个用逗号分隔）
  const extraOrigins =
    (typeof process !== "undefined" && process.env?.ALLOWED_ORIGINS) || "";
  if (extraOrigins) {
    const list = extraOrigins.split(",").map((s) => s.trim()).filter(Boolean);
    if (list.includes(origin)) return true;
  }

  return false;
}
