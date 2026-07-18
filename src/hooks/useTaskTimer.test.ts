import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { computeElapsed } from "./useTaskTimer";

function remainingSeconds(
  suggestedMinutes: number,
  elapsedSeconds: number,
): number {
  const total = Math.max(0, suggestedMinutes) * 60;
  return Math.max(0, total - elapsedSeconds);
}

describe("计时核心：正计时不重复累计", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T10:00:00"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("运行中 elapsed = base + (now - startedAt)", () => {
    const startedAt = Date.now();
    vi.advanceTimersByTime(5000);
    expect(computeElapsed(10, startedAt, "running", Date.now())).toBe(15);
  });

  it("暂停后只固化一次，刷新不会二次叠加", () => {
    const startedAt = Date.now();
    vi.advanceTimersByTime(8000);
    const elapsed = computeElapsed(0, startedAt, "running", Date.now());
    expect(elapsed).toBe(8);

    // 暂停：固化到 base，startedAt 清空
    const base = elapsed;
    vi.advanceTimersByTime(10000);
    expect(computeElapsed(base, null, "paused", Date.now())).toBe(8);

    // 恢复：以 base 为起点，再叠加新会话
    const resumeAt = Date.now();
    vi.advanceTimersByTime(3000);
    expect(computeElapsed(base, resumeAt, "running", Date.now())).toBe(11);
  });

  it("倒计时显示剩余时间并在到 0 时结束", () => {
    const suggestedMinutes = 1;
    const startedAt = Date.now();
    vi.advanceTimersByTime(45000);
    const elapsed = computeElapsed(0, startedAt, "running", Date.now());
    expect(remainingSeconds(suggestedMinutes, elapsed)).toBe(15);

    vi.advanceTimersByTime(20000);
    const done = computeElapsed(0, startedAt, "running", Date.now());
    expect(remainingSeconds(suggestedMinutes, done)).toBe(0);
  });
});
