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
- `npm run test:e2e` 会无条件为测试 worker、受控 Next.js 服务及所有 Node/Prisma 后代注入 Prisma 官方 opt-out `CHECKPOINT_DISABLE=1`，禁止测试期间的 Prisma checkpoint 外联；还会通过 `NODE_OPTIONS` 为这些 Node 进程预加载飞书域名外联 guard。guard 会在标准 `fetch` 及 `node:http` / `node:https` 的 `request`、`get` 入口拦截 `*.feishu.cn` / `*.larksuite.com` / `*.larksuite.cn`，未显式 mock 的测试必须立即失败，且 guard 自测只能使用预取消 signal 或建连前失败的本地 agent，禁止把 DNS、socket 等真实网络错误充当阴性证据。该入口级 guard 是测试禁发的补充防线，不能覆盖先访问非飞书地址后由底层自动重定向、绕过标准入口的 custom transport、原始 socket 或非 Node 外部进程，因此测试仍须保持 `NOTIFICATION_DELIVERY_DISABLED=true` 并显式 mock 外部调用。禁发开关与 guard 不改变生产 callback 的身份读取语义；callback 身份测试必须提供隔离库中的可信假 `union_id`（包括 approval bot 与登录 bot 的跨应用映射）或显式 mock 通讯录查询。
- 推荐设置独立测试库，例如：

  ```bash
  createdb management_system_test
  export PLAYWRIGHT_DATABASE_URL="postgresql://postgres:<密码>@127.0.0.1:5432/management_system_test"
  npm run test:e2e
  ```

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

项目管理 P1-P6 schema、身份、授权、生命周期、Segment、Conflict、UI 或通知接入变更应额外执行：

```bash
npm run test:e2e -- tests/project-management-p1.spec.ts tests/project-management-lifecycle.spec.ts tests/project-management-segments.spec.ts tests/project-management-conflicts.spec.ts tests/project-management-ui.spec.ts tests/notification-outbox-adapters.spec.ts tests/feishu-boundaries.spec.ts
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

1. 桌面 `1440x1000` 与 Pixel 5 分别打开 `/progress`，应展示“我的工作”总览、可见 Active Task、未来投入、待确认计划、开放冲突和未读通知摘要。
2. 打开 `/progress/tasks`，按“只看我参与”、状态、优先级和关键词筛选时，只展示当前 actor 可读 Task；不可读 Task 不能通过列表枚举。
3. 打开 `/progress/tasks/[id]`，成员可看到 Task 工作台、当前计划、成员权限和人员投入；非成员或无范围权限账号应看到“页面不存在或无权访问”。
4. 打开 `/progress/resources`，人员计划时间轴应能新增 Planned Segment，并通过 P5 服务端 action 执行确认、部分确认、拆分、合并、顺延和取消；测试需校验 UI 结果和数据库状态。
5. 打开 `/progress/resources/conflicts`，冲突中心应展示解释和关联 Segment，并能确认已知、忽略、解决、预览建议和显式应用建议；权限不足账号不能处理冲突。
6. 打开 `/progress/notifications`，只展示当前收件人的站内通知；可按类型/未读筛选、标记单条或全部已读，跳转对象前仍要按业务对象权限过滤。
7. 页面不得出现旧项目、阶段、周报、风险、提醒或 `PROJECT_MANAGER` 角色文案；不得出现 500、Next.js error overlay、未处理浏览器错误或横向滚动。
8. 旧 `/progress/task/:id` 应服务端重定向到 `/progress/tasks/:id`；旧 `/progress/projects/*` 和 `/progress/kanban` 应回到 `/progress`，不能永久跳转到不存在页面。收缩 migration 集成测试仍需验证旧表、旧 enum、`PROJECT_MANAGER` 数据和 `channel=progress` outbox/recipient 被删除，同时采购、反馈、用户、附件、CardKit 跟踪和其他 channel outbox 数据保持不变。

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

1. 超级管理员进入 `/admin`。
2. 添加和删除用户角色，期望列表立即更新，权限重新登录或刷新后生效。
3. 角色选择中不应出现 `PROJECT_MANAGER`，也不应存在旧验收条例、进度提醒规则或每日进度卡片管理入口。
4. 对失败 outbox 执行重试，期望状态变化且不重复发送已成功收件人。
5. 触发飞书用户同步，期望同步结果 toast 显示新增/更新数量。

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

1. `tests/project-management-p1.spec.ts` 覆盖新增 schema 约束：单 Task 单 Current Plan、有效 Tag 名称唯一、Segment 时间和 allocation 检查、Review 幂等键、Conflict fingerprint。
2. 身份测试覆盖 `User -> Account/Identity/Person` 首次解析、重复解析幂等、openId fallback 升级为 unionId、冲突硬失败和禁用 Account 拒绝项目管理 actor。
3. 授权测试覆盖 Task member、范围内/外 Team Administrator、非成员、空 scope Team Administrator 拒绝、Tag 创建人无 Task 权限，以及 `taskReadableWhere` 防枚举。
4. 通知测试覆盖站内通知事务 helper、审计脱敏、审计 append-only、`channel=project-management` outbox 入队、审批用途 allowlist、adapter 收件人去重、完整交互卡和通知/审批机器人边界。
5. `tests/project-management-lifecycle.spec.ts` 覆盖 P2/P3 Task 草稿创建、幂等键冲突、Current Plan 持久化、激活、并发/过期锁拒绝、Revision 提交/驳回/取消/审批/直接生效、Planned Segment 待确认标记、Revision 生效后的 Segment 关联失效通知、Milestone Review TEXT/LINK 证据、FILE 证据拒绝、审批推进、Termination 四种 outcome、查询防枚举、审计和 `channel=project-management` outbox。
6. `tests/project-management-segments.spec.ts` 覆盖 P5 Segment 中文校验、本人/他人权限、乐观锁、真实 100 条批量在末项 stale 时对 Segment/change/audit/outbox 的事务回滚、逆序重叠批量输入的 `id ASC` 行锁顺序、split/merge 时间守恒和完整来源历史、merge 最终范围超过 31 天拒绝且恰好 31 天允许、full/partial confirm、一 Planned 多 Actual、多 Planned 一 Actual、无来源 Actual、并发 full confirm、并发 cron transition、cancel、soft delete、relink，以及 Segment 操作不改变 Task/Milestone。批量锁顺序用例外锁最大 ID，并通过 `pg_blocking_pids` 断言一条直接及一条间接等待链；full/partial confirm、cancel、soft delete 和 cron transition 竞争也通过独立 PostgreSQL 行锁屏障确认两个事务真实重叠，并断言最终状态及 change/audit/outbox exactly-once。
7. `tests/project-management-conflicts.spec.ts` 覆盖 P5 Conflict 半开区间、100%/100.01% allocation 边界、任意一条缺失 allocation 时的完整重叠证据、High/Critical、Owner/Lead、Revision overlap、Actual overload、fingerprint 幂等、显式人员名单预校验零写入、逐人失败隔离与 partial result、并发首次扫描、并发到期重开、消失后 resolved、`ignoredUntil` 到期重开，以及 scanner 自动解决来源判定。来源回归会在不篡改 `resolvedAt`/audit `createdAt` 的情况下让真实 scanner 自动解决后恢复原 fingerprint，验证并发只重开一次且 conflict history、audit、opened/resolved outbox exactly once；判定只允许当前 `resolvedAt` 周期下界起（含下界）恰好一条匹配的 CRON resolve audit 重开，并保留 createdAt 严格晚于 resolvedAt 的 legacy audit 与 stale actor、旧周期 audit、同周期多来源歧义、当前周期 audit 缺失、真实人工 resolve/apply 终态。scanner/manual 双向竞争会先改变 Segment 使原 fingerprint 确实 obsolete，再用 conflict row 外锁串起真实 person/conflict 锁链，分别断言系统或人工赢家、loser 的实际服务结果、数据库 actor/source 和 resolved outbox exactly once。查询回归同时覆盖部分可见 `MISSING_ALLOCATION` 的 list/detail DTO，确保隐藏 Segment 的 ID、Task、时间、内容和版本全部脱敏，而完整处理者仍可见合法证据。其余覆盖 acknowledge/resolve/ignore 权限与状态机、逐状态 capability、preview 完整处理权限且不写库、stale apply 零写入、apply 显式确认和 `expectedUpdatedAt` 校验，以及 outbox 只使用项目管理通知机器人。逐人扫描运行时失败会捕获真实 JSON structured logger 输出，断言 public DTO 与日志只保留稳定 `INTERNAL_ERROR`、安全中文和人员/action 诊断字段，不包含原始数据库异常、message 或 stack。并发用例使用独立 PostgreSQL 连接持有 advisory/row lock，通过 `pg_blocking_pids` 确认事务到达预期等待链后才释放，不依赖 sleep 猜测时序；barrier 操作从创建时立即挂接 `allSettled` observer，把同步 throw 托管为 rejection。清理先尝试有界 rollback；若失败则先强制关闭 locker 释放外锁，再有界等待同一 settlement；pending 超时时只允许在当前 `_test` 数据库取消由等待链精确观测到的 client backend PID，取消无响应时终止同一 PID，并在返回前等待 Prisma 事务 settlement。observer 与 locker 独立关闭，保留主错误为聚合错误首项。fake-client 单元式回归覆盖连接失败清理、同步 throw 和 rollback 失败顺序，真实超时回归另验证 backend 取消及 settlement，不污染后续串行用例。关键 barrier 用例以 `--repeat-each=3` 重跑验证确定性。
8. `tests/project-management-ui.spec.ts` 覆盖 P4/P6 `/progress` 总览、Task 工作台、资源时间轴、冲突中心、站内通知中心、桌面/移动视口、持久化状态和非成员拒绝路径。
9. `tests/feishu-boundaries.spec.ts` 必须继续扫描 `app/progress`、`app/actions/project-management`、`components/project-management`、`lib/project-management` 和项目管理 notification adapter，防止项目管理入口或领域服务直接导入飞书传输层。

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
