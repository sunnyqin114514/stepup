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

export type ScheduleMeta = {
  /** AI 或算法确定的工作日 YYYY-MM-DD */
  workDates: string[];
  /** AI 或算法确定的休息日 YYYY-MM-DD */
  restDates: string[];
  /** 分配给该目标的每日预算（分钟） */
  dailyBudgetMinutes?: number;
};

/**
 * 根据截止期与每日预算，生成「前松后紧」的工作日/休息日。
 * - 短周期（≤14 可执行日）：几乎每天安排
 * - 中周期：约每 5 天休息 1 天
 * - 长周期：约每周休息 1–2 天（优先周末）
 */
export function buildDefaultSchedule(
  start: string,
  deadline: string,
  workdays: WorkdayFlag[] | string[] | undefined,
  options?: { preferWeekendRest?: boolean },
): ScheduleMeta {
  const executable = listExecutableDays(start, deadline, workdays);
  if (executable.length === 0) {
    return { workDates: [start], restDates: [] };
  }

  const preferWeekendRest = options?.preferWeekendRest !== false;
  const restDates: string[] = [];
  const workDates: string[] = [];

  if (executable.length <= 14) {
    // 短冲刺：全部可执行日都是工作日
    return { workDates: [...executable], restDates: [] };
  }

  const restEvery = executable.length <= 45 ? 5 : 4;
  executable.forEach((date, index) => {
    const nearEnd = index >= executable.length - 7;
    const isRestSlot =
      !nearEnd &&
      ((preferWeekendRest && isWeekend(date) && index % restEvery === restEvery - 1) ||
        (!preferWeekendRest && (index + 1) % restEvery === 0) ||
        (preferWeekendRest && isWeekend(date) && (index + 1) % 7 === 0));
    if (isRestSlot && workDates.length > 0) {
      restDates.push(date);
    } else {
      workDates.push(date);
    }
  });

  // 确保至少有一半工作日，且首尾是工作日
  if (workDates.length < Math.ceil(executable.length * 0.55)) {
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

/** 从全量工作日中挑出 count 个锚点日（含首尾），避免任务摊得过稀 */
function pickSpacedDates(dates: string[], count: number): string[] {
  if (count >= dates.length) return dates.slice();
  if (count <= 1) return [dates[0]];
  const picked: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const idx = Math.round((i / (count - 1)) * (dates.length - 1));
    picked.push(dates[idx]);
  }
  return [...new Set(picked)];
}

/**
 * 把任务铺到工作日：先按「需要的天数」抽锚点覆盖全程，再在锚点上顺序填满预算。
 * 避免把少量任务均匀摊到全部工作日造成大片空档。
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
  const deadlineDate = parseLocalDate(deadline);
  const validDates = workDates.filter(
    (d) => parseLocalDate(d).getTime() <= deadlineDate.getTime(),
  );
  if (validDates.length === 0) return tasks;

  const totalMinutes = tasks.reduce(
    (sum, task) =>
      sum + Math.max(15, Math.min(budget, Number(task.suggestedMinutes) || 30)),
    0,
  );
  const daysNeeded = Math.min(
    validDates.length,
    Math.max(tasks.length, Math.ceil(totalMinutes / budget)),
  );
  const packDates = pickSpacedDates(validDates, daysNeeded);
  let cursor = 0;

  return tasks.map((task) => {
    let minutes = Math.max(
      15,
      Math.min(budget, Number(task.suggestedMinutes) || 30),
    );
    let date = packDates[Math.min(cursor, packDates.length - 1)];
    let placed = false;

    // 1) 从当前锚点起向后找能完整放下的一天（顺序填满，不回头摊薄）
    for (let attempt = cursor; attempt < packDates.length; attempt += 1) {
      const candidate = packDates[attempt];
      const already = used[candidate] ?? 0;
      if (already + minutes <= budget) {
        date = candidate;
        used[candidate] = already + minutes;
        cursor = attempt;
        placed = true;
        break;
      }
    }

    // 2) 否则放到剩余容量最大的锚点日，并收缩时长
    if (!placed) {
      let bestDate = packDates[packDates.length - 1];
      let bestRemain = -1;
      for (const candidate of packDates) {
        const remain = budget - (used[candidate] ?? 0);
        if (remain > bestRemain) {
          bestRemain = remain;
          bestDate = candidate;
        }
      }
      date = bestDate;
      if (bestRemain >= 15) {
        minutes = Math.min(minutes, bestRemain);
        used[date] = (used[date] ?? 0) + minutes;
      } else {
        let lightest = packDates[0];
        let lightestUsed = Number.POSITIVE_INFINITY;
        for (const candidate of packDates) {
          const already = used[candidate] ?? 0;
          if (already < lightestUsed) {
            lightestUsed = already;
            lightest = candidate;
          }
        }
        date = lightest;
        used[date] = (used[date] ?? 0) + minutes;
      }
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
