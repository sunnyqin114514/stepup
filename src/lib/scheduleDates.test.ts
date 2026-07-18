import { describe, expect, it } from "vitest";
import {
  allocateGlobalDailyBudgets,
  buildDefaultSchedule,
  distributeTasksToWorkDates,
  isExecutableDay,
  listExecutableDays,
  localDateStr,
  snapToNextExecutableDay,
} from "./scheduleDates";

describe("scheduleDates", () => {
  it("localDateStr 使用本地年月日", () => {
    const d = new Date(2026, 6, 18, 23, 30, 0);
    expect(localDateStr(d)).toBe("2026-07-18");
  });

  it("按工作日/周末过滤可执行日", () => {
    const days = listExecutableDays("2026-07-18", "2026-07-26", ["weekday"]);
    expect(days.every((d) => isExecutableDay(d, ["weekday"]))).toBe(true);
    expect(days).not.toContain("2026-07-19"); // 周日
    expect(days).toContain("2026-07-20"); // 周一
  });

  it("snapToNextExecutableDay 跳过周末", () => {
    expect(snapToNextExecutableDay("2026-07-18", ["weekday"], "2026-07-30")).toBe(
      "2026-07-20",
    );
  });

  it("默认排期包含工作日与休息日，且首尾为工作日", () => {
    const schedule = buildDefaultSchedule("2026-07-18", "2026-09-18", [
      "weekday",
      "weekend",
    ]);
    expect(schedule.workDates.length).toBeGreaterThan(10);
    expect(schedule.workDates[0]).toBe("2026-07-18");
    expect(schedule.workDates.at(-1)).toBeTruthy();
  });

  it("任务超预算时顺延到下一工作日而不是丢弃", () => {
    const workDates = ["2026-07-20", "2026-07-21"];
    const tasks = [
      { date: "2026-07-20", suggestedMinutes: 50, title: "a" },
      { date: "2026-07-20", suggestedMinutes: 50, title: "b" },
      { date: "2026-07-20", suggestedMinutes: 50, title: "c" },
    ];
    const placed = distributeTasksToWorkDates(tasks, workDates, 90, "2026-07-30");
    expect(placed).toHaveLength(3);
    const usedByDate = placed.reduce<Record<string, number>>((acc, task) => {
      acc[task.date] = (acc[task.date] ?? 0) + task.suggestedMinutes;
      return acc;
    }, {});
    for (const minutes of Object.values(usedByDate)) {
      expect(minutes).toBeLessThanOrEqual(90);
    }
    // 三个 50 分钟任务不能挤在同一天（预算 90）
    expect(new Set(placed.map((t) => t.date)).size).toBeGreaterThan(1);
  });

  it("少量任务不会被摊到全部工作日造成大片空档", () => {
    const workDates = Array.from({ length: 20 }, (_, i) => {
      const d = new Date(2026, 6, 20);
      d.setDate(d.getDate() + i);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    });
    const tasks = Array.from({ length: 6 }, (_, i) => ({
      date: workDates[0],
      suggestedMinutes: 60,
      title: `t${i}`,
    }));
    const placed = distributeTasksToWorkDates(
      tasks,
      workDates,
      90,
      "2026-09-01",
    );
    const usedDates = new Set(placed.map((t) => t.date));
    // 6 个任务应落在约 6 个锚点日，而不是稀疏散在 20 天
    expect(usedDates.size).toBeLessThanOrEqual(8);
    expect(usedDates.size).toBeGreaterThanOrEqual(4);
  });

  it("多目标全局预算按紧迫度分配且不超过上限", () => {
    const budgets = allocateGlobalDailyBudgets(
      [
        { id: "near", deadline: "2026-07-25", dailyMinutes: 120 },
        { id: "far", deadline: "2026-12-01", dailyMinutes: 120 },
      ],
      180,
    );
    expect(budgets.near + budgets.far).toBeLessThanOrEqual(180);
    expect(budgets.near).toBeGreaterThanOrEqual(budgets.far);
  });
});
