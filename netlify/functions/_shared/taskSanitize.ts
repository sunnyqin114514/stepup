import type { Priority, TaskItem } from "../../../src/types/plan";
import { compactPlainText } from "../../../src/lib/textSanitize";

function compactString(value: unknown, maxLength: number): string {
  return compactPlainText(value, maxLength);
}

export function sanitizeMicroActions(raw: unknown) {
  if (!Array.isArray(raw)) return undefined;
  const items = raw
    .map((item) => {
      if (typeof item === "string") {
        const text = compactString(item, 160);
        return text ? { text } : null;
      }
      if (!item || typeof item !== "object") return null;
      const object = item as Record<string, unknown>;
      const text = compactString(
        object.text ?? object.action ?? object.title ?? object["具体动作"],
        180,
      );
      if (!text) return null;
      const material = compactString(
        object.material ?? object.source ?? object["材料来源"],
        120,
      );
      const sourceRef = compactString(
        object.sourceRef ?? object.reference ?? object.ref ?? object["页码/题号"],
        120,
      );
      const timeLimit = compactString(
        object.timeLimit ?? object.duration ?? object["时间限制"],
        60,
      );
      return {
        text,
        ...(material ? { material } : {}),
        ...(sourceRef ? { sourceRef } : {}),
        ...(timeLimit ? { timeLimit } : {}),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .slice(0, 5);

  return items.length ? items : undefined;
}

export function sanitizeBlockers(raw: unknown) {
  if (!Array.isArray(raw)) return undefined;
  const items = raw
    .map((item) => {
      if (typeof item === "string") {
        const problem = compactString(item, 120);
        return problem
          ? {
              problem,
              solution: "先缩小动作范围，只完成最小可检查产出，再继续下一步。",
            }
          : null;
      }
      if (!item || typeof item !== "object") return null;
      const object = item as Record<string, unknown>;
      const problem = compactString(
        object.problem ?? object.issue ?? object["卡点"],
        120,
      );
      const solution = compactString(
        object.solution ?? object.fix ?? object["解法"],
        180,
      );
      return problem && solution ? { problem, solution } : null;
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .slice(0, 3);

  return items.length ? items : undefined;
}

export function sanitizeSteps(raw: unknown): TaskItem["steps"] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const parsed = raw
    .map((s) => {
      if (typeof s === "string") {
        const action = compactString(s, 80);
        return action ? { action } : null;
      }
      if (s && typeof s === "object") {
        const o = s as Record<string, unknown>;
        const action = compactString(
          o.action ?? o.title ?? o.step ?? o["步骤标题"] ?? "",
          80,
        );
        if (!action) return null;
        const guide = compactString(o.guide ?? o.howTo ?? o["操作指引"], 360);
        const goal = compactString(o.goal ?? o.result ?? o["目标"], 180);
        const minutes = Number(o.minutes ?? o.suggestedMinutes ?? o["预计用时"]);
        const microActions = sanitizeMicroActions(
          o.microActions ?? o.actions ?? o.checklist ?? o["微动作清单"],
        );
        const checkCriteria = compactString(
          o.checkCriteria ??
            o.acceptanceCriteria ??
            o.doneWhen ??
            o["自检标准"],
          180,
        );
        const blockers = sanitizeBlockers(
          o.blockers ??
            o.commonBlockers ??
            o["常见卡点"] ??
            o["常见卡点 & 解法"],
        );
        return {
          action,
          ...(guide ? { guide } : {}),
          ...(goal ? { goal } : {}),
          ...(Number.isFinite(minutes) && minutes > 0
            ? { minutes: Math.min(60, Math.max(5, Math.round(minutes))) }
            : {}),
          ...(microActions ? { microActions } : {}),
          ...(checkCriteria ? { checkCriteria } : {}),
          ...(blockers ? { blockers } : {}),
        };
      }
      return null;
    })
    .filter((s): s is { action: string } => s !== null);
  return parsed.length >= 1 ? parsed.slice(0, 8) : undefined;
}

/** 解析 AI 返回的完整任务（含 steps），供 decompose / replan 共用 */
export function sanitizeFullTask(
  raw: unknown,
): Omit<TaskItem, "id" | "completed" | "focusSeconds"> | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const date = String(r.date ?? "");
  const title = compactString(r.title ?? r.content ?? "", 50);
  const subject = compactString(r.subject ?? r.module ?? r.subGoal ?? "", 60);
  const description = compactString(r.description ?? r.content ?? "", 80);
  const steps = sanitizeSteps(r.steps);
  const checkCriteria =
    compactString(
      r.checkCriteria ?? r.acceptanceCriteria ?? r.doneWhen ?? "",
      120,
    ) || undefined;
  const suggestedMinutes = Number(r.suggestedMinutes ?? r.minutes) || 30;
  const priorityRaw = String(r.priority ?? "medium");
  const priority: Priority =
    priorityRaw === "high" || priorityRaw === "low" ? priorityRaw : "medium";
  if (!date || !title) return null;

  const result: Omit<TaskItem, "id" | "completed" | "focusSeconds"> = {
    date,
    title,
    description,
    subject: subject || undefined,
    suggestedMinutes,
    priority,
    foundation: compactString(r.foundation ?? "", 300) || undefined,
    weakness: compactString(r.weakness ?? "", 300) || undefined,
    topicTags: Array.isArray(r.topicTags)
      ? r.topicTags
          .map((tag) => compactString(tag, 40))
          .filter(Boolean)
          .slice(0, 8)
      : [],
    priorityReason: compactString(r.priorityReason ?? "", 200) || undefined,
    sourceReason: compactString(r.sourceReason ?? "", 200) || undefined,
    resourceSuggestions: Array.isArray(r.resourceSuggestions)
      ? r.resourceSuggestions
          .map((item) => compactString(item, 80))
          .filter(Boolean)
          .slice(0, 8)
      : [],
    reviewIntervals: Array.isArray(r.reviewIntervals)
      ? r.reviewIntervals
          .map(Number)
          .filter((day) => [3, 7, 14, 30].includes(day))
      : [3, 7, 14, 30],
  };
  if (steps) result.steps = steps;
  if (checkCriteria) result.checkCriteria = checkCriteria;
  return result;
}
