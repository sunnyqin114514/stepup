# StepUp

StepUp 是暖奶油与赤陶橙视觉的学习执行应用，包含 6 个主导航：首页、学习日、目标规划、复盘、知识库、复习提醒。

完整闭环：

1. 填写目标、基础与薄弱项，由 AI 生成任务卡、实操指引、自检、资料建议、标签和复习周期。
2. 在任务卡正计时或倒计时专注，多轮追问 AI，绑定并打开知识库资料。
3. 完成后录入总数、正确数、错题、模块统计和失分原因，生成结构化复盘。
4. 补强任务自动写入日程，3 / 7 / 14 / 30 天复习计划进入真实到期队列。
5. 复盘页按目标与日期筛选服务端报告，展示正确率、薄弱项占比和累计时长。

## 技术栈

- React 19、TypeScript、Vite
- Netlify Functions
- Netlify Identity（用户认证与隔离）
- Netlify Database + Drizzle ORM（结构数据）
- Netlify Blobs（仅保存 PDF/TXT/Markdown 原文件）
- Netlify AI Gateway；本地也可通过未提交的 `DEEPSEEK_API_KEY` 调试

## 本地验证

```bash
npm install
npm run typecheck
npm run test
npm run build
npm run dev
```

开发服务固定为 `http://localhost:5174`。Functions 在本地开发环境使用
`dev-user-local-only`，生产环境未认证一律返回 401。

若要运行真实本地数据库：

```bash
npx netlify database init --yes
npm run db:migrate
```

`npm run db:migrate` 只允许应用到本地数据库。托管数据库迁移由 Netlify 部署自动执行，禁止对预览或生产数据库运行 `drizzle-kit push`、`drizzle-kit migrate` 或手写 DDL。

## 本地能力边界

Netlify Identity 目前不能在 `netlify dev` 中完整测试。注册、邮箱确认、登录、回调、生产 401、账号隔离和服务端权益必须在后续 Netlify 预览部署中人工验证。全新站点的 AI Gateway 也需要至少一次生产部署后才会激活；未激活时 Functions 会返回确定性降级结果，不会伪装真实 AI 成功。

## 数据与安全

- 所有数据库表包含 `user_id`，读写均以当前 Identity 用户约束。
- 浏览器缓存按用户 ID 分区；旧版无命名空间缓存只允许首个账号认领。
- 登录后一次性迁移工作区、每日复盘和旧任务 AI 复盘；失败不删除本地副本，可重试。
- 免费版限制由服务端执行：1 个进行中目标、每天 3 次拆解、每天 1 次重排、最多 5 条知识库资源。
- 文件最大 5MB，同时校验扩展名与 MIME（媒体类型）。
- 网页抓取只允许公开 HTTP/HTTPS 地址，拒绝账号凭据、非常用端口、localhost、私网、回环与链路本地地址；重定向逐次复验，正文最大 1MB。

## 后续 Netlify 人工步骤

本仓库当前不执行部署。后续由项目所有者：

1. 创建或关联 Netlify 项目并启用 Identity。
2. 配置注册策略、邮件确认和需要的 OAuth（开放授权）提供商。
3. 启用 AI Gateway；如改用 DeepSeek，只在 Netlify 环境变量中设置 `DEEPSEEK_API_KEY`。
4. 创建预览部署，确认数据库迁移自动应用。
5. 人工验证注册/登录/回调、两个账号的数据隔离、文件上传、全文检索、复习队列和 Pro 权益。
