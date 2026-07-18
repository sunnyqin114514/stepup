import { describe, expect, it } from "vitest";
import { compactPlainText, stripMarkdown } from "./textSanitize";

describe("textSanitize", () => {
  it("去除 Markdown 加粗与标题符号", () => {
    expect(stripMarkdown("**听力精听** 30 分钟")).toBe("听力精听 30 分钟");
    expect(stripMarkdown("## 今日目标\n完成一套题")).toContain("今日目标");
    expect(stripMarkdown("## 今日目标\n完成一套题")).not.toContain("##");
  });

  it("去除列表前缀与多余空白", () => {
    const raw = "- 先热身\n* 再精听\n1. 复述";
    const cleaned = stripMarkdown(raw);
    expect(cleaned).toContain("先热身");
    expect(cleaned).toContain("再精听");
    expect(cleaned).toContain("复述");
    expect(cleaned).not.toMatch(/^[-*]\s/m);
  });

  it("compactPlainText 折叠换行便于卡片展示", () => {
    expect(compactPlainText("A\n\nB\nC", 100)).toBe("A B C");
  });

  it("过滤控制字符", () => {
    expect(stripMarkdown("正常\u0001文本")).toBe("正常文本");
  });

  it("修复常见 mojibake、HTML 实体和替换字符", () => {
    expect(stripMarkdown("ä½ å¥½ &amp; **任务** �")).toBe("你好 & 任务");
    expect(stripMarkdown("＃＃ 今日&nbsp;目标\n＊ 完成")).toBe("今日 目标\n完成");
  });
});
