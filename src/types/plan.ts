export type Priority = "high" | "medium" | "low";

/** 循环复盘周期：按目标设置，到期时在复盘页提示 */
export type ReviewCycle = "off" | "daily" | "weekly" | "biweekly";

export const REVIEW_CYCLE_LABELS: Record<ReviewCycle, string> = {
  off: "不设置",
  daily: "每日",
  weekly: "每周",
  biweekly: "每两周",
};

export const REVIEW_CYCLE_DAYS: Record<ReviewCycle, number> = {
  off: 0,
  daily: 1,
  weekly: 7,
  biweekly: 14,
};

export const PRIORITY_LABELS: Record<Priority, string> = {
  high: "高",
  medium: "中",
  low: "低",
};

export type SkipReason =
  | "too_tired"
  | "no_time"
  | "too_hard"
  | "something_came_up"
  | "other";

export const SKIP_REASON_LABELS: Record<SkipReason, string> = {
  too_tired: "太累了",
  no_time: "时间不够",
  too_hard: "任务太难",
  something_came_up: "临时有事",
  other: "其他",
};

export type TaskSource = "goal" | "adhoc";

/** 子步骤：兼容旧 action/guide，同时支持更细的执行结构 */
export type TaskStep = {
  /** 步骤标题：一句话说明要做什么 */
  action: string;
  /** 这个步骤完成后能达成的具体能力/结果 */
  goal?: string;
  /** 建议用时，控制在 15-25 分钟的微动作块内 */
  minutes?: number;
  /** 旧版操作指引，如「1.…；2.…；3.…」 */
  guide?: string;
  /** 按执行顺序排列的微动作清单 */
  microActions?: Array<{
    text: string;
    material?: string;
    sourceRef?: string;
    timeLimit?: string;
  }>;
  /** 本步骤自己的完成判定；任务级 checkCriteria 仍保留 */
  checkCriteria?: string;
  /** 常见卡点和直接解法 */
  blockers?: Array<{
    problem: string;
    solution: string;
  }>;
};

export type TaskItem = {
  id: string;
  date: string; // YYYY-MM-DD 安排日期
  title: string;
  /** 科目/模块，用于学习日和复盘展示 */
  subject?: string;
  description: string;
  /**
   * 结构化执行步骤。兼容旧数据 string[]，
   * 新拆解为 { action, guide }[]
   */
  steps?: Array<string | TaskStep>;
  /** 完成自检标准：用户判定「这项算做完」的可观察条件 */
  checkCriteria?: string;
  suggestedMinutes: number;
  priority: Priority;
  completed: boolean;
  focusSeconds: number;
  /** goal = 来自某大目标；adhoc = 当天临时添加 */
  source?: TaskSource;
  /** 所属大目标 id；临时任务可为空 */
  goalId?: string;
  /** 所属小目标/模块名（可选） */
  subGoal?: string;
  /** 是否从未完成池加入今日 */
  fromBacklog?: boolean;
  /** 用户自述基础与薄弱领域，供拆解和复盘使用 */
  foundation?: string;
  weakness?: string;
  topicTags?: string[];
  priorityReason?: string;
  /** 任务来源说明，如“来自薄弱领域/知识库薄弱点/近期完成率调整” */
  sourceReason?: string;
  /** AI 建议的资料类型或检索词 */
  resourceSuggestions?: string[];
  /** 艾宾浩斯复习间隔（天） */
  reviewIntervals?: number[];
  /** 已绑定知识库资源 id */
  resources?: string[];
};

/** AI/算法生成的工作日与休息日排期 */
export type PlanSchedule = {
  workDates: string[];
  restDates: string[];
  /** 分配给该目标的每日预算（分钟），可能小于用户填写的 dailyMinutes */
  dailyBudgetMinutes?: number;
};

export type Plan = {
  id: string;
  goal: string;
  deadline: string;
  dailyMinutes: number;
  workdays: ("weekday" | "weekend")[];
  /** 循环复盘周期，默认每周 */
  reviewCycle?: ReviewCycle;
  createdAt: string;
  tasks: TaskItem[];
  status?: "active" | "paused" | "done";
  foundation?: string;
  weakness?: string;
  /** 首次拆解或调整日程后的工作日/休息日 */
  schedule?: PlanSchedule;
};

/** 多目标工作区 */
export type Workspace = {
  plans: Plan[];
  /** 规划页当前选中的目标 */
  activePlanId: string | null;
  /** 不挂大目标的临时任务（按 date 排到学习日） */
  adhocTasks: TaskItem[];
};

export type BacklogStatus = "pending" | "cancelled" | "added";

export type BacklogItem = {
  id: string;
  taskId: string;
  title: string;
  description: string;
  suggestedMinutes: number;
  priority: Priority;
  goalId?: string;
  goalTitle?: string;
  subGoal?: string;
  source?: TaskSource;
  originalDate: string;
  sourceDate: string;
  reason: SkipReason;
  note?: string;
  status: BacklogStatus;
  createdAt: string;
};

export type ReviewLog = {
  id: string;
  date: string;
  completedIds: string[];
  unfinishedIds: string[];
  unfinishedTitles: string[];
  reason?: SkipReason;
  difficulty: string;
  focusMinutes: number;
  completedCount: number;
  totalCount: number;
  tomorrowMinutes?: number;
  aiSuggestion?: string;
  action?: "checkin_complete" | "skip_to_backlog" | "manual_note";
};

/** 单条任务的一键 AI 复盘报告（推送到复盘页） */
export type TaskAiReview = {
  id: string;
  taskId: string;
  taskTitle: string;
  goalTitle?: string;
  report: string;
  focusSeconds: number;
  suggestedMinutes: number;
  checkCriteria?: string;
  date: string;
  createdAt: string;
};

export type TaskHelpRequest = {
  question: string;
  taskId: string;
  threadId?: string;
  history?: HelpMessage[];
  task: Pick<
    TaskItem,
    "title" | "description" | "steps" | "checkCriteria" | "suggestedMinutes"
  >;
  goalTitle?: string;
};

export type TaskHelpResponse = {
  answer: string;
  threadId: string;
  messages?: HelpMessage[];
  mock?: boolean;
};

export type HelpMessage = {
  id?: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
};

export type TaskAttemptInput = {
  totalQuestions?: number;
  correctQuestions?: number;
  wrongText?: string;
  moduleData?: Record<string, { total: number; correct: number }>;
  lossReasons?: string[];
};

export type TaskReviewRequest = {
  task: Pick<
    TaskItem,
    | "id"
    | "title"
    | "description"
    | "steps"
    | "checkCriteria"
    | "suggestedMinutes"
    | "focusSeconds"
    | "priority"
    | "topicTags"
  >;
  goalTitle?: string;
  goalId?: string;
  focusSeconds: number;
  attempt: TaskAttemptInput;
  reviewIntervals?: number[];
  reminderTime?: string;
};

export type TaskReviewResponse = {
  report: string;
  reportId: string;
  summary: string;
  strengths: string[];
  weaknesses: string[];
  errorPatterns: string[];
  moduleAccuracy: Record<string, number>;
  lossReasons: string[];
  reinforcementTasks: Array<{
    id: string;
    taskId: string;
    title: string;
    reason: string;
    suggestedMinutes: number;
    scheduledDate: string;
  }>;
  scheduleIds: string[];
  mock?: boolean;
};

export type Achievement = {
  totalFocusMinutes: number;
  streakDays: number;
  milestone25: boolean;
  milestone50: boolean;
  milestone100: boolean;
};

export type DecomposeRequest = {
  goal: string;
  deadline: string;
  dailyMinutes: number;
  workdays: string[];
  foundation: string;
  weakness: string;
  /** 最近学习完成率，0-100 */
  completionRate?: number;
  /** 连续完成天数 */
  streakDays?: number;
  /** 昨日或近期未完成任务标题 */
  unfinishedTasks?: string[];
  /** 知识库重点，第一步先允许为空；后续知识库 AI 提取会填充 */
  knowledgeKeyPoints?: string[];
  /** 知识库薄弱点，第一步先允许为空；后续知识库 AI 提取会填充 */
  weakKnowledgePoints?: string[];
  /** 根据完成率生成的节奏建议 */
  adaptiveHint?: string;
  /** 全局每日总时长上限（多目标共享） */
  globalDailyCap?: number;
  /** 分配给本目标的每日预算 */
  allocatedDailyMinutes?: number;
};

export type DecomposeResponse = {
  tasks: Omit<TaskItem, "id" | "completed" | "focusSeconds">[];
  mock?: boolean;
  schedule?: PlanSchedule;
  /** 本目标实际分配的每日预算 */
  allocatedDailyMinutes?: number;
};

export type ReplanRequest = {
  plan: Plan;
  difficulty: string;
  tomorrowMinutes: number;
  /** 全局每日总时长上限（多目标共享） */
  globalDailyCap?: number;
  /** 分配给当前目标的每日预算 */
  allocatedDailyMinutes?: number;
  /** 其他活跃目标当日已占用分钟（不含本目标） */
  otherGoalsOccupiedMinutes?: number;
  /** 本目标未完成任务摘要 */
  unfinishedSummary?: string[];
  /** 本目标完成率 0-100 */
  goalCompletionRate?: number;
};

export type ReplanResponse = {
  tasks: Omit<TaskItem, "id" | "completed" | "focusSeconds">[];
  suggestion: string;
  mock?: boolean;
  schedule?: PlanSchedule;
};

export type ResourceItem = {
  id: string;
  kind: "pdf" | "file" | "link" | "note";
  title: string;
  sourceUrl?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  tags: string[];
  extractedText: string;
  createdAt: string;
  updatedAt: string;
};

export type ReviewScheduleItem = {
  id: string;
  taskId?: string | null;
  resourceId?: string | null;
  title: string;
  intervals: number[];
  intervalIndex: number;
  dueAt: string;
  reminderTime: string;
  active: boolean;
};

export type StructuredReviewReport = {
  id: string;
  taskId: string;
  goalId?: string | null;
  summary: string;
  strengths: string[];
  weaknesses: string[];
  errorPatterns: string[];
  moduleAccuracy: Record<string, number>;
  lossReasons: string[];
  focusSeconds: number;
  accuracy?: number | null;
  createdAt: string;
};

export type AiResourceExample = {
  question: string;
  answer: string;
  explanation: string;
};

export type AiResourceLink = {
  type: "视频" | "文章" | "练习";
  title: string;
  url: string;
};

export type AiResourceSearchResult = {
  topic: string;
  explanation: string;
  formulas: string[];
  examples: AiResourceExample[];
  commonMistakes: string[];
  resources: AiResourceLink[];
  subject: "数学" | "英语" | "政治" | "专业课" | "其他";
  difficulty: "基础" | "中等" | "进阶";
  error?: string;
};

/** 免费版最多 1 个进行中大目标；Pro 不限 */
export const FREE_ACTIVE_GOAL_LIMIT = 1;
