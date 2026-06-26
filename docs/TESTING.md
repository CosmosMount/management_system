# 测试手册

本文档用于人工测试、Playwright 仿真测试和 subagent 测试执行。执行测试时不要提交本地 cookie、截图、HTML 快照、数据库文件或 `.tmp/` 内容。

## 测试前准备

### 环境

1. 安装依赖：

   ```bash
   npm install
   ```

2. 准备 `.env`：

   ```bash
   cp .env.example .env
   ```

   至少配置 `AUTH_SECRET`、`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`NEXT_PUBLIC_APP_URL`、`APP_ALLOWED_ORIGINS`、`DATABASE_URL`。本地调试通常使用 `http://127.0.0.1:3000` 或 `http://localhost:3000`，Playwright 测试必须使用独立端口。

3. 启动 PostgreSQL 并同步数据库：

   ```bash
   docker compose up -d postgres
   createdb management_system_shadow 2>/dev/null || true
   npx prisma generate
   npm run db:deploy
   npm run db:seed
   npm run db:seed-acceptance-checklists
   npm run db:seed-progress-reminders
   ```

   本项目不再支持 SQLite，也不迁移旧 SQLite 数据；首次部署从空 PostgreSQL 库开始。

4. 启动 Web：

   ```bash
   npm run dev
   ```

   如果测试的是 `next start` 或 3000 端口上的生产构建，源码变更不会热更新，需要先 `npm run build` 并重启服务。自动化 Playwright 不允许默认访问 3000。

5. 如需测试定时提醒，单独启动 cron：

   ```bash
   npm run cron
   ```

### Playwright 登录态

- 项目已安装 `@playwright/test`，固定配置文件为 `playwright.config.ts`。
- 推荐把登录态保存到 `.tmp/playwright-liqixuan-storage.json`、`.tmp/playwright-admin-storage.json` 等本地文件。
- `.tmp/` 已被 git 忽略，不要把 cookie、storage state 或请求头写入仓库。
- 默认测试地址为 `http://127.0.0.1:3100`。配置中包含端口保护，禁止默认打到 3000。
- 推荐设置独立测试库，例如：

  ```bash
  createdb management_system_test
  export PLAYWRIGHT_DATABASE_URL="postgresql://postgres:<密码>@127.0.0.1:5432/management_system_test"
  npm run test:e2e
  ```

可用临时脚本加载登录态，例如放在 `.tmp/check.mjs`：

```js
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({
  storageState: ".tmp/playwright-liqixuan-storage.json",
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
page.on("console", (message) => {
  if (["error", "warning"].includes(message.type())) {
    console.log(`[console:${message.type()}] ${message.text()}`);
  }
});
await page.goto("http://127.0.0.1:3100", { waitUntil: "networkidle" });
await page.screenshot({ path: ".tmp/home.png", fullPage: true });
await browser.close();
```

## 基础代码测试

每次提交前至少执行：

```bash
npx prisma generate
DATABASE_URL="postgresql://..." npm run db:deploy
SHADOW_DATABASE_URL="postgresql://..._shadow" npx prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --exit-code
npx tsc --noEmit --incremental false
npx eslint app components lib scripts --max-warnings=0
npm run build
git diff --check
```

数据库相关改动额外执行：

```bash
npm run db:deploy
```

如果全量 ESLint 因历史问题失败，测试报告必须记录失败规则和文件，并补跑本次改动文件的定向 ESLint。

## Playwright 通用检查

每个页面测试都执行以下通用断言：

- 页面响应不是 500，未显示 Next.js error overlay。
- 控制台没有新的 uncaught error。
- 桌面视口 `1440x1000` 无横向滚动：`document.documentElement.scrollWidth <= window.innerWidth`。
- 移动视口 `390x844` 无明显文字重叠、按钮溢出或横向滚动。
- 主要按钮可通过可见文本或稳定 `data-testid` 定位。
- 提交失败时页面显示中文可读错误，不直接暴露 Zod JSON 或堆栈。

基础巡检路径：

- `/`
- `/login`
- `/profile`
- `/procurement`
- `/procurement/list`
- `/procurement/dashboard`
- `/procurement/new`
- `/procurement/workshop-fee`
- `/progress`
- `/progress/list`
- `/progress/dashboard`
- `/progress/archive`
- `/progress/new`
- `/feedback`
- `/admin`
- `/not-exists-for-test`

404 页面期望：显示“页面不存在或无权访问”、有“返回首页”按钮，并能自动或手动回到 `/`。

## 采购模块测试

### 新建申请与草稿

1. 进入 `/procurement/new`。
2. 不填必填项直接提交。
3. 期望字段下方出现明显错误提示，toast 为中文可读文案。
4. 填写车组、技术组、用途、采购明细和购买链接。
5. 点击“保存草稿”。
6. 进入 `/procurement/list`，打开草稿编辑页。
7. 修改草稿后分别测试“保存草稿”和“提交申请”。
8. 期望不会出现 `orderId expected string, received undefined`，草稿保存或进入管理审核状态成功。

### 审批与驳回

1. 使用对应车组组长、技术组组长或超级管理员账号打开订单详情。
2. 管理审核阶段分别执行通过和驳回。
3. 通过后期望两个管理审核位都保留，状态只推进一次。
4. 驳回后期望订单变为 `REJECTED`，申请人收到通知或 outbox 记录。
5. 老师审核阶段使用 `TEACHER` 或超级管理员执行通过和驳回。

### 上传凭证与报销

1. 审批通过后，申请人上传发票、每行实物照片，并生成验收清单。
2. 缺失电子签名、发票或实物照片时应显示中文错误。
3. 报销员上传报销截图。
4. 申请人确认报销。
5. 期望状态流转到 `COMPLETED`，附件在详情页可查看。

### 工坊加工费

1. 登录任意用户进入 `/procurement/workshop-fee`。
2. 页面应可访问。
3. 普通用户如无提交权限，提交时应被服务端拒绝并显示可读错误。
4. 对应车组 `FINANCE` 或 `SUPER_ADMIN` 提交应成功。

### 附件权限

1. 未登录访问 `/uploads/...` 应返回登录页或 401。
2. 无关登录用户访问无权限附件应返回 403 或 404。
3. 有权限用户可打开订单附件、报销截图、签名图片。

## 进度模块测试

### 项目创建与编辑

1. 进入 `/progress/new`。
2. 空表单提交，期望项目名、阶段、负责人等必填项显示字段级错误。
3. 只选车组或只选技术组时允许创建，但显示非阻塞警告。
4. 车组和技术组都不选时阻止提交。
5. 选择多名项目负责人和参与人员后创建项目。
6. 详情页应显示负责人、参与人员、阶段和活动动态。
7. 编辑项目基础信息、负责人、参与人员、是否允许负责人自审。
8. 期望详情、动态、通知 outbox 和 live refresh 均更新。

### 全员可见与只看自己

1. 普通登录用户进入 `/progress`、`/progress/list`、`/progress/dashboard`、`/progress/archive`。
2. 默认应看到全队可见项目和任务。
3. 切换“只看自己”，URL 应包含 `mine=1`。
4. 列表只保留自己负责、参与、阶段负责、任务负责或提交过申请的项目/任务。
5. 切回“全队”，URL 和列表恢复全队视图。

### 任务创建、申请与编辑

1. 管理者在项目详情创建任务。
2. 未填必填项提交，期望标题、阶段、负责人、截止时间等字段显示明显错误。
3. 项目 `NOT_STARTED` 或 `IN_PROGRESS` 时应允许创建任务。
4. 参与人员但非管理者点击“申请新任务”，提交任务草案。
5. 管理者审核通过后生成真实任务；驳回后不生成任务并显示意见。
6. 归档前任务可编辑；所属项目完成或取消后禁止编辑。
7. 任务有交付记录后验收 checklist 只读。

### 任务推进与验收

1. `TODO` 任务由负责人、管理者或超级管理员点击“开始任务”。
2. `IN_PROGRESS` 任务由负责人或超级管理员提交飞书文档链接和关键数据链接。
3. 必填链接为空或非法 URL 时显示字段级错误，并聚焦到首个错误。
4. 提交后任务进入 `PENDING_ACCEPTANCE`。
5. 有验收 checklist 的任务，审批人必须逐项手动勾选后才能通过。
6. 验收通过后任务进入 `COMPLETED`，交付历史显示确认条目。
7. checklist 为空任务仍可按旧流程验收。
8. 驳回验收后任务回到 `IN_PROGRESS`，历史提交保留。

### 周报与风险

1. 要求周报的进行中任务应显示周报提交入口。
2. 后期编辑打开周报要求后，任务详情应立即显示周报入口。
3. 后期关闭周报要求后，任务详情不应继续显示周报入口。
4. 周报“本周完成情况”为空时显示字段级错误。
5. 风险同步成功后写入动态和通知。

### 删除申请与软删除

1. 任务负责人或参与人员提交删除申请，任务仍可见并显示待审核。
2. 同一任务存在待审申请时，重复申请应失败。
3. 管理者审核通过后任务软删除，并从项目任务区、列表、看板和归档默认视图隐藏。
4. 审核驳回后任务仍可见，申请人可看到驳回意见。
5. 管理者可直接软删除任意未删除任务。
6. 已软删除任务不能编辑、交付、审批、重启或再次申请删除。

### 项目回退与任务重启

1. 管理者在项目详情看到“回退流程”按钮。
2. 不填写原因不能提交。
3. 待验收阶段回退后变为进行中，旧提交仍在历史中。
4. 已完成项目回退后项目回到进行中，最后阶段变为进行中。
5. 管理者在待验收或已完成任务详情看到“重启任务”。
6. 重启后任务状态变为 `IN_PROGRESS`，交付表单重新出现，历史交付保留。
7. 已归档或 `PROJECT_CANCELED` 任务不显示重启入口，直接调用 action 也应失败。

### 项目取消与完成

1. 存在未完成任务时，“完成项目”按钮为灰色。
2. 鼠标悬浮或按钮旁提示应说明原因，例如“还有 X 个任务未完成”或“还有 X 个阶段未完成”。
3. 直接调用完成 action 时，如仍有未完成阶段或任务，服务端拒绝并返回中文错误。
4. 全部阶段完成，且全部未删除任务为 `COMPLETED` 或 `ARCHIVED` 后，完成项目成功。
5. 取消项目后，`TODO`、`IN_PROGRESS`、`PENDING_ACCEPTANCE` 任务变为 `PROJECT_CANCELED`。
6. 已完成、已归档任务在项目取消后保持原状态。
7. `PROJECT_CANCELED` 任务详情可查看历史，但不显示开始、交付、周报、验收、编辑、重启、归档或删除申请入口。

### 看板逾期与筛选

1. 进入 `/progress/dashboard`。
2. 首屏应出现风险概览条和风险任务区。
3. 逾期任务显示红色样式和 `已超 N 天`。
4. 今日到期显示 `今天截止`。
5. 临期任务显示 `剩 N 天`，阈值来自提醒规则，没有配置时默认 2 天。
6. 点击 `已超时`、`今日到期`、`即将超时`、`全部` 后任务列表正确过滤。
7. 紧急度筛选 `高`、`中`、`低` 正常生效。

## 反馈中心测试

1. 打开 `/feedback`。
2. 默认筛选应为“活动”，列表只包含 `OPEN` 和 `IN_PROGRESS`。
3. 筛选顺序应为“活动 / 开放 / 处理中 / 已关闭 / 全部”。
4. 点击“全部”，滚动列表并点击一个已关闭反馈。
5. 期望筛选仍保持“全部”，URL 更新 `selected`，右侧详情更新，页面不跳回已关闭筛选。
6. 再点击开放或处理中反馈，仍保持“全部”。
7. 直接打开 `/feedback?selected=<closedId>`，初始应自动进入“已关闭”视图并显示详情。
8. 新建反馈后应跳到新反馈详情，新反馈出现在“活动”中。
9. 上传图片超过数量、类型或大小限制时显示中文错误。
10. 有权限用户可回复、修改状态；无权限用户不能执行管理操作。

## 管理员面板测试

1. 超级管理员进入 `/admin`。
2. 添加和删除用户角色，期望列表立即更新，权限重新登录或刷新后生效。
3. 添加和删除常用验收条例。
4. 新建或编辑任务时可快捷加入常用条例；删除模板不影响已有任务 checklist。
5. 修改进度提醒规则，保存后再次进入仍保持配置。
6. 手动触发提醒扫描，期望生成通知 outbox 或发送记录。
7. 对失败 outbox 执行重试，期望状态变化且不重复发送已成功收件人。
8. 触发飞书用户同步，期望同步结果 toast 显示新增/更新数量。

## 实时同步测试

使用两个浏览器上下文或两个页面，分别代表用户 A 和用户 B：

1. A 打开项目详情，B 推进阶段或修改任务。
2. A 在无弹窗时应自动刷新看到新状态。
3. A 打开编辑弹窗时，B 修改同一项目或任务。
4. A 应看到“页面数据已更新”提示；提交旧表单时服务端乐观锁拒绝。
5. A 在动态区域点击“加载更多”，B 触发新动态。
6. A 自动刷新后已加载历史不丢失，新动态合并到顶部。
7. 采购订单、反馈详情、项目列表、任务看板和归档页都应调用 `/api/live-version` 成功返回 200。

## 通知与 cron 测试

1. 启动 `npm run cron`。
2. 创建采购订单、项目、任务、删除申请、任务创建申请、验收、回退、重启、项目取消等关键动作。
3. 每个业务成功后应写入 `NotificationOutbox`。
4. 飞书发送失败时 outbox 保留可重试状态，不回滚业务状态。
5. 重跑 drain 不重复发送相同 `eventKey`。
6. 到期任务、逾期任务、缺失周报、阶段临期提醒应按管理员提醒规则生成通知。
7. 同时启动多个 cron 时，应确认不会重复执行同一次扫描；如发现重复，记录为并发风险。

## 部署冒烟测试

### Docker

```bash
docker compose up -d --build
docker compose logs -f app
docker compose logs -f cron
```

检查：

- app 监听端口可访问。
- cron 独立运行。
- PostgreSQL 和上传目录挂载到持久化 volume。
- `SUDO_PASSWORD` 不进入容器环境。
- `/uploads/...` 仍通过鉴权 route 访问。

### systemd

```bash
sudo systemctl status pnx-management-server
sudo systemctl status pnx-management-cron
```

检查：

- server service 启动前执行数据库部署命令。
- cron service 只启动一个实例。
- reinstall/uninstall 脚本不会删除数据库和上传附件。
- 重启服务后 `/`、`/feedback`、`/progress/dashboard` 可访问。

## Subagent 执行提示词

### 测试执行 subagent

```text
请在当前仓库按 docs/TESTING.md 执行测试。先记录 commit、Node/npm 版本、PostgreSQL 连接目标（脱敏）、Web 端口和登录态文件。按“基础代码测试 → Playwright 通用检查 → 采购模块 → 进度模块 → 反馈中心 → 管理员面板 → 实时同步 → 通知/cron → 部署冒烟”的顺序执行。不要修改代码。每个场景输出 PASS/FAIL/SKIP，FAIL 必须包含复现步骤、实际结果、期望结果、截图或 HTML 保存路径。不要输出 cookie、token、.env 密钥或完整用户敏感信息。
```

### 代码审查 subagent

```text
请对当前仓库做只读代码审查，重点检查权限边界、状态机、事务一致性、通知 outbox、软删除过滤、文件上传/下载权限、live refresh、Playwright 可测性和死代码。不要修改代码。输出按严重程度排序的 findings，每条包含文件路径、行号、风险说明、复现或推理依据、建议修复方向。如果没有阻塞问题，明确说明剩余风险和建议补充测试。
```

## 测试报告格式

```text
环境：
- commit:
- Node:
- npm:
- 数据库:
- Web 地址:
- 登录态:

命令结果：
- prisma generate:
- db deploy:
- tsc:
- eslint:
- build:
- git diff --check:

Playwright 结果：
- 路由巡检:
- 采购:
- 进度:
- 反馈:
- 管理员:
- 实时同步:
- 移动端:

失败项：
1. 严重程度：
   场景：
   复现步骤：
   期望：
   实际：
   证据：
   建议：

结论：
- 是否可发布:
- 必须修复:
- 可后续处理:
```
