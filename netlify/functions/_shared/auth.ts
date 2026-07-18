import { getUser } from "@netlify/identity";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../../db";
import { aiUsage, userEntitlements } from "../../../db/schema";

export type AppUser = { id: string; email?: string; development: boolean };

export type AiQuotaResult = {
  allowed: boolean;
  used: number;
  limit: number | null;
};

function env(name: string): string | undefined {
  if (typeof Netlify !== "undefined") return Netlify.env.get(name);
  return typeof process !== "undefined" ? process.env[name] : undefined;
}

function freeLimit(action: "decompose" | "replan"): number {
  return action === "decompose" ? 3 : 1;
}

function usageDateUtc(): string {
  return new Date().toISOString().slice(0, 10);
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

/**
 * 只读检查今日是否还有额度，不扣次。
 * mock / 超时兜底前应 peek；真实 AI 成功后再 commit。
 */
export async function peekAiQuota(
  userId: string,
  action: "decompose" | "replan",
  options?: { testerMode?: boolean },
): Promise<AiQuotaResult> {
  if (options?.testerMode) return { allowed: true, used: 0, limit: null };
  const entitlement = await getEntitlement(userId);
  if (entitlement.pro) return { allowed: true, used: 0, limit: null };

  const limit = freeLimit(action);
  const usageDate = usageDateUtc();
  try {
    const [record] = await db
      .select({ count: aiUsage.count })
      .from(aiUsage)
      .where(
        and(
          eq(aiUsage.userId, userId),
          eq(aiUsage.usageDate, usageDate),
          eq(aiUsage.action, action),
        ),
      )
      .limit(1);
    const used = Number(record?.count) || 0;
    return { allowed: used < limit, used, limit };
  } catch (error) {
    console.error("AI 配额读取失败，按免费版拒绝以避免绕过限制", error);
    return { allowed: false, used: limit, limit };
  }
}

/**
 * 真实 AI 成功后扣 1 次。已达上限则不再增加。
 */
export async function commitAiQuota(
  userId: string,
  action: "decompose" | "replan",
  options?: { testerMode?: boolean },
): Promise<AiQuotaResult> {
  if (options?.testerMode) return { allowed: true, used: 0, limit: null };
  const entitlement = await getEntitlement(userId);
  if (entitlement.pro) return { allowed: true, used: 0, limit: null };

  const limit = freeLimit(action);
  const usageDate = usageDateUtc();
  try {
    const peek = await peekAiQuota(userId, action, options);
    if (!peek.allowed) {
      return peek;
    }

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
          // 仅在未超限时 +1，避免并发把 used 顶到虚高
          count: sql`CASE WHEN ${aiUsage.count} < ${limit} THEN ${aiUsage.count} + 1 ELSE ${aiUsage.count} END`,
          updatedAt: new Date(),
        },
      })
      .returning({ count: aiUsage.count });
    const used = Number(record?.count) || peek.used + 1;
    return { allowed: used <= limit, used, limit };
  } catch (error) {
    console.error("AI 配额写入失败", error);
    return { allowed: false, used: limit, limit };
  }
}
