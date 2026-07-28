# 技术文档

本文档面向开发者，描述 pnx management 的架构、数据模型与关键实现。使用说明见根目录 [`README.md`](../README.md)。

## 技术栈

| 层级 | 选型 |
|------|------|
| 框架 | Next.js 16（App Router, TypeScript） |
| 数据库 | Prisma 7 + PostgreSQL（`@prisma/adapter-pg`） |
| UI | Tailwind CSS 4 + shadcn/ui（Base UI） |
| 表单 | React Hook Form + Zod |
| 认证 | Auth.js v5（飞书 OAuth） |
| 定时任务 | node-cron（`scripts/cron.ts`，独立进程） |

## 架构

```
用户 → Next.js 页面 → Server Actions → Prisma/PostgreSQL
                    ↘ 飞书 Webhook / 私信（卡片通知）
定时脚本 cron.ts → Prisma → 采购日报 + 通知 outbox 投递
```

- 无独立后端服务，业务逻辑集中在 `app/actions/` 与 `lib/`
- 文件上传写入私有目录 `storage/uploads/`，通过 `/uploads/...` 鉴权 route 返回
- 飞书集成拆分为 OAuth、通讯录、Webhook、统一私信传输层和 notification outbox。`lib/feishu-message.ts` 的 `sendFeishuDirectMessage()` 是 IM 私信唯一出口，支持 `text`、交互卡片和 CardKit；Webhook 保持独立。
- `lib/notification-channels/{procurement,feedback,project-management}.ts` 分别实现业务 channel adapter，负责校验持久化 payload、计算并去重收件人、构造完整消息和明确消息用途；传输层不查询业务角色，也不理解采购、反馈或项目管理状态。项目管理 adapter 当前校验 P1-P3 payload 与收件人计划，尚不执行真实飞书投递。
- 通知 outbox 分两层：`NotificationOutbox` 表示业务事件，`NotificationOutboxRecipient` 表示单个收件人的投递状态。核心 drain 按 `channel` 查找 adapter，只调度和更新状态；重试失败收件人时不能把已成功收件人再次发送。临时解析/网络错误退避重试，损坏 payload、未知 channel、非法 `type/botKind` 等确定性配置错误直接冻结，修正后才可人工重置。

## 结构化日志

- 统一入口为 `lib/logger.ts`，默认输出 JSON line；开发环境可通过 `LOG_FORMAT=pretty` 使用可读格式，`LOG_LEVEL=debug|info|warn|error|silent` 控制级别。
- 标准字段：`timestamp、level、event、requestId、actorOpenId、module、action、entityType、entityId、durationMs、result、errorCode、errorMessage`。排查时优先按 `requestId/event/entityId/eventKey` 串联。
- 日志会自动脱敏 `password、secret、token、cookie、authorization、appSecret、DATABASE_URL` 等字段。不要把完整飞书卡片、请求 cookie、数据库连接串、文件正文或大体量导入内容写进日志。
- 业务可见历史写入对应领域记录；工程排障写结构化日志。两者职责分开，不能用 stdout 日志替代业务审计记录。
- 关键接入点：采购和反馈 action、通知 outbox 入队与收件人级投递、飞书统一传输层、WS/卡片回调、cron、Playwright DB setup、Prisma 连接池错误。
- 事务内 outbox 入队日志使用 `notification.outbox.enqueue_tx.prepared` 和 `result=prepared`，只表示事务中已准备写入；只有事务提交后数据库里的 outbox 行才代表可投递事件。
- 本地和测试验证默认设置 `NOTIFICATION_DELIVERY_DISABLED=true`，只检查 outbox 和日志，不发送真实飞书消息。该开关同时覆盖 outbox drain、飞书群 Webhook、IM 图片/文件素材上传等直连出口；人工调试脚本如确需真实发送或上传，代码必须显式传入禁发 bypass，运行时还必须设置 `CONFIRM_SEND_FEISHU=true`。普通应用进程即使误传 bypass，也会继续被禁发闸拦截。

### 已知框架治理项

- Web 进程里仍存在 `drainNotificationOutboxSoon()`，当前已具备结构化日志，但后续应收口为“Web 只入队，cron/worker 统一投递”。
- outbox claim 当前以乐观 `updateMany` 抢占为主；后续建议改为 PostgreSQL `FOR UPDATE SKIP LOCKED` 原子 claim，并记录 `lockOwner`/心跳。
- channel adapter 必须固化业务 payload 与收件人计划；不要在 outbox 核心或飞书传输层增加业务分支。
- 维护脚本应逐步统一 dry-run/confirm 约定，写操作脚本必须要求显式 `APPLY_*=true` 和目标数据库确认；会触达飞书的脚本必须要求 `CONFIRM_SEND_FEISHU=true`，并默认尊重 `NOTIFICATION_DELIVERY_DISABLED=true`。

## 目录结构

```
app/
  actions/          # Server Actions（采购 + 反馈 + 管理）
  api/auth/         # Auth.js 路由
  apply/ orders/    # 采购报销页面
  progress/         # 项目管理重构占位页与旧路由重定向
  admin/            # 角色管理
components/         # UI 组件
lib/                # 业务逻辑、权限、飞书、校验
  project-management/ # v2.1 P1-P5 身份、授权、生命周期、资源、通知和审计
prisma/
  schema.prisma     # 数据模型
  seed.ts           # 初始角色 seed
scripts/            # cron、seed/fix 脚本
storage/uploads/    # 私有上传附件（运行时生成）
```

## 认证与中间件

Auth.js 不能在中件件中 import 含 Prisma 的模块，因此拆分：

| 文件 | 用途 |
|------|------|
| `lib/auth.config.ts` | Edge 可用配置 |
| `lib/auth-edge.ts` | middleware 使用 |
| `lib/auth.ts` | 完整 auth（含 signIn 时 upsert User，并初始化项目管理 Account/Person） |

登录后 `User` 表继续记录采购和回调用的 `openId`、姓名、头像；`UserRole` 表单独维护采购审批角色。项目管理 v2.1 另用 `Account`、`AccountIdentity` 和 `Person`：飞书 `unionId` 优先作为 `providerSubject`，无 `unionId` 时使用 `open:<openId>` 作为兼容 subject。`npm run pm:identity-backfill` 可对已有 `User` 做 dry-run 对账，只有设置 `APPLY_PM_IDENTITY_BACKFILL=true` 才会写入 Account/Person。身份冲突会硬失败，并写入脱敏 `DomainAuditEvent` 供管理员后续处理。

## 权限

| 模块 | 文件 | 说明 |
|------|------|------|
| 采购 | `lib/permissions.ts` | 服务端角色查询 |
| 采购（客户端） | `lib/permissions-client.ts` | 纯函数，无数据库依赖 |
| 项目管理 | `lib/project-management/authorization` | P1-P5 授权、稳定 action 字符串、状态机操作鉴权和 readableWhere 查询过滤 |

角色类型见 `UserRoleType` enum：`SUPER_ADMIN`、`TEAM_ADMIN`、`TECH_GROUP_ADMIN`、`TEACHER`、`FINANCE`。

项目管理使用独立 `ProjectManagementSystemRole`。`SYSTEM_ADMINISTRATOR` 必须是全局角色；`AUDITOR` 可全局或限定范围；`TEAM_ADMINISTRATOR` 与 `RESOURCE_MANAGER` 必须带 `team` 或 `techGroup` 范围，数据库和授权 helper 都会拒绝空范围的越权读写。

## 数据模型

### 采购报销

| 模型 | 说明 |
|------|------|
| `User` | 飞书用户 |
| `UserRole` | 角色分配（可带 team / techGroup 范围） |
| `PurchaseOrder` | 采购主单 |
| `PurchaseItem` | 明细（含购买链接） |
| `ProcurementBudgetPool` | 采购预算池：按项目分行（description）+ 车组+技术组+周期唯一；含导入顺序 |

**采购明细 Excel 导入**（`lib/import-procurement-items.ts`）：采购申请页支持从 Excel 导入条目，列包括物品名称、规格、种类、采购链接、加工商、数量、行总价。加工费条目导入后仍需手动上传图片。

**预算池**（`lib/procurement-budget.ts`、`lib/procurement-budget-alerts.ts`）：

- 超级管理员在 `/admin` 通过 Excel 导入预算（项目、车组、技术组、预算、周期默认 2026）；每行一个项目，同组可有多个项目；仅「项目+车组+技术组+周期」完全相同才合并预算；展示顺序与导入表行序一致；单次最多 300 行；支持追加或覆盖同周期数据
- 已使用金额 = 同一车组且同一技术组、状态非 `DRAFT`/`REJECTED` 的订单 `totalPrice` 之和；同组别多项目按各自预算占比分摊已用金额，使用率按组预算合计计算
- 使用率首次达到 70%、80%、90%、100% 时向对应车组组长或技术组组长发送飞书私信（按组别去重）
- 采购看板 `/procurement/dashboard` 按项目分行展示预算占用（副标为车组·技术组），并汇总当前筛选下的预算池总量；支持按车组/技术组筛选

**状态机：**

```
DRAFT → MANAGEMENT_REVIEW → TEACHER_REVIEW → PENDING_APPLICANT_DOCS
      → PENDING_FINANCE_REVIEW → PENDING_APPLICANT_CONFIRM → COMPLETED
```

状态变更与审批逻辑在 `app/actions/updateOrderStatus.ts`、`approveManagementReview.ts` 等。

### 项目管理

旧项目管理专用模型和开发数据已通过 migration 删除，包括项目、阶段、旧任务及其审批、交付、周报、风险、评论、关注和提醒关系。共享的 `User`、采购/反馈、`FileAsset`、`NotificationOutbox` 与飞书卡片跟踪模型继续保留。

P1 已新增 v2.1 底座模型：`Account`、`AccountIdentity`、`Person`、`Tag`、`Task`、`TaskMember`、`TaskPlanVersion`、`TaskNode`、`PlanVersionNode`、Milestone/Revision/Termination 子类型、`MilestoneReview`、`ReviewEvidence`、`WorkSegment`、`WorkSegmentSource`、`WorkSegmentChange`、`ResourceConflict`、`SystemRoleAssignment`、`NotificationPreference`、`InAppNotification` 和 `DomainAuditEvent`。这些表从空项目管理数据集开始，不包含 Project、legacy map 或旧来源字段。

P2/P3 已补齐 Task 计划生命周期的服务端闭环，入口位于 `lib/project-management/application/lifecycle-service.ts`、`app/actions/project-management/{tasks,plans,revisions,milestones,terminations}.ts` 和 `lib/project-management/queries/task-queries.ts`：

- Task 草稿创建在事务中写入 `Task(status=DRAFT)`、初始 `TaskPlanVersion(status=CURRENT, activatedAt=null)`、有序 Milestone、末尾 Termination、成员、Tag、审计、站内通知和 `channel=project-management` outbox；`TaskPlanVersion.idempotencyKey` 与 `creationRequestHash` 支持同账号请求幂等和 payload 冲突检测。
- `activateTask` 锁定 Task 行，校验 Draft 状态、权限、`expectedLockVersion`、OWNER、Milestone、末尾 Termination 和连续序号后，把首个 Milestone 置为 `ACTIVE` 并递增 `lockVersion`。
- Revision 只允许基于当前 Current Plan 和匹配的 `RevisionNode.baseTaskLockVersion` 创建；目标计划保留已完成前缀、插入 Revision 节点、替换后续 Milestone 与 Termination。提交后默认待审批，`DIRECT_BY_OWNER` 且具备 `revision.apply` 权限时可直接生效。通过审批会原子历史化旧 Current、启用新 Current、标记被替换节点为 `REVISED`，并把受影响的 Planned Work Segment 标记 `associationNeedsReview=true`。
- Milestone Review 允许 OWNER/LEAD/MEMBER 和 scoped Team Admin 提交 TEXT/LINK 证据；FILE 证据当前返回中文校验错误。审批仍限 REVIEWER 或 scoped Admin，默认禁止自审。通过后推进到下一 Milestone 或激活 Termination；驳回和要求修订不推进。
- Termination 确认写入 outcome、reason、summary 和 Task 终态。`SUCCESS` 要求所有前置 Milestone 已完成；`FAILED/CANCELLED/TIMEOUT` 可提前结束但必须填写原因，并取消未完成节点。重复相同确认幂等，不同 outcome 返回状态冲突。
- 查询 facade `getTaskWorkspace`、`getPlanVersion`、`listTaskPlanVersions` 和 `comparePlanVersions` 都通过 `taskReadableWhere(actor)` 过滤，防止枚举不可读 Task 或 Plan。

P5 已补齐 Resource Segment 与 Conflict 服务端闭环，复用 P1 的 `WorkSegment`、`WorkSegmentSource`、`WorkSegmentChange`、`ResourceConflict` 和 `ConflictSegment`，未新增 migration。入口位于 `lib/project-management/application/segment-service.ts`、`lib/project-management/application/conflict-service.ts`、`app/actions/project-management/{segments,conflicts}.ts` 和 `lib/project-management/queries/resource-queries.ts`：

- Segment 服务支持单条/批量 Planned 创建、Actual 创建、更新、批量移动、拆分、合并、取消、完整确认、部分确认、重关联和 Actual 逻辑删除。所有写操作都在事务内写 `WorkSegmentChange` 和 `DomainAuditEvent`，并通过 `expectedUpdatedAt` 执行乐观锁校验。
- Segment 校验包括 `endAt > startAt`、单条最长 31 天、`allocation` 可空且非空时 `0 < allocation <= 100`、`completionPercent` 仅 Actual 可用、Node 必须属于关联 Task。Planned 只能关联 Current Plan 且未 `REVISED/CANCELLED` 的 Node；Actual 可保留历史 Node 关联。
- 权限规则为本人可管理本人 Segment；管理他人 Segment 需要 System Admin，或通过关联 Task 命中 scoped Team Admin/Resource Manager。无 Task 关联的他人 Segment 当前只能由 System Admin 管理。
- 确认 Planned 会创建 Actual 并写 `WorkSegmentSource`；部分确认会取消原 Planned 并生成未覆盖的剩余 Planned 子段。Segment 操作不会改变 Task、Node、Milestone 或 Termination 状态。
- Conflict 扫描使用半开区间 `[startAt, endAt)` 和 `v1|kind|personId|startAt|endAt|sortedSegmentIds` 稳定 fingerprint。重复扫描不会重复创建；冲突消失会置为 `RESOLVED`；`ignoredUntil` 到期后仍命中会重新打开。
- 当前启用 `ALLOCATION_OVER_LIMIT`、`MISSING_ALLOCATION`、`HIGH_PRIORITY_OVERLAP`、`LEAD_ROLE_OVERLAP`、`REVISION_OVERLAP` 和 `ACTUAL_OVERLOAD`。`UNAVAILABLE_TIME` 枚举保留但未扫描，因为当前没有可授权、可维护的人员不可用时间模型。
- Conflict 查看允许涉及本人、相关 Task 可见者和范围内 Resource Manager/Team Admin；处理、忽略和应用建议仅限 System Admin、范围内 Resource Manager/Team Admin，或所有关联 Task 都由其 OWN 的 Task Owner。`previewConflictSuggestion` 不写库，`applyConflictSuggestion` 必须显式 `confirmApply=true` 并复核 Segment `updatedAt`。
- `resource-queries.ts` 提供 Segment 列表、详情、change history，以及 Conflict 列表、详情和关联 Segment 解释；详情查询使用 `segmentReadableWhere(actor)` 或 Conflict readable 条件防止枚举不可读对象。

`scripts/cron.ts` 每 10 分钟运行 `scanSegmentTransitions`，把到期 Planned 推到 `PENDING_CONFIRMATION` 并写 `segment_confirmation_due`，把已开始且未结束的 Planned 置为 `IN_PROGRESS` 并写审计；该扫描不会自动生成 Actual。每 15 分钟运行 `scanResourceConflictsForDefaultWindow`，带运行中保护，只写冲突记录、站内通知和 `channel=project-management` outbox，不调整 Segment。

`/progress` 仍是占位页，资源时间轴 UI、冲突中心 UI、通知中心页面和真实项目管理飞书卡片投递尚未上线。

`DomainAuditEvent` 由 append-only trigger 保护，应用代码只能追加审计事件，不能更新或删除既有审计行。

## 路由一览

### 采购报销

| 路径 | 功能 |
|------|------|
| `/` | 首页导航 |
| `/login` | 飞书登录 |
| `/procurement` | 采购管理首页 |
| `/procurement/new` | 采购申请 |
| `/procurement/list` | 订单列表 |
| `/procurement/[id]` | 订单详情与审批 |
| `/procurement/dashboard` | 采购汇总看板 |
| `/admin` | 角色与通讯录管理 |

### 项目管理占位

| 路径 | 功能 |
|------|------|
| `/progress` | 项目管理重构占位页 |
| `/progress/*` | 服务端重定向到 `/progress` |

## 飞书集成要点

- **OAuth 回调**：`/api/auth/callback/feishu`，须在飞书后台为每个允许入口分别配置完整 URL
- **Webhook 签名**：`HmacSHA256("", timestamp + "\n" + secret)` 后 Base64
- **统一私信传输层**：`lib/feishu-message.ts` 导出 `FeishuMessage`、`FeishuMessagePurpose`、`FeishuSendResult` 和 `sendFeishuDirectMessage()`。调用方传入系统用户 `openId`、明确的 `botKind`、用途和 text/交互卡片/CardKit 消息；传输层统一完成收件人身份解析、机器人凭据、token、HTTP 请求、CardKit 创建、禁发闸、allowlist、结构化日志和错误脱敏。
- **机器人边界**：普通通知只能使用通知机器人，审批请求才可声明审批用途。审批机器人未独立配置时使用通知机器人凭据；独立审批应用通过 `User.unionId` 使用 `receive_id_type=union_id`，缺少 `union_id` 时失败并由 outbox 重试。保留既有的“用户对审批应用不可用时回退通知机器人”行为，发送结果会标明实际机器人和是否 fallback。
- **Outbox adapter**：采购、反馈和项目管理业务只能通过 `lib/notification-channels/` adapter 进入统一私信传输边界。adapter 校验 payload 与持久化元数据、计算收件人和构造业务内容；outbox 核心及传输层不包含业务角色查询或状态分支。adapter 的收件人计划可区分真实私信与 Webhook 等独立传输，采购审批必须至少有一个真实私信审批人。项目管理 P2/P3 生命周期事件和 P5 Segment/Conflict 事件只写 `channel=project-management` outbox；adapter 校验 payload、审批用途和收件人计划，真实飞书消息构造和投递在后续阶段启用。
- **私信防误发**：`FEISHU_DIRECT_MESSAGE_ALLOWED_NAMES / OPEN_IDS / UNION_IDS` 为空时不限制；配置后只允许匹配收件人，其他私信会被记录并拦截。Playwright 启动的应用服务默认只允许 `李棋轩`。Docker Compose 默认 `NOTIFICATION_DELIVERY_DISABLED=true` 且 allowlist 为 `李棋轩`；生产真实投递需要显式设置 `NOTIFICATION_DELIVERY_DISABLED=false`，并按需配置或清空 allowlist。
- **CardKit 回调**：采购审批卡若由审批机器人发送，需要运行审批机器人长连接；生产 `./service/install.sh` 默认安装并启动 `pnx-management-feishu-approval-ws.service`。通知机器人长连接仍可通过 `ENABLE_FEISHU_WS=true` 单独启用。审批机器人回调中的操作人也会通过 `union_id` 映射回系统 `openId` 后再校验权限。
- **群 Webhook**：采购群通知和日报仍使用 Webhook，独立于统一私信接口
- **通讯录同步**：手动入口 `app/actions/syncFeishuUsers.ts`，定时入口 `scripts/cron.ts`，共用 `lib/feishu-user-sync.ts`；需 `contact:*` 只读权限。同步继续 upsert 采购 `User`，同时按同一规则初始化/刷新项目管理 Account/Person。

## Prisma 与数据库

本地开发使用 **PostgreSQL**。推荐只启动 compose 中的 `postgres` 服务，应用在宿主机 3000 端口运行：

```bash
docker compose up -d postgres
npm run db:deploy
```

- 连接串：`DATABASE_URL=postgresql://postgres:<密码>@localhost:5432/management_system`（见 `.env.example`）
- Prisma 7 通过 `prisma.config.ts` 读取 `DATABASE_URL`；客户端使用 `@prisma/adapter-pg` + `pg` Pool（`lib/prisma.ts`）
- `SHADOW_DATABASE_URL` 用于 `prisma migrate diff`，库名建议以 `_shadow` 结尾，并与业务库分离
- dev 热更新可能导致 client 缓存过期；`lib/prisma.ts` 中 `isPrismaClientStale()` 会在缺少新 model delegate 时重建 client
- schema 变更后执行 `npx prisma generate` 并重启 dev server
- 旧 SQLite 数据不迁移；首次部署从空 PostgreSQL 库开始

### 常用命令

```bash
npm run db:deploy              # prisma migrate deploy（等待 PG 就绪）
npm run db:seed                # 写入初始 SUPER_ADMIN 等角色
npm run db:fix-roles           # 清理异常角色数据后重新 seed
npm run db:studio              # Prisma Studio
npm run pm:identity-backfill    # 项目管理 Account/Person 初始化 dry-run
npm run cron                   # 启动定时任务（独立进程）
```

## 文件上传

- 实现：`lib/file-upload.ts`，采购附件元数据：`lib/order-attachments.ts`
- 存储：`storage/uploads/<订单ID>/`
- 单文件 20MB；反馈图片单次合计 50MB；Server Actions 总上限 100MB（`next.config.ts` 中 `serverActions.bodySizeLimit`）
- 访问：浏览器 URL 保持 `/uploads/...`，由 `app/uploads/[...path]/route.ts` 校验登录和 FileAsset 权限后读取

### 验收清单自动生成

采购人上传凭证时，系统根据 `templates/material-acceptance-list-base.docx`（由学校官方模板转换）自动填充表格、**电子签名图片**与日期，并按明细行数扩表；有实物照片时嵌入清单末尾照片区。

- 签名来源：用户在「个人设置」上传的 PNG/JPG（`User.signaturePath`）
- 验收人 1/2：对应车组、技术组组长；领用人：采购发起人
- 正式提交凭证前校验三方均已上传签名；预览可不含签名

- 实现：`lib/generate-reimbursement-docx.ts`（docxtemplater + image module）
- 模板源文件：`templates/material-acceptance-list-source.docx`
- 生成用 base 模板：`templates/material-acceptance-list-base.docx`（`npm run prepare:template` 产出）
- 更新官方模板后运行：`npm run prepare:template`
- 明细最多 50 行（与 Word 模板行数一致，超出会自动扩行直至该上限）

## 定时任务

`scripts/cron.ts` 使用 `node-cron`：

| 调度 | 内容 |
|------|------|
| 默认每日 08:30 | 从飞书通讯录扫描并同步本地人员（可用 `FEISHU_CONTACT_SYNC_CRON` 调整） |
| 每日 09:00 | 采购日报、采购停留催办 |
| 每 10 分钟 | 采购预算阈值扫描 |
| 每 2 分钟 | drain `NotificationOutbox` |

与 Next.js 主进程分离，生产环境用 PM2、systemd 或下文 **Docker** 中的 `cron` 服务单独拉起。

## Docker 部署

### 本地开发

```bash
docker compose up -d postgres
# 无 docker 组权限：./scripts/docker-compose-sudo.sh up -d postgres
```

应用在宿主机运行，`DATABASE_URL` 指向 `localhost:5432`。

### 全栈（app + cron）

仓库提供 `Dockerfile` + `docker-compose.yml`，包含 **postgres**、**app**（Web）与 **cron**（定时任务）三个服务：

```bash
docker compose up -d --build
```

当前用户没有 Docker socket 权限时，可在 `.env` 或当前 shell 设置 `SUDO_PASSWORD` 后执行：

```bash
./scripts/docker-compose-sudo.sh up -d --build
```

`SUDO_PASSWORD` 仅在宿主机侧供 `sudo -S docker compose ...` 使用，不会注入容器运行时环境。

### 镜像说明

- 基础镜像 `node:20-bookworm-slim`
- 构建阶段：`prisma generate` + `next build`（构建时 `DATABASE_URL` 为占位 PostgreSQL 串）
- 启动入口 `docker/entrypoint.sh`：创建数据目录 → `npm run db:deploy` → 可选 seed → 启动进程

### 持久化（全栈 Compose）

| 挂载点 | 用途 |
|--------|------|
| `app-uploads` → `/app/storage/uploads` | 私有上传附件 |
| `postgres-data` → `/var/lib/postgresql/data` | PostgreSQL 数据目录 |

### 环境变量

全栈 Compose 会为 app/cron 注入容器内 PostgreSQL 连接串。应用所需变量通过 `${VAR}` 从宿主机 `.env` 读取后显式注入容器（见 `.env.example`）；宿主机辅助变量如 `SUDO_PASSWORD` 不会传入容器。

| 变量 | 说明 |
|------|------|
| `APP_PORT` | 宿主机映射端口，默认 `3000` |
| `RUN_DB_SEED` | 设为 `true` 时启动 app 会执行 `prisma/seed.ts`（仅首次） |

### 注意

- 双入口访问时不要设置 `AUTH_URL` / `NEXTAUTH_URL`；使用 `APP_ALLOWED_ORIGINS` 允许域名、内网 IP 和本机调试入口
- `NEXT_PUBLIC_APP_URL` 仅作为后台任务/cron 无请求上下文时的默认系统地址
- 更新代码：`docker compose up -d --build`

## 已知限制

- 采购订单首版无驳回流程，状态只能向前流转
- 附件需手动备份；PostgreSQL 使用 `postgres-data` 卷或 `pg_dump`
- `UserRole` 不会随首次登录自动分配，须 seed 或 `/admin` 配置
- Serverless 部署需将 cron 迁出

## 环境变量

完整列表见 [`.env.example`](../.env.example)。局域网调试可设置 `LAN_HOST` 或 `ALLOWED_DEV_ORIGINS`。
