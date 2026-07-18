import type { Config } from "@netlify/functions";
import type { AiResourceSearchResult } from "../../src/types/plan";
import { checkOrigin, createAiClient } from "./_shared/aiClient";
import { isAuthResponse, requireUser } from "./_shared/auth";

const SUBJECTS = ["数学", "英语", "政治", "专业课", "其他"] as const;
const DIFFICULTIES = ["基础", "中等", "进阶"] as const;

function detectSubject(query: string): AiResourceSearchResult["subject"] {
  if (/数学|微积分|极限|导数|积分|函数|概率|线性代数|几何/.test(query)) return "数学";
  if (/英语|阅读|写作|听力|词汇|语法|雅思|托福/.test(query)) return "英语";
  if (/政治|马原|毛概|思修|史纲|时政/.test(query)) return "政治";
  if (/专业|计算机|医学|法律|经济|会计|工程/.test(query)) return "专业课";
  return "其他";
}

function fallbackResult(query: string): AiResourceSearchResult {
  const encoded = encodeURIComponent(query);
  const subject = detectSubject(query);
  return {
    topic: query,
    explanation:
      `${query} 是当前学习目标中的一个关键知识点。建议先用自己的话写出定义，再找 2-3 个典型例子验证理解，最后通过练习题检查是否能独立应用。学习时不要只背结论，要同时记录适用条件、常见变形和容易混淆的边界情况。`,
    formulas: ["先整理定义/条件/结论三栏", "练习记录：正确率 = 正确题数 / 总题数"],
    examples: [
      {
        question: `请用自己的话解释「${query}」，并举一个最简单的例子。`,
        answer: "答案应包含定义、适用条件和一个具体例子。",
        explanation: "先写定义，再补充什么时候能用，最后用一个小例子检验是否真的理解。",
      },
      {
        question: `做一道与「${query}」相关的基础题，并标出解题依据。`,
        answer: "依据清晰、步骤完整即可视为掌握基础。",
        explanation: "重点不是题目难度，而是能否说清每一步为什么成立。",
      },
    ],
    commonMistakes: ["只背结论，不看适用条件", "例题能看懂，换个问法就不会做", "错题没有记录失分原因"],
    resources: [
      {
        type: "视频",
        title: `${query} 视频讲解搜索`,
        url: `https://www.youtube.com/results?search_query=${encoded}`,
      },
      {
        type: "文章",
        title: `${query} 文章资料搜索`,
        url: `https://www.google.com/search?q=${encoded}`,
      },
      {
        type: "练习",
        title: `${query} 练习题搜索`,
        url: `https://www.google.com/search?q=${encoded}%20%E7%BB%83%E4%B9%A0%E9%A2%98`,
      },
    ],
    subject,
    difficulty: "基础",
  };
}

function sanitize(raw: unknown, query: string): AiResourceSearchResult {
  const fallback = fallbackResult(query);
  if (!raw || typeof raw !== "object") return fallback;
  const value = raw as Record<string, unknown>;
  if (value.error) return { ...fallback, error: String(value.error).slice(0, 80) };
  const subject = SUBJECTS.includes(value.subject as AiResourceSearchResult["subject"])
    ? (value.subject as AiResourceSearchResult["subject"])
    : fallback.subject;
  const difficulty = DIFFICULTIES.includes(value.difficulty as AiResourceSearchResult["difficulty"])
    ? (value.difficulty as AiResourceSearchResult["difficulty"])
    : fallback.difficulty;
  const examples = Array.isArray(value.examples)
    ? value.examples
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const example = item as Record<string, unknown>;
          return {
            question: String(example.question ?? "").trim().slice(0, 500),
            answer: String(example.answer ?? "").trim().slice(0, 500),
            explanation: String(example.explanation ?? "").trim().slice(0, 1_000),
          };
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item?.question))
        .slice(0, 3)
    : fallback.examples;
  const resources = Array.isArray(value.resources)
    ? value.resources
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const resource = item as Record<string, unknown>;
          const type = ["视频", "文章", "练习"].includes(String(resource.type))
            ? (String(resource.type) as AiResourceSearchResult["resources"][number]["type"])
            : "文章";
          const url = String(resource.url ?? "").trim();
          if (!/^https?:\/\//i.test(url)) return null;
          return {
            type,
            title: String(resource.title ?? `${query} 资料`).trim().slice(0, 120),
            url,
          };
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
        .slice(0, 3)
    : fallback.resources;
  return {
    topic: String(value.topic ?? query).trim().slice(0, 120) || query,
    explanation: String(value.explanation ?? fallback.explanation).trim().slice(0, 500),
    formulas: Array.isArray(value.formulas)
      ? value.formulas.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 6)
      : fallback.formulas,
    examples: examples.length ? examples : fallback.examples,
    commonMistakes: Array.isArray(value.commonMistakes)
      ? value.commonMistakes.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 5)
      : fallback.commonMistakes,
    resources: resources.length ? resources : fallback.resources,
    subject,
    difficulty,
  };
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  if (!checkOrigin(req)) return new Response("Forbidden", { status: 403 });
  const auth = await requireUser();
  if (isAuthResponse(auth)) return auth;

  try {
    const body = (await req.json()) as { query?: unknown };
    const query = String(body.query ?? "").trim();
    if (!query) return Response.json({ error: "请输入知识点" }, { status: 400 });
    if (query.length > 120) return Response.json({ error: "知识点不能超过 120 字" }, { status: 400 });

    const prompt = `你是一个备考资料检索助手。请联网搜索以下知识点的详细学习资料并整理返回。

【搜索知识点】${query}

请搜索并整理以下内容，用 JSON 格式返回：
{
  "topic": "知识点名称",
  "explanation": "用通俗语言解释这个知识点，300字以内，适合大学生理解",
  "formulas": ["核心公式1", "核心公式2"],
  "examples": [
    {"question": "例题题目", "answer": "答案", "explanation": "解题思路和过程"}
  ],
  "commonMistakes": ["易错点1", "易错点2", "易错点3"],
  "resources": [
    {"type": "视频", "title": "资源标题", "url": "链接"},
    {"type": "文章", "title": "资源标题", "url": "链接"},
    {"type": "练习", "title": "资源标题", "url": "链接"}
  ],
  "subject": "科目分类（数学/英语/政治/专业课/其他）",
  "difficulty": "难度等级（基础/中等/进阶）"
}

要求：
1. explanation 必须通俗易懂，不要用太学术的语言。
2. examples 给 2-3 道典型例题，必须附答案和解题过程。
3. commonMistakes 给 2-3 个学生最容易犯的错。
4. resources 给 3 个真实可访问的学习资源链接，必须是 http/https。
5. 如果找不到对应资料，返回 {"error": "未找到相关资料"}。
只输出 JSON，不要解释。`;

    try {
      const ai = createAiClient();
      if (!ai) {
        throw new Error("AI client unavailable: missing DeepSeek key and Netlify AI Gateway key");
      }
      const { client, model } = ai;
      const completion = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: "你是结构化学习资料整理助手，只输出合法 JSON。" },
          { role: "user", content: prompt },
        ],
        temperature: 0.25,
        max_tokens: 1800,
        response_format: { type: "json_object" },
      });
      const content = completion.choices?.[0]?.message?.content ?? "";
      return Response.json(sanitize(JSON.parse(content), query));
    } catch (error) {
      console.error("AI 资料搜索失败，使用兜底资料", error);
      return Response.json({ ...fallbackResult(query), mock: true });
    }
  } catch (error) {
    console.error("AI 资料搜索处理失败", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "资料搜索失败" },
      { status: 500 },
    );
  }
};

export const config: Config = {
  path: "/api/ai-resource-search",
  method: "POST",
};
