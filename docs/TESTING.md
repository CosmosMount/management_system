# 测试手册

本文档用于人工测试、Playwright 仿真测试和 subagent 测试执行。执行测试时不要提交本地 cookie、截图、HTML 快照、数据库文件或 `.tmp/` 内容。

完整业务回归范围见 [全功能测试规划](./FULL_FUNCTIONAL_TEST_PLAN.md)。本文档中的 Playwright smoke 只覆盖主要页面入口和少量浅交互，不能等同于全功能通过。

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

   **在 3005 端口开发**（与默认 3000 隔离，适合并行调试）：

   ```bash
   npm run dev -- -p 3005
   ```

   在 `.env` 的 `APP_ALLOWED_ORIGINS` 中追加 `http://localhost:3005` 与 `http://127.0.0.1:3005`（局域网则加 `http://<LAN_HOST>:3005`）。飞书开放平台需注册重定向 URL：`http://localhost:3005/api/auth/callback/feishu` 等。登录 cookie 按 `host:port` 隔离，3000 上已登录不能自动用于 3005，需在该端口重新飞书登录，或将 Playwright `storageState` 保存为 `.tmp/playwright-*-3005.json` 并针对 `http://127.0.0.1:3005` 加载。

3. 启动 PostgreSQL 并同步数据库：

   ```bash
   docker compose up -d postgres
   createdb management_system_shadow 2>/dev/null || true
   npx prisma generate
   npm run db:deploy
   npm run db:seed
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
- 默认测试地址为 `http://127.0.0.1:3002`。配置中包含端口保护，禁止默认打到 3000。
- Playwright 启动的应用服务强制 `NOTIFICATION_DELIVERY_DISABLED=true`，并默认设置 `FEISHU_DIRECT_MESSAGE_ALLOWED_NAMES="李棋轩"`，防止测试期间误发给其他人；业务 outbox 仍保留完整候选收件人，投递层负责拦截。
- `npm run test:e2e` 的 POSIX script 先以空 `NODE_OPTIONS` 启动 `tsx`，runner 再无条件为测试 worker、受控 Next.js 服务及所有 Node/Prisma 后代注入 `CHECKPOINT_DISABLE=1`。调用方 `NODE_OPTIONS`（其中的 `--require`/`--import` 会在 guard 前执行）不会传给 runner 后代，而是严格重建为受控 sentinel 与 cwd 绑定官方 guard 的绝对 import；继承 probe output/role 同样清空，仅 runner 直接拥有的 server 进程组可写固定 repo `.tmp` probe。已能控制父 npm 进程的同 UID 主体不属于此 harness 的认证边界。guard 会在标准 `fetch` 及 `node:http` / `node:https` 的 `request`、`get` 入口拦截 `*.feishu.cn` / `*.larksuite.com` / `*.larksuite.cn`，未显式 mock 的测试必须立即失败，且 guard 自测只能使用预取消 signal 或建连前失败的本地 agent，禁止把 DNS、socket 等真实网络错误充当阴性证据。该入口级 guard 是测试禁发的补充防线，不能覆盖先访问非飞书地址后由底层自动重定向、绕过标准入口的 custom transport、原始 socket 或非 Node 外部进程，因此测试仍须保持 `NOTIFICATION_DELIVERY_DISABLED=true` 并显式 mock 外部调用。禁发开关与 guard 不改变生产 callback 的身份读取语义；callback 身份测试必须提供隔离库中的可信假 `union_id`（包括 approval bot 与登录 bot 的跨应用映射）或显式 mock 通讯录查询。
- 只需提供本机 PostgreSQL 的凭据/authority 模板；URL 路径不会被访问，也不会成为测试库名：

  ```bash
  export PLAYWRIGHT_DATABASE_URL="postgresql://postgres:<密码>@127.0.0.1:5432/credential_template"
  npm run test:e2e
  ```

  `npm run test:e2e` 是 POSIX-only 官方入口；Windows 因无法在当前实现中可靠保证整个进程树终止，会在 marker/child 创建前拒绝。每次执行会生成新的密码学随机 token 和独立 secret，以 token 构造一对不同、以 `_test` 结尾的 target/shadow，并用 token 唯一 `O_EXCL` marker 绑定精确 pair 与连接摘要。继承的静态路径/shadow/source/clone/reuse/skip/确认变量均被覆盖。runner 强制官方 config、单 worker、`recreate`、`127.0.0.1:3002`、禁通知/checkpoint 和 guard；所有调用方 short option（包括 `-xcalternate...`、`-xc alternate...`、`-xj4`、`-xj 4` 等 Commander cluster）都会拒绝，危险长参数的分离值/等号形式也全部拒绝。clone 脚本在加载数据库代码前 hard reject。

  `scripts/setup-playwright-db.ts` 与 `scripts/cleanup-playwright-db.ts` 的直接调用同样 fail-closed：公开 token/确认值不够，仍须匹配当前 marker、secret hash、连接摘要及精确 pair；路径逐层拒绝 symlink/不安全 owner 或 mode，leaf/file 必须精确 `0700`/`0600`，file 还须 single-link、regular、大小受限且 inode 稳定。setup 部分创建失败会补偿两个精确名称；cleanup/补偿仅在全部数据库操作成功后删除 marker，任何 drop/unlink 失败均非零且 marker 保留。普通 `SHADOW_DATABASE_URL` 从不作为输入。marker 防误用、cross-run 和公开 token 单独删除，但同 UID 或已有工作树写权限的恶意主体可读取/篡改文件与进程，不是此机制声称抵御的认证边界。

  runner 不再让 Playwright 通过 built-in `webServer` 创建 runner 看不见的 detached 组：它先在 marker 创建前确认 3002 未被占用，再独立启动并拥有 server 组，确认受控 HTTP readiness 后，启动无 built-in server 的 CLI 组。`SIGINT`、`SIGTERM`、`SIGHUP` 第一次同时转发给已存在的两组，第二次（同/不同信号）或 5 秒超时分别升级 `SIGKILL`；正常结束、CLI/server 自发 exit/error 和 pre-child signal 都必须先确认 server 与 CLI 两组退出。端口检查只辅助 availability/readiness/诊断，不能替代进程组静默证明。任一组无法 quiesce 时，runner 跳过 DB cleanup、非零退出并保留 marker，而不会删除仍被活动后代使用的库。cleanup 错误递归展开叶子原因并经统一 redaction 逐条记录；入口先设置 129/130/143 fallback 再尝试重触发原信号，因此 `tsx`/handler 忽略信号或 kill 抛错也不会返回 0。直接 runner `SIGKILL`、崩溃、OS 故障或断电仍可能跳过 cleanup；此时禁止前缀删除，只能由 DBA 只读确认精确名称后处理。

  修改 Playwright 数据库 harness 后，先运行不连接数据库的 runner/lifecycle 回归，再用同一本机凭据运行 PostgreSQL 安全演练：

  ```bash
  npm run test:playwright-db-lifecycle

  PLAYWRIGHT_DATABASE_URL="postgresql://postgres:<密码>@127.0.0.1:5432/credential_template" \
    NOTIFICATION_DELIVERY_DISABLED=true \
    CHECKPOINT_DISABLE=1 \
    npm run test:playwright-db-safety
  ```

  lifecycle 命令真实启动 `scripts/run-playwright.ts` 验证危险 CLI/short cluster 在 marker/child 前失败，并证明历史 self-test 环境名不能绕过 runner 且不会传给受控后代；正式入口没有 caller 可选择的测试分支。独立的 `verify-playwright-runner-finalizer-entry.ts` 只验证共享 production finalizer 的三种信号内核终止或 129/130/143 fallback、原信号日志、嵌套 cleanup 根因展开与凭据/secret redaction，不宣称它执行了正式 runner 数据库生命周期；clone 是另一个真实 hard-reject 子进程。lifecycle 会真实创建两个独立 POSIX 进程组，以占用 3002 的 detached server 分别覆盖 CLI 自然失败、首次信号超时升级和第二信号强杀，并在 server 尚未静默时断言 cleanup 未调用、marker 与注入的精确 pair 所有权仍保留，静默后才允许清理；另有 parent 自发退出、同组 descendant 继续占端口的回归。marker 的 symlink、mode、owner policy、hardlink、oversize/content、inode swap以及 direct setup 部分补偿、drop/unlink failure 使用 deterministic 文件/注入 seam，不冒充真实数据库故障。PostgreSQL 演练除随机双 pair、相似 sentinel、非法 setup/cleanup、并发 recreate、direct cleanup、pair 隔离外，还用真实随机 target/shadow 重跑上述三种 detached 双组场景，逐次证明活动 server 期间 DB/marker 保留，双组静默后 cleanup 恰好一次且 DB/marker/3002/进程组残留为 0；命令不会访问 source 或发送飞书。

  如需执行登录后的功能冒烟，额外指定本地登录态：

  ```bash
  export PLAYWRIGHT_STORAGE_STATE=".tmp/playwright-liqixuan-storage.json"
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
npm run check
```

`npm run check` 会依次执行 Prisma validate、Prisma generate + TypeScript、脚本 TypeScript、全量 ESLint（含 Playwright tests）和 `git diff --check`。数据库或生产构建相关改动再额外执行：

```bash
DATABASE_URL="postgresql://..." npm run db:deploy
SHADOW_DATABASE_URL="postgresql://..._shadow" npx prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --exit-code
npm run build
```

数据库相关改动额外执行：

```bash
npm run db:deploy
```

项目管理 P1-P6 schema、身份、授权、生命周期、Segment、UI 或通知接入变更应额外执行：

```bash
npm run test:e2e -- tests/project-management-p1.spec.ts tests/project-management-lifecycle.spec.ts tests/project-management-segments.spec.ts tests/project-management-resource-removal-migration.spec.ts tests/project-management-ui.spec.ts tests/notification-outbox-adapters.spec.ts tests/feishu-boundaries.spec.ts
npm run pm:identity-backfill
```

`npm run pm:identity-backfill` 默认只做 dry-run。需要验证写入时只能在隔离库或发布演练库设置 `APPLY_PM_IDENTITY_BACKFILL=true`，并确认重复执行不会新增重复 Account、Identity 或 Person。

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

## 项目管理 P4/P6 UI 测试

1. 桌面 `1440x1000` 与 Pixel 5 分别打开 `/progress`，应展示“我的工作”总览、可见 Active Task、未来投入、待确认计划和未读通知摘要；导航中不得出现“资源冲突”。
2. 打开 `/progress/tasks`，按“只看我参与”、状态、优先级和关键词筛选时，只展示当前 actor 可读 Task；不可读 Task 不能通过列表枚举。
3. 打开 `/progress/tasks/[id]`，成员可看到 Task 工作台、当前计划、成员权限和人员投入；非成员或无范围权限账号应看到“页面不存在或无权访问”。
4. 打开 `/progress/resources`，人员计划时间轴应能新增 Planned Segment，并通过 P5 服务端 action 执行确认、部分确认、拆分、合并、顺延和取消；测试需校验 UI 结果和数据库状态。
5. `/progress/resources/conflicts` 必须返回 404。资源计划、个人时间线、Task 工作台和 Agenda 不得出现冲突标记或投入比例；快速创建与 Inspector 不得提供比例输入。创建、更新、移动、拆分、合并和确认仍需正常工作，重叠 Segment 不得产生冲突待办、通知或 outbox。
6. 打开 `/progress/notifications`，只展示当前收件人的站内通知；可按类型/未读筛选、标记单条或全部已读，跳转对象前仍要按业务对象权限过滤。
7. 页面不得出现旧项目、阶段、周报、风险、提醒或 `PROJECT_MANAGER` 角色文案；不得出现 500、Next.js error overlay、未处理浏览器错误或横向滚动。
8. 旧 `/progress/task/:id` 应服务端重定向到 `/progress/tasks/:id`；旧 `/progress/projects/*` 和 `/progress/kanban` 应回到 `/progress`，不能永久跳转到不存在页面。收缩 migration 集成测试仍需验证旧表、旧 enum、`PROJECT_MANAGER` 数据和 `channel=progress` outbox/recipient 被删除，同时采购、反馈、用户、附件、CardKit 跟踪和其他 channel outbox 数据保持不变。

### Task 创建页专项测试

专项规格见 [`docs/plan/task-create-ui/README.md`](plan/task-create-ui/README.md)。自动化和人工检查都必须使用隔离测试数据库并保持 `NOTIFICATION_DELIVERY_DISABLED=true`。

1. 桌面 `1440x1000` 打开 `/progress/tasks/new`：页面为 Task 信息、TimeCanvas/节点表、节点 Inspector 三栏，初始计划只有 Start 和名称为 `Terminal` 的 Terminal；不得查询或展示成员 Planned、Actual、Busy 数据，不得出现节点负责人或状态列。
2. 验证 `start`、`relatedTaskId` 和 `templateTaskId` URL 预填不回退。无模板时 Start 为上海时区次日 `09:00`、Terminal 为 Start 后 14 天；模板保留 Milestone 内容、时间和自定义 Terminal 名称。
3. 分别创建含 0、1、200 个 Milestone 的 Task，并通过服务端和数据库验证 Current Plan、严格 sequence、Terminal 名称、创建者 Owner、审计、站内通知和 outbox；201 个 Milestone 必须在客户端与服务端被拒绝。创建失败保留草稿和幂等键，成功清理本地草稿并跳转工作台。
4. 构造 Start=首个 Milestone、相邻 Milestone 同刻、最后 Milestone=Terminal 和任意逆序输入；新建、Draft 替换、模板副本与 Revision 目标均不得保存。已有只读/Active 旧同刻计划仍可打开并显示兼容提示，不得被自动改时。
5. 验证 Terminal 名称 trim 后空白、200/201 字符边界；自定义名称在创建、Draft 编辑、Revision、模板复制、查询、工作台、版本差异、审计和快照中保持一致。默认 `Terminal` 不改变既有 canonical hash，自定义名称及其变更必须改变 hash。
6. 在画布选择 Start、Milestone、Terminal，再从节点表选择同一批节点；画布高亮、表格选中、Inspector 和所选节点的前置阶段块必须双向同步。阶段块可点击并选择其下一节点；零 Milestone 时点击 Start → Terminal 阶段应选择 Terminal 并高亮整段，同时仍保留可操作空状态。
7. 从空白画布快捷菜单新增 Milestone、移动 Terminal；非法时刻的操作保持禁用并显示原因。新增 Milestone 应立即以琥珀虚线临时节点进入画布和节点表，前后两段阶段块同时标记临时；补全必填项后自动转正。
8. 拖动及键盘移动 Start、Milestone、Terminal，分别验证小时档 30 分钟、日/周档 1 天、月档 7 天吸附和上海时区增量。拖动预览期间节点前后阶段块必须同步伸缩，Milestone 穿越时按预览时间重排连接；Start、Terminal 与 Milestone 的严格边界必须在预览阶段钳制，锚点不得先越界再于松手后回弹。无合法吸附位置时保持原值并提示放大画布或使用 Inspector。
9. Inspector 不显示保存/取消；Start、Terminal、Milestone 输入实时同步到画布、节点表和校验。清空或输入同刻/越界时间时，字段显示错误而画布保留最后合法位置；同一节点连续修改多个字段只需一次撤销即可整体恢复。
10. 复制 Milestone 应复制目标、完成条件、验收要求和业务说明；完整合法副本按自动校验规则直接转正，原节点之后没有分钟级合法位置时不得创建。临时节点切换后保留并可显式删除；单删和批量删除只作用于 Milestone，Start/Terminal 永远不可删除、复制或勾选。
11. 刷新页面后恢复 v3 临时节点、最后合法画布位置与选中节点，并验证旧 v3 Inspector 工作副本转换为实时临时节点。v1/v2 草稿缺少 Terminal 名称时迁移为 `Terminal`，零 Milestone 可恢复，同刻时间保持原值并阻止提交；不兼容草稿继续可导出。另用 200 个 Milestone、每个四项 2,000 字符且包含 JSON 转义字符的极限草稿验证 IndexedDB 正文、`localStorage` 指针、刷新往返、两个同账号标签页并发“保存并离开”、立即“放弃并离开”不会被待触发防抖重新写回，以及创建成功后的双存储清理。
12. 创建零 Milestone Task 后执行激活：Task 和 Terminal 均为 `ACTIVE`，`activeMilestoneNodeId=null`；工作台和列表使用 Terminal 名称/日期，审计和激活通知使用 Terminal 名称，不显示“当前没有 Active Milestone”。结束确认仍走现有事务、审计和 `project-management` outbox。
13. Task Composer 与 Task Workbench 的 PLAN 行验证节点符号、阶段块中心线对齐，阶段块显示下一节点名称，节点下方显示上海日期；使用长 Task/Terminal/Milestone/成员/Tag 名称、长错误、慢提交、空列表和 200 节点验证桌面无页面级横向滚动、无 Next.js overlay、无未捕获浏览器错误，Inspector 和表格滚动/换行可用。
14. Pixel 5 不应显示桌面三栏 TimeCanvas 布局；纵向流程仍能创建零 Milestone Task、编辑 Terminal 名称、修正严格时间错误，并验证无横向滚动、重复焦点、服务器错误或未捕获浏览器错误。

### DRAFT Task 统一编辑专项测试

1. Owner 从 DRAFT 工作台右上角进入 `/progress/tasks/[id]/edit`；按钮顺序为“编辑 Task → 激活 Task → 复制链接”，工作台不再出现“编辑 Draft 计划”，DRAFT 的概览、Tag、成员和计划均无保存控件。激活后编辑按钮消失，直达编辑 URL 重定向工作台；不可查看或无 metadata 更新权的用户直达 URL 得到脱敏 404。
2. 编辑页在 Desktop 复用三栏 Composer、在 Pixel 5 复用纵向 Composer，并回填元数据、当前 Tag、关联 Task、全部现有成员（包括停用人员）、Start、既有 Milestone/Terminal 及节点 ID。迁移后异常残留的 `LEAD/MEMBER/REVIEWER/VIEWER` 四种历史角色必须逐行回显并保留，存在历史角色时成员区整体只读，但仍可保存其他内容。当前归档 Tag 可见且可移除，新选项只含未归档 Tag；关联选择器排除当前 Task。
3. Owner 一次修改基本信息、Tag、关联 Task、成员、既有节点、新 Milestone 和 Terminal 后保存；数据库全部更新、既有 nodeId 保留、新节点产生稳定映射、`snapshotHash` 更新、Task `lockVersion` 仅增加 1，并只产生一条 `pm.task.draft.update` 审计。失败时任一区域都不得部分提交，且不得产生站内通知、outbox 或真实飞书调用。
4. Participant 可进入编辑页并保存元数据与计划；成员区只读、没有搜索/添加/移除/角色控件，请求省略 `members`，数据库成员保持不变。直接伪造 `members`、移除有关联 Segment 的成员或删除被 Segment 引用的节点必须被服务端拒绝并完整回滚。
5. 未修改时桌面和移动主保存按钮均禁用；选择节点不应被视为内容修改。客户端和服务端字段错误定位相应区域，无法映射的业务错误显示中文提示。保存成功清理该 Task 编辑草稿并返回默认“计划与资源”工作台，展示权威最新数据。
6. 编辑草稿按环境、账号和 Task ID 隔离；刷新仅在 Task、Plan Version 和基础 lockVersion 全匹配时允许恢复。失去成员管理权或服务端出现历史角色后，恢复必须以服务端标准成员覆盖本地成员改动，同时保留其他可编辑内容。服务端版本变化后旧草稿不能恢复或覆盖，只能导出或“放弃并加载最新版本”；`STALE_TASK` 保留当前输入，不隐式刷新或合并。
7. 领域测试覆盖并发相同 lockVersion 只有一次成功、错误 Plan Version、非初始 v1 Current Plan、非 DRAFT、权限拒绝、Tag/关联/成员/计划晚失败回滚和完整审计。UI 在 Desktop/Pixel 5 另覆盖长 Task、节点、成员、Tag、长错误、零/200 Milestone 和窄屏无横向溢出、Next.js overlay 或未捕获浏览器错误。

## 反馈中心测试

1. 打开 `/feedback`。
2. 默认筛选应为“活动”，列表只包含 `OPEN` 和 `IN_PROGRESS`。
3. 筛选顺序应为“活动 / 开放 / 处理中 / 已关闭 / 全部”。
4. 点击“全部”，滚动列表并点击一个已关闭反馈。
5. 期望筛选仍保持“全部”，URL 更新 `selected`，右侧详情更新，页面不跳回已关闭筛选。
6. 再点击开放或处理中反馈，仍保持“全部”。
7. 直接打开 `/feedback?selected=<closedId>`，初始应自动进入“已关闭”视图并显示详情。
8. 新建反馈后应跳到新反馈详情，新反馈出现在“活动”中。
9. 上传图片超过数量、类型、单张 20MB 或合计 50MB 限制时显示中文错误。
10. 有权限用户可回复、修改状态；无权限用户不能执行管理操作。

## 管理员面板测试

1. 统一超级管理员进入 `/admin/accounts`；非超管和项目管理员访问页面或直接调用 Server Action 均被拒绝。`/admin/roles` 应服务端重定向到新地址。
2. 按姓名、角色、车组和技术组筛选，验证 30 条服务端分页；空结果显示中文空状态，页面不得出现项目启用/禁用筛选或操作。
3. 授予/撤销项目管理员和四类报销角色，验证 UI、数据库活跃记录、角色历史、安全审计、站内通知和 mandatory outbox 一致；项目角色 UI 不得再提供 `GROUP_LEADER`，直接提交该角色也必须被服务端拒绝。采购报销的车组/技术组角色继续可配置。
4. Person 为 `INACTIVE` 的统一账号仍可进入 `/progress`、读取全部未删除业务数据并创建 Task，且创建者自动成为 Owner；该 Person 不可作为其他 Task 的新增成员，也不可创建新 Segment，历史成员和历史 Segment 继续展示。
5. 验证禁止自撤销超级管理员、最后一名超管保护、重复提交幂等和可理解的中文错误。
6. Desktop 使用表格与详情面板；Pixel 5 使用卡片和全屏详情。长姓名、多角色、身份缺失和错误消息均不得造成横向滚动。
7. 对失败 outbox 执行重试，期望状态变化且不重复发送已成功收件人。
8. 触发飞书用户同步，期望同步结果 toast 显示新增/更新数量。

## 实时同步测试

使用两个浏览器上下文或两个页面，分别代表用户 A 和用户 B：

1. A 打开采购订单或反馈详情，B 修改同一业务对象。
2. A 在无弹窗时应自动刷新看到新状态。
3. A 打开编辑弹窗时，B 修改同一对象；A 应看到更新提示或在提交旧表单时收到可理解的冲突错误。
4. 采购订单和反馈详情的实时刷新请求应成功；`/api/live-version` 不再接受旧项目/任务 scope。

## 通知与 cron 测试

1. 自动化测试强制 `NOTIFICATION_DELIVERY_DISABLED=true`，并 mock 飞书 HTTP；确认测试过程没有真实网络投递。
2. 飞书传输层分别验证 text、交互卡片和 CardKit，以及禁发、allowlist、通知/审批凭据、`open_id`/`union_id`、审批 fallback、`cardId` 返回和错误脱敏。
3. procurement/feedback/project-management adapter 分别验证 payload、`type`、`botKind` 校验，真实/独立传输收件人计算与去重、完整消息内容和明确用途；普通通知不得使用审批机器人，审批事件只有 Webhook 而无真实审批人时不得标记成功。
4. 创建采购、反馈或项目管理事件后应写入正确 channel 的 `NotificationOutbox`；旧 `progress` channel 必须被拒绝或不存在 adapter。项目管理 adapter 测试应 mock 飞书 HTTP 并验证交互卡包含操作人、Task、事件、对象、时间和上下文。
5. 飞书网络失败、临时收件人查询失败或缺少 `union_id` 时 outbox 保留可重试状态，不回滚业务状态；未知 channel、非法 payload/元数据和错误机器人用途应终止重试并保留明确错误。
6. 重跑 drain 不重复发送相同 `eventKey`，多收件人通知只重试失败的 `NotificationOutboxRecipient`；首次收件人解析失败和 outbox/recipient 锁过期后都可安全恢复。
7. 同时启动多个 cron 时，应确认不会重复 claim 同一 outbox；如发现重复，记录为并发风险。
8. 验证 CardKit fallback 后跟踪表保存实际机器人和最终 `cardId`，远端 CardKit 错误中的敏感字符串不会进入异常或 outbox。
9. 通过静态搜索确认 IM 消息 API 只在统一传输层、CardKit API 只在 CardKit 模块、Webhook URL 只在 Webhook 模块出现。

## 项目管理 P1-P6 测试

1. `tests/project-management-p1.spec.ts` 覆盖核心 schema 约束：单 Task 单 Current Plan、有效 Tag 名称唯一、Segment 时间检查和 Review 幂等键。
2. 身份测试覆盖 `User -> Account/Identity/Person` 首次解析、重复解析幂等、openId fallback 升级为 unionId、同 unionId 下的 openId 轮换、报销 User 原位更新、角色与收件人不丢失、冲突硬失败和非空 `User.accountId` 关联；账号级项目访问禁用已经移除。
3. 授权测试覆盖普通非成员、Participant、Owner、统一超级管理员、项目管理员和已退役 `GROUP_LEADER`。所有已登录统一账号都应读取全部未删除 Task、计划、验收、审计与完整 Segment；非成员/组长写入必须零副作用，Participant/Owner/全局管理员按固定矩阵验证允许和拒绝路径。两类全局管理员均可审批且允许自审，Task 不再存在 `allowSelfReview` 分支。
4. 通知测试覆盖站内通知事务 helper、审计脱敏、审计 append-only、`channel=project-management` outbox 入队、审批用途 allowlist、全局管理员收件人按账号去重、结果通知创建人/提交人加所有 Owner、完整交互卡和通知/审批机器人边界；不得出现 Task Reviewer 或项目组长审批收件人。
5. `tests/project-management-lifecycle.spec.ts` 覆盖 P2/P3 Task 草稿创建、创建者自动 Owner、幂等键冲突、Current Plan 持久化、0/200/201 Milestone 边界、Start/Milestone/Terminal 严格递增、Terminal 名称传播、零 Milestone 激活 Terminal、并发/过期锁拒绝、Revision 始终待审批、Participant/Owner 的 Revision 管理边界、管理员批准/驳回和自审、零活跃审批人或全部管理员无有效飞书身份时整事务回滚、Planned Segment 待确认标记、Revision 生效后的 Segment 关联失效通知、Milestone Review TEXT/LINK 证据、FILE 证据拒绝、仅管理员审批推进、Termination 四种 outcome、全员查询、审计和 `channel=project-management` outbox。
6. `tests/project-management-segments.spec.ts` 覆盖 P5 Segment 中文校验、全员完整读取、无 Task 关联本人管理、Task 关联时 Participant 只管本人、Owner 管理全 Task、非成员拒绝、Person 必须是目标 Task 成员、损坏的非成员关联更新零写入、乐观锁、真实 100 条批量在末项 stale 时对 Segment/change/audit/outbox 的事务回滚、逆序重叠批量输入的 `id ASC` 行锁顺序、split/merge 时间守恒和完整来源历史、merge 最终范围超过 31 天拒绝且恰好 31 天允许、full/partial confirm、一 Planned 多 Actual、多 Planned 一 Actual、无来源 Actual、并发 full confirm、并发 cron transition、cancel、soft delete、relink，以及 Segment 操作不改变 Task/Milestone。批量锁顺序用例外锁最大 ID，并通过 `pg_blocking_pids` 断言一条直接及一条间接等待链；成员降级竞争会外锁 TaskMember，形成“成员替换持有 Task 锁 → Segment 写等待 Task 锁”的真实阻塞链，证明降级后的 Owner 不能移动或删除他人投入；其他 full/partial confirm、cancel、soft delete 和 cron transition 竞争也通过独立 PostgreSQL 行锁屏障确认两个事务真实重叠，并断言最终状态及 change/audit/outbox exactly-once。
7. `tests/project-management-resource-removal-migration.spec.ts` 从完整前置迁移链创建隔离 PostgreSQL 数据库，写入旧 allocation、Conflict、通知、outbox、checkpoint 和审计数据；应用删除 migration 后验证目标对象消失，普通 Segment、通知、outbox 与审计保留，历史 JSON 只清除顶层 `allocation`。
8. `tests/project-management-ui.spec.ts` 和 `tests/project-management-s3-shell.spec.ts` 覆盖 `/progress` 总览、全员 Task 工作台、全员资源计划、个人时间线、站内通知中心、桌面/移动视口、Task 创建/统一 DRAFT 编辑的三栏与移动纵向布局、零 Milestone、Terminal 名称、严格时间顺序、画布/节点表/Inspector 联动、本地草稿恢复与版本冲突，以及 DRAFT 工作台只读、编辑 URL 防护、Participant 成员只读、创建页只显示 Task 级负责人/参与人且无流程策略、非成员只读、Owner/Participant 分层按钮、管理员审批与自审、冲突入口消失、旧 URL 404、比例输入与展示消失。
9. `tests/feishu-boundaries.spec.ts` 必须继续扫描 `app/progress`、`app/actions/project-management`、`components/project-management`、`lib/project-management` 和项目管理 notification adapter，防止项目管理入口或领域服务直接导入飞书传输层。
10. `tests/project-management-s2-plan-mutations.spec.ts` 覆盖六个兼容 Draft/Active mutation 及统一 `updateTaskDraft`：参数化允许状态、完全不可见与 visible-but-unauthorized、Draft/Active/四个 terminal/Archived、逐 action stale、成员不变量、Participant 成员字段拒绝、错误 Plan Version、一次全量成功、同锁并发 exactly-once、Segment 引用约束、零通知、完整统一审计，以及受控晚失败整事务回滚；Active member 另在 InApp 已写、outbox insert 阶段注入失败并断言成员 active/history、lock、audit、InApp 和 outbox 全部回滚。副作用快照比较 metadata、TaskTag、active/historical members 和节点正文，不只比较计数。该 spec 还覆盖 raw/foreign `nodeId` 的统一拒绝、legacy Active 修复 Revision/Termination、200 节点长正文的有界审计、公开 absolute date-time 拒绝 `Date` 对象、随机 Task 与隐藏 Task 在 single/batch Planned、Actual、update/relink 的同码同文零写入，以及 mandatory recipient 仅使用 default tenant 非空 openId。TaskNode/Segment 竞争回归使用独立 PostgreSQL 连接外锁 Task 行，通过 `pg_blocking_pids` 建立 writer-first 与 replace-first 阻塞链，分别证明已有关联使删除失败、先删除使新关联失败，且不会死锁或出现 `nodeId` 静默置空。该 spec 只允许随机本机 `_test` PostgreSQL，并要求 `NOTIFICATION_DELIVERY_DISABLED=true`。
11. `tests/project-management-s8.spec.ts` 覆盖 Action Inbox 权限/逾期排序、Tag 删除仅移除分类、Tag 写事务内角色撤销复核、普通/强制通知偏好、Asia/Shanghai deadline event key、保留清理和完整性巡检；UI 的 S8 场景在 Desktop/Pixel 5 验证驾驶舱、待办、Tag 与偏好。
12. `tests/project-management-s9-cron.spec.ts` 覆盖保留的 PostgreSQL 跨实例 advisory lock；新增 migration 必须在 runner 随机 target 数据库从空库执行。
13. `tests/project-management-performance.spec.ts` 默认跳过。仅在受控 runner 中设置 `PM_RUN_SCALE_TESTS=true`，生成 10k Task、100k Segment、50×100 PlanNode 和 100k 站内通知，执行 p95、query plan、响应体积与浏览器 DOM 门禁。不得对开发、共享或生产数据库设置该变量。
14. `tests/project-management-s10-release.spec.ts` 只在 Desktop 执行运维规格：演练工具 fail-closed、空库 migration、两次共享快照、受保护表 row/hash、identity backfill dry-run/APPLY 幂等、整库/上传恢复和旧 contract/直接飞书发送静态扫描。工具只接受本机 `_test`/`_snapshot` 来源，要求 `PM_RELEASE_REHEARSAL_CONFIRM=LOCAL_ISOLATED_REHEARSAL` 与 `NOTIFICATION_DELIVERY_DISABLED=true`，并只创建/删除随机 `pmrel_*_test` 数据库；不得把生产 URL 伪装成允许名称。
15. `tests/task-access-migration.spec.ts` 从完整前置 migration 链构造旧角色组合，覆盖零 Owner 阻断、多 Owner、重复有效成员、Owner 优先、Lead/Member 转 Participant、Reviewer/Viewer 结束、Segment Participant 回填、`GROUP_LEADER` 撤销、旧策略审计、历史成员保留、零通知副作用和后续全局审批人部署门禁。
16. `tests/task-approval-notification-repair.spec.ts` 覆盖修复脚本 dry-run 零写入、旧 outbox 冻结、管理员账号去重、approval bot、版本化事件键、逐审批对象事务故障注入、管理员均无有效飞书 openId 时冻结前阻断和幂等重跑。
17. `tests/project-access-status-removal-migration.spec.ts` 从完整前置 migration 链构造 ACTIVE/DISABLED 账号，验证状态列与枚举删除、历史禁用账号迁移审计、通知/outbox 零副作用，以及剩余六个全局管理员数据库门禁均不再引用旧状态字段。

## 统一账号迁移验证

已有数据库发布前按顺序执行：

```bash
npm run accounts:preflight
npm run db:deploy
npm run accounts:validate
```

预检是旧 schema 上的只读命令，应覆盖身份多账号冲突、待创建账号、孤儿角色、重复或非法角色范围、双范围旧项目组长和旧报销超管数量。任何阻断项必须非零退出，不能猜测身份或自动拆分双范围。

`tests/legacy-project-management-migration.spec.ts` 在额外的随机本机 `_test` PostgreSQL 中从真实前置 migration 链构造旧用户和角色，验证：

- `unionId/openId` 关联和缺失 Account 自动创建；
- 报销超管、旧项目系统管理员和旧组长的映射；
- `RESOURCE_MANAGER/AUDITOR` 等所有旧角色逐条撤销审计、重复执行不重复审计；
- 旧角色撤销但保留、`User.accountId NOT NULL` 和新范围约束；该历史迁移阶段可存在的 `projectAccessStatus` 会由后续状态移除 migration 单独验证并删除；
- 身份多账号冲突和双范围旧组长会阻止迁移；
- `source=MIGRATION` 审计存在，站内通知与 outbox 为零；
- 活跃旧角色、非法报销范围和重复活跃角色被数据库拒绝。

迁移测试只允许官方 runner 的随机 `_test` 数据库；不得把普通开发库或生产库改名伪装成测试库。

## Task 全员可见迁移与发布验证

在仍包含旧 Task 成员和审批策略字段的只读副本上先执行：

```bash
npm run pm:task-access-preflight
```

报告必须人工核对零 Owner Task、重复有效成员、旧角色数量和转换数量、Work Segment 参与人回填数量、孤立 Task 关联 Segment、活跃 `GROUP_LEADER`、活跃全局管理员账号数、具备 default tenant 非空飞书 openId 的全局管理员账号数、待处理 Milestone/Revision 及旧通知/outbox。已有 Task 时任一管理员计数为零、`ready=false` 或非零退出均不得部署；零 Owner、孤立 Person 或损坏关联必须人工修复，不能自动猜测负责人。

完整 migration 链回归还必须验证所有管理员门禁都排在不可逆 Task migration 之前；零全局管理员或零有效飞书 openId 时，受控 `npm run db:deploy` 失败后旧审批字段、`RevisionApprovalMode`、旧成员 enum 和成员数据必须保持原样，不能出现半升级数据库。双连接回归要让管理员失效事务先持有 DML 锁，再启动原子门禁迁移，验证迁移等待后观察到失效状态并在主迁移前失败；永久门禁安装后撤销角色、清空 openId、删除管理员账号三类写入都必须被拒绝，两个连接并发移除不同管理员只能有一个提交，空库无管理员时首个 Task 也必须在提交时被拒绝。主迁移撤销旧 `GROUP_LEADER` 后仍可添加角色约束；兼容清理 migration 必须只移除第一代触发器和函数并保留第二代门禁。另需用真实 `prisma migrate deploy` history 模拟已应用后续 migration 的旧环境，验证补跑低编号门禁和最终清理。

在随机隔离 PostgreSQL 中完成 migration 演练后，执行以下迁移后断言：

- 每个 Task 至少一名有效 Owner，允许多 Owner；
- 每个 Task/Person 最多一条有效成员，且角色只为 Owner/Participant；
- 每条未删除 Task 关联 Segment 的 Person 都是有效成员；
- 活跃项目系统角色只剩两类全局管理员，所有 `GROUP_LEADER` 均有 `revokedAt`；
- 旧 Task 审批策略、成员归一化、Segment 回填和角色撤销都有 `source=MIGRATION` 审计；
- migration 本身没有创建 InAppNotification 或 NotificationOutbox。

保持 `NOTIFICATION_DELIVERY_DISABLED=true` 和通知 worker 停止，先 dry-run 再 APPLY 待审批修复：

```bash
npm run pm:repair-task-approval-notifications

NOTIFICATION_DELIVERY_DISABLED=true \
npm run pm:repair-task-approval-notifications -- --apply
```

验证已发送历史消息保留、旧可重试审批 outbox 被明确冻结、每个当前待审批对象只生成一组按账号去重的全局管理员站内通知和 approval outbox、二次运行零重复，并确认没有真实飞书请求。完成 `npm run check`、`npm run db:deploy`、`npm run build`、`npm run test:e2e` 及人工桌面/Pixel 5 验收后，才可恢复通知 worker。

`tests/project-access-status-removal-migration.spec.ts` 从状态删除之前的完整 migration 链构造 ACTIVE/DISABLED 账号，验证管理员门禁先移除状态依赖、历史 DISABLED 账号逐一获得 `source=MIGRATION` 恢复审计、ACTIVE 账号无该审计、通知/outbox 数量不变、列与枚举删除且 append-only 审计触发器仍有效。`tests/fuzzy-search.spec.ts` 与 S2 option 安全测试覆盖标准化、拼音/顺序评分、AND 语义、50/501 边界、游标绑定和 resolver 不泄露。`tests/entity-picker.spec.ts` 通过仅在 runner-owned `_test` 数据库和通知禁发环境开放的 `/progress/entity-picker-fixtures`，确定性验证旧响应、分页和 resolver 竞态、失败重试、50 项上限、键盘独立投入及 disabled FormData 语义。

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
- 重启服务后 `/`、`/feedback`、`/progress`、`/progress/tasks`、`/progress/resources` 和 `/progress/notifications` 可访问；旧 `/progress/task/:id` 正确重定向到 `/progress/tasks/:id`。

## Subagent 执行提示词

### 测试执行 subagent

```text
请在当前仓库按 docs/TESTING.md 执行测试。先记录 commit、Node/npm 版本、PostgreSQL 连接目标（脱敏）、Web 端口和登录态文件。按“基础代码测试 → Playwright 通用检查 → 采购模块 → 项目管理 P4/P6 UI → 反馈中心 → 管理员面板 → 实时同步 → 通知/cron → 部署冒烟”的顺序执行。不要修改代码。每个场景输出 PASS/FAIL/SKIP，FAIL 必须包含复现步骤、实际结果、期望结果、截图或 HTML 保存路径。不要输出 cookie、token、.env 密钥或完整用户敏感信息。
```

### 代码审查 subagent

```text
请对当前仓库做只读代码审查，重点检查旧项目管理残留、权限与数据暴露、迁移删除范围、统一飞书传输层、notification channel adapter、outbox 事务/幂等/逐收件人重试、机器人路由、禁发与 allowlist、文件上传权限、Playwright 可测性和死代码。不要修改代码。输出按严重程度排序的 findings，每条包含文件路径、行号、风险说明、复现或推理依据、建议修复方向。如果没有阻塞问题，明确说明剩余风险和建议补充测试。
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
- 项目管理 P4/P6 UI:
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
