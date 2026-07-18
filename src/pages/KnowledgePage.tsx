import { useEffect, useState } from "react";
import type { AiResourceSearchResult, ResourceItem } from "../types/plan";
import {
  bindTaskResource,
  createNoteResource,
  createTaskFromResource,
  listResources,
  searchAiResource,
  uploadResource,
} from "../services/planApi";
import ProBadge from "../components/ProBadge";
import { getAllTasks, loadWorkspace, mergeServerTask, todayStr, uid } from "../lib/storage";

type SearchHistoryItem = { query: string; timestamp: string };
type KnowledgeBaseItem = {
  id: string;
  title: string;
  summary: string;
  keyPoints: string[];
  subject: string;
  tags: string[];
  difficulty: string;
  hasWeakPoint: boolean;
  content: string;
  createdAt: string;
  addedToTask: boolean;
  source: "ai_search";
};

const SUBJECT_STYLE: Record<string, string> = {
  数学: "bg-sky-50 text-sky-700",
  英语: "bg-emerald-50 text-emerald-700",
  政治: "bg-rose-50 text-rose-700",
  专业课: "bg-violet-50 text-violet-700",
  其他: "bg-stone-100 text-stone-600",
};
const DIFFICULTY_STYLE: Record<string, string> = {
  基础: "bg-emerald-50 text-emerald-700",
  中等: "bg-orange-50 text-orange-700",
  进阶: "bg-rose-50 text-rose-700",
};

function loadSearchHistory(): SearchHistoryItem[] {
  try {
    const parsed = JSON.parse(localStorage.getItem("searchHistory") || "[]") as unknown;
    return Array.isArray(parsed) ? parsed.slice(0, 5) as SearchHistoryItem[] : [];
  } catch {
    return [];
  }
}

function saveSearchHistory(query: string): SearchHistoryItem[] {
  const next = [
    { query, timestamp: new Date().toISOString() },
    ...loadSearchHistory().filter((item) => item.query !== query),
  ].slice(0, 5);
  localStorage.setItem("searchHistory", JSON.stringify(next));
  return next;
}

function addToLocalKnowledgeBase(result: AiResourceSearchResult): KnowledgeBaseItem {
  const item: KnowledgeBaseItem = {
    id: `kb_${uid()}`,
    title: result.topic,
    summary: result.explanation,
    keyPoints: [...result.formulas, ...result.commonMistakes].slice(0, 8),
    subject: result.subject,
    tags: [result.subject, result.difficulty, ...result.commonMistakes.slice(0, 2)],
    difficulty: result.difficulty,
    hasWeakPoint: result.commonMistakes.length > 0,
    content: [
      result.explanation,
      result.formulas.length ? `公式：${result.formulas.join("；")}` : "",
      result.commonMistakes.length ? `易错点：${result.commonMistakes.join("；")}` : "",
    ].filter(Boolean).join("\n"),
    createdAt: new Date().toISOString(),
    addedToTask: false,
    source: "ai_search",
  };
  const existing = JSON.parse(localStorage.getItem("knowledgeBase") || "[]") as KnowledgeBaseItem[];
  localStorage.setItem("knowledgeBase", JSON.stringify([item, ...existing]));
  return item;
}

function addToTodayTasks(result: AiResourceSearchResult): void {
  const raw = JSON.parse(localStorage.getItem("todayTasks") || "[]") as Array<Record<string, unknown>>;
  const task = {
    id: `task_ai_${uid()}`,
    title: `学习：${result.topic}`,
    subject: result.subject,
    minutes: 30,
    completed: false,
    completedAt: null,
    date: todayStr(),
    source: "ai_search",
    isYesterdayLeftover: false,
  };
  localStorage.setItem("todayTasks", JSON.stringify([task, ...raw]));
}

function resultToNoteText(result: AiResourceSearchResult): string {
  return [
    `# ${result.topic}`,
    "",
    "## 知识点详解",
    result.explanation,
    "",
    "## 核心公式",
    ...result.formulas.map((formula) => `- ${formula}`),
    "",
    "## 典型例题",
    ...result.examples.map((example, index) => `${index + 1}. ${example.question}\n答案：${example.answer}\n思路：${example.explanation}`),
    "",
    "## 常见易错点",
    ...result.commonMistakes.map((mistake) => `- ${mistake}`),
    "",
    "## 推荐资源",
    ...result.resources.map((resource) => `- [${resource.type}] ${resource.title}: ${resource.url}`),
  ].join("\n");
}

export default function KnowledgePage() {
  const [items, setItems] = useState<ResourceItem[]>([]);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"file" | "note" | "link">("file");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [tags, setTags] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [selected, setSelected] = useState<ResourceItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [freeLimit, setFreeLimit] = useState(5);
  const [pro, setPro] = useState(false);
  const [bindingResourceId, setBindingResourceId] = useState<string | null>(null);
  const [bindingTaskId, setBindingTaskId] = useState("");
  const [aiQuery, setAiQuery] = useState("");
  const [aiResult, setAiResult] = useState<(AiResourceSearchResult & { mock?: boolean }) | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [searchInvalid, setSearchInvalid] = useState(false);
  const [history, setHistory] = useState<SearchHistoryItem[]>(() => loadSearchHistory());
  const [expandedExamples, setExpandedExamples] = useState<Record<number, boolean>>({});
  const tasks = getAllTasks(loadWorkspace());

  const loadItems = async (search = query) => {
    setError(null);
    try {
      const result = await listResources(search);
      setItems(result.resources ?? []);
      setFreeLimit(Number(result.freeLimit) || 5);
      setPro(Boolean(result.entitlement?.pro));
    } catch (loadError) {
      console.error("知识库加载失败", loadError);
      setError(loadError instanceof Error ? loadError.message : "知识库加载失败");
    }
  };

  useEffect(() => {
    void loadItems("");
  }, []);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (kind === "file") {
        if (!file) throw new Error("请选择 PDF、TXT 或 Markdown 文件");
        await uploadResource({
          file,
          title: title.trim() || file.name,
          tags,
        });
      } else {
        await createNoteResource({
          kind,
          title: title.trim(),
          text: kind === "note" ? text : undefined,
          url: kind === "link" ? url : undefined,
          tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean),
        });
      }
      setTitle("");
      setText("");
      setUrl("");
      setTags("");
      setFile(null);
      setNotice("资源已保存并建立全文索引");
      await loadItems("");
    } catch (submitError) {
      console.error("知识库资源保存失败", submitError);
      setError(submitError instanceof Error ? submitError.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  const createTask = async (resource: ResourceItem) => {
    setError(null);
    try {
      const result = await createTaskFromResource(resource.id);
      mergeServerTask(result.task);
      setNotice(`已从「${resource.title}」创建今日任务`);
    } catch (taskError) {
      console.error("从资源创建任务失败", taskError);
      setError(taskError instanceof Error ? taskError.message : "创建任务失败");
    }
  };

  const bindTask = async () => {
    if (!bindingResourceId || !bindingTaskId) return;
    setError(null);
    try {
      await bindTaskResource(bindingTaskId, bindingResourceId);
      const task = tasks.find((item) => item.id === bindingTaskId);
      setNotice(`已将资料绑定到「${task?.title ?? "任务"}」`);
      setBindingResourceId(null);
      setBindingTaskId("");
    } catch (bindError) {
      console.error("知识库绑定任务失败", bindError);
      setError(bindError instanceof Error ? bindError.message : "绑定任务失败");
    }
  };

  const runAiSearch = async (input = aiQuery) => {
    const search = input.trim();
    if (!search) {
      setSearchInvalid(true);
      setAiError("请输入知识点");
      window.setTimeout(() => setSearchInvalid(false), 500);
      return;
    }
    setAiLoading(true);
    setAiError(null);
    setAiResult(null);
    setExpandedExamples({});
    try {
      const result = await searchAiResource(search);
      if (result.error) {
        setAiError("😕 没有找到相关资料，换个关键词试试？");
        return;
      }
      setAiResult(result);
      setHistory(saveSearchHistory(search));
      setAiQuery(search);
    } catch (searchError) {
      console.error("AI 资料搜索失败", searchError);
      setAiError(searchError instanceof Error ? searchError.message : "😕 没有找到相关资料，换个关键词试试？");
    } finally {
      setAiLoading(false);
    }
  };

  const saveAiResultToKnowledge = async () => {
    if (!aiResult) return;
    setError(null);
    setNotice(null);
    try {
      addToLocalKnowledgeBase(aiResult);
      await createNoteResource({
        kind: "note",
        title: aiResult.topic,
        text: resultToNoteText(aiResult),
        tags: [aiResult.subject, aiResult.difficulty, "AI搜索"],
      });
      setNotice(`✅ 已加入知识库 · ${aiResult.subject}`);
      await loadItems("");
    } catch (saveError) {
      console.error("AI 搜索结果加入知识库失败", saveError);
      setError(saveError instanceof Error ? saveError.message : "加入知识库失败");
    }
  };

  const saveAiResultToToday = () => {
    if (!aiResult) return;
    addToTodayTasks(aiResult);
    setNotice("✅ 已加入今日任务");
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-stone-900">个人知识库</h1>
            <ProBadge />
          </div>
          <p className="text-sm text-stone-500 mt-1">
            PDF、TXT、Markdown、网页与文本笔记统一检索。单文件上限 5MB。
          </p>
        </div>
        <span className="text-xs text-stone-500">{pro ? "Pro · 可批量整理" : `免费版 ${items.length}/${freeLimit}`}</span>
      </div>

      <div className="card p-4 mb-5">
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            className={`input-field py-3 text-base transition ${searchInvalid ? "border-rose-400 animate-pulse" : ""}`}
            placeholder="🔍 输入知识点，AI帮你找详细资料..."
            value={aiQuery}
            onChange={(event) => setAiQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void runAiSearch();
            }}
          />
          <button className="btn-primary shrink-0 px-5 py-3" disabled={aiLoading} onClick={() => void runAiSearch()}>
            {aiLoading ? "搜索中..." : "搜索"}
          </button>
        </div>
        {history.length > 0 && (
          <div className="mt-2 text-xs text-stone-500">
            最近搜索：
            {history.map((item, index) => (
              <button
                key={`${item.query}-${item.timestamp}`}
                className="mx-1 text-brand-600 hover:underline"
                onClick={() => void runAiSearch(item.query)}
              >
                {item.query}{index < history.length - 1 ? " |" : ""}
              </button>
            ))}
          </div>
        )}
        {aiLoading && (
          <div className="mt-4 rounded-xl bg-sky-50 px-4 py-5 text-center text-sm font-medium text-sky-700">
            <span className="mr-2 inline-block animate-spin">🔍</span>
            正在为你查找资料...
          </div>
        )}
        {aiError && (
          <div className="mt-4 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-600">
            {aiError}
            <div className="mt-2 text-xs text-rose-500">
              你可能想搜：
              {["极限定义", "导数应用", "积分技巧"].map((suggestion) => (
                <button key={suggestion} className="mx-1 underline" onClick={() => void runAiSearch(suggestion)}>
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}
        {aiResult && (
          <div className="mt-5 animate-fade-in space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-xl font-bold text-stone-900">{aiResult.topic}</h2>
                <div className="mt-1 flex gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs ${SUBJECT_STYLE[aiResult.subject] ?? SUBJECT_STYLE.其他}`}>{aiResult.subject}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${DIFFICULTY_STYLE[aiResult.difficulty] ?? DIFFICULTY_STYLE.基础}`}>{aiResult.difficulty}</span>
                  {aiResult.mock && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700">兜底资料</span>}
                </div>
              </div>
              <div className="flex gap-2">
                <button className="btn-ghost py-2 text-sm" onClick={() => void saveAiResultToKnowledge()}>📥 加入知识库</button>
                <button className="btn-primary py-2 text-sm" onClick={saveAiResultToToday}>📝 生成学习任务</button>
              </div>
            </div>

            <section className="rounded-2xl bg-sky-50 p-4">
              <h3 className="font-semibold text-sky-900">📖 知识点详解</h3>
              <p className="mt-2 text-sm leading-relaxed text-sky-950">{aiResult.explanation}</p>
              {aiResult.formulas.length > 0 && (
                <div className="mt-3 space-y-2">
                  {aiResult.formulas.map((formula) => (
                    <code key={formula} className="block rounded-lg bg-stone-100 px-3 py-2 text-sm text-stone-700">{formula}</code>
                  ))}
                </div>
              )}
            </section>

            <section>
              <h3 className="mb-2 font-semibold text-stone-900">✏️ 典型例题</h3>
              <div className="space-y-2">
                {aiResult.examples.map((example, index) => (
                  <div key={`${example.question}-${index}`} className="rounded-xl border border-stone-100 bg-white p-3">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium text-stone-800">{example.question}</p>
                      <button
                        className="shrink-0 text-xs text-brand-600"
                        onClick={() => setExpandedExamples((value) => ({ ...value, [index]: !value[index] }))}
                      >
                        {expandedExamples[index] ? "收起答案" : "查看答案"}
                      </button>
                    </div>
                    {expandedExamples[index] && (
                      <div className="mt-3 rounded-lg bg-[#FBF9F4] p-3 text-sm text-stone-700 transition">
                        <p><strong>答案：</strong>{example.answer}</p>
                        <p className="mt-1"><strong>思路：</strong>{example.explanation}</p>
                        <div className="mt-3 flex gap-2">
                          <button className="rounded-lg bg-emerald-50 px-3 py-1.5 text-xs text-emerald-700">👍 已掌握</button>
                          <button className="rounded-lg bg-rose-50 px-3 py-1.5 text-xs text-rose-700">👎 未掌握</button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-2xl bg-amber-50 p-4">
              <h3 className="font-semibold text-amber-900">⚠️ 常见易错点</h3>
              <ul className="mt-2 space-y-1 text-sm text-amber-900">
                {aiResult.commonMistakes.map((mistake) => <li key={mistake}>⚠️ {mistake}</li>)}
              </ul>
            </section>

            <section>
              <h3 className="mb-2 font-semibold text-stone-900">🔗 推荐资源</h3>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                {aiResult.resources.map((resource) => (
                  <div key={`${resource.type}-${resource.url}`} className="rounded-xl border border-stone-100 bg-white p-3">
                    <div className="text-lg">{resource.type === "视频" ? "🎬" : resource.type === "练习" ? "✏️" : "📄"}</div>
                    <div className="mt-1 line-clamp-2 text-sm font-medium text-stone-800">{resource.title}</div>
                    <a className="mt-3 inline-flex text-xs font-medium text-brand-600" href={resource.url} target="_blank" rel="noreferrer">打开</a>
                  </div>
                ))}
              </div>
            </section>

            <div className="flex flex-wrap gap-2 border-t border-stone-100 pt-3">
              <button className="btn-ghost py-2 text-sm" onClick={() => void saveAiResultToKnowledge()}>📥 加入知识库</button>
              <button className="btn-primary py-2 text-sm" onClick={saveAiResultToToday}>📝 生成学习任务</button>
              <button className="btn-ghost py-2 text-sm" onClick={() => {
                setAiResult(null);
                setAiQuery("");
                setAiError(null);
              }}>🔍 再搜一个</button>
            </div>
          </div>
        )}
      </div>

      <div className="card p-4 mb-5">
        <div className="flex gap-2 mb-3">
          {(["file", "note", "link"] as const).map((value) => (
            <button key={value} className={`px-3 py-1.5 rounded-lg text-sm border ${kind === value ? "bg-brand-50 border-brand-300 text-brand-600" : "bg-white border-stone-200 text-stone-600"}`} onClick={() => setKind(value)}>
              {value === "file" ? "上传文件" : value === "note" ? "文本/手写笔记" : "网页链接"}
            </button>
          ))}
        </div>
        <input className="input-field mb-2" placeholder="标题" value={title} onChange={(event) => setTitle(event.target.value)} />
        {kind === "file" && <input className="input-field mb-2" type="file" accept=".pdf,.txt,.md,.markdown,application/pdf,text/plain,text/markdown" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />}
        {kind === "note" && <textarea className="input-field mb-2 min-h-28" placeholder="粘贴文本，或录入手写笔记的转写内容" value={text} onChange={(event) => setText(event.target.value)} />}
        {kind === "link" && <input className="input-field mb-2" type="url" placeholder="https://..." value={url} onChange={(event) => setUrl(event.target.value)} />}
        <input className="input-field mb-3" placeholder="标签，逗号分隔" value={tags} onChange={(event) => setTags(event.target.value)} />
        <button className="btn-primary py-2" disabled={busy || (kind === "file" ? !file : !title.trim())} onClick={() => void submit()}>
          {busy ? "保存中…" : "保存到知识库"}
        </button>
        {!pro && <p className="mt-2 text-xs text-stone-400">免费版可真实新增最多 {freeLimit} 条；Pro 解锁批量整理。</p>}
      </div>

      <div className="flex gap-2 mb-4">
        <input className="input-field py-2" placeholder="搜索标题与全文" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void loadItems()} />
        <button className="btn-ghost py-2 shrink-0" onClick={() => void loadItems()}>搜索</button>
      </div>
      {error && <div className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</div>}
      {notice && <div className="mb-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {items.map((resource) => (
          <article key={resource.id} className="card p-4">
            <div className="flex justify-between gap-2 text-xs text-stone-400">
              <span>{resource.kind.toUpperCase()}</span>
              <span>{new Date(resource.createdAt).toLocaleDateString()}</span>
            </div>
            <h2 className="mt-2 font-semibold text-stone-900">{resource.title}</h2>
            <p className="mt-1 text-sm text-stone-600 line-clamp-3">{resource.extractedText || "文件已保存，暂无可提取文本"}</p>
            <div className="mt-2 flex flex-wrap gap-1">{(resource.tags ?? []).map((tag) => <span key={tag} className="rounded-full bg-brand-50 px-2 py-0.5 text-xs text-brand-600">{tag}</span>)}</div>
            <div className="mt-3 flex gap-3 text-xs">
              <button className="text-brand-600" onClick={() => setSelected(resource)}>查看</button>
              {resource.kind === "pdf" || resource.kind === "file" ? <a className="text-brand-600" href={`/api/resources?id=${encodeURIComponent(resource.id)}&download=1`} target="_blank" rel="noreferrer">打开文件</a> : null}
              {resource.kind === "link" && resource.sourceUrl ? <a className="text-brand-600" href={resource.sourceUrl} target="_blank" rel="noreferrer">打开网页</a> : null}
              <button className="text-brand-600" onClick={() => {
                setBindingResourceId(resource.id);
                setBindingTaskId("");
              }}>绑定任务</button>
              <button className="text-brand-600" onClick={() => void createTask(resource)}>创建任务</button>
            </div>
            {bindingResourceId === resource.id && (
              <div className="mt-3 flex gap-2">
                <select className="input-field py-1.5 text-xs" value={bindingTaskId} onChange={(event) => setBindingTaskId(event.target.value)}>
                  <option value="">选择已有任务</option>
                  {tasks.map((task) => <option key={task.id} value={task.id}>{task.goalTitle ? `${task.goalTitle} · ` : ""}{task.title}</option>)}
                </select>
                <button className="btn-ghost shrink-0 py-1.5 text-xs" disabled={!bindingTaskId} onClick={() => void bindTask()}>确认</button>
              </div>
            )}
          </article>
        ))}
      </div>
      {items.length === 0 && <p className="py-10 text-center text-sm text-stone-500">暂无匹配资源。</p>}

      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 p-4" onClick={() => setSelected(null)}>
          <div className="card max-h-[80vh] w-full max-w-2xl overflow-y-auto p-5" onClick={(event) => event.stopPropagation()}>
            <h2 className="font-semibold text-stone-900">{selected.title}</h2>
            <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-stone-700">{selected.extractedText || "暂无可查看文本"}</p>
            <button className="btn-ghost mt-4" onClick={() => setSelected(null)}>关闭</button>
          </div>
        </div>
      )}
    </div>
  );
}
