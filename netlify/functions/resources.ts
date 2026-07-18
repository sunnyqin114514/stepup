import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { load } from "cheerio";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { createRequire } from "node:module";
import { db } from "../../db";
import { resources, taskResources, tasks } from "../../db/schema";
import { createId, getEntitlement, isAuthResponse, requireUser } from "./_shared/auth";
import { validatePublicUrl, validateUpload } from "./_shared/resourceValidation";

// 直接加载 lib，避免 pdf-parse 入口在某些打包环境下误跑测试脚本导致 500
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse/lib/pdf-parse.js") as (
  data: Buffer,
) => Promise<{ text?: string }>;

const store = getStore({ name: "stepup-resources", consistency: "strong" });
const FREE_RESOURCE_LIMIT = 5;
const MAX_WEB_BYTES = 1024 * 1024;

function tagsFrom(value: FormDataEntryValue | null): string[] {
  return String(value ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 12);
}

async function fetchPublicPage(raw: string): Promise<{ url: string; title: string; text: string }> {
  let url = await validatePublicUrl(raw);
  for (let redirect = 0; redirect < 4; redirect += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: "manual",
        headers: { "User-Agent": "StepUpResourceReader/1.0" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      console.error("网页资源抓取失败", error);
      throw new Error("网页读取失败");
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("网页重定向无目标");
      url = await validatePublicUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) throw new Error(`网页返回 ${response.status}`);
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
      throw new Error("网页内容类型不受支持");
    }
    const declaredSize = Number(response.headers.get("content-length") ?? 0);
    if (declaredSize > MAX_WEB_BYTES) throw new Error("网页正文超过 1MB");
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_WEB_BYTES) throw new Error("网页正文超过 1MB");
    const source = new TextDecoder().decode(buffer);
    if (contentType.includes("text/plain")) {
      return { url: url.toString(), title: url.hostname, text: source.slice(0, 200_000) };
    }
    const $ = load(source);
    $("script,style,noscript,svg,nav,footer").remove();
    const title = $("title").first().text().trim() || url.hostname;
    const text = $("article,main,body").first().text().replace(/\s+/g, " ").trim();
    return { url: url.toString(), title, text: text.slice(0, 200_000) };
  }
  throw new Error("网页重定向次数过多");
}

async function extractBufferText(buffer: Buffer, fileName: string, mimeType = ""): Promise<string> {
  if (mimeType === "application/pdf" || fileName.toLowerCase().endsWith(".pdf")) {
    try {
      const parsed = await pdfParse(buffer);
      return String(parsed.text ?? "").slice(0, 500_000);
    } catch (error) {
      console.error("PDF 文本提取失败", error);
      throw new Error("PDF 无法解析或不含可提取文本");
    }
  }
  return buffer.toString("utf8").slice(0, 500_000);
}

async function persistUploadedFile(input: {
  userId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  title: string;
  tags: string[];
  buffer: Buffer;
}) {
  const validation = validateUpload({
    name: input.fileName,
    type: input.mimeType,
    size: input.sizeBytes,
  });
  if (validation) return Response.json({ error: validation }, { status: 400 });

  const entitlement = await getEntitlement(input.userId);
  if (!entitlement.pro) {
    const existing = await db
      .select({ id: resources.id })
      .from(resources)
      .where(eq(resources.userId, input.userId));
    if (existing.length >= FREE_RESOURCE_LIMIT) {
      return Response.json({ error: `免费版最多新增 ${FREE_RESOURCE_LIMIT} 条资源` }, { status: 403 });
    }
  }

  const id = createId("res");
  const safeName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const blobKey = `${input.userId}/${id}/${safeName}`;
  const extractedText = await extractBufferText(input.buffer, input.fileName, input.mimeType);
  await store.set(blobKey, input.buffer, {
    metadata: { contentType: input.mimeType, originalName: input.fileName },
  });
  const [record] = await db
    .insert(resources)
    .values({
      id,
      userId: input.userId,
      kind: input.fileName.toLowerCase().endsWith(".pdf") ? "pdf" : "file",
      title: input.title.trim() || input.fileName,
      blobKey,
      mimeType: input.mimeType || null,
      sizeBytes: input.sizeBytes,
      tags: input.tags,
      extractedText,
    })
    .returning();
  return Response.json({ resource: record }, { status: 201 });
}

export default async (req: Request): Promise<Response> => {
  const auth = await requireUser();
  if (isAuthResponse(auth)) return auth;
  const url = new URL(req.url);

  try {
    if (req.method === "GET") {
      const id = url.searchParams.get("id");
      const download = url.searchParams.get("download") === "1";
      if (id) {
        const [record] = await db
          .select()
          .from(resources)
          .where(and(eq(resources.id, id), eq(resources.userId, auth.id)))
          .limit(1);
        if (!record) return Response.json({ error: "资源不存在" }, { status: 404 });
        if (download && record.blobKey) {
          const blob = await store.get(record.blobKey, { type: "blob" });
          if (!blob) return Response.json({ error: "文件不存在" }, { status: 404 });
          return new Response(blob, {
            headers: {
              "Content-Type": record.mimeType ?? "application/octet-stream",
              "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(record.title)}`,
            },
          });
        }
        const bindings = await db
          .select()
          .from(taskResources)
          .where(and(eq(taskResources.userId, auth.id), eq(taskResources.resourceId, id)));
        return Response.json({ resource: record, taskIds: bindings.map((item) => item.taskId) });
      }
      const query = url.searchParams.get("q")?.trim();
      const condition = query
        ? and(
            eq(resources.userId, auth.id),
            or(
              ilike(resources.title, `%${query}%`),
              ilike(resources.extractedText, `%${query}%`),
              sql`${resources.tags}::text ILIKE ${`%${query}%`}`,
            ),
          )
        : eq(resources.userId, auth.id);
      const items = await db.select().from(resources).where(condition).orderBy(desc(resources.updatedAt));
      const entitlement = await getEntitlement(auth.id);
      return Response.json({ resources: items, entitlement, freeLimit: FREE_RESOURCE_LIMIT });
    }

    if (req.method === "POST") {
      const contentType = req.headers.get("content-type") ?? "";
      if (contentType.includes("multipart/form-data")) {
        try {
          const form = await req.formData();
          const file = form.get("file");
          if (!(file instanceof File)) {
            return Response.json({ error: "请选择文件" }, { status: 400 });
          }
          return await persistUploadedFile({
            userId: auth.id,
            fileName: file.name,
            mimeType: file.type,
            sizeBytes: file.size,
            title: String(form.get("title") ?? file.name),
            tags: tagsFrom(form.get("tags")),
            buffer: Buffer.from(await file.arrayBuffer()),
          });
        } catch (error) {
          console.error("multipart 上传解析失败，请改用 JSON 上传", error);
          return Response.json(
            { error: "本地环境暂不支持 multipart 上传，请刷新后重试（已切换 JSON 上传）" },
            { status: 500 },
          );
        }
      }

      const body = (await req.json()) as Record<string, unknown>;
      const action = String(body.action ?? "create");
      if (action === "upload") {
        const fileName = String(body.fileName ?? "").trim();
        const contentBase64 = String(body.contentBase64 ?? "").replace(/\s+/g, "");
        if (!fileName || !contentBase64) {
          return Response.json({ error: "缺少文件名或文件内容" }, { status: 400 });
        }
        let buffer: Buffer;
        try {
          buffer = Buffer.from(contentBase64, "base64");
        } catch (error) {
          console.error("Base64 文件解码失败", error);
          return Response.json({ error: "文件内容解码失败" }, { status: 400 });
        }
        return await persistUploadedFile({
          userId: auth.id,
          fileName,
          mimeType: String(body.mimeType ?? ""),
          sizeBytes: buffer.byteLength,
          title: String(body.title ?? fileName),
          tags: Array.isArray(body.tags)
            ? body.tags.map(String).map((tag) => tag.trim()).filter(Boolean).slice(0, 12)
            : tagsFrom(String(body.tags ?? "")),
          buffer,
        });
      }
      if (action === "bind") {
        const taskId = String(body.taskId ?? "");
        const resourceId = String(body.resourceId ?? "");
        const [task] = await db
          .select({ id: tasks.id })
          .from(tasks)
          .where(and(eq(tasks.id, taskId), eq(tasks.userId, auth.id)))
          .limit(1);
        const [resource] = await db
          .select({ id: resources.id })
          .from(resources)
          .where(and(eq(resources.id, resourceId), eq(resources.userId, auth.id)))
          .limit(1);
        if (!task || !resource) return Response.json({ error: "任务或资源不存在" }, { status: 404 });
        await db
          .insert(taskResources)
          .values({ id: createId("tr"), userId: auth.id, taskId, resourceId })
          .onConflictDoNothing();
        return Response.json({ bound: true, taskId, resourceId });
      }
      if (action === "createTask") {
        const resourceId = String(body.resourceId ?? "");
        const [resource] = await db
          .select()
          .from(resources)
          .where(and(eq(resources.id, resourceId), eq(resources.userId, auth.id)))
          .limit(1);
        if (!resource) return Response.json({ error: "资源不存在" }, { status: 404 });
        const taskId = createId("task");
        const task = {
          id: taskId,
          userId: auth.id,
          date: new Date().toISOString().slice(0, 10),
          title: `学习：${resource.title}`.slice(0, 100),
          description: "从知识库资源创建",
          source: "adhoc",
          suggestedMinutes: 30,
        };
        await db.insert(tasks).values(task);
        await db.insert(taskResources).values({
          id: createId("tr"),
          userId: auth.id,
          taskId,
          resourceId,
        });
        return Response.json({
          resourceId,
          task: {
            id: task.id,
            date: task.date,
            title: task.title,
            description: task.description,
            steps: ["打开已绑定资料", "学习并整理重点", "完成自检后标记任务完成"],
            checkCriteria: "能够不看资料复述核心内容，并记录至少 3 个关键点",
            priority: "medium",
            source: task.source,
            suggestedMinutes: task.suggestedMinutes,
            resources: [resourceId],
            reviewIntervals: [3, 7, 14, 30],
          },
        }, { status: 201 });
      }

      const entitlement = await getEntitlement(auth.id);
      if (!entitlement.pro) {
        const existing = await db
          .select({ id: resources.id })
          .from(resources)
          .where(eq(resources.userId, auth.id));
        if (existing.length >= FREE_RESOURCE_LIMIT) {
          return Response.json({ error: `免费版最多新增 ${FREE_RESOURCE_LIMIT} 条资源` }, { status: 403 });
        }
      }
      const kind = String(body.kind ?? "note");
      if (kind !== "note" && kind !== "link") {
        return Response.json({ error: "资源类型无效" }, { status: 400 });
      }
      const title = String(body.title ?? "").trim();
      if (!title) return Response.json({ error: "标题必填" }, { status: 400 });
      if (title.length > 200) return Response.json({ error: "标题不能超过 200 字" }, { status: 400 });
      let sourceUrl: string | undefined;
      let extractedText = String(body.text ?? "").trim().slice(0, 500_000);
      let resolvedTitle = title;
      if (kind === "note" && !extractedText) {
        return Response.json({ error: "笔记正文必填" }, { status: 400 });
      }
      if (kind === "link") {
        const page = await fetchPublicPage(String(body.url ?? ""));
        sourceUrl = page.url;
        extractedText = page.text;
        resolvedTitle = title || page.title;
      }
      const [record] = await db
        .insert(resources)
        .values({
          id: createId("res"),
          userId: auth.id,
          kind,
          title: resolvedTitle,
          sourceUrl,
          tags: Array.isArray(body.tags)
            ? body.tags.map(String).map((tag) => tag.trim()).filter(Boolean).slice(0, 12)
            : [],
          extractedText,
        })
        .returning();
      return Response.json({ resource: record }, { status: 201 });
    }

    if (req.method === "DELETE") {
      const id = url.searchParams.get("id") ?? "";
      const [record] = await db
        .select()
        .from(resources)
        .where(and(eq(resources.id, id), eq(resources.userId, auth.id)))
        .limit(1);
      if (!record) return Response.json({ error: "资源不存在" }, { status: 404 });
      await db
        .delete(taskResources)
        .where(and(eq(taskResources.userId, auth.id), eq(taskResources.resourceId, id)));
      await db.delete(resources).where(and(eq(resources.id, id), eq(resources.userId, auth.id)));
      if (record.blobKey) await store.delete(record.blobKey);
      return Response.json({ deleted: true, id });
    }
  } catch (error) {
    console.error("资源 API 处理失败", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "资源处理失败" },
      { status: 500 },
    );
  }

  return new Response("Method Not Allowed", { status: 405 });
};

export const config: Config = {
  path: "/api/resources",
  method: ["GET", "POST", "DELETE"],
};
