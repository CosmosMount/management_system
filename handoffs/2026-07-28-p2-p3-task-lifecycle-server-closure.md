# P2+P3 Task 计划生命周期服务端闭环 Handoff

日期：2026-07-28

最后更新：2026-07-28 23:07 CST

工作区：`/home/pnx/code/management_system_dev`

状态：P2/P3 Task 计划生命周期服务端闭环已实现并通过验证。`/progress` 仍为占位页；P4 UI、完整 Segment/Conflict 工作流、通知中心页面和真实项目管理飞书投递仍未启用。

## 1. 本阶段目标与边界

本阶段在 P1 schema、身份、授权、站内通知、审计和项目管理 notification outbox 底座上，完成 Task 计划生命周期的服务端闭环：

- Task Draft 创建。
- Task 激活。
- Current Plan 查询与版本比较 facade。
- Revision 草稿创建、提交、审批通过、驳回、取消、直接生效。
- Milestone Review 提交、审批通过、驳回、要求修订。
- Termination 结束确认。
- 服务端状态机、事务、行锁、幂等键、审计、站内通知和 `channel=project-management` outbox。

本阶段明确未实现：

- 未替换 `/progress` 占位 UI。
- 未新增完整 Task 工作台、计划编辑器、Revision 对比 UI、通知中心 UI 或附件证据 UI。
- 未实现完整 Tag CRUD、Resource Segment CRUD、Conflict UI。
- 未实现真实项目管理飞书卡片构造或投递；项目管理 adapter 仍明确抛出 P6 未启用错误。
- 未新增 Milestone 级成员表；Milestone 执行与验收权限继续使用 TaskMember role 和 scoped system role。
- 未实现已推进 Approved Review 的撤销/补偿纠错。

## 2. 阅读依据

实现和收尾时已阅读或对齐：

- `handoffs/2026-07-28-p1-schema-identity-authorization-baseline.md`
- 用户提供的 P2+P3 Task 生命周期计划
- `docs/plan/03-领域规则与状态机.md`
- `docs/plan/05-服务端操作与接口计划.md`
- `docs/plan/07-身份权限与审计计划.md`
- `docs/plan/08-通知定时任务与外部集成.md`
- `docs/plan/10-测试策略与验收用例.md`
- `prisma/schema.prisma`
- `lib/project-management/authorization/index.ts`
- `lib/project-management/audit/index.ts`
- `lib/project-management/notifications/events.ts`
- `lib/notification-channels/project-management.ts`
- `tests/project-management-p1.spec.ts`
- `tests/feishu-boundaries.spec.ts`

P1 handoff 的关键接手规则仍适用：项目管理业务只能写 outbox，不得直连飞书传输层；详情查询必须用 readableWhere 防枚举；审计只追加；业务状态变更要使用事务和状态机校验。

## 3. 变更文件

新增：

- `app/actions/project-management/tasks.ts`
- `app/actions/project-management/plans.ts`
- `app/actions/project-management/revisions.ts`
- `app/actions/project-management/milestones.ts`
- `app/actions/project-management/terminations.ts`
- `lib/project-management/application/action-result.ts`
- `lib/project-management/application/errors.ts`
- `lib/project-management/application/lifecycle-service.ts`
- `lib/project-management/queries/task-queries.ts`
- `lib/project-management/validations/lifecycle.ts`
- `prisma/migrations/20260728231000_project_management_p2_p3_lifecycle_fields/migration.sql`
- `tests/project-management-lifecycle.spec.ts`
- `handoffs/2026-07-28-p2-p3-task-lifecycle-server-closure.md`

修改：

- `README.md`
- `docs/NOTIFICATIONS.md`
- `docs/TECH.md`
- `docs/TESTING.md`
- `lib/prisma.ts`
- `lib/project-management/authorization/index.ts`
- `lib/revalidate.ts`
- `prisma/schema.prisma`

## 4. Prisma Schema 与 Migration

新增 migration：

- `20260728231000_project_management_p2_p3_lifecycle_fields`

新增字段：

- `TaskPlanVersion.idempotencyKey String?`
- `TaskPlanVersion.creationRequestHash String @default("")`
- `RevisionNode.baseTaskLockVersion Int @default(0)`

新增索引与约束：

- 普通索引：`TaskPlanVersion(createdByAccountId, idempotencyKey)`。
- raw partial unique index：`TaskPlanVersion(createdByAccountId, idempotencyKey) WHERE idempotencyKey IS NOT NULL`。
- check：`TaskPlanVersion.idempotencyKey` 若非 null，trim 后必须非空。
- check：`RevisionNode.baseTaskLockVersion >= 0`。

`lib/prisma.ts` schema revision 标记已更新为：

```text
project-management-p2-p3-lifecycle-v1
```

兼容说明：

- 新字段都有默认值或可空，不破坏 P1 空项目管理数据集。
- 未修改已应用 P1 migration。
- `Task.currentPlanVersionId` 与 `TaskPlanVersion.taskId` 的 deferrable 循环 FK 仍依赖 P1 迁移；Draft 创建继续在事务内执行 `SET CONSTRAINTS ALL DEFERRED` 并预生成 UUID。

## 5. 输入 DTO 与 Server Actions

新增 Zod schema 位于 `lib/project-management/validations/lifecycle.ts`。

主要输入：

- `createTaskDraftInputSchema`
  - `title`
  - `description`
  - `team`
  - `techGroup`
  - `priority`
  - `tagIds`
  - `members`
  - `milestones`
  - `termination`
  - `revisionApprovalMode`
  - `idempotencyKey`
- `activateTaskInputSchema`
  - `taskId`
  - `expectedLockVersion`
- `revisionDraftInputSchema`
  - `taskId`
  - `basePlanVersionId`
  - `baseTaskLockVersion`
  - `revisedFromNodeId`
  - `reason`
  - `replacementMilestones`
  - `termination`
  - `idempotencyKey`
- `submitMilestoneReviewInputSchema`
  - `milestoneNodeId`
  - `idempotencyKey`
  - `evidences`
- `reviewMilestoneDecisionInputSchema`
  - `reviewId`
  - `result`
  - `comment`
- `confirmTerminationInputSchema`
  - `taskId`
  - `terminationNodeId`
  - `outcome`
  - `reason`
  - `summary`
  - `expectedLockVersion`

日期校验说明：

- `requiredDate()` 不使用宽松 `z.coerce.date()`。
- 只接受：
  - 合法 `Date` 对象。
  - `YYYY-MM-DD`。
  - 带 timezone 的 ISO datetime，例如 `2026-08-01T10:00:00Z` 或 `2026-08-01T18:00:00+08:00`。
- 拒绝 `"123"`、`"0"`、`"2026-02-31"`、无 timezone datetime 和本地化日期字符串。
- `YYYY-MM-DD` 当前按 UTC 零点存储，这是已接受的非阻塞约定。

Server Actions：

- `createTaskDraft(input)`
- `activateTask(input)`
- `getTaskWorkspace(taskId)`
- `getPlanVersion(planVersionId)`
- `listTaskPlanVersions(taskId)`
- `comparePlanVersions(input)`
- `createRevisionDraft(input)`
- `submitRevision(input)`
- `approveRevision(input)`
- `rejectRevision(input)`
- `cancelRevision(input)`
- `submitMilestoneForReview(input)`
- `approveMilestoneReview(input)`
- `rejectMilestoneReview(input)`
- `requireMilestoneRevision(input)`
- `confirmTermination(input)`

所有 Server Actions 都返回：

```ts
{ ok: true, data } | { ok: false, error: { code, message, fieldErrors? } }
```

错误封装位于 `lib/project-management/application/action-result.ts` 和 `lib/project-management/application/errors.ts`。对用户暴露的消息均为中文，不暴露 raw Zod、SQL、stack、secret 或内部异常细节。

## 6. 查询 Facade

新增 `lib/project-management/queries/task-queries.ts`。

公开入口：

- `getTaskWorkspace({ actor, taskId })`
- `getPlanVersion({ actor, planVersionId })`
- `listTaskPlanVersions({ actor, taskId })`
- `comparePlanVersions({ actor, fromPlanVersionId, toPlanVersionId })`

防枚举规则：

- Task 详情查询使用 `where: { AND: [{ id }, taskReadableWhere(actor)] }`。
- Plan 详情查询使用 `where: { id, task: taskReadableWhere(actor) }`。
- Plan compare 会分别按 readableWhere 查两个版本，若任一不可读或不属于同一 Task，统一返回 `对象不存在或无权查看`。

Facade 返回 DTO 不暴露数据库原始对象；时间序列化为 ISO 字符串。

## 7. Task Draft 创建

入口：

- `createTaskDraft(actor, input)`

关键行为：

- 解析 `createTaskDraftInputSchema`。
- 计算 `creationRequestHash = sha256(stableStringify({ operation, input }))`。
- 在事务内刷新 actor system roles。
- `assertAuthorized(task.create)`。
- 对 `(actor.accountId, idempotencyKey)` 执行 `pg_advisory_xact_lock()`。
- 若同账号同幂等键已存在：
  - hash 相同：返回既有 Task/Plan，`created=false`。
  - hash 不同：返回状态冲突。
- 校验成员 Person active、Tag 未归档。
- `SET CONSTRAINTS ALL DEFERRED`。
- 预生成 `taskId` 与 `planVersionId`。
- 创建：
  - `Task(status=DRAFT, currentPlanVersionId=planVersionId)`
  - `TaskPlanVersion(status=CURRENT, activatedAt=null, versionNo=1)`
  - 有序 `TaskNode(type=MILESTONE, status=PENDING)`
  - 末尾 `TaskNode(type=TERMINATION, status=PENDING)`
  - `PlanVersionNode`
  - `TaskMember`
  - `TaskTag`
- 初始 `snapshotHash` 在节点落库后通过 `loadPlanEntriesTx()` + `hashPlanEntries()` 计算。
- 校验计划链：
  - 至少一个 Milestone。
  - 最后一个节点为 Termination。
  - sequence 从 1 连续递增。
- 写 `DomainAuditEvent`。
- 写站内通知和 project-management outbox：
  - kind/type：`task_assigned`
  - 收件人：active TaskMember。

Draft 阶段不会设置 `Task.activeMilestoneNodeId`。

## 8. Task 激活

入口：

- `activateTask(actor, input)`

关键行为：

- 解析 `activateTaskInputSchema`。
- 在事务内 `SELECT ... FOR UPDATE` 锁 Task 行。
- 刷新 actor roles。
- 通过 `task.view` 防枚举。
- `assertAuthorized(task.activate)`。
- 校验：
  - Task 必须为 `DRAFT`。
  - `expectedLockVersion` 必须匹配。
  - Current Plan 存在且 status 为 `CURRENT`。
  - 计划链合法。
  - 至少一个 active OWNER。
  - 至少一个 Milestone。
- 将首个 Milestone TaskNode 更新为 `ACTIVE`。
- Task 更新为：
  - `status=ACTIVE`
  - `activeMilestoneNodeId=firstMilestone.nodeId`
  - `startedAt=now`
  - `lockVersion += 1`
- Current Plan 写入 `activatedAt` 和最新 `snapshotHash`。
- 写审计和通知：
  - kind/type：`task_activated`
  - 收件人：active TaskMember。

重复或并发激活只能成功一次；后续请求会因状态或 lockVersion 冲突失败。

## 9. Revision 生命周期

### 9.1 创建 Revision Draft

入口：

- `createRevisionDraft(actor, input)`

关键行为：

- 仅允许 `ACTIVE` Task。
- 仅允许基于当前 `Task.currentPlanVersionId` 和当前 `Task.lockVersion`。
- 同账号同 `idempotencyKey` 幂等，hash 不同返回冲突。
- `revisedFromNodeId` 必须在 Current Plan 中。
- 不允许从 `COMPLETED` 节点开始修订。
- 修订目标计划必须仍至少包含一个 Milestone。
- 新建目标 `TaskPlanVersion(status=DRAFT)`：
  - `baseVersionId=currentPlanVersionId`
  - `idempotencyKey`
  - `creationRequestHash`
  - `revisionNodeId`
- 目标计划内容：
  - carry-forward 已完成前缀。
  - 插入一个 `TaskNode(type=REVISION, status=PENDING)` 和 `RevisionNode(status=DRAFT)`。
  - 写入 replacement Milestones。
  - 写入新的 Termination。
- `RevisionNode.baseTaskLockVersion = task.lockVersion`。
- 计算并保存目标版本 `snapshotHash`。
- 写审计。

注意：Current/Historical 版本不会被原地修改核心字段。

### 9.2 提交 Revision

入口：

- `submitRevision(actor, input)`

关键行为：

- 允许 `RevisionNode.status in (DRAFT, REJECTED)`。
- 目标 Plan 必须仍为 `DRAFT`。
- base plan 仍必须是 Task 当前 Current Plan。
- baseTaskLockVersion 必须仍匹配 Task 当前 lockVersion。
- 默认更新为 `PENDING_APPROVAL` 并写审计。
- 通知 Reviewer：
  - kind/type：`revision_pending_review`
  - purpose：`approval_request`
  - botKind：`approval`
  - 收件人：active REVIEWER + scoped Team Admin。
- 若 Task `revisionApprovalMode=DIRECT_BY_OWNER` 且操作者具备 `revision.apply`，直接调用 `applyRevisionTx()` 生效，不进入 pending。

### 9.3 审批通过 / 生效

入口：

- `approveRevision(actor, input)`
- `applyRevisionTx()` 内部共享实现。

关键行为：

- `approveRevision` 要求 `revision.review` 权限。
- 授权层默认禁止自审；`allowSelfReview` 未显式打开时，提交人不能审批自己的 Revision。
- Revision 必须为 `PENDING_APPROVAL`；已 `EFFECTIVE` 的重复通过返回幂等结果。
- 生效前校验：
  - target Plan 为 `DRAFT`。
  - basePlanVersionId 仍为当前 Current Plan。
  - baseTaskLockVersion 仍匹配 Task lockVersion。
  - Task 仍为 `ACTIVE`。
  - 已完成 Milestone 前缀未被改变。
- 原子更新：
  - Revision -> `EFFECTIVE`
  - 旧 Current Plan -> `HISTORICAL`
  - target Plan -> `CURRENT`
  - 被替换且未完成节点 -> `REVISED`
  - Revision TaskNode -> `COMPLETED`
  - 激活目标计划中的下一个 pending Milestone；若没有 pending Milestone，则激活 Termination 并让 `activeMilestoneNodeId=null`
  - Task.currentPlanVersionId -> target Plan
  - Task.lockVersion += 1
  - 受影响 `WorkSegment(type=PLANNED)` -> `associationNeedsReview=true`
- 写审计。
- 通知 Task 成员：
  - kind/type：`revision_applied`
  - purpose：`notification`
  - botKind：`notification`

### 9.4 驳回 Revision

入口：

- `rejectRevision(actor, input)`

关键行为：

- 需要 `revision.review` 权限。
- 必须填写 comment。
- 仅允许 `PENDING_APPROVAL`。
- 更新：
  - Revision -> `REJECTED`
  - `reviewedAt`
  - `reviewedByAccountId`
  - `reviewComment`
- target Plan 保持 `DRAFT`，允许修改后重提。
- 通知创建人和 OWNER：
  - kind/type：`revision_result`

### 9.5 取消 Revision

入口：

- `cancelRevision(actor, input)`

关键行为：

- 创建人可取消自己的 Revision。
- 非创建人需要 `revision.apply` 权限。
- 允许状态：
  - `DRAFT`
  - `PENDING_APPROVAL`
  - `REJECTED`
- 更新：
  - Revision -> `CANCELLED`
  - target Plan 若仍为 `DRAFT`，标记 `ABANDONED`
  - target Plan 中非 carry-forward 且未完成节点标记 `CANCELLED`
- 已生效 Revision 不能取消。
- 已取消重复请求返回幂等结果。

## 10. Milestone Review 生命周期

### 10.1 提交 Review

入口：

- `submitMilestoneForReview(actor, input)`

授权：

- OWNER / LEAD / MEMBER 可提交。
- scoped Team Admin 可提交。
- System Admin 仍按 P1 授权默认允许。

状态校验：

- Task 必须为 `ACTIVE`。
- Milestone TaskNode 必须为 `ACTIVE`。
- `Task.activeMilestoneNodeId` 必须等于该 Milestone nodeId。
- 节点必须属于 Current Plan。

证据：

- `TEXT` 支持 `note`。
- `LINK` 支持 `externalUrl` 和 `note`。
- `FILE` 当前明确返回中文校验错误：
  - `文件证据暂未启用，请先提交文本或链接证据`

幂等：

- 同 Milestone + 同 idempotencyKey 返回既有 Review。
- 若已存在未撤销 pending Review，重复提交返回该 pending Review，不新建。

副作用：

- 创建 `MilestoneReview(result=PENDING)`。
- 创建 `ReviewEvidence`。
- 更新 `MilestoneNode.submittedForReviewAt`。
- 写审计。
- 通知 Reviewer：
  - kind/type：`milestone_review_submitted`
  - purpose：`approval_request`
  - botKind：`approval`
  - 收件人：active REVIEWER + scoped Team Admin。

### 10.2 审批 Review

入口：

- `approveMilestoneReview(input)`
- `rejectMilestoneReview(input)`
- `requireMilestoneRevision(input)`
- service：`reviewMilestone(actor, input)`

授权：

- REVIEWER 和 scoped Team Admin 可审批。
- 默认禁止自审。

状态校验：

- 只能处理最新 Review。
- 只能处理 `result=PENDING` 且未 revoked 的 Review。
- Task 必须为 `ACTIVE`。
- Milestone 必须仍是当前 active Milestone。
- 节点必须仍属于 Current Plan。

结果行为：

- `APPROVED`
  - Review -> `APPROVED`
  - MilestoneNode.completedAt = now
  - Milestone TaskNode -> `COMPLETED`
  - 推进到下一个 pending Milestone 并置为 `ACTIVE`
  - 若没有下一个 Milestone，则激活 Termination，Task.activeMilestoneNodeId = null
  - Task.lockVersion += 1
- `REJECTED`
  - Review -> `REJECTED`
  - 不推进计划。
- `REVISION_REQUIRED`
  - Review -> `REVISION_REQUIRED`
  - 不推进计划。

重复相同审批结果返回幂等结果；不同结果返回状态冲突。

通知：

- kind/type：`milestone_review_result`
- 收件人：提交人 + OWNER。

## 11. Termination 生命周期

入口：

- `confirmTermination(actor, input)`

授权：

- `task.terminate`。
- 本阶段取消了 cancelled 终态额外要求 `task.archive` 的逻辑，Termination 确认只看 terminate 权限和状态机。

状态校验：

- Task 必须为 `ACTIVE`。
- `expectedLockVersion` 必须匹配。
- terminationNodeId 必须属于该 Task。
- Termination 必须是 Current Plan 最后一个节点。
- Current Plan 链必须合法。

outcome 行为：

- `SUCCESS`
  - 要求所有前置 Milestone 都已 `COMPLETED`。
  - Task -> `COMPLETED`。
- `FAILED`
  - 可提前结束，但必须填写 reason。
  - Task -> `FAILED`。
- `CANCELLED`
  - 可提前结束，但必须填写 reason。
  - Task -> `CANCELLED`。
- `TIMEOUT`
  - 可提前结束，但必须填写 reason。
  - Task -> `TIMEOUT`。

统一副作用：

- `TerminationNode.outcome/reason/summary/confirmedByAccountId/confirmedAt` 落库。
- Termination TaskNode -> `COMPLETED`。
- 未完成且未 Revised 的其他节点 -> `CANCELLED`。
- Task.activeMilestoneNodeId = null。
- Task.endedAt = now。
- Task.lockVersion += 1。
- 写审计。
- 通知 Task 成员：
  - kind/type：`task_terminated`

幂等：

- 重复相同 outcome 返回既有结果。
- 不同 outcome 返回状态冲突。

## 12. 授权变更

修改文件：

- `lib/project-management/authorization/index.ts`

关键变更：

- `milestone.submit_review` 现在允许：
  - OWNER
  - LEAD
  - MEMBER
  - scoped Team Admin
  - System Admin 仍按全局管理员规则允许
- `task.terminate` 不再因为目标 outcome 为 cancelled 而额外要求 `task.archive`。

其他 P1 授权规则保持：

- 默认拒绝。
- Task 可见性来自 TaskMember、scoped Team Admin、System Admin、Auditor。
- scoped role 必须匹配 team/techGroup。
- Tag 不扩大 Task 权限。
- 自审默认拒绝。

## 13. 通知与审计

通知入口：

- `createInAppNotificationTx()`
- `enqueueProjectManagementNotificationTx()`

所有生命周期通知都在业务事务内创建。

项目管理 outbox：

- `channel=project-management`
- payloadVersion = 1
- `type` 必须等于 payload.kind
- `purpose=approval_request` 自动使用 `botKind=approval`
- 普通通知自动使用 `botKind=notification`
- 只允许以下 approval_request：
  - `milestone_review_submitted`
  - `revision_pending_review`

本阶段事件：

| 场景 | kind/type | purpose | 收件人 |
|------|-----------|---------|--------|
| Task 草稿成员加入 | `task_assigned` | `notification` | active TaskMember |
| Task 激活 | `task_activated` | `notification` | active TaskMember |
| Milestone 提交验收 | `milestone_review_submitted` | `approval_request` | active REVIEWER + scoped Team Admin |
| Milestone 验收结果 | `milestone_review_result` | `notification` | 提交人 + OWNER |
| Revision 待审批 | `revision_pending_review` | `approval_request` | active REVIEWER + scoped Team Admin |
| Revision 驳回 | `revision_result` | `notification` | 创建人 + OWNER |
| Revision 生效 | `revision_applied` | `notification` | active TaskMember |
| Task 结束确认 | `task_terminated` | `notification` | active TaskMember |

收件人规则：

- 站内通知按 active Account 创建。
- outbox payload 中 `recipientOpenIds` 只包含 active Account 下可用的 Feishu identity openId。
- in-app payload 会清空 `recipientOpenIds`，避免把外部投递目标复制进站内通知 payload。
- 收件人按 accountId 去重。

飞书边界：

- 项目管理 lifecycle service 和 Server Actions 不导入或调用飞书传输层。
- `lib/notification-channels/project-management.ts` 仍只做 payload 和收件人计划校验。
- `sendToRecipient()` 与 `sendComposite()` 当前抛 `NonRetryableNotificationError("项目管理飞书通知投递将在 P6 启用")`。

审计：

- 所有写操作都调用 `createDomainAuditEventTx()`。
- 审计 before/after 只记录状态、版本、节点、lockVersion、数量和摘要。
- 不记录大 payload、附件路径、token、cookie 或外部凭据。
- `DomainAuditEvent` 仍由 P1 append-only trigger 保护。

## 14. 测试覆盖

新增：

- `tests/project-management-lifecycle.spec.ts`

在 desktop 和 mobile 两个 Playwright project 下执行。

覆盖：

- Draft 创建 allowed/denied。
- Draft 创建幂等：同 key 同 payload 返回同 Task，不同 payload 冲突。
- Current Plan、Milestone、Termination 节点链持久化。
- 查询 facade 防枚举。
- 激活成功、stale lockVersion、重复/并发激活只成功一次。
- Milestone Review TEXT/LINK evidence。
- FILE evidence 中文拒绝。
- 重复提交 Review 返回已有记录。
- Approved Review 推进 Milestone。
- Rejected / Revision Required 不推进。
- 并发审批只持久化一个结果。
- Revision create/submit/reject/cancel。
- Revision approval 原子切换 Current Plan。
- 旧 Current 历史化，新 Current 唯一。
- base plan / base lockVersion 冲突。
- 自审拒绝。
- `DIRECT_BY_OWNER` 直接生效。
- Planned Segment `associationNeedsReview=true`。
- Termination 四种 outcome。
- SUCCESS 前置 Milestone 校验。
- FAILED/CANCELLED/TIMEOUT 提前结束并取消未完成节点。
- 重复确认幂等。
- outbox `channel/project-management`、botKind/purpose。
- 站内通知事务一致。
- 审计 append-only 相关路径。
- 日期 parser 严格性：拒绝 `"123"`、`"0"`、`"2026-02-31"`，接受严格格式。

现有边界测试：

- `tests/project-management-p1.spec.ts`
- `tests/feishu-boundaries.spec.ts`
- 全量 E2E 回归。

## 15. 验证记录

最后一次完整验证在 2026-07-28 23:07 CST 前完成。

已执行并通过：

```text
npx prisma validate
  PASS
  The schema at prisma/schema.prisma is valid.

npx prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --exit-code
  PASS
  No difference detected.

npm run db:deploy
  PASS
  39 migrations found; no pending migrations to apply.

npm run pm:p0-baseline
  PASS
  legacyTableCount=0
  legacyEnumCount=0
  progressOutboxRows=0
  projectManagerRoleRows=0
  forbiddenLegacyColumns=[]

npm run build
  PASS

npm run test:e2e -- tests/project-management-p1.spec.ts tests/project-management-lifecycle.spec.ts tests/feishu-boundaries.spec.ts
  PASS
  36 passed.

npm run test:e2e
  PASS
  224 passed, 30 skipped.
  skip 为现有 authenticated/privileged smoke 条件，不是本次新增失败。
  Playwright 启动日志显示 notificationDeliveryDisabled=true，没有真实飞书投递。

npm run check
  PASS
  包含 prisma validate、prisma generate、应用 TypeScript、脚本 TypeScript、ESLint 和 git diff --check。

git diff --check
  PASS
```

已知测试日志：

- lifecycle 并发测试会出现 Node/pg deprecation warning：
  - `Calling client.query() when the client is already executing a query is deprecated and will be removed in pg@9.0.`
- 测试结果通过；这是当前并发测试流下的非阻塞残留风险。

## 16. 独立审查

按 AGENTS.md 要求，使用独立 reviewer subagent 进行了多轮只读审查。

最终 reviewer：

- agent id：`019fa91e-4c05-7a81-a78d-2ef602613c89`

最后一轮结论：

- 未发现新的 actionable issue。
- 上一轮 Low 已关闭。

最终关闭的问题：

- 日期输入最初过宽，可能接受 `"123"`、`"0"` 等非预期字符串。
- 修复后 `requiredDate()` 改为严格 regex + calendar validation。
- reviewer 用 schema 探针确认：
  - `"123"`、`"0"`、`"2026-02-31"`、`"08/01/2026"`、无 timezone datetime 均被拒绝并返回中文错误。
  - `YYYY-MM-DD`、带 `Z` 或 `+08:00` 的 ISO datetime、合法 Date 对象通过。

reviewer 标记的非 actionable 风险：

- `YYYY-MM-DD` 按 UTC 零点存储。
- 无 timezone datetime 和超过 3 位毫秒的小数 ISO 会被拒绝。
- 这与当前“只接受 Date、YYYY-MM-DD 或带 timezone 的 ISO datetime”的约定一致。

## 17. 当前工作树状态

最后一次 `git status --short` 显示本阶段相关变更：

```text
 M README.md
 M docs/NOTIFICATIONS.md
 M docs/TECH.md
 M docs/TESTING.md
 M lib/prisma.ts
 M lib/project-management/authorization/index.ts
 M lib/revalidate.ts
 M prisma/schema.prisma
?? app/actions/project-management/
?? lib/project-management/application/
?? lib/project-management/queries/
?? lib/project-management/validations/
?? prisma/migrations/20260728231000_project_management_p2_p3_lifecycle_fields/
?? tests/project-management-lifecycle.spec.ts
?? handoffs/2026-07-28-p2-p3-task-lifecycle-server-closure.md
```

`git diff --check` 已通过。

## 18. 接手注意事项

### P4 UI

- `/progress` 仍是占位页；不要误以为浏览器工作台已上线。
- P4 可以调用现有 Server Actions，但必须继续在服务端执行鉴权和状态机校验。
- UI 不要自行复制 role 判断；应使用 query facade 返回的 permissions 或 Server Action 结果。
- 对所有表单展示中文 fieldErrors。
- FILE evidence UI 暂不要开放；附件权限扩展完成后再启用。

### Revision 后续

- 当前 DRAFT target Plan 创建后还没有独立编辑 action。
- 若 P4/P5 要做“替换编辑”，应新增 service，继续遵守：
  - 只能编辑 DRAFT target Plan。
  - Current/Historical 不原地改核心字段。
  - basePlanVersionId 和 baseTaskLockVersion 必须重新校验。
  - 完成前缀不可改变。

### Segment / Conflict

- Revision 生效只把已有 Planned Segment 标记 `associationNeedsReview=true`。
- 没有实现 Resource Segment CRUD、Conflict UI 或自动冲突解决。
- 后续实现 Segment 时，应复用 P1 `segmentReadableWhere()` 和授权 action，不要从 Task 权限直接推断资源权限。

### 通知 / 飞书

- 项目管理业务仍不得直接导入：
  - `lib/feishu-message`
  - `lib/feishu-webhook`
  - `lib/feishu-cardkit`
  - `lib/feishu-procurement-card-sync`
- P6 启用真实投递前，需要补：
  - 项目管理卡片内容。
  - recipient 级 retry。
  - 禁发/allowlist 回归。
  - 审批机器人与通知机器人边界回归。
  - 收件人身份缺失和 union/openId 解析失败处理。

### 审计

- 不要 update/delete `DomainAuditEvent`。
- before/after 继续只记录摘要。
- 不要把 Review evidence 大正文、附件路径或外部链接完整上下文复制进审计。

### 幂等与并发

- Draft 和 Revision Draft 使用 `TaskPlanVersion.idempotencyKey`。
- Milestone Review 使用 P1 `MilestoneReview(milestoneNodeId, idempotencyKey)` 唯一约束。
- Task 写操作通过 `SELECT ... FOR UPDATE` 锁 Task 行。
- Revision Draft additionally 使用 advisory lock 避免同账号同 key 并发双写。
- 后续新增写操作也应保持：
  - 输入 hash。
  - 状态机前置条件。
  - lockVersion 或 plan baseline。
  - 事务内审计和 outbox。

## 19. 剩余风险与限制

- `/progress` 无可用业务 UI。
- 项目管理真实飞书投递未启用。
- FILE evidence 未启用。
- Revision target Plan 缺少后续编辑 API；当前支持创建、提交、审批、驳回、取消、生效。
- 已推进的 Approved Review 没有撤销/补偿。
- `YYYY-MM-DD` 按 UTC 零点存储，若 P4 UI 需要业务时区展示，应显式处理 Asia/Shanghai 显示语义。
- lifecycle 并发测试有 `pg` deprecation warning；测试通过，但未来 pg@9 需要检查事务/并发测试写法。

## 20. 下一阶段建议

建议 P4 顺序：

1. 先做只读 Task Workspace 页面，调用 `getTaskWorkspace()` 和 `listTaskPlanVersions()`。
2. 再做 Draft 创建表单，复用现有 Zod 字段语义，展示中文 fieldErrors。
3. 然后开放 Activate、Milestone Review、Termination 的最小操作面。
4. Revision UI 最后做，因为需要 Plan diff、替换段编辑和冲突提示。
5. 每开放一个 UI action，都补 desktop + mobile Playwright，并验证无横向滚动、无 Next error overlay、权限受限状态可见。
6. P6 真实飞书投递前，不要删除 adapter 中的 P6 non-retryable guard。

