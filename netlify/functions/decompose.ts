import type { Config } from "@netlify/functions";
import type {
  DecomposeRequest,
  DecomposeResponse,
  PlanSchedule,
  TaskItem,
  Priority,
} from "../../src/types/plan";
import {
  buildDefaultSchedule,
  distributeTasksToWorkDates,
  listExecutableDays,
  localDateStr,
  parseLocalDate,
  snapToNextExecutableDay,
} from "../../src/lib/scheduleDates";
import { compactPlainText } from "../../src/lib/textSanitize";
import { checkOrigin, createAiClient } from "./_shared/aiClient";
import { buildFallbackStepsForTask } from "./_shared/taskDetail";
import { sanitizeFullTask } from "./_shared/taskSanitize";
import {
  consumeAiQuota,
  getRequestEntitlement,
  isAuthResponse,
  isTesterModeRequest,
  requireUser,
} from "./_shared/auth";

function resolveDailyBudget(req: DecomposeRequest): number {
  const allocated = Number(req.allocatedDailyMinutes);
  if (Number.isFinite(allocated) && allocated >= 15) {
    return Math.min(600, Math.round(allocated));
  }
  return Math.max(15, Math.round(Number(req.dailyMinutes) || 120));
}

function buildPrompt(req: DecomposeRequest): string {
  const todayStr = localDateStr();
  const dailyBudget = resolveDailyBudget(req);
  const executableDays = listExecutableDays(todayStr, req.deadline, req.workdays);
  const executableCount = Math.max(1, executableDays.length);
  const schedule = buildDefaultSchedule(todayStr, req.deadline, req.workdays);
  const lastTaskDateStr =
    schedule.workDates[schedule.workDates.length - 1] ??
    executableDays[executableDays.length - 1] ??
    req.deadline;

  let strategy: string;
  let taskCountHint: string;
  if (executableCount <= 7) {
    strategy = "短期冲刺：几乎每个可执行日都有任务，每天 1-2 个";
    taskCountHint = `${Math.min(executableCount * 2, 14)} 个任务左右`;
  } else if (executableCount <= 30) {
    strategy = "月度计划：约每天 1 个可执行任务，前中后三段都要有实质练习";
    taskCountHint = `${Math.min(Math.max(12, Math.ceil(executableCount * 1.05)), 28)} 个任务`;
  } else if (executableCount <= 90) {
    strategy = "季度计划：按周推进，每周至少 3-4 个具体练习任务，覆盖诊断/专项/模拟";
    taskCountHint = `${Math.min(Math.max(18, Math.ceil(executableCount * 0.55)), 36)} 个任务`;
  } else {
    strategy = "长期计划：按阶段里程碑密集排布，开始、中段、冲刺周都要有实质任务";
    taskCountHint = `${Math.min(Math.max(24, Math.ceil(executableCount * 0.35)), 42)} 个任务`;
  }

  const unfinishedTasks = (req.unfinishedTasks ?? [])
    .map(String)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12);
  const knowledgeKeyPoints = (req.knowledgeKeyPoints ?? [])
    .map(String)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);
  const weakKnowledgePoints = (req.weakKnowledgePoints ?? [])
    .map(String)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);

  const sampleWork = schedule.workDates.slice(0, 8).join("、");
  const sampleRest = schedule.restDates.slice(0, 6).join("、") || "无";

  return `只输出合法 JSON 对象，不要 Markdown（禁止 ** 加粗、# 标题、反引号），不要解释。
任务：按用户目标生成具体、可执行、贴合场景的计划，并给出工作日/休息日排期。

输入：
- 目标：${req.goal}
- 起始日期：${todayStr}
- 截止日期：${req.deadline}，最后任务不晚于 ${lastTaskDateStr}
- 本目标每日预算：${dailyBudget} 分钟（全局上限 ${Number(req.globalDailyCap) || dailyBudget}）
- 可执行日偏好：${req.workdays.join("、")}；可执行日共 ${executableCount} 天
- 推荐工作日样例：${sampleWork}
- 推荐休息日样例：${sampleRest}
- 当前基础：${req.foundation || "未填写"}
- 薄弱领域：${req.weakness || "未填写"}
- 密度：${strategy}；任务数建议：${taskCountHint}
- 近期完成率：${Number.isFinite(Number(req.completionRate)) ? `${Number(req.completionRate)}%` : "暂无"}
- 连续完成天数：${Number(req.streakDays) || 0}
- 未完成任务：${unfinishedTasks.length ? unfinishedTasks.join("；") : "无"}
- 知识库重点：${knowledgeKeyPoints.length ? knowledgeKeyPoints.join("；") : "暂无"}
- 知识库薄弱点：${weakKnowledgePoints.length ? weakKnowledgePoints.join("；") : "暂无"}
- 节奏提示：${req.adaptiveHint || "正常"}

硬性规则：
1. date 必须在推荐工作日上；day1 必须是 ${todayStr}（若今天不可执行则用最近工作日）。
2. 每天总分钟数 ≤ ${Math.round(dailyBudget * 0.9)}，同一天最多 3 个任务；有任务的日子尽量用到预算的 60%-90%，禁止大量空档日。
3. 任务日期必须覆盖前期、中期、冲刺：最早任务在开始 3 天内，最晚任务在截止前 7 天内；相邻有任务的工作日间隔尽量不超过 2 天。
4. 备考目标必须拆到考试模块/题型/练习动作；禁止“澄清目标/成功标准/搭建框架”。
5. 工作/项目目标才允许需求澄清、交付、评审类任务。
6. 薄弱领域相关任务占比不少于 30%。
7. steps 2-3 项，含 action、goal、minutes、microActions、checkCriteria、blockers；guide 一句话。
8. 文本全部用纯中文/英文，禁止 Markdown 符号。
9. 同时输出 schedule.workDates 与 schedule.restDates（YYYY-MM-DD 数组）。

返回结构：
{"schedule":{"workDates":["YYYY-MM-DD"],"restDates":["YYYY-MM-DD"]},"tasks":[{"date":"YYYY-MM-DD","subject":"科目或模块","title":"8-25字具体动作","description":"30-60字","steps":[{"action":"步骤标题","goal":"达成结果","minutes":20,"guide":"一句话","microActions":[{"text":"具体动作","material":"材料","sourceRef":"题号/段落","timeLimit":"15分钟"}],"checkCriteria":"本步自检","blockers":[{"problem":"卡点","solution":"解法"}]}],"checkCriteria":"任务自检","suggestedMinutes":30,"priority":"high|medium|low","topicTags":["标签"],"priorityReason":"原因","sourceReason":"来源","resourceSuggestions":["检索词"],"reviewIntervals":[3,7,14,30]}]}`;
}

function compactString(value: unknown, maxLength: number): string {
  return compactPlainText(value, maxLength);
}

function tryParseJson(text: string): unknown | null {
  const candidates = new Set<string>();
  const base = text
    .replace(/^\uFEFF/, "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  candidates.add(base);

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) candidates.add(fenced);

  const balanced = extractBalancedJson(base);
  if (balanced) candidates.add(balanced);

  for (const candidate of candidates) {
    const normalized = candidate.replace(/,\s*([}\]])/g, "$1");
    try {
      return JSON.parse(normalized);
    } catch {
      // Try the next recoverable candidate.
    }
  }
  return null;
}

function extractBalancedJson(text: string): string | null {
  const start = text.search(/[\[{]/);
  if (start < 0) return null;
  return extractBalancedJsonFrom(text, start);
}

function extractBalancedJsonFrom(text: string, start: number): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      continue;
    }
    if (char === "}" || char === "]") {
      if (stack.pop() !== char) return null;
      if (stack.length === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

function recoverPartialTaskObjects(text: string): unknown[] {
  const recovered: unknown[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "{") continue;
    const snippet = extractBalancedJsonFrom(text, i);
    if (!snippet || seen.has(snippet)) continue;
    seen.add(snippet);
    try {
      const parsed = JSON.parse(snippet.replace(/,\s*([}\]])/g, "$1"));
      if (sanitizeFullTask(parsed)) recovered.push(parsed);
    } catch {
      // Ignore non-task nested objects or malformed fragments.
    }
  }

  return recovered;
}

function flattenParsedTasks(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object") return [];

  const object = parsed as Record<string, unknown>;
  if (Array.isArray(object.tasks)) return object.tasks;
  if (Array.isArray(object.items)) return object.items;
  if (Array.isArray(object.data)) return object.data;

  if (Array.isArray(object.plan)) {
    return object.plan.flatMap((day) => {
      if (!day || typeof day !== "object") return [];
      const item = day as Record<string, unknown>;
      const date = String(item.date ?? "");
      if (Array.isArray(item.tasks)) {
        return item.tasks.map((task) =>
          task && typeof task === "object"
            ? { ...(task as Record<string, unknown>), date }
            : task,
        );
      }
      return date ? [{ ...item, date }] : [item];
    });
  }

  return [];
}

function isLikelyGenericMetaTask(task: Pick<TaskItem, "title" | "description">): boolean {
  const text = `${task.title} ${task.description}`;
  return /澄清目标|成功标准|搭建.*框架|最小可执行框架|摸清现状|交付什么|怎样算达成/.test(text);
}

function isExamLikeGoal(req: DecomposeRequest): boolean {
  const text = `${req.goal} ${req.foundation ?? ""} ${req.weakness ?? ""}`.toLowerCase();
  return /考试|备考|高考|中考|考研|考公|国考|省考|托福|toefl|雅思|ielts|gre|gmat|sat|act|四六级|六级|四级|证书|认证/.test(text);
}

function tasksNeedScenarioFallback(
  req: DecomposeRequest,
  tasks: Array<Omit<TaskItem, "id" | "completed" | "focusSeconds">>,
): boolean {
  if (tasks.length === 0) return true;
  if (!isExamLikeGoal(req)) return false;
  const genericCount = tasks.filter(isLikelyGenericMetaTask).length;
  return genericCount / tasks.length >= 0.35;
}

// ===== Mock 兜底：必须按目标场景生成，不能回退成空泛元任务 =====

const MOCK_TEMPLATES: {
  title: string;
  desc: string;
  priority: Priority;
  check: string;
  steps: string[];
  subject?: string;
  sourceReason?: string;
}[] = [
  {
    title: "澄清目标与成功标准",
    desc: "写清要交付什么、怎样算达成",
    priority: "high",
    check: "一页笔记写清目标、截止与 3 条可验收标准",
    steps: [
      "用一句话重写目标（可被外人听懂）",
      "列出截止前必须交付的 3 个结果",
      "标出当前最大不确定点",
      "写下明天就能动手的第一步",
    ],
  },
  {
    title: "摸清现状与缺口",
    desc: "盘点已有资源与关键短板",
    priority: "high",
    check: "列出已有/缺口清单，并圈出优先补的 2 项",
    steps: [
      "列出已有材料、技能或进度",
      "对照目标标出缺口",
      "按影响排序前 2 个缺口",
      "为每个缺口写一个补齐动作",
    ],
  },
  {
    title: "搭建最小可执行框架",
    desc: "先做出能跑的骨架，再填充细节",
    priority: "high",
    check: "骨架可演示：别人 1 分钟内能看懂主流程",
    steps: [
      "划定本期最小范围（MVP）",
      "搭出主流程的空壳结构",
      "填入一个端到端样例",
      "记录阻塞点与下一步",
    ],
  },
  {
    title: "完成一块核心模块",
    desc: "推进主线中最关键的一块产出",
    priority: "medium",
    check: "该模块有可检查的产出物（文档/代码/作品片段）",
    steps: [
      "明确本模块输入与输出",
      "集中完成核心部分",
      "自测一遍主路径",
      "记下遗留问题不超过 3 条",
    ],
  },
  {
    title: "练习/迭代并收集反馈",
    desc: "用真实反馈修正方向",
    priority: "medium",
    check: "至少获得 1 条外部反馈并写明将如何改",
    steps: [
      "准备可展示的中间成果",
      "找一人或一个标准做检验",
      "记录反馈要点",
      "改掉最高优先级的 1 个问题",
    ],
  },
  {
    title: "专项突破薄弱点",
    desc: "针对卡住进度的点做集中突破",
    priority: "medium",
    check: "薄弱点相关的 1 个障碍被消除或绕过",
    steps: [
      "写出卡住你的具体现象",
      "找一条最小可行解法",
      "实际做一遍验证",
      "把解法记成可复用笔记",
    ],
  },
  {
    title: "整合联调与自测",
    desc: "把分散产出串成完整链路",
    priority: "high",
    check: "主链路跑通一次，并记录未通过项",
    steps: [
      "按最终使用顺序串起来",
      "走查一遍主路径",
      "记录失败点",
      "修复最影响完成的问题",
    ],
  },
  {
    title: "模拟验收演练",
    desc: "按最终交付标准完整过一遍",
    priority: "high",
    check: "按验收清单勾完，剩余问题 ≤ 3 条",
    steps: [
      "列出验收清单",
      "限时完整演练一次",
      "对照清单打分",
      "安排补漏动作",
    ],
  },
  {
    title: "查漏补缺与收尾",
    desc: "处理遗留项，准备最终交付",
    priority: "medium",
    check: "遗留清单清空或每项都有处理结论",
    steps: [
      "汇总全部遗留项",
      "区分必须改/可延后",
      "处理必须改的项",
      "写一段完成说明",
    ],
  },
  {
    title: "最终交付与复盘",
    desc: "交付成果并记录可复用经验",
    priority: "high",
    check: "成果已提交/展示，并有 3 条复盘结论",
    steps: [
      "按最终格式打包成果",
      "提交或演示给目标对象",
      "写下做得好的 1 点与要改的 2 点",
      "写下下次可复用的流程",
    ],
  },
];

const TOEFL_MOCK_TEMPLATES: typeof MOCK_TEMPLATES = [
  {
    subject: "托福听力",
    title: "精听一篇 TPO Conversation",
    desc: "用真实托福对话训练主旨、态度和细节定位",
    priority: "high",
    check: "完成 1 篇对话精听，整理 8 个信号词，错题原因不少于 3 条",
    sourceReason: "来自目标考试模块：托福听力",
    steps: [
      "打开一篇 TPO Conversation 听力材料",
      "第一遍限时做题并记录正确数",
      "第二遍逐句精听标出转折和态度词",
      "整理错题原因和 8 个信号词",
    ],
  },
  {
    subject: "托福口语",
    title: "练 3 道独立口语题并录音",
    desc: "针对口语卡顿问题训练限时组织和表达流畅度",
    priority: "high",
    check: "完成 3 段录音，每段 45 秒内说完，复听后标出 2 个卡顿点",
    sourceReason: "来自薄弱领域：口语独立题",
    steps: [
      "选 3 道独立口语高频题",
      "每题 15 秒写关键词提纲",
      "计时 45 秒完整作答并录音",
      "复听标记停顿、语法和例子不足处",
    ],
  },
  {
    subject: "托福写作",
    title: "拆解一篇综合写作结构",
    desc: "训练阅读观点、听力反驳和段落模板的对应关系",
    priority: "high",
    check: "写出阅读 3 点和听力 3 个反驳点，并完成 180 字以上提纲",
    sourceReason: "来自薄弱领域：综合写作结构",
    steps: [
      "打开一套综合写作题",
      "阅读材料中圈出 3 个主张",
      "听力中记录对应反驳点",
      "按引言/三段反驳写出提纲",
    ],
  },
  {
    subject: "托福阅读",
    title: "限时完成一篇阅读并复盘",
    desc: "训练词汇题、指代题和句子简化题的定位速度",
    priority: "medium",
    check: "20 分钟内完成 1 篇阅读，正确率达到 70%，错题按题型归类",
    sourceReason: "来自目标考试模块：托福阅读",
    steps: [
      "选择一篇 TPO 阅读文章",
      "计时 20 分钟完成全部题目",
      "按题型统计正确率",
      "摘出 5 个影响理解的长难句或词汇",
    ],
  },
  {
    subject: "托福听力",
    title: "训练讲座笔记缩写法",
    desc: "把听力内容压缩成结构化笔记，减少漏听和记不住",
    priority: "medium",
    check: "完成 1 篇 Lecture 笔记，包含主题、分论点、例子和态度标记",
    sourceReason: "来自薄弱领域：听力记笔记",
    steps: [
      "打开一篇 TPO Lecture",
      "只记名词、箭头、因果和转折符号",
      "听后用笔记复述 60 秒",
      "对照原文补齐漏掉的结构点",
    ],
  },
  {
    subject: "托福词汇",
    title: "整理阅读高频词和同义替换",
    desc: "用阅读错题反推词汇短板，补齐影响理解的核心词",
    priority: "medium",
    check: "整理 20 个高频词，写出英文释义或同义替换，并完成自测",
    sourceReason: "来自当前基础：词汇需要持续巩固",
    steps: [
      "从阅读错题中摘出不熟词",
      "查英文释义和同义替换",
      "每个词写一个托福语境例句",
      "遮住释义做一轮自测",
    ],
  },
  {
    subject: "托福口语",
    title: "练综合口语听读转述",
    desc: "训练读材料、听反驳、用模板组织回答",
    priority: "medium",
    check: "完成 2 道综合口语，录音中包含阅读观点、听力细节和结论",
    sourceReason: "来自目标考试模块：托福口语",
    steps: [
      "选择 2 道综合口语题",
      "阅读材料限时 45 秒抓观点",
      "听力时记录原因和例子",
      "按模板录音并复听修改",
    ],
  },
  {
    subject: "托福模考",
    title: "完成半套托福模块模考",
    desc: "把阅读和听力放在连续时间内训练耐力",
    priority: "high",
    check: "完成阅读+听力半套模考，记录各模块正确率和最弱题型",
    sourceReason: "来自冲刺复习：综合检验",
    steps: [
      "选择一套 TPO 的阅读和听力部分",
      "按考试时间连续完成",
      "统计阅读和听力正确率",
      "列出下次优先补强的 2 个题型",
    ],
  },
];

const GENERAL_EXAM_MOCK_TEMPLATES: typeof MOCK_TEMPLATES = [
  {
    subject: "诊断测评",
    title: "完成一次限时摸底练习",
    desc: "先用真实题目定位当前分数、薄弱模块和时间分配问题",
    priority: "high",
    check: "完成 1 套或 1 个模块限时练习，记录正确率、耗时和 3 个最弱题型",
    sourceReason: "来自备考目标：先建立基线",
    steps: [
      "选择最近真题或权威模拟题",
      "按考试时间限制完成一个模块",
      "统计总题数、正确数和耗时",
      "按题型标出最弱的 3 类问题",
    ],
  },
  {
    subject: "薄弱模块",
    title: "专项练习一个薄弱题型",
    desc: "针对用户填写的薄弱领域做集中训练，避免平均用力",
    priority: "high",
    check: "完成 20-30 分钟专项练习，错题全部写出原因和下一次避免方法",
    sourceReason: "来自薄弱领域：优先补短板",
    steps: [
      "从薄弱领域中选 1 个具体题型",
      "找 10-15 道同类真题或例题",
      "计时完成并记录正确数",
      "把错题按知识点、审题、计算、表达归因",
    ],
  },
  {
    subject: "核心知识点",
    title: "整理一个高频考点清单",
    desc: "把高频知识点压缩成可复习、可检查的笔记",
    priority: "medium",
    check: "产出一页高频考点笔记，包含定义、常见题型和 3 个易错点",
    sourceReason: "来自备考目标：夯实高频内容",
    steps: [
      "打开教材目录、考纲或真题解析",
      "选一个高频考点写出定义和适用场景",
      "补充 2 道典型题或案例",
      "写下 3 个容易混淆或扣分的位置",
    ],
  },
  {
    subject: "真题训练",
    title: "限时完成一组真题并订正",
    desc: "用真题训练速度和准确率，同时形成可复盘错题",
    priority: "high",
    check: "完成一组真题，订正全部错题，并统计本组正确率",
    sourceReason: "来自备考目标：真题驱动提升",
    steps: [
      "选择一组与当前阶段匹配的真题",
      "按考试节奏计时完成",
      "对答案并计算正确率",
      "把错题编号、原因和正确解法写入错题表",
    ],
  },
  {
    subject: "错题复盘",
    title: "复盘昨日错题并二次作答",
    desc: "把错题转成可再次训练的知识漏洞，防止重复犯错",
    priority: "medium",
    check: "完成至少 5 道错题二刷，二刷正确率达到 80% 或写出补救动作",
    sourceReason: "来自艾宾浩斯复习：错题间隔回顾",
    steps: [
      "打开昨日或上次练习的错题记录",
      "遮住答案重新作答",
      "对照解析标出仍不会的步骤",
      "为每道错题写一句避错提醒",
    ],
  },
  {
    subject: "模拟冲刺",
    title: "完成一次考前模拟复盘",
    desc: "在截止日前检验完整流程，定位最后需要补强的模块",
    priority: "high",
    check: "完成一次模拟或半套模拟，记录分数、耗时、薄弱模块和明日补强任务",
    sourceReason: "来自冲刺阶段：模拟查漏",
    steps: [
      "选择一套完整模拟题或半套真题",
      "按正式考试顺序和时间完成",
      "统计各模块得分和耗时",
      "列出明天必须补强的 2 个点",
    ],
  },
];

function pickMockTemplates(req: DecomposeRequest): typeof MOCK_TEMPLATES {
  const text = `${req.goal} ${req.foundation ?? ""} ${req.weakness ?? ""}`.toLowerCase();
  if (/托福|toefl/.test(text)) return TOEFL_MOCK_TEMPLATES;
  if (/雅思|ielts/.test(text)) {
    return TOEFL_MOCK_TEMPLATES.map((template) => ({
      ...template,
      subject: template.subject?.replace("托福", "雅思"),
      title: template.title
        .replace("TPO", "剑桥雅思")
        .replace("托福", "雅思")
        .replace("独立口语", "Part 2 口语")
        .replace("综合写作", "Task 2 写作"),
      desc: template.desc.replace("托福", "雅思"),
      sourceReason: template.sourceReason?.replace("托福", "雅思"),
    }));
  }
  if (isExamLikeGoal(req)) return GENERAL_EXAM_MOCK_TEMPLATES;
  return MOCK_TEMPLATES;
}

function generateMockTasks(req: DecomposeRequest): Omit<
  TaskItem,
  "id" | "completed" | "focusSeconds"
>[] {
  const today = localDateStr();
  const schedule = buildDefaultSchedule(today, req.deadline, req.workdays);
  const days =
    schedule.workDates.length > 0
      ? schedule.workDates
      : listExecutableDays(today, req.deadline, req.workdays);
  const workDays = days.length > 0 ? days : [today];

  const templates = pickMockTemplates(req);
  const count = Math.max(
    6,
    Math.min(28, Math.ceil(workDays.length * 0.95)),
  );

  const perDayMinutes = resolveDailyBudget(req);
  const rawTasks: Omit<TaskItem, "id" | "completed" | "focusSeconds">[] = [];
  for (let i = 0; i < count; i++) {
    const tpl = templates[i % templates.length];
    const minutes = Math.min(
      perDayMinutes,
      Math.max(30, Math.round(perDayMinutes * (0.5 + (i % 3) * 0.15))),
    );
    rawTasks.push({
      date: workDays[0],
      title: tpl.title,
      subject: tpl.subject,
      description: tpl.desc,
      steps: tpl.steps.map((action, stepIndex) =>
        buildMockStep(action, tpl, minutes, stepIndex),
      ),
      checkCriteria: tpl.check,
      suggestedMinutes: minutes,
      priority: tpl.priority,
      foundation: req.foundation,
      weakness: req.weakness,
      topicTags: tpl.subject ? [tpl.subject, "自检"] : ["目标执行", "自检"],
      priorityReason: tpl.sourceReason ?? "位于当前目标的关键推进路径",
      sourceReason: tpl.sourceReason,
      resourceSuggestions: tpl.subject
        ? [`${tpl.subject} 高频题`, `${tpl.subject} 真题解析`, "错题复盘表"]
        : ["知识库中与当前任务最相关的入门资料"],
      reviewIntervals: [3, 7, 14, 30],
    });
  }
  return distributeTasksToWorkDates(
    rawTasks,
    workDays,
    Math.round(perDayMinutes * 0.9),
    req.deadline,
  );
}

function extractScheduleFromParsed(
  parsed: unknown,
  fallback: PlanSchedule,
): PlanSchedule {
  if (!parsed || typeof parsed !== "object") return fallback;
  const object = parsed as Record<string, unknown>;
  const schedule = object.schedule;
  if (!schedule || typeof schedule !== "object") return fallback;
  const s = schedule as Record<string, unknown>;
  const workDates = Array.isArray(s.workDates)
    ? s.workDates.map(String).filter(Boolean)
    : [];
  const restDates = Array.isArray(s.restDates)
    ? s.restDates.map(String).filter(Boolean)
    : [];
  if (workDates.length === 0) return fallback;
  return { workDates, restDates };
}

function cleanFinalSteps(
  task: Omit<TaskItem, "id" | "completed" | "focusSeconds">,
  checkCriteria: string,
): TaskItem["steps"] {
  const rawSteps = task.steps?.length
    ? task.steps
    : buildFallbackStepsForTask(
        task.title,
        task.subject,
        task.suggestedMinutes,
        checkCriteria,
      );

  const steps = rawSteps
    .map((step) => {
      if (typeof step === "string") {
        const action = compactString(step, 80);
        return action ? { action } : null;
      }

      const action = compactString(step.action, 80);
      if (!action) return null;
      const guide = compactString(step.guide ?? "", 360);
      const goal = compactString(step.goal ?? "", 180);
      const check = compactString(step.checkCriteria ?? "", 180);
      const microActions = Array.isArray(step.microActions)
        ? step.microActions
            .map((item) => {
              const text = compactString(item.text, 180);
              if (!text) return null;
              const material = compactString(item.material ?? "", 120);
              const sourceRef = compactString(item.sourceRef ?? "", 120);
              const timeLimit = compactString(item.timeLimit ?? "", 60);
              return {
                text,
                ...(material ? { material } : {}),
                ...(sourceRef ? { sourceRef } : {}),
                ...(timeLimit ? { timeLimit } : {}),
              };
            })
            .filter((item): item is NonNullable<typeof item> => item !== null)
            .slice(0, 5)
        : undefined;
      const blockers = Array.isArray(step.blockers)
        ? step.blockers
            .map((item) => {
              const problem = compactString(item.problem, 120);
              const solution = compactString(item.solution, 180);
              return problem && solution ? { problem, solution } : null;
            })
            .filter((item): item is NonNullable<typeof item> => item !== null)
            .slice(0, 3)
        : undefined;

      return {
        action,
        ...(guide ? { guide } : {}),
        ...(goal ? { goal } : {}),
        ...(Number.isFinite(Number(step.minutes)) && Number(step.minutes) > 0
          ? { minutes: Math.min(60, Math.max(5, Math.round(Number(step.minutes)))) }
          : {}),
        ...(microActions?.length ? { microActions } : {}),
        ...(check ? { checkCriteria: check } : {}),
        ...(blockers?.length ? { blockers } : {}),
      };
    })
    .filter((step): step is NonNullable<typeof step> => step !== null);

  return steps.length ? steps : undefined;
}

function finalizeScheduledTasks(
  req: DecomposeRequest,
  tasks: Array<Omit<TaskItem, "id" | "completed" | "focusSeconds">>,
  aiSchedule?: PlanSchedule | null,
): {
  tasks: Array<Omit<TaskItem, "id" | "completed" | "focusSeconds">>;
  schedule: PlanSchedule;
  allocatedDailyMinutes: number;
} {
  const today = localDateStr();
  const dailyBudget = resolveDailyBudget(req);
  const fallback = buildDefaultSchedule(today, req.deadline, req.workdays);
  let schedule: PlanSchedule = aiSchedule?.workDates?.length
    ? {
        workDates: [...aiSchedule.workDates].sort(),
        restDates: [...(aiSchedule.restDates ?? [])].sort(),
        dailyBudgetMinutes: dailyBudget,
      }
    : { ...fallback, dailyBudgetMinutes: dailyBudget };

  // 保证今天（或最近可执行日）在工作日中
  const firstWork =
    snapToNextExecutableDay(today, req.workdays, req.deadline) ?? today;
  if (!schedule.workDates.includes(firstWork)) {
    schedule.workDates = [firstWork, ...schedule.workDates].sort();
    schedule.restDates = schedule.restDates.filter((d) => d !== firstWork);
  }

  const workSet = new Set(schedule.workDates);
  const snapped = tasks.map((task) => {
    let date = task.date;
    if (!workSet.has(date)) {
      date =
        snapToNextExecutableDay(date, req.workdays, req.deadline) ??
        schedule.workDates[0] ??
        today;
      if (!workSet.has(date) && schedule.workDates.length) {
        date = schedule.workDates[0];
      }
    }
    if (parseLocalDate(date) > parseLocalDate(req.deadline)) {
      date = schedule.workDates[schedule.workDates.length - 1] ?? today;
    }
    return { ...task, date };
  });

  const distributed = distributeTasksToWorkDates(
    snapped,
    schedule.workDates,
    Math.round(dailyBudget * 0.9),
    req.deadline,
  );

  const capped = distributed.map((t) => {
    const checkCriteria =
      compactString(t.checkCriteria ?? "", 180) ||
      `完成「${t.title}」并留下可核对的产出（笔记/文件/截图/可演示结果）`;
    const title = compactString(t.title, 50);
    const subject = t.subject ? compactString(t.subject, 60) : undefined;
    const description = compactString(t.description, 80);
    const steps = cleanFinalSteps(
      { ...t, title, subject, description, checkCriteria },
      checkCriteria,
    );
    return {
      ...t,
      title,
      description,
      subject,
      checkCriteria,
      steps,
      foundation: t.foundation ? compactString(t.foundation, 300) : undefined,
      weakness: t.weakness ? compactString(t.weakness, 300) : undefined,
      topicTags: Array.isArray(t.topicTags)
        ? t.topicTags.map((tag) => compactString(tag, 40)).filter(Boolean).slice(0, 8)
        : [],
      priorityReason: t.priorityReason ? compactString(t.priorityReason, 200) : undefined,
      sourceReason: t.sourceReason ? compactString(t.sourceReason, 200) : undefined,
      resourceSuggestions: Array.isArray(t.resourceSuggestions)
        ? t.resourceSuggestions
            .map((item) => compactString(item, 80))
            .filter(Boolean)
            .slice(0, 8)
        : [],
    };
  });

  return {
    tasks: capped,
    schedule,
    allocatedDailyMinutes: dailyBudget,
  };
}

function buildMockStep(
  action: string,
  tpl: (typeof MOCK_TEMPLATES)[number],
  taskMinutes: number,
  stepIndex: number,
) {
  const stepMinutes = Math.max(15, Math.min(25, Math.round(taskMinutes / 3)));
  const subject = tpl.subject ?? "当前目标";
  return {
    action,
    goal: `完成后能推进「${tpl.title}」中的一个可检查动作`,
    minutes: stepMinutes,
    guide: `1.找到${subject}相关材料；2.计时${stepMinutes}分钟只做本步；3.留下笔记、错题或截图作为产出`,
    microActions: [
      {
        text: action,
        material: tpl.subject ? `${subject}真题/题库/课堂笔记` : "知识库或本地已有资料",
        sourceRef: `当前资料第 ${stepIndex + 1} 组/同类题`,
        timeLimit: `${stepMinutes}分钟`,
      },
      {
        text: "记录本步结果和错误原因",
        material: "错题表或空白笔记",
        sourceRef: "本步骤产出区",
        timeLimit: "5分钟",
      },
    ],
    checkCriteria: tpl.check,
    blockers: [
      {
        problem: "找不到对应材料",
        solution: `先用「${subject} 高频题」作为检索词，在知识库、真题册或网课讲义里找同类题。`,
      },
      {
        problem: "超过时间还没完成",
        solution: "停止扩展资料，只保留已完成部分和卡点，下一步先补最影响正确率的问题。",
      },
    ],
  };
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  if (!checkOrigin(req)) {
    return new Response("Forbidden", { status: 403 });
  }
  const auth = await requireUser();
  if (isAuthResponse(auth)) return auth;

  let body: DecomposeRequest;
  try {
    body = (await req.json()) as DecomposeRequest;
  } catch {
    return Response.json({ error: "无效的请求体" }, { status: 400 });
  }

  if (!body.goal?.trim() || !body.deadline) {
    return Response.json(
      { error: "目标和截止日期必填" },
      { status: 400 }
    );
  }
  const deadlineTime = new Date(body.deadline).getTime();
  const dailyMinutes = Number(body.dailyMinutes);
  if (
    Number.isNaN(deadlineTime) ||
    deadlineTime <= Date.now() ||
    !Number.isFinite(dailyMinutes) ||
    dailyMinutes < 15 ||
    dailyMinutes > 600 ||
    String(body.goal).length > 500 ||
    String(body.foundation ?? "").length > 2_000 ||
    String(body.weakness ?? "").length > 2_000
  ) {
    return Response.json({ error: "目标、日期或每日时长无效" }, { status: 400 });
  }
  const totalDays = Math.ceil(
    (deadlineTime - Date.now()) / 86_400_000,
  );
  if (totalDays > 90) {
    const entitlement = await getRequestEntitlement(auth.id, req);
    if (!entitlement.pro) {
      return Response.json(
        { error: "超过 90 天的全局长期排期为 Pro 功能" },
        { status: 403 },
      );
    }
  }
  const quota = await consumeAiQuota(auth.id, "decompose", {
    testerMode: isTesterModeRequest(req),
  });
  if (!quota.allowed) {
    return Response.json(
      { error: `今日 AI 拆解次数已用完（免费版每天 ${quota.limit} 次）` },
      { status: 429 },
    );
  }

  // 兜底 workdays，避免 mock/prompt 崩溃
  if (!Array.isArray(body.workdays) || body.workdays.length === 0) {
    body.workdays = ["weekday", "weekend"];
  }

  let content = "";
  try {
    const ai = createAiClient();
    if (!ai) {
      throw new Error("AI client unavailable: missing DeepSeek key and Netlify AI Gateway key");
    }
    const { client, model } = ai;
    const messages = [
      {
        role: "system" as const,
        content:
          "你是任务拆解助手。必须输出合法 JSON 对象。考试目标直接拆到科目/题型/练习动作，禁止输出泛泛的目标管理任务。",
      },
      { role: "user" as const, content: buildPrompt(body) },
    ];
    const baseRequest = {
      model,
      messages,
      temperature: 0.2,
      max_tokens: 2200,
    };

    try {
      const completion = await client.chat.completions.create(
        {
          ...baseRequest,
          response_format: { type: "json_object" },
        },
        { timeout: 7_500 },
      );
      content = completion.choices?.[0]?.message?.content ?? "";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const canRetryWithoutJsonMode =
        /response_format|json_object|unsupported|invalid.*parameter|400/i.test(message) &&
        !/timeout|timed out|abort/i.test(message);

      if (!canRetryWithoutJsonMode) {
        throw err;
      }

      console.warn("AI JSON 模式不可用，降级为普通 JSON 提示:", message);
      const completion = await client.chat.completions.create(baseRequest, {
        timeout: 7_000,
      });
      content = completion.choices?.[0]?.message?.content ?? "";
    }
  } catch (err) {
    console.warn("AI 调用失败，使用场景化兜底:", err instanceof Error ? err.message : err);
    const mockTasks = generateMockTasks(body);
    const finalized = finalizeScheduledTasks(body, mockTasks, null);
    return Response.json({
      tasks: finalized.tasks,
      schedule: finalized.schedule,
      allocatedDailyMinutes: finalized.allocatedDailyMinutes,
      mock: true,
    });
  }

  const parsed = tryParseJson(content);
  const usedRecoveredJson = parsed === null;
  const arr = parsed === null
    ? recoverPartialTaskObjects(content)
    : flattenParsedTasks(parsed);
  const today = localDateStr();
  const defaultSchedule = buildDefaultSchedule(today, body.deadline, body.workdays);
  const aiSchedule = extractScheduleFromParsed(parsed, defaultSchedule);

  if (parsed === null && arr.length === 0) {
    console.warn("AI 返回无法解析为 JSON，使用场景化兜底");
    const mockTasks = generateMockTasks(body);
    const finalized = finalizeScheduledTasks(body, mockTasks, null);
    return Response.json({
      tasks: finalized.tasks,
      schedule: finalized.schedule,
      allocatedDailyMinutes: finalized.allocatedDailyMinutes,
      mock: true,
    });
  }
  let tasks = arr
    .map(sanitizeFullTask)
    .filter((t): t is NonNullable<typeof t> => t !== null);

  if (usedRecoveredJson && tasks.length > 0 && tasks.length < 5) {
    const existingTitles = new Set(tasks.map((task) => task.title));
    const supplements = generateMockTasks(body)
      .filter((task) => !existingTitles.has(task.title))
      .slice(0, 5 - tasks.length);
    tasks = [...tasks, ...supplements];
  }

  if (tasksNeedScenarioFallback(body, tasks)) {
    console.warn("AI 返回任务过于通用，使用场景化兜底");
    const mockTasks = generateMockTasks(body);
    const finalized = finalizeScheduledTasks(body, mockTasks, null);
    return Response.json({
      tasks: finalized.tasks,
      schedule: finalized.schedule,
      allocatedDailyMinutes: finalized.allocatedDailyMinutes,
      mock: true,
    });
  }

  if (tasks.length === 0) {
    const mockTasks = generateMockTasks(body);
    const finalized = finalizeScheduledTasks(body, mockTasks, null);
    return Response.json({
      tasks: finalized.tasks,
      schedule: finalized.schedule,
      allocatedDailyMinutes: finalized.allocatedDailyMinutes,
      mock: true,
    });
  }

  const finalized = finalizeScheduledTasks(body, tasks, aiSchedule);
  if (finalized.tasks.length === 0) {
    const mockTasks = generateMockTasks(body);
    const fallback = finalizeScheduledTasks(body, mockTasks, null);
    return Response.json({
      tasks: fallback.tasks,
      schedule: fallback.schedule,
      allocatedDailyMinutes: fallback.allocatedDailyMinutes,
      mock: true,
    });
  }

  const result: DecomposeResponse = {
    tasks: finalized.tasks,
    schedule: finalized.schedule,
    allocatedDailyMinutes: finalized.allocatedDailyMinutes,
  };
  return Response.json(result);
};

export const config: Config = {
  path: "/api/decompose",
  method: "POST",
};
