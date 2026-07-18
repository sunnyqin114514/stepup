import type { Config } from "@netlify/functions";
import type { TaskHelpRequest, TaskHelpResponse } from "../../src/types/plan";
import { checkOrigin, createAiClient } from "./_shared/aiClient";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db";
import { helpMessages, helpThreads, tasks } from "../../db/schema";
import { createId, isAuthResponse, requireUser } from "./_shared/auth";

function formatSteps(steps: TaskHelpRequest["task"]["steps"]): string {
  if (!steps?.length) return "（无）";
  return steps
    .map((s, i) => {
      if (typeof s === "string") return `${i + 1}. ${s}`;
      return `${i + 1}. ${s.action}${s.guide ? `\n   指引：${s.guide}` : ""}`;
    })
    .join("\n");
}

function mockAnswer(req: TaskHelpRequest): string {
  const q = req.question.trim() || "怎么开始";
  const mins = req.task.suggestedMinutes || 30;
  return [
    `针对「${req.task.title}」，按你的问题「${q}」分步如下：`,
    `1. 先确认材料：打开与本任务相关的文件/网页，没有就新建一个空白文档命名为任务名。`,
    `2. 设定时器 ${mins} 分钟，只做当前任务标题里的动作，中途不切无关软件。`,
    `3. 按步骤列表从上到下执行；卡住超过 8 分钟，记下卡点原文再换最小可行动作。`,
    `4. 对照自检标准「${req.task.checkCriteria || "留下可核对产出"}」勾选是否达标。`,
    `5. 达标后打勾完成；未达标只补缺口，不要重做整项。`,
  ].join("\n");
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  if (!checkOrigin(req)) {
    return new Response("Forbidden", { status: 403 });
  }
  const auth = await requireUser();
  if (isAuthResponse(auth)) return auth;

  let body: TaskHelpRequest;
  try {
    body = (await req.json()) as TaskHelpRequest;
  } catch {
    return Response.json({ error: "无效的请求体" }, { status: 400 });
  }

  const question = String(body.question ?? "").trim();
  if (!question) {
    return Response.json({ error: "请先输入问题" }, { status: 400 });
  }
  if (!body.task?.title?.trim()) {
    return Response.json({ error: "缺少任务信息" }, { status: 400 });
  }
  const taskId = String(body.taskId ?? "").trim();
  if (!taskId) return Response.json({ error: "缺少任务 id" }, { status: 400 });

  let threadId = String(body.threadId ?? "").trim();
  let history: Array<{ role: "user" | "assistant"; content: string }> = [];
  try {
    const [ownedTask] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.userId, auth.id)))
      .limit(1);
    if (!ownedTask) return Response.json({ error: "任务不存在或不属于当前用户" }, { status: 404 });
    if (threadId) {
      const [thread] = await db
        .select()
        .from(helpThreads)
        .where(and(eq(helpThreads.id, threadId), eq(helpThreads.userId, auth.id)))
        .limit(1);
      if (!thread) return Response.json({ error: "问答线程不存在" }, { status: 404 });
      if (thread.taskId !== taskId) {
        return Response.json({ error: "问答线程与任务不匹配" }, { status: 400 });
      }
      const stored = await db
        .select()
        .from(helpMessages)
        .where(and(eq(helpMessages.threadId, threadId), eq(helpMessages.userId, auth.id)))
        .orderBy(asc(helpMessages.createdAt));
      history = stored.map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content,
      }));
    } else {
      threadId = createId("thread");
      await db.insert(helpThreads).values({
        id: threadId,
        userId: auth.id,
        taskId,
        title: body.task.title.slice(0, 160),
      });
    }
    await db.insert(helpMessages).values({
      id: createId("message"),
      userId: auth.id,
      threadId,
      role: "user",
      content: question,
    });
  } catch (error) {
    console.error("保存问答线程失败，拒绝生成不可追踪回答", error);
    return Response.json({ error: "问答记录保存失败，请重试" }, { status: 500 });
  }

  const prompt = `你是执行教练。用户正在做一项具体任务，请针对他的问题给出分步教学。
适配任意场景（考试/工作/技能/项目），禁止套用固定学科模板。

【大目标】${body.goalTitle || "未绑定"}
【任务】${body.task.title}
【说明】${body.task.description || "无"}
【建议时长】${body.task.suggestedMinutes} 分钟
【自检标准】${body.task.checkCriteria || "无"}
【已有步骤】
${formatSteps(body.task.steps)}

【用户问题】${question}

要求：
1. 只回答当前这条任务，给 4-6 个编号步骤
2. 每步可立刻执行（工具、时长、产出物写清楚）
3. 语言简洁，不要客套，不要输出 JSON`;

  try {
    const { client, model } = createAiClient();
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: "你是任务执行教练，只输出分步教学正文。" },
        ...history.slice(-10),
        { role: "user", content: prompt },
      ],
      temperature: 0.4,
      max_tokens: 800,
    });
    const answer =
      completion.choices?.[0]?.message?.content?.trim() || mockAnswer(body);
    const result: TaskHelpResponse = { answer, threadId };
    try {
      await db.insert(helpMessages).values({
        id: createId("message"),
        userId: auth.id,
        threadId,
        role: "assistant",
        content: answer,
      });
    } catch (error) {
      console.error("保存 AI 回答失败", error);
      return Response.json({ error: "回答生成成功但保存失败，请重试" }, { status: 500 });
    }
    return Response.json({ ...result, threadId });
  } catch (err) {
    console.warn(
      "task-help AI 失败，mock 兜底:",
      err instanceof Error ? err.message : err
    );
    const answer = mockAnswer(body);
    try {
      await db.insert(helpMessages).values({
        id: createId("message"),
        userId: auth.id,
        threadId,
        role: "assistant",
        content: answer,
      });
    } catch (saveError) {
      console.error("保存兜底回答失败", saveError);
      return Response.json({ error: "问答保存失败，请重试" }, { status: 500 });
    }
    return Response.json({ answer, threadId, mock: true });
  }
};

export const config: Config = {
  path: "/api/task-help",
  method: "POST",
};
