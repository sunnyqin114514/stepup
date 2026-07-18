import { describe, expect, it } from "vitest";
import {
  isPrivateIp,
  nextReviewDate,
  normalizeIntervals,
  validateUpload,
} from "./resourceValidation";

describe("复习周期算法", () => {
  it("清洗、排序并去重复习间隔", () => {
    expect(normalizeIntervals([30, "7", 3, 7, -1, 999])).toEqual([3, 7, 30]);
  });

  it("记得进入下一周期，模糊减半，忘了次日重启", () => {
    const now = new Date("2026-07-17T12:00:00Z");
    expect(nextReviewDate(now, [3, 7, 14, 30], 0, "remember").dueAt.toISOString()).toBe(
      "2026-07-24T12:00:00.000Z",
    );
    expect(nextReviewDate(now, [3, 7, 14, 30], 1, "fuzzy").dueAt.toISOString()).toBe(
      "2026-07-21T12:00:00.000Z",
    );
    expect(nextReviewDate(now, [3, 7, 14, 30], 3, "forgot").dueAt.toISOString()).toBe(
      "2026-07-18T12:00:00.000Z",
    );
  });
});

describe("资源输入安全校验", () => {
  it("拒绝私网与回环地址", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("10.1.2.3")).toBe(true);
    expect(isPrivateIp("192.168.0.1")).toBe(true);
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
  });

  it("执行扩展名、MIME 与 5MB 限制", () => {
    expect(validateUpload({ name: "note.md", type: "text/markdown", size: 100 })).toBeNull();
    expect(validateUpload({ name: "run.exe", type: "application/octet-stream", size: 100 })).toContain(
      "仅支持",
    );
    expect(validateUpload({ name: "large.pdf", type: "application/pdf", size: 6 * 1024 * 1024 })).toContain(
      "5MB",
    );
  });
});
