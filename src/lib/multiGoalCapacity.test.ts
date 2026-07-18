import { describe, expect, it } from "vitest";
import { allocateGlobalDailyBudgets } from "./scheduleDates";

describe("多目标容量互不污染", () => {
  it("两个目标共享全局上限，近截止者获得更多预算", () => {
    const budgets = allocateGlobalDailyBudgets(
      [
        {
          id: "ielts",
          deadline: "2026-08-01",
          dailyMinutes: 150,
        },
        {
          id: "side",
          deadline: "2026-12-01",
          dailyMinutes: 120,
        },
      ],
      180,
    );

    expect(budgets.ielts).toBeGreaterThan(0);
    expect(budgets.side).toBeGreaterThan(0);
    expect(budgets.ielts + budgets.side).toBeLessThanOrEqual(180);
    expect(budgets.ielts).toBeGreaterThanOrEqual(budgets.side);
  });

  it("单目标时预算不超过全局上限与自身需求", () => {
    const budgets = allocateGlobalDailyBudgets(
      [{ id: "only", deadline: "2026-09-01", dailyMinutes: 90 }],
      180,
    );
    expect(budgets.only).toBeLessThanOrEqual(90);
  });
});
