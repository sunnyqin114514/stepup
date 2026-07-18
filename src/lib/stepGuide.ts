import type { TaskStep } from "../types/plan";
import { stripMarkdown } from "./textSanitize";

/** 把旧 string / 新对象统一成 TaskStep，并补上极简实操指引 */
export function normalizeSteps(
  steps: Array<string | TaskStep> | undefined,
  ctx: { title: string; suggestedMinutes: number; goalTitle?: string }
): TaskStep[] {
  if (!steps || steps.length === 0) return [];
  return steps.map((raw) => {
    if (typeof raw === "string") {
      const action = stripMarkdown(raw);
      return {
        action,
        guide: action.includes("操作指引")
          ? undefined
          : buildGuide(action, ctx),
      };
    }
    const action = stripMarkdown(raw.action ?? "");
    const guide = stripMarkdown(raw.guide ?? "") || buildGuide(action, ctx);
    return {
      ...raw,
      action,
      guide,
      goal: raw.goal ? stripMarkdown(raw.goal) : undefined,
      checkCriteria: raw.checkCriteria ? stripMarkdown(raw.checkCriteria) : undefined,
      microActions: Array.isArray(raw.microActions)
        ? raw.microActions
            .filter((item) => item.text?.trim())
            .map((item) => ({
              ...item,
              text: stripMarkdown(item.text),
              material: item.material ? stripMarkdown(item.material) : undefined,
              sourceRef: item.sourceRef ? stripMarkdown(item.sourceRef) : undefined,
              timeLimit: item.timeLimit ? stripMarkdown(item.timeLimit) : undefined,
            }))
        : undefined,
      blockers: Array.isArray(raw.blockers)
        ? raw.blockers
            .filter((item) => item.problem?.trim() && item.solution?.trim())
            .map((item) => ({
              problem: stripMarkdown(item.problem),
              solution: stripMarkdown(item.solution),
            }))
        : undefined,
    };
  });
}

/**
 * 按任务语义生成通用实操指引（非考试/AP 限定）。
 * 考试、工作、技能学习共用同一套「找材料 → 计时执行 → 留下产出」逻辑。
 */
export function buildGuide(
  action: string,
  ctx: { title: string; suggestedMinutes: number; goalTitle?: string }
): string {
  const mins = Math.max(15, ctx.suggestedMinutes || 30);
  const a = action.toLowerCase();
  const tips: string[] = [];

  if (/下载|搜|找|打开|准备|材料|资源|文档|题目|赛题/.test(action)) {
    tips.push("在知识库或本地文件夹定位到对应资源；没有就先建一个空文件占位");
  } else if (/计时|限时|模拟|考试|刷|练|做题/.test(action) || /分钟/.test(action)) {
    tips.push(`手机/电脑计时器设 ${mins} 分钟，中途不查资料、不切聊天`);
  } else if (/写|草稿|笔记|记录|整理|复盘|总结/.test(action)) {
    tips.push("用空白纸或新建文档，只写本步产出，写完标日期");
  } else if (/搭|建|跑|代码|环境|安装|调试/.test(action) || /run|build|npm|git/.test(a)) {
    tips.push("先确认环境能打开；卡住超过 10 分钟就记下报错原文再继续");
  } else if (/交|发|提交|演示|展示|评审|反馈/.test(action)) {
    tips.push("按最终交付格式打包，发出前对照自检标准勾一遍");
  } else {
    tips.push(`围绕「${ctx.title}」只做本步动作，设定时 ${Math.min(mins, 45)} 分钟`);
  }

  tips.push("做完留下可核对痕迹：截图 / 文件 / 笔记三选一");
  if (ctx.goalTitle) {
    tips.push(`对照大目标「${ctx.goalTitle}」确认本步没有跑偏`);
  }

  return tips.map((t, i) => `${i + 1}.${t}`).join("；");
}
