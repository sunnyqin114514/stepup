import { getUser } from "@netlify/identity";
import { eq, sql } from "drizzle-orm";
import { db } from "../../../db";
import { aiUsage, userEntitlements } from "../../../db/schema";

export type AppUser = { id: string; email?: string; development: boolean };

function env(name: string): string | undefined {
  if (typeof Netlify !== "undefined") return Netlify.env.get(name);
  return typeof process !== "undefined" ? process.env[name] : undefined;
}

export async function requireUser(): Promise<AppUser | Response> {
  try {
    const user = await getUser();
    if (user?.id) {
      return { id: user.id, email: user.email ?? undefined, development: false };
    }
  } catch (error) {
    console.error("Identity 用户解析失败，拒绝生产请求", error);
  }

  const development =
    env("NETLIFY_DEV") === "true" ||
    (env("NODE_ENV") === "development" &&
      env("CONTEXT") !== "production" &&
      env("CONTEXT") !== "deploy-preview" &&
      env("CONTEXT") !== "branch-deploy");
  if (development) {
    return {
      id: "dev-user-local-only",
      email: "dev@localhost",
      development: true,
    };
  }
  return Response.json({ error: "请先登录" }, { status: 401 });
}

export function isAuthResponse(value: AppUser | Response): value is Response {
  return value instanceof Response;
}

export function isTesterModeRequest(req: Request): boolean {
  return req.headers.get("x-stepup-tester-mode") === "true";
}

export async function getEntitlement(userId: string): Promise<{
  plan: "free" | "pro";
  pro: boolean;
}> {
  try {
    const [record] = await db
      .select()
      .from(userEntitlements)
      .where(eq(userEntitlements.userId, userId))
      .limit(1);
    const pro =
      record?.plan === "pro" &&
      (!record.proUntil || record.proUntil.getTime() > Date.now());
    return { plan: pro ? "pro" : "free", pro };
  } catch (error) {
    console.error("读取会员权益失败，按免费版降级", error);
    return { plan: "free", pro: false };
  }
}

export async function getRequestEntitlement(
  userId: string,
  req: Request,
): Promise<{
  plan: "free" | "pro";
  pro: boolean;
  tester?: boolean;
}> {
  if (isTesterModeRequest(req)) return { plan: "pro", pro: true, tester: true };
  return getEntitlement(userId);
}

export function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export async function consumeAiQuota(
  userId: string,
  action: "decompose" | "replan",
  options?: { testerMode?: boolean },
): Promise<{ allowed: boolean; used: number; limit: number | null }> {
  if (options?.testerMode) return { allowed: true, used: 0, limit: null };
  const entitlement = await getEntitlement(userId);
  if (entitlement.pro) return { allowed: true, used: 0, limit: null };

  const limit = action === "decompose" ? 3 : 1;
  const usageDate = new Date().toISOString().slice(0, 10);
  try {
    const [record] = await db
      .insert(aiUsage)
      .values({
        id: createId("usage"),
        userId,
        usageDate,
        action,
        count: 1,
      })
      .onConflictDoUpdate({
        target: [aiUsage.userId, aiUsage.usageDate, aiUsage.action],
        set: {
          count: sql`${aiUsage.count} + 1`,
          updatedAt: new Date(),
        },
      })
      .returning({ count: aiUsage.count });
    const used = Number(record?.count) || 1;
    return { allowed: used <= limit, used, limit };
  } catch (error) {
    console.error("AI 配额校验失败，按免费版拒绝以避免绕过限制", error);
    return { allowed: false, used: limit, limit };
  }
}
