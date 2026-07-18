/**
 * 清洗 AI 返回文本：去掉 Markdown 装饰、控制字符，保留可读纯文本。
 */

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
};

function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    const key = entity.toLowerCase();
    if (key.startsWith("#x")) {
      const codePoint = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (key.startsWith("#")) {
      const codePoint = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return HTML_ENTITIES[key] ?? match;
  });
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function decodeLatin1Utf8(input: string): string | null {
  if (typeof TextDecoder === "undefined") return null;
  const bytes: number[] = [];
  for (const char of input) {
    const code = char.charCodeAt(0);
    if (code > 255) return null;
    bytes.push(code);
  }
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

function repairMojibake(input: string): string {
  if (!/[ÃÂâäåæçèéêëìíîïðñòóôõöøùúûüýÿ�]/i.test(input)) {
    return input;
  }
  return input.replace(/[\u00A0-\u00FF]{2,}/g, (segment) => {
    const decoded = decodeLatin1Utf8(segment);
    if (!decoded || decoded === segment) return segment;

    const beforeCjk = countMatches(segment, /[\u3400-\u9FFF]/g);
    const afterCjk = countMatches(decoded, /[\u3400-\u9FFF]/g);
    const beforeBad = countMatches(segment, /[ÃÂâäåæçèéêëìíîïðñòóôõöøùúûüýÿ�]/gi);
    const afterBad = countMatches(decoded, /[ÃÂâäåæçèéêëìíîïðñòóôõöøùúûüýÿ�]/gi);
    const beforeReplacement = countMatches(segment, /�/g);
    const afterReplacement = countMatches(decoded, /�/g);

    if (
      afterReplacement <= beforeReplacement &&
      (afterCjk > beforeCjk || afterBad < beforeBad)
    ) {
      return decoded;
    }
    return segment;
  });
}

export function stripMarkdown(input: unknown): string {
  let text = String(input ?? "");
  text = repairMojibake(decodeHtmlEntities(text));
  text = text.replace(/[＃＊＿｀＞]/g, (char) => {
    const map: Record<string, string> = {
      "＃": "#",
      "＊": "*",
      "＿": "_",
      "｀": "`",
      "＞": ">",
    };
    return map[char] ?? char;
  });
  // 去掉不可见控制字符（保留换行与制表）
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  // 去掉解码失败的替换字符
  text = text.replace(/\uFFFD+/g, "");
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
