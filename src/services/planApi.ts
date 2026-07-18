import type {
  DecomposeRequest,
  DecomposeResponse,
  ReplanRequest,
  ReplanResponse,
  TaskHelpRequest,
  TaskHelpResponse,
  TaskReviewRequest,
  TaskReviewResponse,
  TaskItem,
  AiResourceSearchResult,
  ResourceItem,
  ReviewScheduleItem,
  StructuredReviewReport,
} from "../types/plan";
import { isTesterModeEnabled } from "../lib/storage";

function requestHeaders(): HeadersInit {
  return {
    "Content-Type": "application/json",
    ...(isTesterModeEnabled() ? { "X-StepUp-Tester-Mode": "true" } : {}),
  };
}

async function postJSON<T>(
  url: string,
  body: unknown,
  options?: { timeoutMs?: number },
): Promise<T> {
  const controller = new AbortController();
  const timeoutMs = options?.timeoutMs ?? 25_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`请求失败 (${res.status}): ${text || res.statusText}`);
    }
    return (await res.json()) as T;
  } catch (error) {
    console.error(`API POST ${url} 失败`, error);
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(
        `请求超时：AI 生成超过 ${Math.round(timeoutMs / 1000)} 秒，请稍后重试或缩短目标周期。`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function getJSON<T>(url: string): Promise<T> {
  try {
    const response = await fetch(url, {
      headers: isTesterModeEnabled() ? { "X-StepUp-Tester-Mode": "true" } : {},
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(detail || `请求失败 (${response.status})`);
    }
    return (await response.json()) as T;
  } catch (error) {
    console.error(`API GET ${url} 失败`, error);
    throw error;
  }
}

/** 仅本地开发：把浏览器里的 Pro 试用开关同步到服务端 user_entitlements */
export async function syncDevProEntitlement(pro: boolean): Promise<{
  entitlement: { plan: "free" | "pro"; pro: boolean };
}> {
  return postJSON("/api/workspace", { action: "setDevPro", pro });
}

export async function decomposePlan(
  req: DecomposeRequest
): Promise<DecomposeResponse> {
  // 冷启动 + 真 AI 偶发超过 20s；演示场景放宽，避免前端先断开
  return postJSON<DecomposeResponse>("/api/decompose", req, { timeoutMs: 40_000 });
}

export async function replanPlan(
  req: ReplanRequest
): Promise<ReplanResponse> {
  return postJSON<ReplanResponse>("/api/replan", req, { timeoutMs: 40_000 });
}

export async function askTaskHelp(
  req: TaskHelpRequest
): Promise<TaskHelpResponse> {
  return postJSON<TaskHelpResponse>("/api/task-help", req, { timeoutMs: 60_000 });
}

export async function requestTaskReview(
  req: TaskReviewRequest
): Promise<TaskReviewResponse> {
  return postJSON<TaskReviewResponse>("/api/task-review", req, { timeoutMs: 90_000 });
}

export async function listResources(query = ""): Promise<{
  resources: ResourceItem[];
  entitlement: { plan: "free" | "pro"; pro: boolean };
  freeLimit: number;
}> {
  return getJSON(`/api/resources${query ? `?q=${encodeURIComponent(query)}` : ""}`);
}

export async function searchAiResource(query: string): Promise<AiResourceSearchResult & { mock?: boolean }> {
  return postJSON("/api/ai-resource-search", { query }, { timeoutMs: 60_000 });
}

export async function createNoteResource(input: {
  kind: "note" | "link";
  title: string;
  text?: string;
  url?: string;
  tags: string[];
}): Promise<{ resource: ResourceItem }> {
  return postJSON("/api/resources", input);
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => {
      console.error("文件读取失败", reader.error);
      reject(new Error("文件读取失败"));
    };
    reader.readAsDataURL(file);
  });
}

/** 使用 JSON+Base64，避开本地 Netlify 模拟环境对 multipart 的解析失败 */
export async function uploadResource(input: {
  file: File;
  title: string;
  tags: string;
}): Promise<{ resource: ResourceItem }> {
  try {
    const contentBase64 = await fileToBase64(input.file);
    return await postJSON("/api/resources", {
      action: "upload",
      fileName: input.file.name,
      mimeType: input.file.type,
      title: input.title.trim() || input.file.name,
      tags: input.tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
      contentBase64,
    });
  } catch (error) {
    console.error("知识库文件上传失败", error);
    throw error;
  }
}

export async function bindTaskResource(taskId: string, resourceId: string): Promise<void> {
  await postJSON("/api/resources", { action: "bind", taskId, resourceId });
}

export async function createTaskFromResource(resourceId: string): Promise<{ resourceId: string; task: TaskItem }> {
  return postJSON("/api/resources", { action: "createTask", resourceId });
}

export async function listDueReviews(): Promise<{
  schedules: ReviewScheduleItem[];
  dueCount: number;
  entitlement: { plan: "free" | "pro"; pro: boolean };
}> {
  return getJSON("/api/reviews");
}

export async function submitReviewFeedback(
  scheduleId: string,
  result: "remember" | "fuzzy" | "forgot",
): Promise<{ schedule: ReviewScheduleItem; algorithm: string }> {
  return postJSON("/api/reviews", { action: "feedback", scheduleId, result });
}

export async function addReviewToToday(scheduleId: string): Promise<{ task: TaskItem }> {
  return postJSON("/api/reviews", { action: "addToToday", scheduleId });
}

export async function listReviewReports(filters?: {
  from?: string;
  to?: string;
  goalId?: string;
}): Promise<{ reports: StructuredReviewReport[] }> {
  const params = new URLSearchParams({ mode: "reports" });
  if (filters?.from) params.set("from", filters.from);
  if (filters?.to) params.set("to", filters.to);
  if (filters?.goalId) params.set("goalId", filters.goalId);
  return getJSON(`/api/reviews?${params}`);
}
