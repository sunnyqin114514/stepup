# StepUp 持久化闭环

## 本地运行

1. 使用 Node.js 20+，执行 `npm install`。
2. 运行 `npx netlify database init --yes` 初始化本地 Netlify Database。
3. 执行 `npm run db:migrate`，只将迁移应用到本地数据库。
4. 执行 `npm run dev`，Vite 固定监听 `http://localhost:5174`。
5. 启动后另开终端执行 `npm run dev:check`，确认 `/api/resources`、
   `/api/reviews`、`/api/workspace` 均返回 200 且不报 `NETLIFY_DB_URL`。

Identity 当前不能在 `netlify dev` 中完整工作。本地开发仅在
`NODE_ENV=development` 或 `NETLIFY_DEV=true` 时使用固定用户
`dev-user-local-only`。生产 Functions 无此兜底，未登录返回 401。

## 本地数据库连接失效的恢复

现象：所有依赖数据库的 API 返回 500，前端报
`NETLIFY_DB_URL environment variable is not set`。

根因：`@netlify/vite-plugin` 在 `vite` 启动时启动本地 pglite
并注入 `NETLIFY_DB_URL`。dev server 长时间运行后本地 Postgres
连接可能失效，但 vite 插件不会重新注入，导致函数运行时拿不到连接串。

恢复步骤：
1. 停掉 5174 上的 vite 进程：`lsof -ti tcp:5174 | xargs kill -9`。
2. 重新执行 `npm run dev`。
3. 执行 `npm run dev:check`，三项均显示 `✓` 即恢复。
4. 若仍失败：`rm -rf .netlify/db` 后重启（会清空本地数据，不影响线上）。

为避免再次发生，`db/index.ts` 已在 drizzle 初始化失败时抛出中文指引，
前端会显示明确提示而不是裸堆栈。

## Netlify 配置与部署

1. 在 Netlify 项目配置中启用 Identity；按需要开启邮箱注册或 OAuth。
2. 提交 `netlify/database/migrations`。预览部署和生产部署会自动执行迁移。
3. 禁止对 hosted database（托管数据库）运行 `drizzle-kit push/migrate` 或手写 DDL。
4. AI 可使用 `DEEPSEEK_API_KEY`（仅 Netlify 环境变量）或 Netlify AI Gateway。不要提交 `.env`。
5. 用预览部署验证注册、登录、用户隔离、文件上传与数据库迁移，再发布生产。

## 数据边界

- Netlify Database：目标、任务、答疑线程、结构化复盘、补强任务、复习计划和权益。
- `ai_usage` 保存按用户、日期和动作聚合的 AI 配额计数；浏览器计数仅用于即时提示。
- `imported_daily_reviews` 与 `imported_task_reviews` 保存登录前本地历史的迁移副本。
- Netlify Blobs：PDF/TXT/Markdown 原文件。Blob 不保存动态记录。
- 所有表和查询均包含 `user_id`（用户标识）约束。
- 登录后会一次性迁移现有 `workspace/reviews/taskAiReviews`；失败保留本地数据，可重试。
- 浏览器工作区、复盘、待办池、计时器和 AI 用量缓存按 Identity 用户 ID 分区，避免共享浏览器串号。

## 知识库与链接安全

- 支持 PDF、TXT、`.md/.markdown`、网页链接、文本或手写笔记转写。
- 单文件 5MB；PDF/TXT/Markdown 可全文搜索。
- 网页只允许 HTTP/HTTPS，拒绝 localhost、回环、链路本地和私网 IP。
- 网页正文最多读取 1MB，仅接受 HTML 或纯文本；重定向目标会再次校验。

## 复习与 Pro

- 复习默认支持 3/7/14/30 天及自定义组合。
- “记得”进入下一周期；“模糊”按当前周期一半安排；“忘了”次日重启。
- 任务复盘可选择自定义提醒时间；服务端校验 `HH:mm` 格式并保存到复习计划。
- 免费版真实限制为 1 个进行中目标、每天 3 次 AI 拆解、每天 1 次 AI 重排、最多 5 条知识库资源；Pro 服务端权益来自 `user_entitlements`。
- 全局长期排期、深度复盘、批量知识库整理、批量提醒由服务端权益控制。
- 邮件与浏览器推送尚未配置外部 provider（服务提供方），界面只声明未配置，不会伪装已发送。

## 本轮收尾与本地验证

- 浏览器工作区每次保存后会防抖同步到 `/api/workspace`；服务端按用户更新目标与任务，并清理该用户已从本地工作区删除的记录。
- 服务端生成的补强任务、到期复习任务和知识库任务会立即合并到本地工作区；补强任务保留目标归属，并按服务端日期出现在对应学习日。
- 任务复盘提交的自定义提醒时间会写入服务端复习计划；当前仅用于站内复习提醒展示与调度。
- `npm run typecheck`：通过。
- `npm test`：通过，1 个测试文件、4 个测试。
- `npm run build`：通过，Vite 生产构建成功。
- `http://localhost:5174`：已有本地 Vite 服务，健康检查成功。
- 本轮仅完成代码与本地验证；未执行 Netlify 部署、线上数据库迁移或其他外部写操作。

## 当前限制

- 尚未配置邮件或浏览器推送 provider（服务提供方），因此没有发送邮件或浏览器推送。
- Identity、托管数据库迁移、AI Gateway 和多账号隔离仍需部署后人工验证；本轮不得据此声称线上可用。

## 尚需部署后人工验证

- Identity 注册、邮箱确认、登录、回调与退出。
- 未登录 Functions 返回 401，以及两个账号间数据库、Blob 和浏览器缓存隔离。
- 托管数据库自动应用 `netlify/database/migrations` 中的迁移。
- AI Gateway 首次生产部署激活后的真实模型调用。
- Pro 权益由管理员写入 `user_entitlements` 后的服务端放行。
