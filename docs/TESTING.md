# 测试手册

本文档用于人工测试、Playwright 仿真测试和 subagent 测试执行。执行测试时不要提交本地 cookie、截图、HTML 快照、数据库文件或 `.tmp/` 内容。

本文档同时定义全功能回归范围；页面 smoke 只覆盖主要入口和少量浅交互，不能等同于全功能通过。完整结论必须覆盖下述静态、业务闭环、并发和迁移层级。

## 全功能回归分层

- **L0 静态与构建**：`npm run check`、migration drift 和 `npm run build` 全部通过；warning 必须记录并分级。
- **L1 页面与权限冒烟**：匿名与登录状态访问首页、采购、反馈、项目管理、管理员和附件入口；Desktop `1440x1000` 与 Pixel 5 均无 500、Next error overlay 或横向溢出。
- **L2 单账号浅交互**：反馈筛选与 `selected`、采购列表与详情、项目管理规范 URL/筛选/画布、管理员筛选均可刷新复现，且控制台无未处理错误。
- **L3 业务闭环**：在独立 PostgreSQL 测试库中完成采购申请至报销、反馈创建/回复/关闭、Task/Project/Segment/审批以及管理员角色和预算流程；同时核对数据库、审计、outbox 和文件补偿。
- **L4 并发与一致性**：覆盖订单号、审批、Task/Segment 锁竞争、outbox claim/heartbeat/逐收件人重试、event key 幂等和飞书禁发/allowlist/机器人边界。

全功能环境至少准备申请人、车组组长、技术组组长、超管和报销员五类账号；采购各状态、待处理/处理中/已关闭反馈、多个 Task/Segment 状态、部分失败 outbox 与迁移前 fixture。所有写入场景必须使用 runner 创建的随机 `_test` PostgreSQL 和测试上传目录。

### 自动化测试定义清单

截至 2026-08-29，`tests/` 有两类可执行测试定义：7 个 `tests/*.node.ts` 文件（15 个 `node:test` 用例）和 76 个由 Playwright 收集的 `tests/*.spec.ts` 文件。文件清单按领域归类如下；Playwright 文件名省略统一的 `tests/` 前缀和 `.spec.ts` 后缀，新增、移动或删除测试时必须同步更新本节。

- **Node / cron 调度与处理器映射（2 个用例）**：`cron-schedule-wiring.node.ts`。
- **Node / 项目管理展示契约（5 个用例）**：`project-management-recent-activity-formatter.node.ts`。
- **Node / Composer 浏览器存储契约（2 个用例）**：`task-composer-legacy-draft-tombstone.node.ts`。
- **Node / Playwright repository topology 聚合契约（3 个用例）**：`playwright-test-topology.node.ts`。
- **Node / Playwright AST/spec policy 契约（1 个用例）**：`playwright-spec-policy.node.ts`。
- **Node / Playwright CLI selection 契约（1 个用例）**：`playwright-cli-selection.node.ts`。
- **Node / Playwright reporter 与真实 CLI 契约（1 个用例）**：`playwright-topology-reporter.node.ts`。
- **Playwright / 跨领域、基础设施与冒烟（10 个 spec）**：`business-flows`、`entity-picker`、`form-field-error-mapping`、`functional-panels`、`fuzzy-search`、`logger`、`next-image-config`、`root-layout-hydration`、`security-and-lifecycle`、`smoke`。
- **Playwright / 账号与管理员（4 个 spec）**：`account-management`、`admin-account-options`、`feishu-user-sync-action-result`、`feishu-user-sync`。
- **Playwright / 采购、报销与反馈写入（12 个 spec）**：`inactive-person-procurement-safety`、`processing-vendor-hook-races`、`procurement-budget-import-atomicity`、`procurement-budget-pool-dashboard`、`procurement-dashboard-spend`、`procurement-form-accessibility`、`procurement-import-dialog-races`、`procurement-notify-approver`、`procurement-pending-orders`、`procurement-shell`、`procurement-teacher-email`、`procurement-upload-atomicity`。
- **Playwright / 飞书与通知（7 个 spec）**：`feishu-boundaries`、`feishu-delivery-guard`、`feishu-message`、`feishu-procurement-card-stage`、`feishu-procurement-confirm-card`、`notification-outbox-adapters`、`notification-user-facing-copy`。
- **Playwright / 项目管理、迁移与发布（43 个 spec）**：原有 41 个 spec，加上 `project-management-query-pagination` 与 `project-management-ui-pagination`；后两者锁定通知、Task、风险、近期动态的复合游标稳定排序与对象/筛选锚点校验，以及 Desktop/Pixel 5 上首屏外记录的可达性。

每个 Playwright spec 必须使用 `.spec.ts` 文件名，在首行声明 `// @playwright-project node-db` 或 `// @playwright-project ui`，并在该 spec 内直接从 `@playwright/test` 导入 `test`（允许 import alias）。分类器会先扫描 Playwright 1.61.1 默认的 `**/*.@(spec|test).?(c|m)[jt]s?(x)` 名称；`.test.ts`、`.spec.tsx`、`.test.tsx` 和相应 JS/MJS/CJS/JSX/MTS/CTS 形式都会显式拒绝，不能在项目 `testMatch` 生成前被静默遗漏。共享 AST 分类器只静态追踪官方本地 binding：每次引用都必须是已批准 direct `test...()` API 的 root，test/suite/hook 注册 callback 必须 inline；本地/容器/factory alias、computed/间接 test API 和 `test.extend` 都会 fail closed。Playwright 1.61.1 的 `test.describe.fixme`、`test.describe.serial.only`、`test.describe.parallel.only` 及 `test.expect` 的 `soft`/`poll`/`configure`/`extend`/asymmetric matcher 入口均受支持；`test.info()`、configured/extended Expect 和 matcher 返回值可正常读取或调用。`test.skip`/`fixme`/`fail`/`slow` conditional callback 必须 inline，其中的 fixture 会参与分类；fixture key 使用 AST 解码后的标识符或字符串值，Unicode escape 不能隐藏 `page`/`browser`/`context`，computed key 会 fail closed。模块或 suite 注册阶段只允许官方 test API、未被局部绑定遮蔽且参数中不含可调用本地绑定的 Node 内建调用及少量确定性全局调用；能接收 callback 的 safe-global path、Promise 或未解析构造器、本地注册 helper、非 Node 导入、namespace 解构、callback 型 factory，以及 getter/解构/对象展开/custom iterator 等隐式注册期执行一律拒绝。它不虚称能跨模块追踪 custom fixture，只在无法证明绑定安全时 fail closed；Stage 3A 再统一 UI fixture。因此无需在配置或文档维护第二份 76 文件 topology 清单。分类器还会拒绝声明缺失/重复、node-db 文件使用浏览器 fixture、或 UI 文件完全不使用 `page`/`browser`/`context`。`node-db` project 收集 46 个非浏览器 DB/API/领域 spec 一次；30 个真正 UI spec 继续由 `desktop`（Desktop Chrome，`1440x1000`）与 `mobile`（Pixel 5）各收集一次。默认 reporter 始终拒绝实际收集中的跨项目或未分类文件，并在校验失败时先把整套已收集测试标记为 skipped、阻止测试体副作用，再由 `onEnd` 返回失败；默认、`--list`、纯 `--project` 以及 timeout/headed/retry/trace/output/quiet 等不缩小收集集的参数属于全集选择，会逐文件验证与所选 project 相交的全部 spec 完整出现。`--project` 的 exact、大小写不敏感和 `*` wildcard 行为由 runner/reporter 共用 helper，并以真实 Playwright CLI 回归锁定 `Desktop`、`d*`、`*`、split/equal 形式及错误状态。只有文件/行号、grep、grep-invert、shard、last-failed、only-changed、test-list/test-list-invert 属于局部选择，只放宽未选择文件和每个文件的完整 project 集合要求；未知长参数直接拒绝，不能借 partial 绕过全集校验。`.node.ts` 只由 `test:node` 收集。

Playwright 数据库 harness 另有两个独立验证入口：`npm run test:playwright-db-lifecycle` 负责不连接数据库的 runner 生命周期回归，`npm run test:playwright-db-safety` 负责真实随机 PostgreSQL target/shadow 的安全演练；二者不属于上述 76 个 spec，也不会由 `test:node` 重复执行。2026-08-29 使用官方 runner 执行 `--list` 的收集基线为 666 个 project-test：node-db 276、desktop 195、mobile 195，共 76 个文件；相较拆分前 934 个 project-test，去除了 268 个无意义的非浏览器移动端副本。命令退出 0、`notificationDeliveryDisabled=true`，随机 target/shadow、marker、3003 和进程组清理后残留为 0。该数字只证明测试收集成功，不代表 666 个用例已经执行通过。

用以下命令复核文件层基线和 Playwright 实际收集结果；Playwright 列表仍必须走官方 runner 和随机隔离数据库，不能直接调用 `playwright test` 绕过安全门禁：

```bash
rg --files tests | sort | rg '\.(node|spec)\.ts$'
npm run test:node
npm run test:e2e -- --list
```

### 自动化门禁分层

三层 Playwright 命令都必须经过同一个官方 runner，不允许直接调用 `playwright test`：

```bash
npm run test:e2e:smoke
npm run test:e2e:full
npm run test:e2e:nightly
```

- `test:e2e:smoke` 使用 Playwright 原生 `@smoke` tag，当前收集 44 个 project-test：1 个匿名/保护路由 suite、采购与项目管理导航、附件允许/拒绝、采购提交、反馈闭环、Project 入口、Task 创建/激活、飞书禁发和 outbox 幂等。UI 在 Desktop 与 Pixel 5 对称执行，且不依赖本地 storage state。该命令使用 `--grep`，属于局部选择，不能用它证明完整 topology 或全量回归通过。
- `test:e2e:full` 与兼容入口 `test:e2e` 都执行完整 76 个 spec，并保留 reporter 对全文件、全 project 收集完整性的严格校验。PR 合并前以及共享测试基础设施变更后使用这一层。
- `test:e2e:nightly` 执行同一完整集合，并设置 `PM_RUN_SCALE_TESTS=true` 打开既有 10k/100k 规模用例。聚合门禁 `npm run test:nightly` 还会依次执行 `check`、runner lifecycle、真实 PostgreSQL safety、nightly E2E 和 `build`；仓库不包含 CI 调度文件，定时触发由外部流水线配置。

`tests/` 不使用 `page.waitForTimeout`。普通加载、导航、保存、竞态完成和数据库传播必须使用可观察状态、受控 fixture 事件、`expect.poll`、URL/locator 或持久化状态同步；“完整时间窗内没有迟到副作用”改用 Playwright 虚拟时钟，“连续渲染帧内不漂移”改用 animation-frame 采样，避免真实时间睡眠造成慢测和偶发失败。

仍使用 `serial` 的 8 个 suite 都依赖进程级或跨用例共享状态，不能在未隔离这些依赖前机械并行：`business-flows` 与 `functional-panels` 复用 `beforeAll` 创建的业务主体和连续状态；`feishu-message` 复用全局网络 mock；`notification-outbox-adapters` 复用 adapter/时钟 mock 与 outbox 清理；`feishu-user-sync`、`account-management`、`inactive-person-procurement-safety` 验证并发锁、停用和权限状态；`procurement-upload-atomicity` 验证共享文件存储及补偿清理。后续解除 `serial` 时，必须先把对应全局 mock、数据库状态或文件目录改为逐用例隔离。

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
- 默认测试地址为 `http://127.0.0.1:3003`。配置中包含端口保护，禁止默认打到 3000。
- Playwright 启动的应用服务强制 `NOTIFICATION_DELIVERY_DISABLED=true`，并默认设置 `FEISHU_DIRECT_MESSAGE_ALLOWED_NAMES="李棋轩"`，防止测试期间误发给其他人；业务 outbox 仍保留完整候选收件人，投递层负责拦截。
- `npm run test:e2e` 的 POSIX script 先以空 `NODE_OPTIONS` 启动 `tsx`，runner 再无条件为测试 worker、受控 Next.js 服务及所有 Node/Prisma 后代注入 `CHECKPOINT_DISABLE=1`。调用方 `NODE_OPTIONS`（其中的 `--require`/`--import` 会在 guard 前执行）不会传给 runner 后代，而是严格重建为受控 sentinel 与 cwd 绑定官方 guard 的绝对 import；继承 probe output/role 同样清空，仅 runner 直接拥有的 server 进程组可写固定 repo `.tmp` probe。已能控制父 npm 进程的同 UID 主体不属于此 harness 的认证边界。guard 会在标准 `fetch` 及 `node:http` / `node:https` 的 `request`、`get` 入口拦截 `*.feishu.cn` / `*.larksuite.com` / `*.larksuite.cn`，未显式 mock 的测试必须立即失败，且 guard 自测只能使用预取消 signal 或建连前失败的本地 agent，禁止把 DNS、socket 等真实网络错误充当阴性证据。该入口级 guard 是测试禁发的补充防线，不能覆盖先访问非飞书地址后由底层自动重定向、绕过标准入口的 custom transport、原始 socket 或非 Node 外部进程，因此测试仍须保持 `NOTIFICATION_DELIVERY_DISABLED=true` 并显式 mock 外部调用。禁发开关与 guard 不改变生产 callback 的身份读取语义；callback 身份测试必须提供隔离库中的可信假 `union_id`（包括 approval bot 与登录 bot 的跨应用映射）或显式 mock 通讯录查询。
- 默认从 `.env` 的 `DATABASE_URL` 只提取本机 PostgreSQL 的凭据/authority，URL 路径不会被访问，也不会成为测试库名。需要覆盖账号或端口时可显式设置 `PLAYWRIGHT_DATABASE_URL`，它优先于 `DATABASE_URL`；显式值无效会直接失败，不会静默回退：

  ```bash
  npm run test:e2e

  # 可选的显式凭据来源覆盖
  PLAYWRIGHT_DATABASE_URL="postgresql://postgres:<密码>@127.0.0.1:5432/credential_template" \
    npm run test:e2e
  ```

  `npm run test:e2e` 是 POSIX-only 官方入口；Windows 因无法在当前实现中可靠保证整个进程树终止，会在 marker/child 创建前拒绝。每次执行会生成新的密码学随机 token 和独立 secret，以 token 构造一对不同、以 `_test` 结尾的 target/shadow，并用 token 唯一 `O_EXCL` marker 绑定精确 pair 与连接摘要。继承的静态路径/shadow/source/clone/reuse/skip/确认变量均被覆盖。runner 强制官方 config、reporter、单 worker、`recreate`、`127.0.0.1:3003`、禁通知/checkpoint 和 guard；所有调用方 short option（包括 `-xcalternate...`、`-xc alternate...`、`-xj4`、`-xj 4` 等 Commander cluster）都会拒绝，`--config`、`--workers`、`--fully-parallel`、`--reporter`、`--ui*`、`--browser` 的分离值/等号形式也全部拒绝。按安装版 1.61.1 使用的 namespace，非空 `PWDEBUG*`、`PWPAUSE`、`PWTEST_*`、`PWMCP_*`、`PW_*` 以及仓库 allowlist 外的 `PLAYWRIGHT_*` 环境都会在 port/marker/server/CLI/cleanup 前失败；这包括 `PWDEBUG`、`PWTEST_WATCH` 和远程浏览器的 `PW_TEST_CONNECT_WS_ENDPOINT/HEADERS/EXPOSE_NETWORK`，空值也不会传入受控后代。clone 脚本在加载数据库代码前 hard reject。

  `scripts/setup-playwright-db.ts` 与 `scripts/cleanup-playwright-db.ts` 的直接调用同样 fail-closed：公开 token/确认值不够，仍须匹配当前 marker、secret hash、连接摘要及精确 pair；路径逐层拒绝 symlink/不安全 owner 或 mode，leaf/file 必须精确 `0700`/`0600`，file 还须 single-link、regular、大小受限且 inode 稳定。setup 部分创建失败会补偿两个精确名称；cleanup/补偿仅在全部数据库操作成功后删除 marker，任何 drop/unlink 失败均非零且 marker 保留。普通 `SHADOW_DATABASE_URL` 从不作为输入。marker 防误用、cross-run 和公开 token 单独删除，但同 UID 或已有工作树写权限的恶意主体可读取/篡改文件与进程，不是此机制声称抵御的认证边界。

  runner 不再让 Playwright 通过 built-in `webServer` 创建 runner 看不见的 detached 组：它先在 marker 创建前确认 3003 未被占用，再独立启动并拥有 server 组，确认受控 HTTP readiness 后，启动无 built-in server 的 CLI 组。`SIGINT`、`SIGTERM`、`SIGHUP` 第一次同时转发给已存在的两组，第二次（同/不同信号）或 5 秒超时分别升级 `SIGKILL`；正常结束、CLI/server 自发 exit/error 和 pre-child signal 都必须先确认 server 与 CLI 两组退出。端口检查只辅助 availability/readiness/诊断，不能替代进程组静默证明。任一组无法 quiesce 时，runner 跳过 DB cleanup、非零退出并保留 marker，而不会删除仍被活动后代使用的库。cleanup 错误递归展开叶子原因并经统一 redaction 逐条记录；入口先设置 129/130/143 fallback 再尝试重触发原信号，因此 `tsx`/handler 忽略信号或 kill 抛错也不会返回 0。直接 runner `SIGKILL`、崩溃、OS 故障或断电仍可能跳过 cleanup；此时禁止前缀删除，只能由 DBA 只读确认精确名称后处理。

  修改 Playwright 数据库 harness 后，先运行不连接数据库的 runner/lifecycle 回归，再用同一本机凭据运行 PostgreSQL 安全演练：

  ```bash
  npm run test:playwright-db-lifecycle

  PLAYWRIGHT_DATABASE_URL="postgresql://postgres:<密码>@127.0.0.1:5432/credential_template" \
    NOTIFICATION_DELIVERY_DISABLED=true \
    CHECKPOINT_DISABLE=1 \
    npm run test:playwright-db-safety
  ```

  lifecycle 命令真实启动 `scripts/run-playwright.ts` 验证危险 CLI/short cluster 和上述 hostile Playwright 环境在端口检查及 marker/child 前失败，并断言 server、CLI、cleanup 和 marker 目录完全未触及；它也证明历史 self-test 环境名不能绕过 runner 且不会传给受控后代，正式入口没有 caller 可选择的测试分支。独立的 `verify-playwright-runner-finalizer-entry.ts` 只验证共享 production finalizer 的三种信号内核终止或 129/130/143 fallback、原信号日志、嵌套 cleanup 根因展开与凭据/secret redaction，不宣称它执行了正式 runner 数据库生命周期；clone 是另一个真实 hard-reject 子进程。lifecycle 会真实创建两个独立 POSIX 进程组，以占用 3003 的 detached server 分别覆盖 CLI 自然失败、首次信号超时升级和第二信号强杀，并在 server 尚未静默时断言 cleanup 未调用、marker 与注入的精确 pair 所有权仍保留，静默后才允许清理；另有 parent 自发退出、同组 descendant 继续占端口的回归。marker 的 symlink、mode、owner policy、hardlink、oversize/content、inode swap以及 direct setup 部分补偿、drop/unlink failure 使用 deterministic 文件/注入 seam，不冒充真实数据库故障。PostgreSQL 演练除随机双 pair、相似 sentinel、非法 setup/cleanup、并发 recreate、direct cleanup、pair 隔离外，还用真实随机 target/shadow 重跑上述三种 detached 双组场景，逐次证明活动 server 期间 DB/marker 保留，双组静默后 cleanup 恰好一次且 DB/marker/3003/进程组残留为 0；命令不会访问 source 或发送飞书。

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

Node 测试定向开发时可单独执行：

```bash
npm run test:node
```

每次提交前至少执行统一入口（其中已经包含一次 Node 测试，不需要再重复执行）：

```bash
npm run check
```

`npm run test:node` 会先运行纯 synthetic 安全 verifier，再自动发现、排序并只执行一次当前全部 `tests/*.node.ts`；任一验证失败、用例失败或没有匹配文件都会非零退出。Node runner 会清除数据库、通知和邮件等危险继承变量，重建飞书出口 guard，并强制关闭真实投递。当前 15 个 Node 用例不启动浏览器、不连接测试数据库：topology 回归锁定 30/46/76 分类、AST/spec policy、仅单一类别时的 fail-closed 行为、CLI selection 与 reporter 归属，cron wiring 回归锁定七条 schedule→handler 映射、`Asia/Shanghai` 时区和错误路由。`npm run check` 还依次执行 Prisma validate、应用与脚本 TypeScript、源码依赖门禁、全量 ESLint 和 `git diff --check`。数据库或生产构建相关改动再额外执行：

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
npm run test:e2e -- tests/project-management-p1.spec.ts tests/project-management-lifecycle.spec.ts tests/project-management-segments.spec.ts tests/project-management-resource-removal-migration.spec.ts tests/project-management-ui-composer.spec.ts tests/project-management-ui-workbench.spec.ts tests/project-management-ui-resource-planner.spec.ts tests/project-management-ui-routes-responsive.spec.ts tests/project-management-collaboration.spec.ts tests/notification-outbox-adapters.spec.ts tests/feishu-boundaries.spec.ts
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

所有新增或修改的表单验证场景还必须在配置的 Desktop `1440x1000` 与 Pixel 5 项目中检查：

- 初始控件没有 `aria-invalid="true"`，也不提前显示字段错误。
- 空值提交后首个错误控件获得焦点，错误控件出现 destructive 边框/ring，并用 `aria-describedby` 关联可见中文 `role="alert"`。
- 选择器、文件输入、日期时间控件和原生输入遵循同一行为；一个跨字段约束只渲染一个警报，所有相关控件共同引用它。
- 修正一个字段只清除该字段错误，其他尚未修正的字段保持标红；服务端 `fieldErrors` 不重复显示为全局 notice。
- 长错误文本、窄屏、滚动容器和弹窗中首个错误均可见且无横向溢出；提交后的 loading/disabled 状态不覆盖错误提示。

基础巡检路径：

- `/`
- `/login`
- `/profile`
- `/procurement`
- `/procurement/list`
- `/procurement/dashboard`
- `/procurement/new`
- `/progress`
- `/feedback`
- `/admin`
- `/not-exists-for-test`

404 页面期望：显示“页面不存在或无权访问”、有“返回首页”按钮，并能自动或手动回到 `/`。

## 采购模块测试

1. `tests/procurement-shell.spec.ts` 在 Desktop 与 Pixel 5 验证 `/procurement` 重定向到看板、四项侧栏/抽屉导航、折叠与关闭焦点、导航后抽屉关闭、订单详情归属“订单列表”；四个导航面板和确定性草稿订单的详情、编辑页还会断言顶部为“采购管理”上下文命令栏、标题正确、不存在返回链接，并检查无横向溢出和浏览器异常；详情页另验证状态与可用操作位于命令栏。该用例验证导航中不存在“工坊加工费”，`tests/functional-panels.spec.ts` 另验证旧 `/procurement/workshop-fee` 返回 404。`tests/inactive-person-procurement-safety.spec.ts` 验证停用账号的侧栏/抽屉隐藏“新建申请”、直达写入路由被重定向或返回 404、历史草稿可读且无继续编辑、提交、上传、确认或催办入口。
   `tests/functional-panels.spec.ts` 还会在两个项目中创建 `isWorkshopFee=true` 的已完成历史订单，验证普通用户仍能从列表展开明细并进入详情，看到工坊徽标、加工费种类和加工商；页面只读访问前后订单及明细记录必须完全不变。
2. `tests/procurement-pending-orders.spec.ts` 验证 `/procurement/pending` 的当前处理人过滤、待办和最近订单；`tests/procurement-budget-pool-dashboard.spec.ts` 验证新 Excel 无技术方向列、同兵种组聚合历史预算行、看板一组一栏及项目说明。

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

### 附件权限

1. 未登录访问 `/uploads/...` 应返回登录页或 401。
2. 无关登录用户访问无权限附件应返回 403 或 404。
3. 有权限用户可打开订单附件、报销截图、签名图片。

## 项目管理 P4/P6 UI 测试

1. 桌面 `1440x1000` 与 Pixel 5 分别打开 `/progress`，应展示“我的工作”指标、完整个人时间画布、最多 8 条行动待办、参与 Task、到期确认队列和折叠通知；导航中不得再出现独立“我的时间”或“资源冲突”。旧 `/progress/my-timeline` 必须返回 404。
2. 打开 `/progress/tasks`，默认勾选“只看我参与”并选择“进行中”；按人员范围、状态、优先级和关键词筛选时，只展示当前 actor 可读 Task，且仍可手动取消默认筛选；不可读 Task 不能通过列表枚举。
3. 打开 `/progress/tasks/[id]`，应看到三层详情结构：概览；完整的“计划与人员投入”（时间画布及共享节点导航）；以及桌面端“Task 风险与评论 / 待处理 Revision、选中节点详情和风险录入 / 近期动态”三栏。低于 `xl` 时第三层按“主体详情 → 风险与评论 → 近期动态”单列排列，审批门禁和全局操作反馈保持在概览与时间线之间。全部有效成员及其全部投入继续展示；有效 TaskMember 按服务端 capability 创建或管理投入，旁观者只读；Project 详情的投入保持只读。投入悬浮提示必须显示关联 Task，未关联时显示“独立投入”，Busy 不得显示 Task。页面不得下发 raw 审计列表。Task Owner/Participant 可在 ACTIVE 状态提出和解决风险，普通旁观者只能查看风险但仍可评论；只有全局管理员显示评论删除入口。Active Task 编辑 Dialog 继续使用一次事务保存基本信息和成员，并保持原有并发保护。
4. Desktop 与 Pixel 5 打开 `/progress/resources`：两者都渲染横向时间画布且页面无横向溢出。Desktop 未保存虚线创建草稿可横移、调整两端和拖到当前可创建 Person 行，整个过程中不得调用服务端 transform mutation；Pixel 5 不提供直接拖动，但必须可通过表单改人员、时间、内容和预期产出后创建。既有投入总览只读；双击或 Enter 打开宽版详情，基本信息必须明确展示类型、状态、所属人员与关联 Task（关联 Task 可直达详情），完整上下文可见且只有目标 Segment 可编辑。草稿或详情有未保存修改时 Esc/关闭必须确认，失败时表单必须保留。资源选择和视口状态由 URL 保存，时间范围由已选内容自动派生。
5. Planned 完整确认后只显示 Actual；完整确认、前缀部分确认和批量确认都必须填写实际输出，预期输出不重复填写并由 Actual 继承 Planned。前缀部分确认不显示也不要求原因输入，仍须填写实际投入内容、固定开始点并只生成一条尾段；尾段继续保留原预期输出。缺少实际输出、部分确认缺少实际内容或伪造中间起点必须在服务端零写入拒绝。确认、取消、Actual 软删除仍需验证数据库、来源、中文安全 change DTO、audit、站内通知与 outbox；历史分页不得下发 raw `before/after`、账号 ID 或无权读取的 Task 名称，测试环境必须禁用真实飞书投递。普通 DTO、表单和最终数据库均不得包含 `completionPercent`；迁移前非空值只能从 append-only 领域审计查询。
6. `/progress` 默认只显示全部 ACTIVE 参与 Task；切换“显示全部”后显示全部草稿和终态，Task 表、版本/当前节点和 Plan 行同步且不分页；行动待办保留 Segment confirmation 数量但不把它计入 `criticalCount`，逾期当前 Task 节点计入 `criticalCount`，到期队列“处理”必须打开统一详情而不是第二套确认表单。页面不再出现日期、日/周视图或日期平移控件。验证所有 TimeCanvas 在没有显式尺度时默认显示周，URL/调用方尺度仍优先；Task 节点聚焦和 Resize 不得出现尺度跳变。工具栏保留周/月/季/年与“今天”，不显示前后箭头，并验证多级上海日期轴及独立底部滚动条。内容驱动页即使全部内容远离今天，也必须能通过“今天”加载并定位今天附近，同时保持尺度。有效 Planned 的创建/更新必须重新计算内容范围、在两端增加两个上海日历月、加载目标及相邻块并保持当前视口；已确认/已取消 Planned 不扩展范围。浏览器前进/后退后筛选控件必须与 URL 一致；投入详情有未保存修改时，服务端刷新或 `rowPageKey` 变化不得直接丢弃表单。
7. 在 Desktop `1440x1000` 与 Pixel 5 上分别验证响应式冻结行标题、页面无横向溢出、底部滚动与顶部日期轴/时间对象同步。覆盖空数据、超长名称、跨年、超过 366 天、三年裁剪提示、单块自动二分和 20,000 对象/16 块预算错误；测试不得联系真实飞书服务。
8. `/progress/task/:id`、`/progress/kanban`、`/progress/my-timeline`、`/progress/resources/conflicts`、`/progress/tags` 与 `/admin/roles` 必须返回 404。资源计划默认显示全部，也可按 Project/Task/人员多选；验证集合并集、超过 25 个 Task 和 50 个人员仍一次完整装配、只读 Plan 与可交互 Person 混排、焦点固定、空选择、已确认/已取消 Planned 不返回也不渲染，以及内容两侧两个上海日历月和 180 天自适应块。旧 `taskCursor`/`personCursor` 必须被忽略并从规范 URL 移除。我的工作和 Task 工作台不得出现冲突标记、投入比例或完成比例；重叠 Segment 不得产生冲突待办、通知或 outbox。
9. 打开 `/progress/notifications`，只展示当前收件人的站内通知；可按类型/未读筛选、标记单条或全部已读，跳转对象前仍要按业务对象权限过滤。
10. 页面不得出现旧项目、阶段、周报、提醒或 `PROJECT_MANAGER` 角色文案；当前风险区不得出现旧 Stage 风险或计划节点绑定入口。页面不得出现 500、Next.js error overlay、未处理浏览器错误或横向滚动。
11. `/progress/projects/*` 与 `/progress/tasks/*` 是当前正式路由；旧路径不得重定向。带 `timelineDate`、`timelineFocus`、单值 `personId`/`taskId`、`start`/`end` 或 `zoom` 的链接应忽略这些值，并将其从规范 URL 移除；`focus`、`center`、`scale` 与复数资源选择继续保留。收缩 migration 集成测试仍需验证历史旧表、旧 enum、`PROJECT_MANAGER` 数据和 `channel=progress` outbox/recipient 被删除；HEAD 还必须证明新 Project 不含 Stage、`ownerOpenId` 等旧签名。
12. Project/Task 生命周期、审批、风险和评论通知的飞书按钮与站内通知必须使用同一个规范目标：Task 使用 `/progress/tasks/[id]`，Project 使用 `/progress/projects/[id]`，同时存在 `taskId/projectId` 时 Task 优先，不得回到“我的工作”。Terminal 的合法 `focus`、Project 立项的 `#establishment` 和 Segment 的 `/progress?focus=[segmentId]` 继续保留；已删除 Task/Project 分别回到对应列表。浏览器冒烟需验证登录后直达详情及未登录认证后的回跳，不要求定位单条风险、评论或审批记录。

### 待办与审批专项测试

1. `tests/project-management-s8.spec.ts` 验证 Action Inbox 不返回 `TERMINATION`/“任务结束申请”，而是为在职有效 OWNER/PARTICIPANT 返回 ACTIVE Task 的 Current Plan 当前节点。Milestone 必须匹配 `activeMilestoneNodeId`；进入结束阶段后返回 ACTIVE Terminal。DRAFT、终态、已删除 Task、已移除成员、旁观者、管理员非成员、候选/历史 Plan 和停用 actor 均不得获得当前节点。
2. 相同 Milestone 存在未撤出的 `PENDING` Review、相同 Terminal 存在 `PENDING` Termination Review 时，成员当前节点必须隐藏；全局管理员只看到对应审批项。待处理 Revision 不隐藏当前节点。逾期当前节点为 `CRITICAL` 并计入 `criticalCount`，未逾期为 `MEDIUM`。
3. 混合数据流使用小页循环加载，断言全局顺序、无重复、无缺口且 `generatedAt` 跨页保持不变；格式错误、字段注入、校验被破坏和跨 actor 游标均返回中文 `VALIDATION_ERROR` 与安全字段错误。只有带非空 `fieldErrors.cursor` 的 `VALIDATION_ERROR` 才表示游标失效；其他校验错误不得误导用户重新加载队列。游标锚点离开当前队列后应拒绝；客户端保留已加载内容，但不再重放失效游标，而是通过“重新加载队列”无游标获取并整体替换为新的权威首屏。普通网络失败仍保留原游标供重试。
4. `tests/project-management-ui-routes-responsive.spec.ts` 在 Desktop `1440x1000` 与 Pixel 5 验证完整行包含类型、严重度、标题、摘要、Project/Task、Node 类型/状态、相关时间和明确操作按钮；空列表、超长内容和无页面级横向溢出均受覆盖。创建 55 条待办时首屏只展示 50 条；已加载的非锚点退出队列时，游标仍有效且 APPEND 必须保持首屏统计与 `generatedAt` 快照，只追加 items 和更新 `nextCursor`。已消费锚点退出队列后，加载更多必须显示结构化中文错误并保留 50 条旧内容，“重新加载队列”恢复为无该锚点的新首屏，随后网络失败仍可用原游标重试并无重复、无缺口地加载全部剩余项；返回 `/progress` 只预览 8 条。

### Project 立项专项测试

1. `/progress/projects` 无参数时默认“只看我参与 + 进行中”，显式 `mine=0&status=` 可取消默认；Desktop 和 Pixel 5 均无横向滚动。
2. 普通账号可提交完整立项但不能审批；两类全局管理员可通过或驳回。驳回保留同一 Project，原申请人可修改并创建新轮次。
3. 立项提交不改变所选 Task；批准时全部 Task 原子挂载，冲突时零部分写入。Task 成员同步为 Project Participant，Project Owner 不获得 Task 写权限。
4. 空 Project 可以直接结束；未删除的 `DRAFT` 或 `ACTIVE` Task 会阻止结束，仅包含 `COMPLETED/FAILED/CANCELLED/TIMEOUT/ARCHIVED` Task 时允许结束。阻塞请求必须零写入，详情阻塞数必须精确且明细最多 10 条，Task 完成进度仍只统计 `COMPLETED`。软删除保留 Task 并清空 `projectId`，删除对象直达返回脱敏 404。
5. 头像只接受真实 PNG/JPEG/WebP 且不超过 2 MiB；所有自动化测试继续使用禁通知环境，不发送真实飞书消息。
6. Desktop `1440x1000` 与 Pixel 5 打开 `/progress/projects/[id]`：概览只显示头像、名称、完整内容、状态、负责人、参与人和 Task 完成进度，权限操作位于右上；不得显示立项历史或 raw 审计卡片，但 `#establishment` 仍定位审批区。第二层为与概览左右对齐的全宽时间线，只包含本 Project Task 的 Current Plan，同时展示 Project/Task 全部有效成员在其他 Task 和独立投入中的完整时间。第三层在桌面端按“Project 自身及所属 Task 风险与 Project 评论 / 全量 Task 列表和风险录入 / 中文近期动态”三栏展示；低于 `xl` 时按“Task 列表和风险录入 → 风险与评论 → 近期动态”单列排列。Task 列表按“草稿 → 进行中 → 所有终态”展示；已完成节点使用绿色勾选，未完成节点保留普通圆点。定位按钮仍选择当前进行中的非 Revision 节点，没有 Active 节点时回退到 Start；范围外目标通过规范 `focus` / `center` 回载后，应滚动到时间线并聚焦目标。两种视口都要验证无横向溢出、全量 Task/人员投入和投入悬浮 Task 信息。

### 风险、评论和近期动态专项测试

1. ACTIVE Project/Task 的负责人、参与人和两类全局管理员可以提出及解决直接风险；普通旁观者服务端返回 `FORBIDDEN`。DRAFT、待审批和终态不能提出风险，ACTIVE 与终态可解决既有 `ACTIVE` 风险。
2. 同一对象创建多条未解决风险，逐条解决并验证风险表状态、解决人/说明/时间、领域审计、站内通知、durable outbox、recipient、非 mandatory 和稳定事件键。`risk_created` 与 `risk_resolved` 均通知直接目标的负责人、参与人、活跃全局管理员和操作人并按账号去重；操作人关闭对应飞书偏好后仍有站内通知但不进入飞书 payload。Task 事件不得扩散给仅属于其 Project 的成员。并发重复解决只能成功一次。
3. 所有已登录用户可在未删除 Project/Task 发表评论；发布后验证 `comment_created` 的站内通知与 durable outbox，收件人同样为直接目标成员、活跃全局管理员和操作人并按账号去重；必须覆盖成员操作人、管理员操作人及非成员评论者，且三者使用相同偏好规则。只有全局管理员可软删除；删除后普通列表不可见，但正文、删除人、删除时间和删除审计仍在数据库，不得产生站内通知或 outbox。
4. 风险和评论首屏及加载更多均为 20 条，游标同时约束 `createdAt + id`，跨目标或筛选游标必须拒绝。Project 自身风险和当前所属 Task 风险分别计数、分页；Task 移出后不再进入原 Project 风险区。
5. Project 动态包含自身事件和事件发生时所属 Task 的白名单事件；Task 移动事件在新旧 Project 两端可见。既有缺少 `projectId` 的普通 Task 审计不回填且不进入 Project 动态，未知 action 隐藏。
6. 切换动态分类后必须由服务端重新查询；版本 token 变化触发刷新，页面隐藏暂停、恢复可见立即检查，失败保留当前内容并重试。Desktop `1440x1000` 验证长正文、长姓名、空状态、无 error overlay 和无横向滚动。
7. 自动化始终由官方 Playwright runner 创建隔离数据库并设置 `NOTIFICATION_DELIVERY_DISABLED=true`；飞书 HTTP 必须显式 mock，并解析交互卡片断言按钮的完整绝对 URL，覆盖 Project、Task、Task 优先、删除对象列表回退及旧 `/progress` outbox 推导，不得使用开发/生产数据库或真实飞书投递。

近期动态 formatter 的无数据库纯映射回归可单独执行：

```bash
npx tsx --test tests/project-management-recent-activity-formatter.node.ts
```

### Task 创建页专项测试

自动化和人工检查都必须使用隔离测试数据库并保持 `NOTIFICATION_DELIVERY_DISABLED=true`。创建 Composer 必须覆盖 Start/Milestone/Terminal 严格时间顺序、0/200/201 节点、临时与非法节点、Inspector、撤销/重做、Desktop TimeCanvas、移动端纵向编辑，以及 v4 localStorage/IndexedDB 恢复、账号/环境隔离、Web Locks、多标签页离开保护和成功清理。

1. 桌面 `1440x1000` 打开 `/progress/tasks/new`：页面按 Task 信息、TimeCanvas、共享节点导航、节点 Inspector 纵向排列，初始计划只有 Start 和名称为 `Terminal` 的 Terminal；负责人和参与人员分别显示头像胶囊及独立搜索框，不再使用统一人员选择器加角色下拉框；不得出现桌面节点表、节点复制、批量选择/删除、独立校验按钮，也不得查询或展示成员 Planned、Actual、Busy 数据。
2. 验证旧 `start` 参数被忽略并从规范 URL 移除，`relatedTaskId` 和 `templateTaskId` 仍可预填且不回退。无模板时 Start 为上海时区次日 `09:00`、Terminal 为 Start 后 14 天；模板保留 Milestone 内容、时间和自定义 Terminal 名称。
3. 分别创建含 0、1、200 个 Milestone 的 Task，并通过服务端和数据库验证 Current Plan、严格 sequence、Terminal 名称、显式成员集合、审计，以及仅在有成员时产生的站内通知和 outbox；创建者不得被隐式写为 Owner。201 个 Milestone 必须在客户端与服务端被拒绝。创建失败保留草稿和幂等键，成功清理本地草稿并跳转工作台；还要验证无前缀旧版创建 hash 可幂等重放、带版本前缀的新 hash 仍拒绝成员角色变化。
4. 构造 Start=首个 Milestone、相邻 Milestone 同刻、最后 Milestone=Terminal 和任意逆序输入；新建、Draft 替换、模板副本与 Revision 目标均不得保存。已有只读/Active 旧同刻计划仍可打开并显示兼容提示，不得被自动改时。
5. 验证 Terminal 名称 trim 后空白、200/201 字符边界；自定义名称在创建、Draft 编辑、Revision、模板复制、查询、工作台、版本差异、审计和快照中保持一致。默认 `Terminal` 不改变既有 canonical hash，自定义名称及其变更必须改变 hash。
6. Revision 创建必须直接进入待审批；分别验证 `revisionAt` 等于 Start、Candidate Terminal、最后完成 Milestone 和上一条有效 Revision 时允许，越界时事务零写入。驳回后修改应直接重新送审且 `reviewRound + 1`，不存在 Draft 或单独 Submit。分别从待审批和已驳回状态取消，验证 `revision_cancelled` 使用通知机器人并直达 Task，创建人、OWNER、操作人和活跃全局管理员按账号去重；所有轮次未完成审批 outbox/recipient 置为 `CANCELED`、旧站内审批已读、已发送记录保留，重复取消 exactly once。还要覆盖 PROCESSING outbox/recipient 与 worker 的 outbox→recipient 并发锁序、收件人解析后状态变化的发送前复核，以及无 round 旧消息不得在第 2 轮误发。
7. 批准前 Revision 只出现在历史；批准后才进入 Current Plan 时间轴。Revision anchor 不增加阶段带，所有 Segment 新建、批量新建、更新和重关联入口均拒绝 Revision 节点。
8. 在画布与共享节点导航选择 Start、Milestone、Terminal；画布高亮、节点导航、Inspector 和所选节点的前置阶段块必须双向同步。从节点导航选择节点时，桌面 TimeCanvas 必须自动横向滚动，将对应时间点带入可视区。阶段块可点击并选择其下一节点；零 Milestone 时点击 Start → Terminal 阶段应选择 Terminal 并高亮整段。
9. 从空白画布快捷菜单新增 Milestone、移动 Terminal；非法时刻的操作保持禁用并显示原因。新增 Milestone 应立即以琥珀虚线临时节点进入画布和共享节点导航，前后两段阶段块同时标记临时；补全必填项后自动转正。
10. 拖动及键盘移动 Start、Milestone、Terminal，分别验证小时档 30 分钟、日/周档 1 天、月档 7 天吸附和上海时区增量。拖动预览期间节点前后阶段块必须同步伸缩，Milestone 穿越时按预览时间重排连接；Start、Terminal 与 Milestone 的严格边界必须在预览阶段钳制，锚点不得先越界再于松手后回弹。无合法吸附位置时保持原值并提示放大画布或使用 Inspector。
11. Inspector 不显示保存/取消；Start、Terminal、Milestone 输入实时同步到画布、节点导航和自动校验。清空或输入同刻/越界时间时，字段与问题摘要显示错误而画布保留最后合法位置；同一节点连续修改多个字段只需一次撤销即可整体恢复。
12. Milestone 只能在节点详情中单独删除；临时节点切换后保留并可显式删除，Start/Terminal 永远不可删除。页面不得出现节点复制、勾选或批量删除入口。
13. 刷新页面后恢复 v4 临时节点、最后合法画布位置与选中节点，并验证 v4 Inspector 工作副本转换为实时临时节点。预置 v1/v2/v3 localStorage 与 IndexedDB 数据后不得出现恢复或导出提示，tombstone 最终删除旧数据；当前 v4 草稿仍完整恢复。另用 200 个 Milestone、每个四项 2,000 字符且包含 JSON 转义字符的极限草稿验证 IndexedDB 正文、`localStorage` 指针、刷新往返、两个同账号标签页并发“保存并离开”、立即“放弃并离开”不会被待触发防抖重新写回，以及创建成功后的双存储清理。
14. 创建零 Milestone Task 后执行激活：Task 和 Terminal 均为 `ACTIVE`，`activeMilestoneNodeId=null`；工作台和列表使用 Terminal 名称/日期，审计和激活通知使用 Terminal 名称，不显示“当前没有 Active Milestone”。OWNER/PARTICIPANT 提交结束申请后 Task 仍为 `ACTIVE`，全局管理员批准才在同一事务结束 Task，并写审计和 `project-management` outbox。
15. Task Composer 与 Task Workbench 的共享节点导航验证节点符号、选中/完成/错误态和上海日期；使用长 Task/Terminal/Milestone/成员名称、长错误、慢提交、空列表和 200 节点验证桌面无页面级横向滚动、无 Next.js overlay、无未捕获浏览器错误，Inspector 和节点导航滚动/换行可用。
16. Pixel 5 上共享节点导航改为纵向；仍能创建零 Milestone Task、编辑 Terminal 名称、修正严格时间错误，并验证无横向滚动、重复焦点、服务器错误或未捕获浏览器错误。

### DRAFT Task 统一编辑专项测试

1. Owner 从 DRAFT 工作台右上角进入 `/progress/tasks/[id]/edit`；按钮顺序为“编辑 Task → 激活 Task → 删除草稿 → 复制链接”，工作台不再出现“编辑 Draft 计划”，DRAFT 的概览、成员和计划均无保存控件。删除草稿只对 Owner/全局管理员显示，需二次确认并软删除 Task；激活后编辑与删除草稿按钮都消失，直达编辑 URL 重定向工作台；不可查看或无 metadata 更新权的用户直达 URL 得到脱敏 404。
2. DRAFT 激活使用事务内服务端时间复核 Current Plan 的 `plannedStartAt`；开始时间在未来时必须拒绝且 Task、节点、审计、通知和 outbox 零写入，开始时间已到达时保持既有激活流程。已经离开 DRAFT 的历史 Task 不追溯处理。
3. 编辑页在 Desktop 与 Pixel 5 均复用纵向 Composer，并回填元数据、关联 Task、全部现有 Owner/Participant（包括停用人员）、Start、既有 Milestone/Terminal 及节点 ID。负责人和参与人员使用与创建页相同的分组头像胶囊和独立搜索框，选择人员即加入对应分组。最终 schema 不存在 `LEAD/MEMBER/REVIEWER/VIEWER` 运行时成员，旧事实仅在领域审计中查询。关联选择器排除当前 Task。
4. Owner 一次修改基本信息、关联 Task、成员、既有节点、新 Milestone 和 Terminal 后保存；数据库全部更新、既有 nodeId 保留、新节点产生稳定映射、`snapshotHash` 更新、Task `lockVersion` 仅增加 1，并只产生一条 `pm.task.draft.update` 审计。失败时任一区域都不得部分提交，且不得产生站内通知、outbox 或真实飞书调用。
5. Participant 可进入编辑页并保存元数据与计划；成员区只读、没有搜索/添加/移除/角色控件，请求省略 `members`，数据库成员保持不变。直接伪造 `members` 或移除有关联 Segment 的成员必须被服务端拒绝并完整回滚；Segment 不再关联节点，因此删除草稿节点不受 Segment 阻挡。
6. 未修改时桌面和移动主保存按钮均禁用；选择节点不应被视为内容修改。客户端和服务端字段错误定位相应区域，无法映射的业务错误显示中文提示。保存成功清理该 Task 编辑草稿并返回新版 Task 工作台，展示权威最新数据。
7. 编辑草稿按环境、账号和 Task ID 隔离；刷新仅在 Task、Plan Version 和基础 lockVersion 全匹配时允许恢复。失去成员管理权后，恢复必须以服务端标准成员覆盖本地成员改动，同时保留其他可编辑内容。服务端版本变化后旧草稿不能恢复或覆盖，只能导出或“放弃并加载最新版本”；`STALE_TASK` 保留当前输入，不隐式刷新或合并。
8. 领域测试覆盖并发相同 lockVersion 只有一次成功、错误 Plan Version、非初始 v1 Current Plan、非 DRAFT、权限拒绝、关联/成员/计划晚失败回滚和完整审计。UI 在 Desktop/Pixel 5 另覆盖长 Task、节点、成员、长错误、零/200 Milestone 和窄屏无横向溢出、Next.js overlay 或未捕获浏览器错误。

### Revision 通用 Composer 专项测试

1. ACTIVE Task 的“发起 Revision”必须进入 `/progress/tasks/[id]/revisions/new`；非成员直达新建 URL 得到脱敏 404，非 ACTIVE 时返回 Task 工作台，已有 Candidate 时也返回工作台并展示“当前 Revision 候选”。
2. Desktop 与 Pixel 5 均验证纵向 Composer：顶部使用与 Task 创建页一致的“基本信息 / 组织与分类 / 成员”结构并只读展示权威 Task 内容，不显示独立“Revision 信息 / 只读基线”；页面自动选中一个不可删除的当前 Revision 节点，Revision 名称、Revision 详细内容和 Revision 时间均在节点详情中填写且必填。Start/已完成 Milestone/已生效 Revision 只读，当前 Revision Marker 可调整且不切割阶段带，后续 Milestone 与 Terminal 可编辑；节点详情只显示红色校验提示框，不再重复显示“问题列表”。创建按钮为“创建并送审”，成功返回 Task 工作台并持久化 `PENDING_APPROVAL`，工作台候选卡片与批准后的 Current Plan 节点详情均回显名称和详细内容。
3. 被驳回记录的“修改并重新送审”进入 `/progress/tasks/[id]/revisions/[revisionId]/edit`；仅创建人（仍有 `revision.create`）或 Owner/全局管理员可进入。保存按钮同为“修改并重新送审”，成功后 `reviewRound + 1` 且直接回到待审批，不存在 Draft/Submit。
4. Revision 本地草稿按环境、账号、Task、基线计划/锁或 Revision/候选 `updatedAt` 隔离；刷新后可恢复 Revision 名称、Revision 详细内容、revisionAt、节点、选中项与最后合法画布位置。版本冲突不得覆盖服务端，必须保留并允许导出或显式放弃加载最新版本；成功清理失败不得伪装成服务端失败。

## 反馈中心测试

1. 打开 `/feedback`。
2. 默认筛选应为“活动”，列表只包含 `OPEN` 和 `IN_PROGRESS`。
3. 筛选顺序应为“活动 / 待处理 / 处理中 / 已关闭 / 全部”。
4. 点击“全部”，滚动列表并点击一个已关闭反馈。
5. 期望筛选仍保持“全部”，URL 更新 `selected`，右侧详情更新，页面不跳回已关闭筛选。
6. 再点击待处理或处理中反馈，仍保持“全部”。
7. 直接打开 `/feedback?selected=<closedId>`，初始应自动进入“已关闭”视图并显示详情。
8. 新建反馈后应跳到新反馈详情，新反馈出现在“活动”中。
9. 上传图片超过数量、类型、单张 20MB 或合计 50MB 限制时显示中文错误。
10. 有权限用户可回复、修改状态；无权限用户不能执行管理操作。

## 管理员面板测试

1. 统一超级管理员进入 `/admin/accounts`，应看到「车组职责配置」「技术组职责配置」「用户与角色」三块；非超管和项目管理员访问页面或直接调用账号搜索/角色 Server Action 均被拒绝。`/admin/roles` 必须返回 404。
2. 在车组和技术组职责矩阵中搜索账号并就地添加/移除四类报销角色；指导老师支持保存和清除审批邮箱，邮箱规范化结果应立即回显并写入安全审计。Desktop 使用职责表格，Pixel 5 使用纵向职责卡片，两种视口均不得横向滚动。
3. 在「用户与角色」表单中搜索统一账号，授予项目管理员或带范围的报销角色；重复授予显示角色已存在。授予超级管理员以及撤销超级管理员/项目管理员必须确认，报销角色从标签直接移除并显示结果 toast。
4. 按姓名、角色、车组和技术组筛选账号，验证 30 条服务端分页；空结果显示中文空状态。账号表/移动卡片应展示当前项目与报销角色，并可打开「查看记录」弹窗查看飞书身份、角色历史和安全审计。
5. 对角色增删验证 UI、数据库活跃/撤销记录、角色历史、安全审计、站内通知和 mandatory outbox 一致；项目角色 UI 不得提供 `GROUP_LEADER`，直接提交该角色也必须被服务端拒绝。页面不得出现项目访问启用/禁用筛选或操作。
6. Person 为 `INACTIVE` 的统一账号仍可进入 `/progress` 并读取全部未删除历史数据，但创建 Task、修改项目业务、新增 Segment 和所有采购写入都必须由服务端拒绝；项目与采购 UI 均呈现只读，该 Person 不可作为新增成员或新通知收件人，历史成员和历史 Segment 继续展示。账号后台当前成员列表、职责矩阵和选择器不展示该 Person，但既有历史事实不得物理删除。
7. 验证禁止自撤销超级管理员、最后一名超管保护、最后一名可用全局审批人保护、重复提交幂等和可理解的中文错误。
8. 使用长姓名、多角色、身份缺失、缺少报销 User、空职责和长错误消息验证 Desktop/Pixel 5；选择器弹层、职责卡片、账号列表和记录弹窗均不得造成横向滚动。
9. 对失败 outbox 执行重试，期望状态变化且不重复发送已成功收件人。
10. 在 `/admin/system` 触发飞书用户同步，期望同步结果 toast 显示新增、更新、停用和恢复数量。飞书鉴权、网络、HTTP 或响应失败时，Desktop/Pixel 5 均应显示白名单化中文错误，不出现生产 Server Components 通用错误，也不得把原始响应或内部异常返回客户端；`tests/feishu-user-sync-action-result.spec.ts` 覆盖错误分类与脱敏。`tests/feishu-user-sync.spec.ts` 验证跨部门离职合并、快照缺席成员停用、返岗成员恢复、历史采购/角色关系保留、领域审计完整和冲突回滚后的脱敏审计；同一套回归还应让快照同时包含新人和超过 30% 的待停用成员，第一次通过公共 API 获得确认令牌并回滚，第二次先证明已撤权确认人携正确令牌仍整批失败且不写确认审计，再由在职超级管理员在独立事务成功创建新人、停用成员并写确认审计；普通比例的手动同步还需在等待管理员集合锁后复核发起人权限，模拟撤权先提交时应拒绝同步，并保证新人身份、返岗 Person 状态和审计零写入。人工另验证根部门授权缺失、分页不完整、快照变化令旧确认失效，以及最后一名有效全局管理员缺失时同步整批拒绝。`tests/inactive-person-procurement-safety.spec.ts` 与项目生命周期回归另验证停用人员只读历史、不能写入、不能删除采购历史订单或成为订单通知收件人；停用反馈账号会在 Desktop/Pixel 5 真实提交新反馈和回复既有反馈，均显示中文拒绝且 Feedback、Message、FileAsset、outbox 零新增。该组还覆盖同步停用与采购写入的 Person 行锁并发顺序；`tests/global-time-markers.spec.ts` 验证停用超级管理员不能保存全局关键时间点；`tests/account-management.spec.ts` 和 `tests/project-establishment.spec.ts` 分别验证通讯录与账号权限反序 Person 锁、全局角色撤销及立项提交的锁顺序，释放后并发操作均完成且不发生死锁；`tests/procurement-budget-import-atomicity.spec.ts` 验证已撤权超级管理员在预算写事务内被拒绝且预算零写入。
   `tests/feishu-user-sync-action-result.spec.ts` 还会通过仅受控 Playwright 服务开放的测试夹具直接调用 Server Action：未登录与非超级管理员分别返回 `UNAUTHENTICATED`/`FORBIDDEN` 且账号、身份、人员、用户、角色和审计记录计数不变；超级管理员调用则越过鉴权并由飞书出站守卫形成安全 `FEISHU_UNAVAILABLE` 结果。`tests/logger.spec.ts` 验证底层网络 cause、错误代码和堆栈经递归脱敏后仍保留，同时稳定的 `syncFailureCode` 不会被 logger 的异常类名覆盖。
11. 在 `/admin/time-markers` 新增名称和上海时间，保存后从数据库核对 UTC 时间；再用桌面鼠标、Pixel 5 触摸和键盘方向键移动胶囊，确认表单仅产生本地草稿，点击「保存全部」后才原子生效。保存 pending 时输入与拖动必须同时禁用；删除应为软删除并保留逐项审计；非超级管理员直接调用 Server Action 必须被拒绝。重复提交、集合版本冲突、同名/同刻、空列表、200/201 项边界、100/101 字名称、重复 ID 及数据库名称/有限时间约束均需覆盖。两个页面制造集合冲突时应保留旧草稿并展示最新集合；站内链接和浏览器后退都必须确认未保存草稿。
12. Desktop 与 Pixel 5 均确认管理员画布没有“全局关键节点”独立标题行，拖动区显示名称、上海日期时间和对应竖线；纵向日期网格与业务行一致，当前时间红线从轴贯穿拖动区且层级高于关键点，页面无横向溢出。个人、资源、Task、Project 业务画布不新增独立行，只显示名称和对应竖线，时间仅保留在 `title`/无障碍文本中，空业务行仍显示关键点；密集长名称必须聚合且可通过键盘/鼠标/触摸打开详情、选择具体点，胶囊不得相互遮挡。桌面 Composer 同样可见并对极远日期保持最多三年逻辑窗口，Pixel 5 沿用既有纵向 Composer、无桌面 TimeCanvas。关键时间点不得抢占业务内容初始中心，也不得产生站内通知、飞书消息或 outbox。

通讯录回归还需验证：当“全部成员”授权按飞书接口语义只返回根部门下的一级部门、未返回虚拟根 ID `0` 时，直接读取根部门成功后继续同步；根部门不可读时必须在拉取任何成员前拒绝。没有一级部门时不得把空 `department_ids` 误判为部分授权，但最终在职成员快照为空仍须零写入拒绝。

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
4. 创建采购、反馈或项目管理事件后应写入正确 channel 的 `NotificationOutbox`；旧 `progress` channel 必须被拒绝或不存在 adapter。项目管理 adapter 测试应 mock 飞书 HTTP 并验证交互卡包含操作人、项目、任务、通知内容、中文事项名称、时间和中文上下文。卡片与站内通知不得显示 `Task`、`Project`、`MilestoneReview`、`WorkSegment`、原始状态枚举、收件人解析状态或未知 context 键；采购卡片应按各处理环节显示不同的明确中文标题。
5. 飞书网络失败、临时收件人查询失败或缺少 `union_id` 时 outbox 保留可重试状态，不回滚业务状态；未知 channel、非法 payload/元数据和错误机器人用途应终止重试并保留明确错误。
6. 重跑 drain 不重复发送相同 `eventKey`，多收件人通知只重试失败的 `NotificationOutboxRecipient`；首次收件人解析失败和 outbox/recipient 锁过期后都可安全恢复。
7. 同时启动多个 cron 时，应确认不会重复 claim 同一 outbox；如发现重复，记录为并发风险。
8. 验证 CardKit fallback 后跟踪表保存实际机器人和最终 `cardId`，远端 CardKit 错误中的敏感字符串不会进入异常或 outbox。
9. 通过静态搜索确认 IM 消息 API 只在统一传输层、CardKit API 只在 CardKit 模块、Webhook URL 只在 Webhook 模块出现。
10. Task、Project、Revision、风险和评论 mutation 成功提交后应触发非阻塞即时 drain；禁发开关开启时不得启动真实投递。即时触发失败仍由独立 cron 接管，同一事件不得因两条触发路径重复发送。

## 项目管理 P1-P6 测试

1. `tests/project-management-p1.spec.ts` 覆盖核心 schema 约束：单 Task 单 Current Plan、Segment 时间检查和 Review 幂等键。
2. 身份测试覆盖 `User -> Account/Identity/Person` 首次解析、重复解析幂等、openId fallback 升级为 unionId、同 unionId 下的 openId 轮换、报销 User 原位更新、角色与收件人不丢失、冲突硬失败和非空 `User.accountId` 关联；账号级项目访问禁用已经移除。
3. 授权测试覆盖普通非成员、Participant、Owner、统一超级管理员和项目管理员。所有已登录统一账号都应读取全部未删除 Task、计划、验收、审计与完整 Segment；非成员写入必须零副作用，Participant/Owner/全局管理员按固定矩阵验证允许和拒绝路径。归档旧角色不再产生运行时授权。两类全局管理员均可审批且允许自审，Task 不再存在 `allowSelfReview` 分支。
4. 通知测试覆盖站内通知事务 helper、审计脱敏、审计 append-only、`channel=project-management` outbox 入队、审批用途 allowlist、全局管理员收件人按账号去重、结果通知创建人/提交人加所有 Owner、完整交互卡和通知/审批机器人边界；不得出现 Task Reviewer 或项目组长审批收件人。
5. `tests/project-management-lifecycle.spec.ts` 覆盖 P2/P3 Task 草稿创建、零成员或仅 Participant 草稿、创建者不被隐式写为 Owner、草稿创建者权限、激活时有效 Owner 门禁、幂等键冲突、Current Plan 持久化、0/200/201 Milestone 边界、Start/Milestone/Terminal 严格递增、Terminal 名称传播、零 Milestone 激活 Terminal、并发/过期锁拒绝、Revision 创建即待审批、驳回后修改直接重新送审、review round 通知键、Participant/Owner 的 Revision 管理边界、管理员批准/驳回和自审、零活跃审批人或全部管理员无有效飞书身份时整事务回滚、Planned Segment 待确认标记、Revision 生效不改写 Segment、Milestone Review TEXT/LINK 证据、FILE 证据拒绝、Termination Review 的提交/通过/驳回/要求修订与四种 outcome、相同请求键幂等与不同键冲突、Milestone/Revision/Terminal 跨类型门禁、审批终态释放、重提重新竞争、并发只保留一个待审批、仅管理员审批推进、全员查询、审计和 `channel=project-management` outbox。
6. `tests/project-management-segments.spec.ts` 覆盖 P5 Segment 中文校验、全员完整读取、无 Task 关联本人管理、Task 关联时 Participant 只管本人、Owner 管理全 Task、非成员拒绝、Person 必须是目标 Task 成员、损坏的非成员关联更新零写入、旧职责/Node 字段严格拒绝、乐观锁、真实 100 条批量在末项 stale 时对 Segment/change/audit/outbox 的事务回滚、逆序重叠批量输入的 `id ASC` 行锁顺序、split/merge 时间守恒和完整来源历史、merge 最终范围超过 31 天拒绝且恰好 31 天允许、full/partial confirm、一 Planned 多 Actual、多 Planned 一 Actual、无来源 Actual、并发 full confirm、并发 cron transition、cancel、soft delete，以及 Segment 操作不改变 Task/Milestone。成员降级竞争继续证明降级后的 Owner 不能移动或删除他人投入；其他状态竞争断言最终状态及 change/audit/outbox exactly-once。
7. `tests/project-management-resource-removal-migration.spec.ts` 从完整前置迁移链创建隔离 PostgreSQL 数据库，写入旧 allocation、Conflict、通知、outbox、checkpoint 和审计数据；应用删除 migration 后验证目标对象消失，普通 Segment、通知、outbox 与审计保留，历史 JSON 只清除顶层 `allocation`。
8. `tests/project-management-ui-composer.spec.ts`、`project-management-ui-workbench.spec.ts`、`project-management-ui-resource-planner.spec.ts`、`project-management-ui-routes-responsive.spec.ts`、`global-time-markers-ui.spec.ts` 和 `project-management-s3-shell.spec.ts` 分别覆盖 Composer、工作台、资源计划、路由/响应式、全局关键时间点以及共享壳。它们验证 `/progress` 统一我的工作、全员 Task 工作台、全员资源计划、站内通知中心、桌面/移动视口、Task 创建/统一 DRAFT 编辑、严格时间顺序、画布/节点表/Inspector 联动、本地草稿恢复与版本冲突、分层权限、审批门禁、旧 URL 及已退役比例/冲突入口；草稿允许零成员或仅 Participant 且不隐式加入创建者，激活前及 ACTIVE 成员修改仍校验负责人，成员集合错误需显示并聚焦成员区，但不得把负责人或可选参与人员的搜索框标记为无效。资源计划还须覆盖七个 Task 状态复选框、默认草稿/进行中、空状态集合、终态切换、Task 搜索建议、`focus` 不绕过计划筛选、人员完整投入、快速创建内容默认为空，以及 `taskStatuses` 在复制/刷新/前进后退/缩放后的保留。所有改动 UI 用例必须同时在 Desktop `1440x1000` 与 Pixel 5 运行，并断言无横向溢出和浏览器异常。
9. `tests/feishu-boundaries.spec.ts` 必须继续扫描 `app/progress`、`app/actions/project-management`、`components/project-management`、`lib/project-management` 和项目管理 notification adapter，防止项目管理入口或领域服务直接导入飞书传输层。
10. `tests/project-management-plan-mutations-draft.spec.ts`、`project-management-plan-mutations-active.spec.ts`、`project-management-plan-mutations-concurrency.spec.ts` 和 `project-management-plan-mutations-revision-time.spec.ts` 分别覆盖 Draft、Active、并发回滚与 Revision 时间规则；`tests/project-management-project-updates.spec.ts` 覆盖 Project 组合更新的单一聚合通知、前后成员并集、no-op 和无权限零副作用。共享 factory、副作用快照和数据库 barrier 位于 `tests/helpers/project-management-plan-mutation-fixtures.ts`。回归仍覆盖兼容及整包 mutation 的状态/权限/stale 矩阵、成员不变量、计划 ID 与时间边界、有界审计、`task_updated`/`project_updated` 收件人和中文变更项、专属成员/Project 事件边界、行锁顺序、exactly-once 和事务晚失败回滚；只允许随机本机 `_test` PostgreSQL，并要求 `NOTIFICATION_DELIVERY_DISABLED=true`。

11. Canvas 安全回归按 `project-management-canvas-route-boundaries.spec.ts`、`project-management-canvas-option-safety.spec.ts`、`project-management-canvas-scope-permissions.spec.ts` 和 `project-management-canvas-adaptive-loading.spec.ts` 拆分；共享账号/Task/Segment factory 位于 `tests/helpers/project-management-canvas-security-fixtures.ts`。四组分别验证路由 session 绑定、选择器最小披露、scope 权限/半开区间和自适应块加载/对象预算。资源计划选择器领域回归必须验证默认/显式/空 Task 状态集合与 Project/Task 的交集、状态外 Task 成员不被派生、直接或 Project 选入人员仍展示状态外 Task 的完整投入，以及焦点 Task 不绕过状态筛选。
12. `tests/project-management-s8.spec.ts` 覆盖 Action Inbox 权限/逾期排序、普通/强制通知偏好、停用人员保存偏好返回 `FORBIDDEN` 且零写入、Asia/Shanghai deadline event key、保留清理和完整性巡检；UI 的 S8 场景在 Desktop/Pixel 5 验证驾驶舱、待办、可编辑偏好及停用后的只读开关。Tag 删除 migration 由迁移规格验证三张分类表消失且 append-only 审计不被改写。
13. `tests/project-management-s9-cron.spec.ts` 覆盖保留的 PostgreSQL 跨实例 advisory lock、5 秒六字段调度表达式及 notification outbox 进程内防重入；新增 migration 必须在 runner 随机 target 数据库从空库执行。
14. `tests/project-management-performance.spec.ts` 默认跳过。仅在受控 runner 中设置 `PM_RUN_SCALE_TESTS=true`，生成 10k Task、100k Segment、50×100 PlanNode 和 100k 站内通知，执行 p95、query plan、响应体积与浏览器 DOM 门禁。不得对开发、共享或生产数据库设置该变量。
15. `tests/project-management-s10-release.spec.ts` 在 `node-db` project 执行一次运维规格：演练工具 fail-closed、空库 migration、两次共享快照、受保护表 row/hash、identity backfill dry-run/APPLY 幂等、整库/上传恢复和旧 contract/直接飞书发送静态扫描。工具只接受本机 `_test`/`_snapshot` 来源，要求 `PM_RELEASE_REHEARSAL_CONFIRM=LOCAL_ISOLATED_REHEARSAL` 与 `NOTIFICATION_DELIVERY_DISABLED=true`，并只创建/删除随机 `pmrel_*_test` 数据库；不得把生产 URL 伪装成允许名称。
16. `tests/task-access-migration.spec.ts` 从完整前置 migration 链构造旧角色组合，覆盖零 Owner 阻断、多 Owner、重复有效成员、Owner 优先、Lead/Member 转 Participant、Reviewer/Viewer 结束、Segment Participant 回填、`GROUP_LEADER` 撤销、旧策略审计、历史成员保留、零通知副作用和后续全局审批人部署门禁。
17. `tests/task-approval-notification-repair.spec.ts` 覆盖修复脚本 dry-run 零写入、旧 outbox 冻结、管理员账号去重、approval bot、版本化事件键、逐审批对象事务故障注入、管理员均无有效飞书 openId 时冻结前阻断和幂等重跑。
18. `tests/project-access-status-removal-migration.spec.ts` 从完整前置迁移链构造 ACTIVE/DISABLED 账号，验证状态列与枚举删除、历史禁用账号迁移审计、通知/outbox 零副作用，以及剩余六个全局管理员数据库门禁均不再引用旧状态字段。
19. `tests/revision-time-marker-migration.spec.ts` 在额外随机 `_test` PostgreSQL 中验证空 Revision 表升级、`revisionAt/reviewRound`、新状态枚举、单候选 partial unique index，以及存在旧 Revision 数据时在破坏性字段调整前 fail-fast。
20. `tests/work-segment-schema-drift-repair.spec.ts` 在 runner 持有的 `_test` PostgreSQL 临时 schema 中重建完整缺失和部分缺失两类 `WorkSegment` 漂移，写入既有 Segment 后连续执行修复与严格 catalog 验证 migration，核对数据保留、默认回填、完整 catalog/OID、约束行为和重复执行 no-op；另构造同名错误字段、列序索引、DESC/operator-class 索引、检查约束和外键动作，验证后置 migration fail-fast 且事务不改变 catalog 或数据。`tests/work-segment-role-node-removal-migration.spec.ts` 还必须从漂移状态按完整合并顺序执行删除准备、历史删除、修复、验证和最终收敛 migration，验证不会在历史删除 migration 前中止；最终删除职责、Node 关联、关联复核和专用通知/历史，同时保留普通 Segment、普通审计、通知、outbox 及 append-only trigger。
21. `tests/single-task-approval-migration.spec.ts` 在 runner 创建的随机 `_test` PostgreSQL 中人工构造同一 Task 同时存在 Milestone/Revision 待审批的异常数据，验证 Milestone 撤出、Revision/候选计划/非承接未完成节点取消、Current Plan 与 Task 锁版本不变、历史终态和采购数据不变、outbox/recipient 冻结、站内通知已读、确定性迁移审计及最终待审批总数为零。
22. `tests/project-establishment.spec.ts` 在 Desktop 与 Pixel 5 验证 Project 默认筛选、立项入口、异步 Task 搜索及选中列表（含长名称和移除入口），并验证新版详情概览、三列占位、全部状态分组 Task、Project 成员外部/独立投入、悬浮 Task 名称、定位及计划轨道不重复；在领域层验证驳回重提、批准挂载、全量 Task 稳定排序、候选授权、完成阻塞与删除解绑；该 spec 只能使用 runner 持有的隔离 PostgreSQL。
23. `tests/project-management-legacy-history-retirement.spec.ts` 在 `node-db` project 执行一次并创建额外随机本机 `_test` 数据库，从完整 migration chain 升级前状态注入全部旧角色、0/100/小数/空完成比例及既有通知记录；验证活跃异常整事务阻断、迁移等待并发 writer 后归档最终值、迁移期间无关通知写入不被修改且不导致误回滚、显式结束后稳定归档、最终枚举/列、审计不可变、受控 `db:deploy` 记账与重复部署 no-op、旧 preflight 在最终 schema 可执行、current-head preflight 接受 openId 历史快照及撤销后重授和 Prisma schema drift。`tests/functional-panels.spec.ts` 在 Desktop 与 Pixel 5 验证账号历史能显示归档旧角色及 migration 审计来源。

## 统一账号迁移验证

已有数据库发布前按顺序执行：

```bash
npm run accounts:preflight
npm run db:deploy
npm run accounts:validate
```

预检是兼容统一账号迁移前后 schema 的只读命令，应覆盖身份多账号冲突、待创建账号、孤儿角色、重复或非法角色范围、双范围旧项目组长和管理员数量。迁移前非空 User 库要求旧报销超管，迁移完成后改为要求有效统一超级管理员，不得因旧超管已归档而误报。任何阻断项必须非零退出，不能猜测身份或自动拆分双范围。

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

报告必须人工核对零 Owner Task、重复有效成员、旧角色数量和转换数量、Work Segment 参与人回填数量、孤立 Task 关联 Segment、活跃 `GROUP_LEADER`、活跃全局管理员账号数、具备 default tenant 非空飞书 openId 的全局管理员账号数、待处理 Milestone/Revision/Termination Review 及旧通知/outbox。已有 Task 时任一管理员计数为零、`ready=false` 或非零退出均不得部署；零 Owner、孤立 Person 或损坏关联必须人工修复，不能自动猜测负责人。

完整 migration 链回归还必须验证所有管理员门禁都排在不可逆 Task migration 之前；零全局管理员或零有效飞书 openId 时，受控 `npm run db:deploy` 失败后旧审批字段、`RevisionApprovalMode`、旧成员 enum 和成员数据必须保持原样，不能出现半升级数据库。双连接回归要让管理员失效事务先持有 DML 锁，再启动原子门禁迁移，验证迁移等待后观察到失效状态并在主迁移前失败；永久门禁安装后撤销角色、清空 openId、删除管理员账号三类写入都必须被拒绝，两个连接并发移除不同管理员只能有一个提交，空库无管理员时首个 Task 也必须在提交时被拒绝。主迁移撤销旧 `GROUP_LEADER` 后仍可添加角色约束；兼容清理 migration 必须只移除第一代触发器和函数并保留第二代门禁。另需用真实 `prisma migrate deploy` history 模拟已应用后续 migration 的旧环境，验证补跑低编号门禁和最终清理。

在随机隔离 PostgreSQL 中完成 migration 演练后，执行以下迁移后断言：

- 每个 Task 至少一名有效 Owner，允许多 Owner；
- 每个 Task/Person 最多一条有效成员，且角色只为 Owner/Participant；
- 每条未删除 Task 关联 Segment 的 Person 都是有效成员；
- 活跃项目系统角色只剩两类全局管理员，所有 `GROUP_LEADER` 均有 `revokedAt`；
- 旧 Task 审批策略、成员归一化、Segment 回填和角色撤销都有 `source=MIGRATION` 审计；
- migration 本身没有创建 InAppNotification 或 NotificationOutbox。

仅在验证尚未包含单一审批门禁迁移的历史“全局管理员审批收件人切换”版本时，保持 `NOTIFICATION_DELIVERY_DISABLED=true` 和通知 worker 停止，先 dry-run 再 APPLY 待审批修复：

```bash
npm run pm:repair-task-approval-notifications

NOTIFICATION_DELIVERY_DISABLED=true \
npm run pm:repair-task-approval-notifications -- --apply
```

该历史版本需验证已发送消息保留、旧可重试审批 outbox 被明确冻结、每个当前待审批对象只生成一组按账号去重的全局管理员站内通知和 approval outbox、二次运行零重复，并确认没有真实飞书请求。包含 `20260805120000_single_task_pending_approval` 的当前版本不再执行这一步补发。

部署单一 Task 审批门禁时不再为当前待审批对象补发通知。进入维护窗口后停止应用写入和通知 worker，保持 `NOTIFICATION_DELIVERY_DISABLED=true`，在隔离 PostgreSQL 先运行 `tests/single-task-approval-migration.spec.ts`，再执行 `npm run db:deploy`。迁移后必须确认未撤出的 `PENDING` Milestone Review 与 `PENDING_APPROVAL` Revision 总数均为零、Current Plan 和 Task 锁版本未变化、对应 outbox/recipient 已冻结且未读站内审批通知已读；任一断言失败不得恢复服务。随后运行生命周期定向测试、工作台 Desktop/Pixel 5 定向测试、`npm run check`、完整 `npm run test:e2e` 和 `npm run build`。

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
- 重启服务后 `/`、`/feedback`、`/progress`、`/progress/tasks`、`/progress/resources` 和 `/progress/notifications` 可访问；旧 `/progress/task/:id`、`/progress/kanban` 与 `/admin/roles` 返回 404。

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
