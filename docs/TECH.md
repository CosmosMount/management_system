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
- `lib/notification-channels/{procurement,feedback,project-management}.ts` 分别实现业务 channel adapter，负责校验持久化 payload、计算并去重收件人、构造完整消息和明确消息用途；传输层不查询业务角色，也不理解采购、反馈或项目管理状态。项目管理 adapter 构造交互卡并通过统一私信传输层投递，验收/Revision 待审批使用审批机器人，其他事件使用通知机器人。
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
  progress/         # 项目管理总览、Task 工作台、资源时间轴和通知中心
  admin/            # 角色管理
components/         # UI 组件
lib/                # 业务逻辑、权限、飞书、校验
  project-management/ # v2.1 P1-P6 身份、授权、生命周期、资源、通知和审计
prisma/
  schema.prisma     # 数据模型
  seed.ts           # 初始角色 seed
scripts/            # cron、seed/fix 脚本
storage/uploads/    # 私有上传附件（运行时生成）
```

## 认证与统一账号

Auth.js 使用飞书 OAuth。认证配置与完整登录副作用拆分如下：

| 文件 | 用途 |
|------|------|
| `lib/auth.config.ts` | OAuth provider 与 JWT/Session 映射 |
| `lib/auth-edge.ts` | Proxy 使用的轻量 Auth.js 实例 |
| `lib/auth.ts` | 完整 auth；登录时解析统一账号并更新报销 User |

`Account + AccountIdentity` 是两个业务域共同的账号底座；`Person` 承载项目成员资料，`User` 通过唯一、非空 `accountId` 保留采购订单关系。飞书 `unionId` 优先作为 `providerSubject`，无 `unionId` 时使用 `open:<openId>`。身份解析与报销 User 协调在同一事务中按 `accountId → unionId → openId` 查找；`openId` 轮换会更新原 Identity 和 User，候选指向不同账号或重复 Identity 时硬失败并写脱敏审计，不按姓名自动合并。`Account.projectAccessStatus` 只控制项目管理：Proxy 在渲染 `/progress` 前把禁用账号引导到说明页，项目 Actor 与所有写事务（包括 Tag）仍独立复核；登录、采购报销和超级管理员后台不受影响。

## 权限

| 模块 | 文件 | 说明 |
|------|------|------|
| 采购 | `lib/permissions.ts` | 服务端角色查询 |
| 采购（客户端） | `lib/permissions-client.ts` | 纯函数，无数据库依赖 |
| 项目管理 | `lib/project-management/authorization` | P1-P6 授权、稳定 action 字符串、状态机操作鉴权和 readableWhere 查询过滤 |
| 统一账号 | `lib/account-authorization.ts` | 账号、项目访问和两个角色域的授权上下文 |
| 账号变更 | `lib/account-management.ts` | 超管复核、事务锁、审计与通知 |

报销活跃角色为 `TEAM_ADMIN`、`TECH_GROUP_ADMIN`、`TEACHER`、`FINANCE`。授权、审批收件人和角色签名回退均通过 `UserRole.accountId` 读取账号当前身份；`UserRole.openId` 仅为只读历史兼容字段。采购管理审核同时保存审批人的稳定 `accountId` 和当时的 `openId` 快照，验收清单签名优先按 `accountId` 解析，避免飞书身份轮换后错误回退到当前组长。旧 `UserRole.SUPER_ADMIN` 仅保留撤销历史；统一超级管理员在报销权限 helper 中合成兼容的超管语义。

项目活跃角色为全局 `SUPER_ADMINISTRATOR`、全局 `PROJECT_ADMINISTRATOR` 和单车组或单技术组 `GROUP_LEADER`。前两者拥有全部项目业务权限；组长匹配 `Task.team OR Task.techGroup`。旧 `SYSTEM_ADMINISTRATOR/TEAM_ADMINISTRATOR/RESOURCE_MANAGER/AUDITOR` 只允许作为已撤销历史。数据库 CHECK、活跃部分唯一索引和 Zod 同时约束角色范围。

## 数据模型

### 采购报销

| 模型 | 说明 |
|------|------|
| `User` | 采购报销资料，通过 `accountId` 关联统一账号 |
| `UserRole` | 报销角色分配、范围及授予/撤销历史 |
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

当前项目管理数据模型包括 `Account`、`AccountIdentity`、`Person`、`Tag`、`Task`、`TaskMember`、`TaskPlanVersion`、`TaskNode`、`PlanVersionNode`、Milestone/Revision/Termination 子类型、`MilestoneReview`、`ReviewEvidence`、`WorkSegment`、`WorkSegmentSource`、`WorkSegmentChange`、`SystemRoleAssignment`、`NotificationPreference`、`InAppNotification` 和 `DomainAuditEvent`。资源冲突表、扫描 checkpoint 和 `WorkSegment.allocation` 已由不可逆 migration 删除。

P2/P3 已补齐 Task 计划生命周期的服务端闭环，入口位于 `lib/project-management/application/lifecycle-service.ts`、`app/actions/project-management/{tasks,plans,revisions,milestones,terminations}.ts` 和 `lib/project-management/queries/task-queries.ts`：

- Task 草稿创建在事务中写入 `Task(status=DRAFT)`、初始 `TaskPlanVersion(status=CURRENT, activatedAt=null)`、有序 Milestone、末尾 Termination、成员、Tag、审计、站内通知和 `channel=project-management` outbox；`TaskPlanVersion.idempotencyKey` 与 `creationRequestHash` 支持同账号请求幂等和 payload 冲突检测。
- `activateTask` 锁定 Task 行，校验 Draft 状态、权限、`expectedLockVersion`、OWNER、Milestone、末尾 Termination 和连续序号后，把首个 Milestone 置为 `ACTIVE` 并递增 `lockVersion`。
- Revision 只允许基于当前 Current Plan 和匹配的 `RevisionNode.baseTaskLockVersion` 创建；目标计划保留已完成前缀、插入 Revision 节点、替换后续 Milestone 与 Termination。提交后默认待审批，`DIRECT_BY_OWNER` 且具备 `revision.apply` 权限时可直接生效。通过审批会原子历史化旧 Current、启用新 Current、标记被替换节点为 `REVISED`，并把受影响的 Planned Work Segment 标记 `associationNeedsReview=true`。
- Milestone Review 允许 OWNER/LEAD/MEMBER 和匹配范围的组长提交 TEXT/LINK 证据；FILE 证据当前返回中文校验错误。审批限 REVIEWER、匹配范围组长或全局项目角色，默认禁止自审。通过后推进到下一 Milestone 或激活 Termination；驳回和要求修订不推进。
- Termination 确认写入 outcome、reason、summary 和 Task 终态。`SUCCESS` 要求所有前置 Milestone 已完成；`FAILED/CANCELLED/TIMEOUT` 可提前结束但必须填写原因，并取消未完成节点。重复相同确认幂等，不同 outcome 返回状态冲突。
- 查询 facade `getTaskWorkspace`、`getPlanVersion`、`listTaskPlanVersions` 和 `comparePlanVersions` 都通过 `taskReadableWhere(actor)` 过滤，防止枚举不可读 Task 或 Plan。
- S2 Task mutation service 将 Draft 更新拆为 metadata/member/plan 三个事务，将 Active 直接更新拆为 metadata/member/tag 三个事务；六个入口都先锁 Task、复核服务端权限/状态/`expectedLockVersion`，再原子提交业务数据、审计与新锁版本。Draft plan replace 只接受当前计划已有 `nodeId`；新节点必须使用 `clientKey`，随机或外部 `nodeId` 统一返回 `ASSOCIATION_INVALID`。计划写入的公开时间边界只接受带 `Z`/offset 的 string，内部解析后才使用 `Date`。plan replace 审计不复制 goal、criteria、reviewRequirements 或 businessDescription 正文，只记录 before/after snapshot hash、planned start、节点数，以及有界的 retained/added/removed/reordered ID/type 和字段名变化统计。新 Task、激活、新 Revision 目标及 Revision submit/apply 均严格要求 `plannedStartAt` 和合法 chronology；仅 legacy Active Current Plan 可在创建修复 Revision 或确认 Termination 时忽略已有的空开始时间/旧时间乱序。Revision 目标仍严格校验新 `plannedStartAt`、replacement suffix 和 Termination，只对标记为 `isCarryForward` 的连续历史前缀容忍其内部旧乱序。

P5 Resource Segment 服务端闭环位于 `lib/project-management/application/segment-service.ts`、`app/actions/project-management/segments.ts` 和 `lib/project-management/queries/resource-queries.ts`：

- Segment 服务支持单条/批量 Planned 创建、Actual 创建、更新、批量移动、拆分、合并、取消、完整确认、部分确认、重关联和 Actual 逻辑删除。所有写操作继续在事务内写 `WorkSegmentChange` 和 `DomainAuditEvent`，通过 `expectedUpdatedAt` 执行乐观锁，批量写入保持全成全败。
- 创建或改变 Task/`nodeId` 关联的路径继续与 Draft plan replace 共用 Task 行锁协议；状态转换继续按稳定 Segment ID 顺序锁行。Revision 生效只锁定受影响 Segment，并安全设置 `associationNeedsReview=true`。
- Segment 校验包括 `endAt > startAt`、单条及 merge 最终结果最长 31 天、Actual 完成比例和 Task/Node 关联规则。Planned 只能关联 Current Plan 且未 `REVISED/CANCELLED` 的 Node；Actual 可保留历史 Node 关联。
- 权限规则、状态机、确认生成 Actual、`WorkSegmentSource`、变更历史和审计均保留。多个 Segment 可以时间重叠，服务端不检测、提示、阻止或通知资源冲突。
- `WorkSegment.allocation`、资源冲突领域模型、扫描器、建议预览、处理 action 和相关 DTO 已删除。旧客户端提交 `allocation` 或 `includeConflicts` 会在 strict Zod 边界返回校验错误。

S2 TimeCanvas 查询通过 `app/actions/project-management/canvas.ts` 暴露，并由 strict `POST /api/project-management/canvas` 提供同一可测试边界。五个 operation 都从 Auth.js session 解析当前 actor，再进入 validation、authorization、`ProjectManagementActionResult`、structured logging 和错误脱敏流程；请求不接受 actor、账号、人员或角色注入字段。

TimeCanvas 的请求预算为 Full Segment + Busy 合计 5,000、Task anchor 50、当前计划非删除 anchor Node 合计 5,000。Busy DTO 只包含 `kind`、`visibility`、`personId`、`startAt` 和 `endAt`，不返回源 Segment、Task、Node、内容、版本、比例或冲突摘要。响应不再包含 `conflicts`，Segment DTO 不再包含 `allocation` 或 `conflictIds`。

`scripts/cron.ts` 每 10 分钟在数据库互斥下运行 Segment transition，并在每日 08:15 执行 deadline/retention/integrity 维护。资源冲突的增量与每日全量扫描、checkpoint、运行状态和日志均已删除。定时任务只处理保留的领域状态、审计、站内通知和 `channel=project-management` outbox，不自动生成 Actual，也不自动调整 Segment 排期。

项目管理浏览器入口覆盖 `/progress` 驾驶舱、Task Composer/工作台、Resource Planner、Personal Timeline、Action Inbox、Tag 和通知偏好。所有页面先解析项目管理 actor，再通过 `taskReadableWhere`、`segmentReadableWhere` 或 `recipientAccountId` 过滤，服务端 action 仍执行项目启停、状态机、权限和版本校验。系统角色与 TaskMember 权限取并集；组长改 Task 组织归属时新旧范围都必须匹配。

项目管理浏览器入口统一由 `app/progress/layout.tsx` 渲染全站 `AppHeader`、`PageShell` 和模块 Shell，子页只提供上下文命令栏与业务内容。桌面端使用可折叠的 sticky 左侧导航；移动端使用模态 Drawer。模块 Shell 统一读取通知未读数；不可用对象使用脱敏页面。`--pm-*` 语义变量集中在 `app/globals.css`，适配明暗主题和 reduced motion。`myTimeline`、`taskNew`、`approvals`、`tags` 均已有类型安全路由和导航入口。

统一 `TimeCanvas` 通过显式 adapter 消费 S2 安全 DTO，共享时间坐标、半开区间、上海时区 snap/fit、稳定泳道、选择和 mutation 模型。桌面端使用 `@tanstack/react-virtual` 纵向虚拟化并只渲染横向可见对象；Pixel 5 使用同 DTO 的 `TimeAgenda`。响应式 renderer 通过 `matchMedia/useSyncExternalStore` 只挂载当前视口所需的一套 DOM，避免桌面隐藏 Agenda 仍创建数千节点。Busy 在 adapter 后仍不恢复源 Segment、Task、Node 或版本标识。受控 fixture 页面继续只对官方随机 `_test` runner 开放。

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
| `/admin` | 超级管理员概览 |
| `/admin/accounts` | 统一账号、项目访问与两个角色域管理 |
| `/admin/roles` | 兼容地址，服务端重定向到 `/admin/accounts` |

### 项目管理

| 路径 | 功能 |
|------|------|
| `/progress` | 我的工作总览 |
| `/progress/tasks` | Task 列表 |
| `/progress/tasks/[id]` | Task 工作台 |
| `/progress/resources` | 人员计划时间轴 |
| `/progress/notifications` | 站内通知中心 |
| `/progress/task/:id` | 旧 Task 详情地址，服务端重定向到 `/progress/tasks/:id` |
| `/progress/projects/*`、`/progress/kanban` | 旧 Project/Kanban 地址，临时重定向到 `/progress` |

## 飞书集成要点

- **OAuth 回调**：`/api/auth/callback/feishu`，须在飞书后台为每个允许入口分别配置完整 URL
- **Webhook 签名**：`HmacSHA256("", timestamp + "\n" + secret)` 后 Base64
- **统一私信传输层**：`lib/feishu-message.ts` 导出 `FeishuMessage`、`FeishuMessagePurpose`、`FeishuSendResult` 和 `sendFeishuDirectMessage()`。调用方传入系统用户 `openId`、明确的 `botKind`、用途和 text/交互卡片/CardKit 消息；传输层统一完成收件人身份解析、机器人凭据、token、HTTP 请求、CardKit 创建、禁发闸、allowlist、结构化日志和错误脱敏。
- **机器人边界**：普通通知只能使用通知机器人，审批请求才可声明审批用途。审批机器人未独立配置时使用通知机器人凭据；独立审批应用通过 `User.unionId` 使用 `receive_id_type=union_id`，缺少 `union_id` 时失败并由 outbox 重试。保留既有的“用户对审批应用不可用时回退通知机器人”行为，发送结果会标明实际机器人和是否 fallback。
- **Outbox adapter**：采购、反馈和项目管理业务只能通过 `lib/notification-channels/` adapter 进入统一私信传输边界。adapter 校验 payload 与持久化元数据、计算收件人和构造业务内容；outbox 核心及传输层不包含业务角色查询或状态分支。adapter 的收件人计划可区分真实私信与 Webhook 等独立传输，采购审批必须至少有一个真实私信审批人。项目管理 adapter 会对 `recipientOpenIds` 去重，按 payload purpose 校验 botKind，构造包含操作人、Task、事件、对象、时间和上下文的交互卡，再交给 `sendFeishuDirectMessage()`；项目管理 Server Action 和领域 service 仍不得直接导入飞书传输层。
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
- `PLAYWRIGHT_DATABASE_URL` 仅是官方 Playwright runner 的本机 PostgreSQL 凭据/authority 模板，路径不会作为测试库名使用。runner 每次用 12 个密码学随机字节生成 ownership token，构造 `pw_<token>_target_test` 与 `pw_<token>_shadow_test`，再生成不出现在库名中的 32-byte secret 和 token 唯一、`O_EXCL` 创建的 marker。marker 创建不使用 recursive mkdir：写前逐层核对 canonical worktree、repo `.tmp` 和精确 `0700` ownership leaf，文件必须为同 UID、regular/non-symlink、精确 `0600`、`nlink=1`、大小受限；解析及删除携带 dev/inode 身份并在 unlink 后核对 link count。直接 setup/cleanup 还须验证 secret hash、连接摘要、token、精确名称和确认值。该机制防错误 run、cross-run 和只拿到公开 token/错误 secret 的调用，不是同 UID 恶意进程或已拥有工作树/进程写权限主体之间的认证边界；后者能够读取或篡改同 UID 文件和进程状态，不在 harness 可建立的安全隔离内
- 官方 runner 仅支持可用 POSIX process group 的平台，Windows 会在 marker/child 创建前 fail closed。`npm run test:e2e` 的 script 先以空 `NODE_OPTIONS` 启动 `tsx`，runner 再为 Playwright/Next 后代严格重建受控值；已控制父 npm 进程的同 UID 主体属于前述非认证边界。runner 覆盖四个数据库 URL、强制 `recreate`、官方 `playwright.config.ts`、单 worker和 `127.0.0.1:3002`；调用方所有 short option（包括 Commander cluster）以及 `--config`、`--workers`、`--fully-parallel` 覆盖都会拒绝。runner 自己以独立 POSIX 进程组启动 `start-playwright-server.ts`，完成 DB setup/deploy/seed 并通过受控 HTTP readiness 后，才以另一独立组启动已关闭 built-in `webServer` 的 Playwright CLI。子进程只得到受控 sentinel 与 cwd 绑定官方 guard 的绝对 import；继承的 guard probe output/role 被清空，仅 runner 拥有的 server 组写固定 repo `.tmp` probe。source clone 脚本在加载数据库代码前 hard reject，普通 `SHADOW_DATABASE_URL` 只是 runner 写给 Prisma 的输出。连接后只读核对 TCP、current user 与 maintenance database；Docker 转发下 PostgreSQL 报告容器侧地址/端口是正常现象，安全边界是连接前限定的 loopback URL
- direct setup 的 target/shadow 任一创建失败会尝试精确补偿两个名称，数据库补偿全部成功后才删除 marker；direct cleanup 同样只在两个 DROP 和 connection close 全成功后删除同一 inode marker。runner 只调用这一共享 lifecycle 一次；若 setup 已补偿并移除 marker，runner 会只读确认两个精确库均不存在。任何 drop、close 或 unlink 失败均非零并保留可重试证据。runner 在创建 marker 前先拒绝已占用或状态无法确认的 3002；正常完成、CLI 自发 exit/error、server 自发 exit/error 或中断后，都会分别收束 server 与 CLI 两个独立进程组。只有两组均被进程组检查证明不再存活，才进入数据库 cleanup。3002 availability/readiness 只是辅助门禁和诊断，不替代进程组静默证明；任一组无法证明 quiescent 时会 fail closed、跳过 DB cleanup 并保留 marker，避免活动后代继续访问正在删除的数据库
- runner 对 `SIGINT`、`SIGTERM`、`SIGHUP` 第一次同时转发给当时已存在的 server/CLI 组，5 秒未退出或累计第二个信号时分别升级 `SIGKILL`，再有界确认两组退出；任一 child 可用前到达的信号会累计并在 observer 建立后立即执行 graceful/force 意图。server 在 readiness 前或测试执行中异常退出会终止 CLI，并经过同一双组静默门禁。数据库 cleanup 后入口先设置 canonical exit code（129/130/143），记录递归展开且经 logger redaction 的聚合叶子原因，再尝试重新触发原信号；若启动器忽略信号或 `process.kill` 失败也不会自然返回 0。直接杀死 runner 的 `SIGKILL`、进程崩溃、操作系统故障或断电无法保证执行 cleanup，遗留库只能由 DBA 在只读确认精确名称后处理
- dev 热更新可能导致 client 缓存过期；`lib/prisma.ts` 中 `isPrismaClientStale()` 会在缺少新 model delegate 时重建 client
- schema 变更后执行 `npx prisma generate` 并重启 dev server
- 旧 SQLite 数据不迁移；首次部署从空 PostgreSQL 库开始

### 常用命令

```bash
npm run db:deploy              # prisma migrate deploy（等待 PG 就绪）
npm run db:seed -- --super-admin-open-id=<openId> # 初始化首位统一超级管理员
npm run accounts:preflight    # 旧 schema 统一账号迁移只读预检
npm run accounts:validate     # 新 schema 统一账号迁移只读核对
npm run db:fix-roles           # 清理异常角色数据后重新 seed
npm run db:studio              # Prisma Studio
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
| 每 10 分钟 | 项目管理 Planned Segment 状态迁移（数据库 advisory lock） |
| 每日 08:15 | Milestone 截止提醒、通知保留清理、项目管理完整性巡检 |

与 Next.js 主进程分离，生产环境用 PM2、systemd 或下文 **Docker** 中的 `cron` 服务单独拉起。

项目管理 cron 不只依赖进程内 boolean；每类保留任务先用 PostgreSQL transaction advisory lock 做跨实例互斥。Task、WorkSegment、站内通知和 outbox 的 S9 查询索引继续保留，原扫描 checkpoint 表已删除。

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
