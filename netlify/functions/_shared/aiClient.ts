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

function env(name: string): string | undefined {
  try {
    const netlifyValue =
      typeof Netlify !== "undefined" ? Netlify.env?.get?.(name) : undefined;
    const processValue =
      typeof process !== "undefined" ? process.env?.[name] : undefined;
    return netlifyValue || processValue || undefined;
  } catch (error) {
    console.error(`读取环境变量 ${name} 失败`, error);
    return undefined;
  }
}

// 创建 AI 客户端：
// 1. 优先使用 DEEPSEEK_API_KEY（本地开发用用户自己的 key）
// 2. 否则使用 Netlify AI Gateway 注入的 OPENAI_API_KEY / OPENAI_BASE_URL
// 3. 两者都不可用时返回 null，由调用方快速走场景化 mock，避免函数 502
export function createAiClient(): AiClient | null {
  const deepseekKey = env("DEEPSEEK_API_KEY");

  if (deepseekKey) {
    return {
      client: new OpenAI({
        apiKey: deepseekKey,
        baseURL: DEEPSEEK_BASE_URL,
        // SDK 默认超时后重试 2 次，会把 7.5s 超时放大成 20s+，前端因此中断
        maxRetries: 0,
      }),
      model: DEEPSEEK_MODEL,
    };
  }

  const openAiKey = env("OPENAI_API_KEY");
  const openAiBaseUrl = env("OPENAI_BASE_URL");
  if (!openAiKey) {
    return null;
  }

  // 走 Netlify AI Gateway（生产部署后自动激活）。显式传入 key/baseURL，
  // 避免 SDK 在无 key 环境下构造时抛出未捕获错误。
  return {
    client: new OpenAI({
      apiKey: openAiKey,
      ...(openAiBaseUrl ? { baseURL: openAiBaseUrl } : {}),
      maxRetries: 0,
    }),
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
  if (env("NODE_ENV") === "development") {
    return true;
  }
  // Netlify Dev
  if (env("NETLIFY_DEV") === "true") {
    return true;
  }
  // 用户在 .env 里设的紧急开关
  if (env("DISABLE_ORIGIN_CHECK") === "true") {
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

  const builtinOrigins = new Set([
    "http://tcamp14.cn",
    "https://tcamp14.cn",
    "http://www.tcamp14.cn",
    "https://www.tcamp14.cn",
  ]);
  if (builtinOrigins.has(origin)) return true;

  // 额外允许的域名（通过环境变量配置，多个用逗号分隔）
  const extraOrigins = env("ALLOWED_ORIGINS") || "";
  if (extraOrigins) {
    const list = extraOrigins.split(",").map((s) => s.trim()).filter(Boolean);
    if (list.includes(origin)) return true;
  }

  return false;
}
