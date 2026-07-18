/**
 * 本地日期与可执行日排期工具（前后端共用语义；Node 侧可复制或直接 import）。
 */

export type WorkdayFlag = "weekday" | "weekend";

export function localDateStr(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function parseLocalDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function addDays(dateStr: string, days: number): string {
  const d = parseLocalDate(dateStr);
  d.setDate(d.getDate() + days);
  return localDateStr(d);
}

export function isWeekend(dateStr: string): boolean {
  const dow = parseLocalDate(dateStr).getDay();
  return dow === 0 || dow === 6;
}

export function isExecutableDay(
  dateStr: string,
  workdays: WorkdayFlag[] | string[] | undefined,
): boolean {
  const flags =
    Array.isArray(workdays) && workdays.length > 0
      ? workdays
      : (["weekday", "weekend"] as WorkdayFlag[]);
  const weekend = isWeekend(dateStr);
  return (
    (flags.includes("weekday") && !weekend) ||
    (flags.includes("weekend") && weekend)
  );
}

/** 从 start（含）到 end（含）的全部可执行日 */
export function listExecutableDays(
  start: string,
  end: string,
  workdays: WorkdayFlag[] | string[] | undefined,
): string[] {
  const days: string[] = [];
  let cursor = start;
  const endDate = parseLocalDate(end);
  while (parseLocalDate(cursor) <= endDate && days.length < 400) {
    if (isExecutableDay(cursor, workdays)) days.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return days;
}

export function snapToNextExecutableDay(
  dateStr: string,
  workdays: WorkdayFlag[] | string[] | undefined,
  deadline: string,
): string | null {
  let cursor = dateStr;
  const end = parseLocalDate(deadline);
  for (let i = 0; i < 400; i += 1) {
    if (parseLocalDate(cursor) > end) return null;
    if (isExecutableDay(cursor, workdays)) return cursor;
    cursor = addDays(cursor, 1);
  }
  return null;
}

export type ScheduleDayKind = "work" | "rest";

/** 休息强度：标准 / 多休（恢复） / 少休（冲刺） */
export type RestIntensity = "standard" | "recovery" | "sprint";

export type ScheduleMeta = {
  /** AI 或算法确定的工作日 YYYY-MM-DD */
  workDates: string[];
  /** AI 或算法确定的休息日 YYYY-MM-DD */
  restDates: string[];
  /** 分配给该目标的每日预算（分钟） */
  dailyBudgetMinutes?: number;
};

/**
 * 从用户调整指令解析休息强度（调整日程 / 多轮输入共用）。
 */
export function resolveRestIntensity(instruction?: string): RestIntensity {
  const note = String(instruction ?? "").trim();
  if (!note) return "standard";
  if (
    /太累|放慢|减少|轻松|多休息|增加休息|降强|降负|休息多|缓一缓|减压/.test(
      note,
    )
  ) {
    return "recovery";
  }
  if (
    /加强|加量|加速|更拼|冲刺|密集|少休息|取消休息|不休息|加练/.test(note)
  ) {
    return "sprint";
  }
  return "standard";
}

/**
 * 学习/休息周期排期（拆解与重排共用）。
 *
 * 依据分布式练习与恢复节奏的常见建议（spacing / deliberate practice recovery）：
 * - standard：约每 5 个学习日插入 1 个休息日（优先周末），工作日任务仍连续密铺
 * - recovery：约每 3 个学习日 1 休（用户要求放慢/多休息）
 * - sprint：约每 8 个学习日 1 休（用户要求冲刺/少休息）
 * - 起始 2 天与截止前 5 天不安排整日休息，保证开局与冲刺密度
 */
export function buildDefaultSchedule(
  start: string,
  deadline: string,
  workdays: WorkdayFlag[] | string[] | undefined,
  options?: { preferWeekendRest?: boolean; restIntensity?: RestIntensity },
): ScheduleMeta {
  const executable = listExecutableDays(start, deadline, workdays);
  if (executable.length === 0) {
    return { workDates: [start], restDates: [] };
  }

  const preferWeekendRest = options?.preferWeekendRest !== false;
  const intensity = options?.restIntensity ?? "standard";
  const studyPerRest =
    intensity === "recovery" ? 3 : intensity === "sprint" ? 8 : 5;
  const protectTail = Math.min(5, Math.max(2, Math.floor(executable.length * 0.15)));
  const protectHead = Math.min(2, executable.length);

  // 极短周期：仅 recovery 且天数够时插入 1 个中段休息
  if (executable.length <= 7) {
    if (intensity === "recovery" && executable.length >= 5) {
      const mid = executable[Math.floor(executable.length / 2)];
      return {
        workDates: executable.filter((d) => d !== mid),
        restDates: [mid],
      };
    }
    return { workDates: [...executable], restDates: [] };
  }

  const restDates: string[] = [];
  const workDates: string[] = [];
  let studyStreak = 0;

  executable.forEach((date, index) => {
    const inHead = index < protectHead;
    const inTail = index >= executable.length - protectTail;
    if (inHead || inTail || workDates.length === 0) {
      workDates.push(date);
      studyStreak += 1;
      return;
    }

    // 攒满学习日后插入休息：优先周末；再等 2 天仍无周末则强制休一天
    const due = studyStreak >= studyPerRest;
    const weekendPreferOk = !preferWeekendRest || isWeekend(date);
    const forceRest = studyStreak >= studyPerRest + 2;
    if (due && (weekendPreferOk || forceRest)) {
      restDates.push(date);
      studyStreak = 0;
      return;
    }

    workDates.push(date);
    studyStreak += 1;
  });

  // 工作日过少则回退：保证密度，不以过度休息牺牲覆盖
  const minWorkRatio =
    intensity === "recovery" ? 0.5 : intensity === "sprint" ? 0.75 : 0.62;
  if (workDates.length < Math.ceil(executable.length * minWorkRatio)) {
    return { workDates: [...executable], restDates: [] };
  }

  if (!workDates.includes(executable[0])) {
    workDates.unshift(executable[0]);
    const ri = restDates.indexOf(executable[0]);
    if (ri >= 0) restDates.splice(ri, 1);
  }
  const last = executable[executable.length - 1];
  if (!workDates.includes(last)) {
    workDates.push(last);
    const ri = restDates.indexOf(last);
    if (ri >= 0) restDates.splice(ri, 1);
  }

  workDates.sort();
  restDates.sort();
  return { workDates, restDates };
}

/** 相邻工作日日历间隔超过 maxGapDays 则视为稀松（会在时间线造成 8/1→8/21） */
export function isSparseDateList(dates: string[], maxGapDays = 4): boolean {
  const sorted = [...new Set(dates.filter(Boolean))].sort();
  if (sorted.length <= 1) return false;
  for (let i = 1; i < sorted.length; i += 1) {
    const gapMs =
      parseLocalDate(sorted[i]).getTime() - parseLocalDate(sorted[i - 1]).getTime();
    const gapDays = gapMs / (24 * 60 * 60 * 1000);
    if (gapDays > maxGapDays) return true;
  }
  return false;
}

/**
 * 按实际任务日期收紧 schedule，去掉任务区间外的孤立休息日（避免时间线只剩远处休息日再跳任务）。
 */
export function tightenScheduleToTasks(
  schedule: ScheduleMeta,
  taskDates: string[],
): ScheduleMeta {
  const dates = [...new Set(taskDates.filter(Boolean))].sort();
  if (dates.length === 0) return schedule;
  const first = dates[0];
  const last = dates[dates.length - 1];
  const workSet = new Set([
    ...schedule.workDates.filter((d) => d >= first && d <= last),
    ...dates,
  ]);
  const restDates = schedule.restDates.filter(
    (d) => d >= first && d <= last && !workSet.has(d),
  );
  return {
    ...schedule,
    workDates: [...workSet].sort(),
    restDates,
  };
}

/**
 * 把任务从起始日顺序填到工作日。
 * 任务数接近工作日数时优先「一天 1 个」，避免一天塞 2 个导致只铺到周期一半（如截止 8/20 却停在 8/5）。
 */
export function distributeTasksToWorkDates<
  T extends { date: string; suggestedMinutes: number },
>(
  tasks: T[],
  workDates: string[],
  dailyBudget: number,
  deadline: string,
): T[] {
  if (workDates.length === 0 || tasks.length === 0) return tasks;
  const budget = Math.max(15, Math.round(dailyBudget));
  const used: Record<string, number> = {};
  const countOnDate: Record<string, number> = {};
  const deadlineDate = parseLocalDate(deadline);
  const validDates = workDates.filter(
    (d) => parseLocalDate(d).getTime() <= deadlineDate.getTime(),
  );
  if (validDates.length === 0) return tasks;

  // 全程工作日都可铺，才能铺到截止日期附近
  const packDates = validDates;
  // 任务够多时一天一个；即便偏少也尽量一天一个拉满跨度（避免挤在前半段）
  const preferOnePerDay = tasks.length >= Math.ceil(packDates.length * 0.55);
  let cursor = 0;

  return tasks.map((task) => {
    let minutes = Math.max(
      15,
      Math.min(budget, Number(task.suggestedMinutes) || 30),
    );
    minutes = preferOnePerDay
      ? Math.min(minutes, Math.max(30, Math.round(budget * 0.7)))
      : Math.min(minutes, Math.max(25, Math.round(budget * 0.55)));

    let date = packDates[Math.min(cursor, packDates.length - 1)];
    let placed = false;

    const tryPlace = (from: number, onePerDay: boolean): boolean => {
      for (let attempt = from; attempt < packDates.length; attempt += 1) {
        const candidate = packDates[attempt];
        const already = used[candidate] ?? 0;
        const count = countOnDate[candidate] ?? 0;
        if (onePerDay && count >= 1) continue;
        if (already + minutes <= budget) {
          date = candidate;
          used[candidate] = already + minutes;
          countOnDate[candidate] = count + 1;
          cursor = attempt;
          return true;
        }
      }
      return false;
    };

    // 1) 优先一天一个向前铺
    placed = tryPlace(cursor, preferOnePerDay);
    // 2) 天数用尽后才允许同日第 2 个
    if (!placed && preferOnePerDay) {
      placed = tryPlace(0, false);
    }
    if (!placed) {
      placed = tryPlace(cursor, false);
    }

    if (!placed) {
      let bestDate = packDates[packDates.length - 1];
      let bestRemain = -1;
      for (let i = packDates.length - 1; i >= 0; i -= 1) {
        const candidate = packDates[i];
        const remain = budget - (used[candidate] ?? 0);
        if (remain > bestRemain) {
          bestRemain = remain;
          bestDate = candidate;
        }
      }
      date = bestDate;
      if (bestRemain >= 15) {
        minutes = Math.min(minutes, bestRemain);
      }
      used[date] = (used[date] ?? 0) + minutes;
      countOnDate[date] = (countOnDate[date] ?? 0) + 1;
    }

    return { ...task, date, suggestedMinutes: minutes };
  });
}

/**
 * 多目标全局每日预算分配：按截止紧迫度加权，保底每个目标至少 20% 或 30 分钟。
 */
export function allocateGlobalDailyBudgets(
  goals: Array<{ id: string; deadline: string; dailyMinutes: number }>,
  globalDailyCap: number,
): Record<string, number> {
  const cap = Math.max(30, Math.round(globalDailyCap));
  if (goals.length === 0) return {};
  if (goals.length === 1) {
    return { [goals[0].id]: Math.min(cap, goals[0].dailyMinutes || cap) };
  }

  const today = localDateStr();
  const weights = goals.map((g) => {
    const days = Math.max(
      1,
      Math.ceil(
        (parseLocalDate(g.deadline).getTime() - parseLocalDate(today).getTime()) /
          86_400_000,
      ),
    );
    // 越临近截止权重越高
    const urgency = 1 / Math.sqrt(days);
    const asked = Math.max(30, Number(g.dailyMinutes) || 60);
    return { id: g.id, weight: urgency * asked, asked };
  });
  const totalWeight = weights.reduce((s, w) => s + w.weight, 0) || 1;
  const floor = Math.max(
    15,
    Math.min(30, Math.floor(cap / (goals.length * 2))),
  );
  const result: Record<string, number> = {};
  for (const w of weights) {
    result[w.id] = Math.max(
      floor,
      Math.min(w.asked, Math.round((w.weight / totalWeight) * cap)),
    );
  }
  // 超分配时按比例收缩，再用逐分钟削峰保证总和 ≤ cap
  let assigned = Object.values(result).reduce((s, n) => s + n, 0);
  if (assigned > cap) {
    const scale = cap / assigned;
    for (const id of Object.keys(result)) {
      result[id] = Math.max(1, Math.round(result[id] * scale));
    }
    assigned = Object.values(result).reduce((s, n) => s + n, 0);
    while (assigned > cap) {
      const heaviest = Object.keys(result).sort(
        (a, b) => result[b] - result[a],
      )[0];
      if (!heaviest || result[heaviest] <= 1) break;
      result[heaviest] -= 1;
      assigned -= 1;
    }
  }
  return result;
}
