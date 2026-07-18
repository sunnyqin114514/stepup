/**
 * 清洗 AI 返回文本：去掉 Markdown 装饰、控制字符，保留可读纯文本。
 */

export function stripMarkdown(input: unknown): string {
  let text = String(input ?? "");
  // 去掉不可见控制字符（保留换行与制表）
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  // 代码块与行内代码
  text = text.replace(/```[\s\S]*?```/g, (block) =>
    block.replace(/^```(?:\w+)?\s*/i, "").replace(/\s*```$/, ""),
  );
  text = text.replace(/`([^`]+)`/g, "$1");
  // 加粗/斜体
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");
  text = text.replace(/\*([^*\n]+)\*/g, "$1");
  text = text.replace(/_([^_\n]+)_/g, "$1");
  // 标题、引用、列表前缀
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  text = text.replace(/^\s{0,3}>\s?/gm, "");
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+\.\s+/gm, "");
  // 链接与图片
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // 残留孤立 ** / __
  text = text.replace(/\*{1,3}/g, "");
  text = text.replace(/_{1,3}/g, "");
  // 空白归一
  text = text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

export function compactPlainText(input: unknown, maxLength: number): string {
  const cleaned = stripMarkdown(input).replace(/\s+/g, " ").trim();
  return cleaned.slice(0, maxLength);
}
