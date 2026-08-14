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
- 通知 outbox 分两层：`NotificationOutbox` 表示业务事件，`NotificationOutboxRecipient` 表示单个收件人的投递状态。`lib/notification-outbox.ts` 保持稳定 façade，通用入队/重试、claim/heartbeat、逐收件人协调与状态汇总拆入 `lib/notification-outbox/`；核心只接受注入的 channel resolver，`lib/notification-delivery.ts` 作为组合入口连接 adapter registry。重试失败收件人时不能把已成功收件人再次发送；临时解析/网络错误退避重试，损坏 payload、未知 channel、非法 `type/botKind` 等确定性配置错误直接冻结，修正后才可人工重置。
- 浏览器共享契约位于 `lib/project-management/composer-contract.ts` 与 `lib/project-management/time-canvas/`，服务端领域和查询不得从 `components/` 或带 `"use client"` 的模块反向导入类型或实现。`npm run check:dependencies` 使用 TypeScript AST 校验传递依赖边界、浏览器契约的服务端依赖、outbox 核心业务依赖，并从 Next 路由、脚本、测试和根配置入口遍历后拒绝 `components/`/`lib/` 中不可达的源码。

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
- outbox claim 使用查询时的 `status/attempts/lockedUntil` 与可投递时间进行条件更新；收件人外部发送期间定时在同一事务续租父 outbox 与 recipient，所有完成/失败回写继续以最新 `attempts + lockedUntil` fencing，避免旧 worker 覆盖新租约或慢请求触发重复投递。
- channel adapter 必须固化业务 payload 与收件人计划；不要在 outbox 核心或飞书传输层增加业务分支。
- 维护脚本应逐步统一 dry-run/confirm 约定，写操作脚本必须要求显式确认（例如既有 `APPLY_*=true` 或受控 `--apply` 参数）和目标数据库确认；会触达飞书的脚本必须要求 `CONFIRM_SEND_FEISHU=true`，并默认尊重 `NOTIFICATION_DELIVERY_DISABLED=true`。

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

`Account + AccountIdentity` 是两个业务域共同的账号底座；`Person` 承载项目成员资料，`User` 通过唯一、非空 `accountId` 保留采购订单关系。飞书 `unionId` 优先作为 `providerSubject`，无 `unionId` 时使用 `open:<openId>`。身份解析与报销 User 协调在同一事务中按 `accountId → unionId → openId` 查找；`openId` 轮换会更新原 Identity 和 User，候选指向不同账号或重复 Identity 时硬失败并写脱敏审计，不按姓名自动合并。账号级项目访问禁用字段和 Proxy/Actor gate 已删除；项目可见性与写权限继续由系统角色、TaskMember、`taskReadableWhere` 和各 action 授权规则服务端执行。

账号与权限后台采用三块职责管理：车组职责、技术组职责以及用户与角色。职责矩阵独立读取全部有效报销角色，不受下方账号列表分页影响；账号列表继续使用服务端筛选和每页 30 条分页。管理员账号选择器及指导老师邮箱更新均使用稳定 `accountId` 定位账号，只允许统一超级管理员调用；邮箱更新和安全审计在同一事务内写入。`REIMBURSEMENT` 范围仅返回已绑定报销 `User` 的账号。空查询使用绑定选择范围的稳定游标，关键词查询在最多 501 个直接/回退候选内按姓名、拼音、`openId`、`unionId` 和邮箱排序并返回前 50 项。页面筛选和选择器共用同一有界模糊匹配实现。

人员与 Task option 查询采用有界两阶段搜索：非空查询在授权 where 内最多读取 501 个直接或回退候选，按 NFKC、前缀、分词前缀、子串、拼音首字母与顺序匹配评分并返回前 50 项；空查询保留绑定 filter hash 的稳定 ID 游标。批量 resolver 按输入顺序完整恢复已选 ID 且静默丢弃不可见对象，不再沿用旧 50 项上限。客户端基于 Base UI Combobox，使用 250ms 防抖、scope/filter 缓存和请求序列防止旧响应覆盖。

## 权限

| 模块 | 文件 | 说明 |
|------|------|------|
| 采购 | `lib/permissions.ts` | 服务端角色查询 |
| 采购（客户端） | `lib/permissions-client.ts` | 纯函数，无数据库依赖 |
| 项目管理 | `lib/project-management/authorization` | P1-P6 授权、稳定 action 字符串、状态机操作鉴权和 readableWhere 查询过滤 |
| 统一账号 | `lib/account-authorization.ts` | 统一账号和两个角色域的授权上下文 |
| 账号变更 | `lib/account-management.ts` | 超管复核、事务锁、审计与通知 |

报销活跃角色为 `TEAM_ADMIN`、`TECH_GROUP_ADMIN`、`TEACHER`、`FINANCE`。授权、审批收件人和角色签名回退均通过 `UserRole.accountId` 读取账号当前身份；`UserRole.openId` 仅为只读历史兼容字段。采购管理审核同时保存审批人的稳定 `accountId` 和当时的 `openId` 快照，验收清单签名优先按 `accountId` 解析，避免飞书身份轮换后错误回退到当前组长。旧 `UserRole.SUPER_ADMIN` 仅保留撤销历史；统一超级管理员在报销权限 helper 中合成兼容的超管语义。

项目系统角色枚举只包含全局 `SUPER_ADMINISTRATOR` 和全局 `PROJECT_ADMINISTRATOR`，二者在项目业务中统一视为全局管理员。`GROUP_LEADER` 与旧 `SYSTEM_ADMINISTRATOR/TEAM_ADMINISTRATOR/RESOURCE_MANAGER/AUDITOR` 的已撤销事实只保存在 append-only `DomainAuditEvent`，账号历史页仍可查询；运行时表、Prisma 类型、授权与账号管理输入均不再接受旧角色。该退役不影响采购报销独立的 `TEAM_ADMIN/TECH_GROUP_ADMIN`。审批提交和全局角色撤销共用全局事务 advisory lock；存在 Task 数据时，账号后台不得撤销最后一名具有 default tenant 非空飞书 `openId` 的全局管理员，审批提交会在事务内重复校验，否则业务状态与通知全部回滚。数据库永久延迟约束覆盖 Task 首次创建、账号删除、全局角色与飞书身份，防止绕过应用层或部署窗口中的并发写入破坏同一不变量。

Task 成员角色枚举只包含 `OWNER` 和 `PARTICIPANT`。同一 Person 在同一 Task 中最多一个有效角色，一个 Task 可以有多名 Owner 但至少有一名；整包成员替换先锁 Task，并在同一事务维护成员历史、乐观锁、审计和通知。Task 关联 Segment 的所有用户写路径先锁关联 Task、再按稳定顺序锁 Segment，并基于锁后的成员快照复核操作者权限和 Segment 持有人成员关系，避免 Owner 被并发降级后继续使用旧权限。已结束的 `LEAD/MEMBER/REVIEWER/VIEWER` 事实仅保存在 append-only `DomainAuditEvent`，不再参与运行时成员读取或 Composer 恢复。Work Segment 不再保存工作职责，也不关联 Task Node。

所有已登录统一账号都可读取全部未删除 Task、计划、验收、Task 审计和完整 Work Segment，也都可创建合法组织范围的 Task；创建者自动成为 Owner。账号模型不再提供项目访问启用/禁用状态。非成员只有读取权，Participant 可编辑 Task/计划、提交验收与 Revision 并管理自己的关联 Segment，Owner 另可管理成员、Task 状态、任意未生效 Revision 和该 Task 全部 Segment，全局管理员拥有全部项目写权限。所有 capability 由服务端计算，终态、关联和状态机校验不因全员可见而放宽。

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

新建采购申请和工坊加工费会先使用预分配的订单 ID 安全写入全部图片；文件准备完成后，订单、明细、最终状态与提交 outbox 才在单一事务中创建。草稿更新同样先完整暂存新图片，再以页面读取到的 `updatedAt` 做乐观版本校验，并在单一事务替换订单与明细；沿用旧图片时服务端要求路径来自当前订单现有明细，且对应 `FileAsset` 的 `orderId/kind` 匹配。文件准备阶段不会暴露中间业务状态，第二张文件失败或数据库事务失败时会清理本次暂存文件，成功后再补偿清理被替换图片。MIME 内容识别位于 `upload-mime.ts`，原子文件替换、资产登记及失败恢复位于 `upload-asset-writer.ts`，`file-upload.ts` 只保留领域上传包装和稳定公共入口。通用上传补偿会执行两次即时幂等清理；持续失败时在 `FileAsset.cleanupRequestedAt/cleanupNextRunAt` 留下持久化任务，由 cron 每 10 分钟继续重试，避免事务失败、附件替换、管理员删除或生成文档注册失败后静默遗留文件。同一任务还会处理超过一小时的 `.tmp-*`/`.bak-*`：临时文件删除，备份在主文件缺失时恢复、主文件存在时清理。签名等固定路径资产覆盖注册失败时不会复用删除资产任务，而是把失败的新文件隔离为 `.tmp-cleanup-*`，通过绑定原 `FileAsset.writeGeneration` 的 `.restore-bak-*` 标记即时或由 cron 恢复旧文件，并保留原权限元数据；后续成功覆盖会推进写入代次，使旧恢复标记只能清理、不能回滚新文件。

**预算池**（`lib/procurement-budget.ts`、`lib/procurement-budget-alerts.ts`）：

- 超级管理员在 `/admin` 通过 Excel 导入预算（项目、车组、技术组、预算、周期默认 2026）；每行一个项目，同组可有多个项目；仅「项目+车组+技术组+周期」完全相同才合并预算；展示顺序与导入表行序一致；单次最多 300 行；支持追加或覆盖同周期数据。导入会按周期排序获取事务级 advisory lock，删除与 upsert 保持在同一事务，防止并发覆盖交错或多周期导入死锁
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

旧项目管理专用模型和开发数据已通过 migration 删除。新 Project 不是旧模型恢复：它不包含 Project Stage、周报或旧审批角色；当前风险、评论和近期动态使用下述统一账号与领域审计实现，不复用旧表。

当前项目管理数据模型还包括 `Project`、`ProjectMember`、`ProjectEstablishmentRequest` 和 `ProjectEstablishmentRequestedTask`。`Task.projectId` 可空且最多指向一个 Project；有效 Project 成员和单一待审批轮次由 PostgreSQL partial unique index 保证。Project 删除使用 `deletedAt` 软删除，并在同一事务清空关联 Task 的 `projectId`。

`RiskRecord` 和 `Comment` 分别是风险与评论的多目标事实表。两表都有可空 `projectId/taskId`，PostgreSQL XOR 检查约束保证恰好一个目标；外键均为 `Restrict`。风险允许同一目标多条 `ACTIVE`，状态只能由 `ACTIVE` 条件更新为 `RESOLVED`，数据库同时约束解决人、说明和时间的一致性。评论不编辑、不恢复，删除只写 `deletedAt/deletedBy*` 软删除字段并由一致性约束保护。Account 外键和姓名快照保留可解释历史，Person 外键允许为空。

风险与评论 mutation 位于 `lib/project-management/application/collaboration-service.ts`：事务内重新读取系统角色、锁定目标或记录、执行状态和成员权限、写业务表与 `DomainAuditEvent`。风险提出/解决和评论发布在同一事务写站内通知及 `channel=project-management` outbox；评论删除不通知。Project/Task 负责人、参与人和两类全局管理员可操作其直接风险；Project 成员不会继承下属 Task 风险权限。所有已登录用户可评论，只有全局管理员可删除。

近期动态只读取 `DomainAuditEvent`。白名单 formatter 返回中文标题和有界字段摘要，不把 raw `before/after` 中的内部 ID、hash、锁版本或未知 action 下发浏览器；DTO 只保留分页去重与安全详情链接需要的记录 ID/路径。筛选、`createdAt + id` 游标和 20 条分页均在服务端执行；Revision、Milestone、Terminal 和人员投入名称通过当前页最多 20 条事件的有界批量查询装配。所有新 Task 审计在统一审计写入函数中固化事件发生时的 `projectId`；Task 加入、移出或移动事件以 `before/after.projectId` 支持两个 Project 查询。既有缺少 `projectId` 的普通 Task 审计不回填，也不进入 Project 动态。客户端每 5 秒查询最新可见审计版本 token，隐藏页面暂停，恢复可见立即检查，并用请求序号防止旧结果覆盖。

Project 详情查询在 Project 可见性校验后，按 `DRAFT`、`ACTIVE`、所有终态三个状态组读取全部未删除 Task，组内使用 `updatedAt desc, id asc`。查询加载这些 Task 的 Current Plan Start、Milestone、Revision 与 Terminal，服务端序列化后由详情页组装只读 TimeCanvas；客户端不能提交任意 Task ID 扩大计划范围。全部计划共同受 5,000 节点上限约束；超限时保留 Project 与 Task 列表、停止向客户端下发节点正文，并在时间线区显示明确错误，不能静默截断。立项轮次和领域审计继续保存，详情 UI 只移除其历史卡片，并用概览上的 `#establishment` 锚点保留待办和通知深链。

P2/P3 已补齐 Task 计划生命周期的服务端闭环。`lib/project-management/application/lifecycle-service.ts` 只保留稳定公共出口，Task 草稿/激活、Revision、Milestone Review 与 Termination 的完整事务分别位于独立命令模块；共享行锁、锁后可见性、Current Plan 读取、节点推进、计划哈希/审计和通知收件人解析位于内部领域模块。外部入口仍为 `app/actions/project-management/{tasks,plans,revisions,milestones,terminations}.ts` 和 `lib/project-management/queries/task-queries.ts`：

- Task 草稿创建在事务中写入 `Task(status=DRAFT)`、初始 `TaskPlanVersion(status=CURRENT, activatedAt=null)`、`0–200` 个有序 Milestone、末尾 Termination、成员、审计、站内通知和 `channel=project-management` outbox；Start 固定由 `plannedStartAt` 表示，Terminal 持久化 trim 后 `1–200` 字符的名称（默认 `Terminal`）。Start、每个 Milestone 与 Terminal 时间必须严格递增，不接受同刻。`TaskPlanVersion.idempotencyKey` 与 `creationRequestHash` 支持同账号请求幂等和 payload 冲突检测。任何已登录并成功解析到统一 `Account/Person` 的账号都可创建，服务端把创建者归一化为 Owner；即使创建者 Person 已停用也保留该自动 Owner，其他新增成员必须是活跃 Person。模板成员只复制 Owner/Participant，人员冲突时 Owner 优先，模板计划继续复制 Terminal 名称并按新时间规则重新校验。
- `activateTask` 锁定 Task 行，校验 Draft 状态、Owner 权限、`expectedLockVersion`、计划开始时间不晚于事务内服务端激活时间、至少一名 OWNER、合法计划、末尾 Termination 和连续序号后递增 `lockVersion`。该规则只作用于新的 DRAFT → ACTIVE 转换，不追溯历史 Task。存在 Milestone 时把首个 Milestone 置为 `ACTIVE` 并写入 `activeMilestoneNodeId`；零 Milestone 时直接激活 Terminal，`activeMilestoneNodeId` 保持 `null`，审计、工作台和通知以 Terminal 名称表示实际活动节点。
- `deleteTaskDraft` 只允许 Task Owner 或全局管理员对 `DRAFT` 执行，在 Task 行锁内复核权限、未激活状态和 `expectedLockVersion`，递增锁版本并写入 `deletedAt`。删除保留 Task、计划、成员及审计历史，但所有未删除 Task 查询和直达路由不再返回该草稿。
- Revision 只允许基于当前 Current Plan 和匹配的 `RevisionNode.baseTaskLockVersion` 创建。`revisionAt` 是用户选择的事件时间；它不形成阶段、不参与 Milestone 严格递增，也不能关联 Segment。目标计划固定沿用 Current Start，自动保留全部已完成 Milestone 和已生效 Revision，并重建全部未完成 Milestone 与 Termination。创建即为 `PENDING_APPROVAL`；被驳回记录保留候选计划，修改时递增 `reviewRound` 并直接重新送审，不存在 `DRAFT` Revision 或单独 submit。每个 Task 只允许一个 `status=DRAFT` 的 Revision 候选计划。Participant 可管理自己创建的未生效 Revision，Owner/全局管理员可管理该 Task 任意未生效 Revision。只有全局管理员批准后才原子历史化旧 Current、启用新 Current 并标记被替换节点为 `REVISED`；Segment 仅关联 Task，因此无需关联失效或重关联流程。
- Milestone Review 允许 OWNER/PARTICIPANT/全局管理员提交 TEXT/LINK 证据；FILE 证据当前返回中文校验错误。只有两类全局管理员可以通过、驳回或要求修订，并允许处理自己提交的 Review。通过后推进到下一 Milestone 或激活 Termination；驳回和要求修订不推进。未撤出的原 Review 使用相同 `idempotencyKey` 时重放原结果，不同请求键在既有 Review 仍待审批时返回 `STATE_CONFLICT`；已撤出的旧请求键也返回明确冲突，调用方必须使用新键重新提交。`reviewerAccountId/reviewedByAccountId` 等历史数据库字段继续保存实际审批人，应用界面统一显示“审批人”。
- `lib/project-management/task-approval-gate.ts` 统一查询未撤出的 `PENDING` Milestone Review 与 `PENDING_APPROVAL` Revision，并返回空闲、单条占用或多条冲突。创建/重新送审 Revision、提交 Milestone 和确认 Termination 都先在事务内通过 `lockTaskTx` 锁定同一 Task 行，处理幂等重放后再检查门禁，因此跨类型并发只会有一个写入成功。审批通过、驳回、要求修订、取消或撤出在原事务内离开待处理状态，自动释放门禁；门禁拒绝不写审计、通知、证据、计划或 Task 锁版本。
- Termination 确认写入 outcome、reason、summary 和 Task 终态。`SUCCESS` 要求所有前置 Milestone 已完成；`FAILED/CANCELLED/TIMEOUT` 可提前结束但必须填写原因，并取消未完成节点。重复相同确认幂等，不同 outcome 返回状态冲突；存在任一 Milestone/Revision 待审批或防御性多审批冲突时不能结束 Task，且 Terminal 本身不创建审批记录。
- 查询 facade `getTaskWorkspace`、`getPlanVersion`、`listTaskPlanVersions` 和 `comparePlanVersions` 都通过 `taskReadableWhere(actor)` 限定 `deletedAt=null`；所有已登录统一账号共享读取范围，但删除对象仍不能通过显式 ID 枚举。
- Task mutation 公共边界只保留 `updateTaskDraft` 与 `updateActiveTask`。Draft 入口在一个事务内锁定 Task 与节点关联、刷新操作者权限，复核 DRAFT、初始未激活 v1 Current Plan、`planVersionId`、`expectedLockVersion`、组织范围、关联 Task、可选成员和 Segment 引用约束，再整体写入元数据、可选成员和完整计划，重算 `snapshotHash`，只递增一次 Task `lockVersion` 并追加一条 `pm.task.draft.update` 审计。Participant 请求必须省略 `members`，事务保留权威成员；伪造成员字段由服务端拒绝。Active 入口在同一事务差异更新元数据与成员，保持成员通知、审计和 outbox 原子性。旧 metadata/member/plan 独立 action、service 与 validation 已删除。
- Task mutation 的计划记录/差异审计与 Active 成员通知解析已经独立；默认飞书租户身份选择和 Task 授权资源构造由项目管理共享模块提供。各写操作仍只有原来的一层事务，锁顺序、幂等键、审计与 outbox 原子性不变。
- Draft 计划整包写入接受 `0–200` 个 Milestone，只接受当前计划已有 `nodeId`；新节点必须使用稳定 `clientKey`，随机或外部 `nodeId` 统一返回 `ASSOCIATION_INVALID`。计划写入的公开时间边界只接受带 `Z`/offset 的 string，内部解析后才使用 `Date`，Start/Milestone/Terminal 必须严格递增。计划审计不复制 goal、criteria、reviewRequirements 或 businessDescription 正文，只记录 before/after snapshot hash、planned start、节点数、Terminal 名称变化，以及有界的 retained/added/removed/reordered ID/type 和字段名变化统计。新 Task、激活、新 Revision 目标及 Revision apply 均严格要求固定的 `plannedStartAt` 和合法 chronology；既有只读或 Active Current Plan 的旧同刻/乱序数据不被迁移自动改写，但新 Draft 保存、模板副本或 Revision 目标必须先修正。Revision 标记时间另行校验为 `[Current Start, Candidate Terminal]`，且不得早于最后完成 Milestone 或上一条已生效 Revision；四类边界均允许相等。

`TerminationNode.name` 是 `VARCHAR(200) NOT NULL DEFAULT 'Terminal'` 的计划版本字段，随创建、Draft 替换、Revision、模板复制、查询 DTO、版本差异和有界审计摘要传播。默认名称为 `Terminal` 时计划快照保持旧 canonical 形式；只有自定义名称进入新增 canonical 键，因此既有默认名称计划的 hash 不会全量失效，自定义名称变化会改变快照 hash。

迁移 `20260805120000_single_task_pending_approval` 不改变 Prisma 业务模型。它必须在应用写入和通知 worker 均停止的维护窗口执行，并在单个显式事务中撤出全部当前 Task 待审批：Milestone 保留 `PENDING` 历史并写 `revokedAt/revokeReason`，Revision 转为 `CANCELLED`、候选计划转为 `ABANDONED`、候选计划内非承接且未完成节点转为 `CANCELLED`；Current Plan、正式时间线与 Task `lockVersion` 不变。迁移同时用确定性 ID 写 `source=MIGRATION` 审计，冻结对应可重试 outbox 和未完成 recipient，将相关未读站内通知标记为已读，并在提交前断言待审批总数为零。采购、报销、投入确认和关联复核表不在操作范围内。

迁移 `20260805115000_prepare_work_segment_role_node_removal` 先为历史删除迁移准备已知漂移库：若旧删除迁移尚未成功，它会幂等补齐删除语句依赖的枚举值、字段、索引和约束；若旧删除迁移已记录成功，则保持 no-op，避免低编号迁移后补时重新引入已删除结构。这样从漂移状态直接部署完整 pending migration 链也不会在历史删除迁移处中止。

迁移 `20260805130000_repair_work_segment_schema_drift` 修复迁移历史已记录 P1、但 `WorkSegment` 被外部旧结构覆盖的数据库漂移。它只补齐 `WorkSegmentRole`、`WorkSegmentChangeAction.RELINK`、四个 Segment 字段及对应索引、外键和检查约束；结构已正确的数据库执行时为 no-op。迁移不删除或改写 Segment 数据。后续 `20260805131000_validate_work_segment_schema_repair` 会核对完整枚举集合、字段类型/可空性/default、索引列序和类型、外键目标与动作以及检查约束表达式；`20260805132000_validate_work_segment_index_semantics` 继续验证索引排序/NULLS 选项、默认 operator class 与 collation。若同名对象定义不正确则 fail-fast，不会把未解决的漂移记录为成功迁移。

迁移 `20260805133000_finalize_task_only_work_segments` 在上述历史修复之后收敛最终模型。它兼容旧删除迁移已执行或尚未执行两种路径，再次清理关联失效通知、outbox、重关联和纯关联失效历史，移除历史 JSON 顶层废弃字段，并最终删除职责、TaskNode 关联、关联复核字段、索引、约束、`WorkSegmentRole` 与 `RELINK`。迁移结束前会校验最终枚举、字段和审计 append-only trigger；Task、TaskNode、Milestone、Revision、Termination 以及普通 Segment 数据继续保留。

P5 Resource Segment 服务端闭环位于 `lib/project-management/application/segment-service.ts`、`app/actions/project-management/segments.ts` 和 `lib/project-management/queries/resource-queries.ts`：

- Segment 服务支持单条/批量 Planned 创建、Actual 创建、更新、批量移动、拆分、合并、取消、完整确认、部分确认和 Actual 逻辑删除。所有写操作继续在事务内写 `WorkSegmentChange` 和 `DomainAuditEvent`，通过 `expectedUpdatedAt` 执行乐观锁，批量写入保持全成全败。
- 创建或改变 Task 关联的路径继续使用 Task 行锁，并要求 Segment Person 是目标 Task 的有效 Owner/Participant；新建、批量新建、更新、拆分、合并和确认均复核该成员一致性。状态转换继续按稳定 Segment ID 顺序锁行。Segment 不再保存职责、Task Node 关联或关联复核状态。
- Segment 校验包括 `endAt > startAt`、单条及 merge 最终结果最长 31 天和 Task 成员关联规则。`completionPercent` 已从写入 validation、service DTO、普通查询 DTO 和数据库列完全退役；迁移前的非空数值连同 Segment、Task、类型、状态和历史时间保存在 append-only `DomainAuditEvent`。
- Segment DTO/审计快照、时间范围与状态规则、定时状态迁移分别位于独立模块；创建/修改、批量移动/取消和确认/来源仍由主服务在单层事务中编排。
- 所有已登录统一账号可读取全员完整 Planned/Actual Segment 和变更历史。Participant 只能管理自己的 Task 关联 Segment，Owner 可管理该 Task 全部 Segment，全局管理员可管理全部；非成员不能写入已有 Task。无 Task 关联的 Segment 仍由本人管理。停用 Person 的历史 Segment 继续展示，但不能创建新 Segment。状态机、确认生成 Actual、`WorkSegmentSource`、变更历史和审计均保留。多个 Segment 可以时间重叠，服务端不检测、提示、阻止或通知资源冲突。
- `WorkSegment.allocation`、资源冲突领域模型、扫描器、建议预览、处理 action 和相关 DTO 已删除。旧客户端提交 `allocation` 或 `includeConflicts` 会在 strict Zod 边界返回校验错误。

S2 TimeCanvas 查询通过 `app/actions/project-management/canvas.ts` 暴露，并由 strict `POST /api/project-management/canvas` 提供同一可测试边界。五个 operation 都从 Auth.js session 解析当前 actor，再进入 validation、authorization、`ProjectManagementActionResult`、structured logging 和错误脱敏流程；请求不接受 actor、账号、人员或角色注入字段。

TimeCanvas 的请求预算为 Full Segment + Busy 合计 5,000、当前计划非删除 anchor Node 合计 5,000；Task、Person 与 anchor Task 行不设数量分页。`rowPageKey`、Prisma 选择集、DTO/权限映射和自适应 leaf 预算分别由查询内部模块负责，页面级查询只编排 scope、行、Segment、Busy 与 Anchor 加载。Busy DTO 只包含 `kind`、`visibility`、`personId`、`startAt` 和 `endAt`，不返回源 Segment、Task、内容、版本、比例或冲突摘要。TimeCanvas 请求不接受 Node 过滤，Segment DTO 不包含职责、Node 关联、关联复核、`allocation` 或 `conflictIds`。

资源计划使用服务端集合展开：`TaskSet = (直接选择 Task ∪ 所选 Project 的未删除 Task) ∩ 所选 Task 状态`，`PersonSet = 直接选择 Person ∪ TaskSet 有效成员 ∪ 所选 Project 有效成员`。状态集合覆盖 `DRAFT/ACTIVE/COMPLETED/FAILED/CANCELLED/TIMEOUT/ARCHIVED`，默认 `DRAFT + ACTIVE`，允许空集合；Task 选项查询使用相同状态条件。状态筛选只影响计划轨道和由 Task 推导的人员，已经由直接选择、Project 成员或焦点进入 `PersonSet` 的人员仍按 Person 范围读取全部可见 Segment，不再按所属 Task 状态过滤。Task 与 Person 一次完整装配、不使用行游标；焦点 Segment 对应 Person 固定置前，焦点 Task 只有符合状态时才进入计划轨道，但始终独立完成可见性校验。Current Plan 轨道只读，人员行保留既有 Segment capability；内容范围两侧增加两个上海日历月，并限制在三年逻辑窗口内按最多 180 天自适应读取，单次自适应查询继续受 20,000 个对象和 16 个 leaf block 预算约束。

迁移 `20260811190000_remove_project_management_tags` 删除 `SegmentTag`、`TaskTag` 与 `Tag`。应用同步删除 Tag 路由、查询、Action、Task/Segment 输入和 DTO，不保留兼容入口；既有 `DomainAuditEvent` 继续 append-only 保存，但近期动态不再解释历史 `tagIds`。

`scripts/cron.ts` 每 10 分钟在数据库互斥下运行 Segment transition，并在每日 08:15 执行 deadline/retention/integrity 维护。资源冲突的增量与每日全量扫描、checkpoint、运行状态和日志均已删除。定时任务只处理保留的领域状态、审计、站内通知和 `channel=project-management` outbox，不自动生成 Actual，也不自动调整 Segment 排期。

项目管理浏览器入口覆盖 `/progress` 统一“我的工作”、Task Composer/工作台、资源计划、Action Inbox 和通知偏好；`/progress/task/:id`、`/progress/kanban`、`/progress/my-timeline`、`/progress/resources/conflicts`、`/progress/tags` 与 `/admin/roles` 返回 404。所有页面先解析项目管理 actor；`taskReadableWhere` 和 `segmentReadableWhere` 对所有已登录统一账号返回全部未删除对象，人员列表返回所有活跃 Person，并在所选范围继续展示有历史投入的停用 Person。停用 Person 对应账号仍可进入页面、全局读取并创建 Task，其本人会成为该 Task 的自动 Owner；停用 Person 不可作为其他 Task 的新增成员，也不可创建新 Segment。服务端 action 仍执行成员、Person 状态、状态机、权限、关联和版本校验，DTO capability flags 决定只读或可操作 UI。审批待办和审批按钮只对两类全局管理员可用。

项目管理浏览器入口统一由 `app/progress/layout.tsx` 渲染全站 `AppHeader`、`PageShell` 和模块 Shell，子页只提供上下文命令栏与业务内容。桌面端使用可折叠的 sticky 左侧导航；移动端使用模态 Drawer。模块 Shell 统一读取通知未读数；不可用对象使用脱敏页面。`--pm-*` 语义变量集中在 `app/globals.css`，适配明暗主题和 reduced motion。`taskNew`、`taskEdit`、`taskRevisionNew`、`taskRevisionEdit`、`approvals`均已有类型安全路由和导航入口；个人时间不再有独立导航项。`/progress/tasks/new`、仅限 DRAFT 的 `/progress/tasks/[id]/edit`、Revision 新建和驳回重提路由共用 Task Composer；权限不足返回脱敏 404，状态变化或已有候选时重定向工作台。DRAFT 工作台只读展示概览与 Current Plan，并在右上角按“编辑 Task → 激活 Task → 删除草稿 → 复制链接”给出能力允许的操作。ACTIVE 工作台右上角“发起 Revision”进入独立新建页；Revision Tab 只保留历史、审批/驳回、取消和三层 Diff，被驳回记录链接到独立编辑页。

Task Composer 支持 `CREATE`、`EDIT_DRAFT`、`CREATE_REVISION`、`RESUBMIT_REVISION` 四种模式。桌面端采用“Task/Revision 信息 / TimeCanvas 与节点表 / 节点 Inspector”三栏，画布与节点表使用同一受控选择和实时节点状态；Inspector 不设保存/取消，连续编辑按节点合并为一条撤销历史。新增 Milestone 立即成为 Composer 专用临时节点，补全后自动转正；Task 编辑保留既有 `nodeId`，新节点的 Composer ID 作为提交 `clientKey`。Revision 模式固定 Start，把已完成 Milestone 和已生效 Revision 作为只读承接节点，仅提交可替换 Milestone、当前 Revision 时间/原因和 Terminal；Revision Marker 不参与阶段带边界。节点元数据保存临时生命周期和无效时间输入期间的最后合法画布位置，不进入服务端 DTO。Pixel 5 保留纵向实时编辑且不显示桌面画布布局。Composer 只复用时间坐标与交互，不查询成员 Planned/Actual/Busy。

Composer 的浏览器安全契约位于 `lib/project-management/composer-contract.ts`，服务端 seed 构造器不再依赖客户端组件。计划时间与节点变换、校验和提交指纹、v4 草稿解析、提交 payload、撤销历史、自动保存和离开保护分别由独立模块负责；客户端壳只组合表单、计划编辑器、恢复提示和业务命令。恢复边界只接受 v4 envelope；v1/v2/v3 不读取、不转换也不导出。`task-composer-legacy-draft-tombstone.ts` 只删除旧 localStorage key 与 IndexedDB 正文，首次生产发布满 30 天后删除该 tombstone 与调用点。

创建草稿继续使用账号/环境隔离的 v4 存储；编辑草稿使用 `task-edit-draft:{environment}:{accountId}:{taskId}:v1`，正文额外绑定 `taskId`、`planVersionId` 和基础 `lockVersion`。两者对普通内容使用 `localStorage`，对合法 200 节点长文本草稿使用 IndexedDB 并在 `localStorage` 保存校验指针；临时状态和最后合法位置随正文保存。同账号多标签页通过 Web Locks 串行化完整存储事务，离开前取消待触发防抖并等待已入队写入及清理完成。编辑恢复只接受环境、账号、Task、Plan Version 和锁版本完全匹配的内容；版本不匹配时仅允许导出或放弃并加载最新版本，不做字段合并。失去成员管理权后恢复时以服务端成员覆盖本地成员。保存成功后清理本地编辑草稿并返回工作台；浏览器清理失败不改变已提交事务的成功结果。

TimeCanvas 保持统一 `TimeCanvasProps/TimeCanvasModel` 契约：Desktop 支持周/月/季/年缩放、虚拟行、键盘焦点、刷选、Segment 横移/缩放和节点锚点；Pixel 5 不开放直接拖动，使用精确表单。资源计划按不超过 180 天的上海时区块自适应加载并缓存，URL 使用 `focus`、`center`、`scale`、`projects`/`tasks`/`people` 和 Task 状态多选 `taskStatuses`；缺失 `taskStatuses` 规范化为默认 `DRAFT,ACTIVE` 并在 URL 中省略，空集合保留为 `taskStatuses=`，非默认集合按固定枚举顺序序列化。`focus` 可定位投入及人员，但不绕过状态筛选增加 Task 计划。`timelineDate`、`timelineFocus`、单值 `personId`/`taskId`、`start`/`end`、`zoom` 以及已退役的 `taskCursor`/`personCursor` 会被忽略并从规范 URL 移除。mutation 后以权威刷新为准。详情 Dialog 只向目标 Segment 注入可编辑 transform；详情与悬浮提示都展示关联 Task 名称，无 Task 时显示“独立投入”，Busy 不泄露 Task。

统一 `TimeCanvas` 通过显式 adapter 消费 S2 安全 DTO，共享时间坐标、半开区间、上海时区 snap/fit、稳定泳道、选择和 mutation 模型。`TASK_COMPOSER` 模式额外支持外部受控选中、锚点选择、空白位置创建请求、锚点拖动/键盘移动回调和带名称/颜色的阶段带；Start、Milestone、Terminal 都是可操作锚点，阶段带标注下一节点，业务严格边界和 Milestone 自动重排由 Composer 负责。人员投入总览覆盖既有 Segment 的写权限，只保留双击/Enter 打开详情；详情 Dialog 才向目标 Segment 注入 transform 回调，同一行其他 Segment 始终只读。所有视口均使用 `@tanstack/react-virtual` 的横向时间画布，窄屏仅在画布容器内滚动，不再装配 `TimeAgenda`。Busy 在 adapter 后仍不恢复源 Segment、Task、Node 或版本标识。受控 fixture 页面继续只对官方随机 `_test` runner 开放。

TimeCanvas 的键盘焦点、刷选与 Segment 变换数学、只读 Inspector、工具栏/Axis/底部滚动条已经从主渲染器分离；资源计划客户端的分块缓存与 URL 同步、Quick Create、Segment Inspector 和部分确认表单也各自拥有独立模块。部分确认表单不收集原因，只提交确认范围与 Actual 的内容、预期输出和实际输出；服务端继续生成系统变更说明。页面继续只依赖稳定的 `TimeCanvasProps`/`TimeCanvasModel`，移动端直接拖动限制与详情内仅目标 Segment 可编辑的规则保持不变。

时间画布查询统一排除 `PLANNED + CONFIRMED/CANCELLED`，不提供按 scope 恢复终态 Planned 的参数，但不删除事实记录、来源和历史。PERSONAL scope 的 Task universe 来自有效 TaskMember；`/progress` 通过 `getMyTimelinePageData` 只接受 `showAll`，服务端派生全部参与 Task，再把全部 Current Plan 与本人可见投入装配到同一画布和 Task 表，客户端没有注入 Task/Person ID 的入口。内容驱动画布在授权过滤后聚合 `min(startAt)/max(endAt)` 与 Current Plan 时间，向外对齐两个上海日历月；可导航范围额外并入今天两侧的上海日历月窗口，使“今天”始终可用，但无显式中心时仍优先定位内容。单次逻辑窗口最多显示三个上海日历年；兼容数据的 `plannedStartAt=null` 仍保留原值，只用 Task `createdAt` 作为只读 Start marker 和范围边界。查询按 180 天块读取，单块超过 5,000 对象时按上海自然日自动二分，并执行 20,000 对象/16 leaf block 双预算；计划锚点继续受总计 5,000 Node 预算约束。常规 DTO 返回稳定 `rowPageKey`；它用于识别结构版本，不代替每次查询的鉴权。Task 详情以全部有效 TaskMember 为人员范围并展示这些人员的全部投入；Project 详情以 ProjectMember 与全部所属 TaskMember 的并集为人员范围，人员投入不再按 Project Task 过滤，但计划锚点只取本 Project 全部 Task；资源计划完整展开 Project/Task/Person 集合，不做 Task/人员行分页。

TimeCanvas 的显示尺度为 `WEEK/MONTH/QUARTER/YEAR`，密度分别为 40/12/4/1.5 px/day。所有 presentation 和业务模式默认 `WEEK`，URL 或调用方显式尺度优先；用户选择后 Resize、数据刷新和 Task 节点聚焦均不覆盖。工具栏只保留尺度选择与“今天”，不提供前后箭头；“今天”使用单次即时居中。视觉尺度不参与业务校验：Segment 与创建草稿变换固定吸附 30 分钟，Composer anchor 固定吸附一个上海自然日。桌面端只允许未保存虚线创建草稿横移、调整两端和跨当前可创建 Person 行；移动端不提供直接拖动，继续使用表单。详情 Dialog 使用完整上下文画布且只有目标 Segment 可编辑，变更历史返回中文安全 DTO 和游标分页。有效 Planned 创建或更新时间范围后，客户端在权威 `rowPageKey` 刷新后把目标及相邻块加入预加载集合。部分确认在事务锁行后强制覆盖起点等于权威 Planned 起点，要求实际内容、预期产出和实际产出，只创建 Actual 与最多一条尾部 Planned；既有审计、来源和 notification outbox 语义不变。

`DomainAuditEvent` 由 append-only trigger 保护，应用代码只能追加审计事件，不能更新或删除既有审计行。

`20260814120000_retire_project_management_legacy_history` 在单一事务中完成最终历史收敛。它先阻断仍有效的旧项目系统角色或旧 Task 成员角色，再以稳定 migration ID 归档已撤销/结束角色和非空 `WorkSegment.completionPercent`，删除对应历史行/列并重建最终角色枚举。迁移不访问通知表；回归以通知全行快照验证既有记录不变，并覆盖迁移期间无关通知并发写入可正常提交，不用易受全库并发影响的行数门禁。重复部署不会产生重复审计。迁移回归还必须验证 append-only 保护、完整 migration chain 与 Prisma schema drift。

### Task 权限迁移与审批通知修复

`20260803120000_task_global_visibility_participants_admin_approval` 是不可逆 migration，不得修改已应用历史。它会：

- 在变更前阻断零 Owner Task 和孤立的 Task 关联 Segment；
- 按 Person 归一化有效成员，保留 Owner，转换 Lead/Member 为 Participant，结束 Reviewer/Viewer，并保留所有历史行；
- 为已有 Task 关联投入的非成员 Person 回填 Participant；
- 撤销所有非全局项目角色，增加有效成员角色、人员唯一和全局角色数据库约束；
- 记录旧 Task 审批策略及每次成员/角色迁移的 `source=MIGRATION` 审计；
- 删除 Task 审批策略列与 enum，且不创建站内通知或 outbox。

`20260803115900_active_global_approval_administrator_preflight` 是排序在上述不可逆 migration 之前的只读数据库门禁，后续兼容迁移安装第一代临时触发器并监听空库首条 Task。`20260803115990_atomic_global_approval_administrator_guard` 安装第二代永久串行延迟约束，紧随其后的 `20260803115995_finalize_atomic_global_approval_administrator_guard` 在显式事务中按固定顺序锁定 Task、Account、AccountIdentity、SystemRoleAssignment 并最终复检，保证任何既有写事务都在不可逆主迁移前被观察。`20260803123000` 继续执行迁移后纵深校验，后续兼容清理迁移只移除第一代触发器和函数，不触碰第二代约束。空库允许先部署并初始化首位管理员，但创建首个 Task 前必须完成初始化。

`npm run db:deploy` 在调用 Prisma 前会由 `scripts/task-access-atomic-deploy.ts` 检查 migration history。若不可逆 `20260803120000` 尚未应用，受控入口会先让 Prisma 只应用其前置 migration，并用首语句安全阻断标记阻止 Prisma 非事务执行主迁移；随后把主 migration SQL 和对应 `_prisma_migrations` 成功记录放入同一 PostgreSQL 事务，最后再交还 Prisma 应用后续 migration。失败会同时回滚 schema、数据和 history；检测到非本工具创建的 legacy enum 或未解决失败记录时拒绝自动猜测。不得绕过该入口直接运行 `prisma migrate deploy`。

发布前在旧 schema 上执行 `npm run pm:task-access-preflight`，检查零 Owner、重复成员、旧角色分布、Segment 回填、活跃 `GROUP_LEADER`、活跃/飞书可达全局管理员、待审批对象和旧通知。迁移后先以 dry-run 执行 `npm run pm:repair-task-approval-notifications`；在 `NOTIFICATION_DELIVERY_DISABLED=true` 的维护窗口以 `npm run pm:repair-task-approval-notifications -- --apply` 重跑，会逐待审批对象事务化冻结旧 Reviewer/组长 outbox，以版本化事件键为活跃全局管理员补建站内通知和 approval outbox，并追加幂等迁移审计。没有活跃全局管理员或所有管理员均无有效飞书 openId 时，脚本会在冻结任何旧 outbox 前阻断。

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
| `/admin/accounts` | 统一账号与两个角色域管理 |
| `/admin/roles` | 已退役，404 |

### 项目管理

| 路径 | 功能 |
|------|------|
| `/progress` | 我的工作总览 |
| `/progress/tasks` | Task 列表 |
| `/progress/projects` | Project 列表（默认我的 + 进行中；空搜索使用 `updatedAt + id` 稳定游标分页） |
| `/progress/projects/new` | 提交 Project 立项 |
| `/progress/projects/[id]` | Project 详情与立项审批 |
| `/progress/projects/[id]/edit` | 驳回重提或 ACTIVE Project 编辑 |
| `/progress/tasks/new` | Task 创建页（桌面三栏 Composer、移动纵向编辑） |
| `/progress/tasks/[id]/revisions/new` | Revision 创建并送审 Composer |
| `/progress/tasks/[id]/revisions/[revisionId]/edit` | 被驳回 Revision 修改并重新送审 Composer |
| `/progress/tasks/[id]` | Task 工作台 |
| `/progress/resources` | 资源计划时间轴 |
| `/progress/notifications` | 站内通知中心 |
| `/progress/task/:id` | 已退役，404 |
| `/progress/kanban` | 已退役，404 |

## 飞书集成要点

- **OAuth 回调**：`/api/auth/callback/feishu`，须在飞书后台为每个允许入口分别配置完整 URL
- **Webhook 签名**：`HmacSHA256("", timestamp + "\n" + secret)` 后 Base64
- **统一私信传输层**：`lib/feishu-message.ts` 导出 `FeishuMessage`、`FeishuMessagePurpose`、`FeishuSendResult` 和 `sendFeishuDirectMessage()`。调用方传入系统用户 `openId`、明确的 `botKind`、用途和 text/交互卡片/CardKit 消息；传输层统一完成收件人身份解析、机器人凭据、token、HTTP 请求、CardKit 创建、禁发闸、allowlist、结构化日志和错误脱敏。
- **机器人边界**：普通通知只能使用通知机器人，审批请求才可声明审批用途。审批机器人未独立配置时使用通知机器人凭据；独立审批应用通过 `User.unionId` 使用 `receive_id_type=union_id`，缺少 `union_id` 时失败并由 outbox 重试。保留既有的“用户对审批应用不可用时回退通知机器人”行为，发送结果会标明实际机器人和是否 fallback。
- **Outbox adapter**：采购、反馈和项目管理业务只能通过 `lib/notification-channels/` adapter 进入统一私信传输边界。adapter 校验 payload 与持久化元数据、计算收件人和构造业务内容；outbox 核心及传输层不包含业务角色查询或状态分支。adapter 的收件人计划可区分真实私信与 Webhook 等独立传输，采购审批必须至少有一个真实私信审批人。项目管理 adapter 会对 `recipientOpenIds` 去重，按 payload purpose 校验 botKind，构造包含操作人、项目、任务、通知内容、中文事项名称、时间和中文业务上下文的交互卡，再交给 `sendFeishuDirectMessage()`；实体类名、枚举值和未知 context 键只保留在内部契约，不进入用户可见卡片。项目管理 Server Action 和领域 service 仍不得直接导入飞书传输层。
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
- 官方 runner 仅支持可用 POSIX process group 的平台，Windows 会在 marker/child 创建前 fail closed。`npm run test:e2e` 的 script 先以空 `NODE_OPTIONS` 启动 `tsx`，runner 再为 Playwright/Next 后代严格重建受控值；已控制父 npm 进程的同 UID 主体属于前述非认证边界。runner 覆盖四个数据库 URL、强制 `recreate`、官方 `playwright.config.ts`、单 worker和 `127.0.0.1:3003`；调用方所有 short option（包括 Commander cluster）以及 `--config`、`--workers`、`--fully-parallel` 覆盖都会拒绝。runner 自己以独立 POSIX 进程组启动 `start-playwright-server.ts`，完成 DB setup/deploy/seed 并通过受控 HTTP readiness 后，才以另一独立组启动已关闭 built-in `webServer` 的 Playwright CLI。子进程只得到受控 sentinel 与 cwd 绑定官方 guard 的绝对 import；继承的 guard probe output/role 被清空，仅 runner 拥有的 server 组写固定 repo `.tmp` probe。source clone 脚本在加载数据库代码前 hard reject，普通 `SHADOW_DATABASE_URL` 只是 runner 写给 Prisma 的输出。连接后只读核对 TCP、current user 与 maintenance database；Docker 转发下 PostgreSQL 报告容器侧地址/端口是正常现象，安全边界是连接前限定的 loopback URL
- direct setup 的 target/shadow 任一创建失败会尝试精确补偿两个名称，数据库补偿全部成功后才删除 marker；direct cleanup 同样只在两个 DROP 和 connection close 全成功后删除同一 inode marker。runner 只调用这一共享 lifecycle 一次；若 setup 已补偿并移除 marker，runner 会只读确认两个精确库均不存在。任何 drop、close 或 unlink 失败均非零并保留可重试证据。runner 在创建 marker 前先拒绝已占用或状态无法确认的 3003；正常完成、CLI 自发 exit/error、server 自发 exit/error 或中断后，都会分别收束 server 与 CLI 两个独立进程组。只有两组均被进程组检查证明不再存活，才进入数据库 cleanup。3003 availability/readiness 只是辅助门禁和诊断，不替代进程组静默证明；任一组无法证明 quiescent 时会 fail closed、跳过 DB cleanup 并保留 marker，避免活动后代继续访问正在删除的数据库
- runner 对 `SIGINT`、`SIGTERM`、`SIGHUP` 第一次同时转发给当时已存在的 server/CLI 组，5 秒未退出或累计第二个信号时分别升级 `SIGKILL`，再有界确认两组退出；任一 child 可用前到达的信号会累计并在 observer 建立后立即执行 graceful/force 意图。server 在 readiness 前或测试执行中异常退出会终止 CLI，并经过同一双组静默门禁。数据库 cleanup 后入口先设置 canonical exit code（129/130/143），记录递归展开且经 logger redaction 的聚合叶子原因，再尝试重新触发原信号；若启动器忽略信号或 `process.kill` 失败也不会自然返回 0。直接杀死 runner 的 `SIGKILL`、进程崩溃、操作系统故障或断电无法保证执行 cleanup，遗留库只能由 DBA 在只读确认精确名称后处理
- dev 热更新可能导致 client 缓存过期；`lib/prisma.ts` 中 `isPrismaClientStale()` 会在缺少新 model delegate 时重建 client
- schema 变更后执行 `npx prisma generate` 并重启 dev server
- 旧 SQLite 数据不迁移；首次部署从空 PostgreSQL 库开始
- `20260803190000_remove_project_access_status` 会删除账号项目访问状态列与枚举，和仍读取旧列的进程不兼容。生产发布必须使用维护窗口：先构建新版本并备份数据库，停止旧 Web/cron/ws 进程，执行 `npm run db:deploy`，再启动新版本并验证账号登录、项目授权和人员/Task 搜索主流程。
- `20260804120000_add_termination_node_name` 为 `TerminationNode` 增加非空 `name` 并用数据库默认值 `Terminal` 回填既有行；迁移不修改历史计划时间、节点状态、审计或通知。部署后需验证默认/自定义名称的查询、模板和 Revision 传播，以及旧同刻计划仍可读取但不能作为新写入提交。
- `20260804150000_revision_time_marker_refactor` 在确认 `RevisionNode` 为空后增加 `revisionAt/reviewRound`、删除草稿提交字段与 `DRAFT` Revision 状态，并安装每 Task 单 Revision 候选 partial unique index。若发现任意旧 Revision，migration 会在破坏性 DDL 前失败，必须停止部署并人工决定转换方案。

### 常用命令

```bash
npm run db:deploy              # prisma migrate deploy（等待 PG 就绪）
npm run db:seed -- --super-admin-open-id=<openId> # 初始化首位统一超级管理员
npm run accounts:preflight    # 旧 schema 统一账号迁移只读预检
npm run accounts:validate     # 新 schema 统一账号迁移只读核对
npm run db:roles:validate      # 只读校验报销角色作用域；异常数据需受控修复
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
