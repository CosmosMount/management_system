# P1 Schema、身份与权限底座 Handoff

日期：2026-07-28

最后更新：2026-07-28 21:05 CST

工作区：`/home/pnx/code/management_system_dev`

状态：P1 schema、飞书身份映射、授权骨架、站内通知、审计和项目管理通知 outbox adapter 骨架已实现；完整项目管理业务 UI、Task 创建流程、Revision/Review/Segment 业务流和真实项目管理飞书投递仍未启用。

## 1. 本阶段目标与边界

本阶段完成项目管理 v2.1 的 P1 底座：

- 新增 Account/Person 身份模型和飞书身份映射。
- 新增 Task/Tag、Plan/Node、Review/Evidence、Work Segment/Conflict、站内通知、审计和项目管理系统角色 schema。
- 新增项目管理授权骨架与 readableWhere 查询过滤。
- 新增项目管理通知 payload 契约、入队 helper 和 notification channel adapter 骨架。
- 保持采购、反馈、附件、现有飞书回调和共享 notification outbox 行为不变。

本阶段明确未实现：

- 未新增 Project 模型。
- 未导入、读取、rename、drop 或回填旧项目管理数据。
- 未新增 legacy mapping、`legacySource*`、`migrationNeedsReview` 或 legacy Tag。
- 未启用完整 `/progress` 新 UI 或业务流程。
- 未实现真实项目管理飞书卡片构造或投递。
- 未新增邮箱、密码、设备管理或邮件通知。

## 2. 阅读依据

实现前已阅读并采用：

- `handoffs/2026-07-28-p0-rule-freeze-safety-baseline.md`
- `docs/plan/README.md`
- `docs/plan/00-目标范围与验收标准.md`
- `docs/plan/01-仓库现状与差距分析.md`
- `docs/plan/02-目标架构与模块边界.md`
- `docs/plan/03-领域规则与状态机.md`
- `docs/plan/04-数据库设计与迁移映射.md`
- `docs/plan/05-服务端操作与接口计划.md`
- `docs/plan/07-身份权限与审计计划.md`
- `docs/plan/08-通知定时任务与外部集成.md`
- `docs/plan/09-数据迁移发布与回滚.md`
- `docs/plan/10-测试策略与验收用例.md`
- `docs/plan/12-可执行任务清单WBS.md`
- `docs/plan/13-风险依赖与待确认决策.md`
- `docs/plan/15-P0规则冻结与安全基线关单.md`
- `docs/plan/management_plan/项目管理系统设计 v2.1.md`
- `prisma/schema.prisma`
- `lib/auth.ts`
- `lib/feishu-user-sync.ts`
- `lib/notification-outbox.ts`
- `lib/notification-channels/*`
- `tests/feishu-boundaries.spec.ts`
- `tests/legacy-project-management-migration.spec.ts`

## 3. 变更文件

新增：

- `handoffs/2026-07-28-p1-schema-identity-authorization-baseline.md`
- `lib/project-management/audit/index.ts`
- `lib/project-management/authorization/index.ts`
- `lib/project-management/identity/index.ts`
- `lib/project-management/notifications/contract.ts`
- `lib/project-management/notifications/events.ts`
- `lib/notification-channels/project-management.ts`
- `prisma/migrations/20260728220000_project_management_p1_schema/migration.sql`
- `prisma/migrations/20260728223000_project_management_p1_role_scope_guard/migration.sql`
- `prisma/migrations/20260728224000_project_management_p1_audit_append_only/migration.sql`
- `prisma/migrations/20260728225000_project_management_p1_role_scope_guard_strict/migration.sql`
- `scripts/project-management-identity-backfill.ts`
- `tests/project-management-p1.spec.ts`

修改：

- `.env.example`
- `README.md`
- `docs/NOTIFICATIONS.md`
- `docs/TECH.md`
- `docs/TESTING.md`
- `lib/auth.ts`
- `lib/feishu-user-sync.ts`
- `lib/notification-channels/index.ts`
- `lib/prisma.ts`
- `package.json`
- `prisma/schema.prisma`

## 4. Prisma Schema 与 Migration

新增项目管理专用 enum：

- `AccountStatus`
- `IdentityProvider`
- `PersonStatus`
- `ProjectManagementSystemRole`
- `TaskStatus`
- `TaskPriority`
- `TaskMemberRole`
- `RevisionApprovalMode`
- `PlanVersionStatus`
- `TaskNodeType`
- `TaskNodeStatus`
- `RevisionStatus`
- `MilestoneReviewResult`
- `ReviewEvidenceKind`
- `TerminationOutcome`
- `WorkSegmentType`
- `WorkSegmentStatus`
- `WorkSegmentRole`
- `WorkSegmentChangeAction`
- `ResourceConflictKind`
- `ResourceConflictSeverity`
- `ResourceConflictStatus`
- `ProjectManagementNotificationCategory`
- `ProjectManagementNotificationChannel`
- `AuditSource`

新增模型：

- `Account`
- `AccountIdentity`
- `Person`
- `Tag`
- `Task`
- `TaskTag`
- `TaskMember`
- `TaskPlanVersion`
- `TaskNode`
- `PlanVersionNode`
- `MilestoneNode`
- `RevisionNode`
- `TerminationNode`
- `MilestoneReview`
- `ReviewEvidence`
- `WorkSegment`
- `SegmentTag`
- `WorkSegmentSource`
- `WorkSegmentChange`
- `ResourceConflict`
- `ConflictSegment`
- `SystemRoleAssignment`
- `NotificationPreference`
- `InAppNotification`
- `DomainAuditEvent`

迁移说明：

- `20260728220000_project_management_p1_schema`
  - 创建 P1 schema、索引和 FK。
  - 将 `Task.currentPlanVersionId` 与 `TaskPlanVersion.taskId` 循环 FK 设为 `DEFERRABLE INITIALLY DEFERRED`。
  - 增加单 Task 单 `CURRENT` Plan 部分唯一索引。
  - 增加有效 Tag 名称唯一索引。
  - 增加 active TaskMember role 唯一索引。
  - 增加 active SystemRoleAssignment scope 唯一索引。
  - 增加 Segment 时间、allocation、completion、customRole、node/task 关联检查。
  - 增加 MilestoneReview 幂等键和拒绝评论检查。
  - 增加 ReviewEvidence shape 检查。
  - 增加 ResourceConflict fingerprint 唯一和时间检查。
  - 增加 InAppNotification 和 DomainAuditEvent 基础完整性检查。
- `20260728223000_project_management_p1_role_scope_guard`
  - 增加第一版角色 scope guard。
- `20260728224000_project_management_p1_audit_append_only`
  - 增加 `prevent_domain_audit_event_mutation()` trigger function。
  - `DomainAuditEvent` UPDATE/DELETE 均被数据库拒绝。
- `20260728225000_project_management_p1_role_scope_guard_strict`
  - 不修改已应用迁移，使用 follow-up migration 收紧角色 scope 规则。
  - `SYSTEM_ADMINISTRATOR` 必须全局：`team='' AND techGroup=''`。
  - `AUDITOR` 可全局或 scoped。
  - `TEAM_ADMINISTRATOR` 与 `RESOURCE_MANAGER` 必须至少一个非空 trimmed scope。

`prisma/schema.prisma` 保持自然模型名，不使用 `Pm*` 前缀，不包含 Project 或 legacy 字段。

## 5. 身份与登录集成

新增模块：`lib/project-management/identity/index.ts`

公开入口：

- `resolveFeishuIdentityForUser(input)`
- `resolveFeishuIdentityForUserTx(tx, input)`
- `getCurrentProjectManagementActor()`
- `getProjectManagementActorForFeishuUser(input)`
- `backfillProjectManagementIdentities({ dryRun })`
- `projectManagementFeishuProviderSubject(input)`

行为：

- 首发 provider 固定为 `FEISHU`。
- `tenantId` 当前固定为 `default`。
- `providerSubject` 优先使用 `unionId`。
- 无 `unionId` 时使用 `open:<openId>`，避免 openId 与 unionId 混淆。
- 解析时同时查 `providerSubject`、`openId`、`unionId`，发现多个 Account 命中则硬失败。
- `Account.status !== ACTIVE` 时拒绝建立项目管理 actor。
- 不按姓名、邮箱或头像自动合并 Person。
- 身份冲突硬失败，并写入脱敏 `DomainAuditEvent`，`entityId` 和 identity 字段只记录 hash。
- `backfillProjectManagementIdentities()` 默认 dry-run；写入必须设置 `APPLY_PM_IDENTITY_BACKFILL=true`。
- backfill 只读取共享 `User`，不读取旧项目管理对象，不修改采购 `User.openId/unionId` 语义。

集成点：

- `lib/auth.ts`
  - signIn 仍先 upsert `User`。
  - 随后调用 `resolveFeishuIdentityForUser()` 初始化项目管理 Account/Person。
- `lib/feishu-user-sync.ts`
  - 通讯录同步仍 upsert `User`。
  - 随后调用同一身份 resolver 初始化或刷新项目管理 Account/Person。
- `scripts/project-management-identity-backfill.ts`
  - 新增命令 `npm run pm:identity-backfill`。
  - 默认输出 dry-run JSON。
  - APPLY 需显式环境变量，重复运行幂等。

## 6. 授权骨架

新增模块：`lib/project-management/authorization/index.ts`

公开入口：

- `PROJECT_MANAGEMENT_ACTIONS`
- `authorize({ actor, action, resource })`
- `assertAuthorized(input)`
- `taskReadableWhere(actor)`
- `segmentReadableWhere(actor)`
- `tagReadableWhere(actor)`
- `auditReadableWhere(actor)`
- `notificationReadableWhere(actor)`

已固定 action 字符串：

- `tag.create`
- `tag.update`
- `tag.delete`
- `task.create`
- `task.view`
- `task.update_metadata`
- `task.manage_members`
- `task.activate`
- `task.archive`
- `plan.view_history`
- `revision.create`
- `revision.review`
- `revision.apply`
- `milestone.submit_review`
- `milestone.review`
- `task.terminate`
- `segment.view`
- `segment.manage_self`
- `segment.manage_others`
- `conflict.view`
- `conflict.resolve`
- `audit.view`

关键规则：

- 默认拒绝。
- System Administrator 全局允许，但不能绕过默认防自审。
- Task 默认只对 TaskMember、范围内 Team Administrator、System Administrator、授权 Auditor 可见。
- Tag 不提供 Task 权限继承；Tag 创建人只可管理 Tag 本身。
- 自审默认拒绝；`allowSelfReview=true` 才允许，并且后续完整策略变更必须由 System Administrator 写审计。
- Team Administrator 与 Resource Manager 必须有 scope；空 scope 不会在 `scopedTaskWhere()` 中生成 `{}` 全量查询。
- Auditor 可全局或 scoped；全局 Auditor 可读全部 Task/审计。

已修复的审查问题：

- 第一版 `roleScopeMatches()` 已拒绝空 scope Team Administrator，但 `scopedTaskWhere()` 最初仍可能为该角色生成 `{}` 全量 where。
- 最终修复为 `scopedTaskWhere()` 通过 `roleCanProduceTaskScopeWhere()` 过滤，空 scope `TEAM_ADMINISTRATOR` / `RESOURCE_MANAGER` 不会进入列表 OR。
- DB 层通过严格 follow-up migration 同步防止非法角色落库。

## 7. 站内通知、Outbox 与飞书边界

新增项目管理通知契约：

- `lib/project-management/notifications/contract.ts`
- `lib/project-management/notifications/events.ts`
- `lib/notification-channels/project-management.ts`

入队规则：

- `channel` 固定为 `project-management`。
- payload 固定 `payloadVersion=1`。
- 入队 helper 会先校验 payload schema。
- `type` 必须等于 `payload.kind`。
- `botKind` 必须与 `purpose` 一致。
- `purpose=approval_request` 自动使用审批机器人。
- 普通通知自动使用通知机器人。
- P1 只允许 `milestone_review_submitted` 和 `revision_pending_review` 声明 `approval_request`。
- 其他事件不得持久化为审批机器人通知。

站内通知：

- `createInAppNotificationTx()` 在业务事务内写 `InAppNotification`。
- `eventKey` 使用唯一键和 `skipDuplicates` 实现幂等。

项目管理 adapter：

- 注册于 `lib/notification-channels/index.ts`。
- 解析 `NotificationOutbox.payload` 并校验 schema。
- 校验 `row.type`、`row.botKind` 与 payload 一致。
- 对 `recipientOpenIds` trim、过滤空值、去重。
- P1 的 `sendToRecipient()` 和 `sendComposite()` 均抛 `NonRetryableNotificationError("项目管理飞书通知投递将在 P6 启用")`。
- 不导入 `lib/feishu-message`、`lib/feishu`、webhook、CardKit 或采购 CardKit 传输模块。

边界测试：

- `tests/feishu-boundaries.spec.ts` 扫描 `app/progress`、`app/actions/project-management`、`components/project-management`、`lib/project-management` 和项目管理 notification adapter。
- 静态测试确认项目管理入口和领域服务不直连飞书传输层。

## 8. 审计

新增模块：`lib/project-management/audit/index.ts`

公开入口：

- `createDomainAuditEventTx(tx, input)`

行为：

- 只追加 `DomainAuditEvent`。
- 默认 `schemaVersion=1`。
- 默认 `source=WEB`，身份 backfill 冲突审计使用 `MIGRATION`，身份解析冲突审计使用 `SYSTEM`。
- `before/after` 会递归脱敏敏感 key。
- 敏感 key 覆盖 token、secret、password、cookie、authorization、credential、appSecret、storagePath、publicPath、filePath、path 等后缀。
- DB trigger 强制 append-only，UPDATE/DELETE 会失败。
- 冲突审计只记录 hash，不记录明文 openId/unionId。

## 9. 文档更新

已更新：

- `.env.example`
  - 增加 `APPLY_PM_IDENTITY_BACKFILL` 注释。
- `README.md`
  - 增加 P1 状态、identity backfill 命令和项目管理通知边界说明。
- `docs/TECH.md`
  - 增加 P1 数据模型、Auth 身份映射、项目管理授权、role scope、审计 append-only、项目管理 adapter 骨架说明。
- `docs/TESTING.md`
  - 增加 P1 targeted tests、identity backfill 验证和安全断言清单。
- `docs/NOTIFICATIONS.md`
  - 增加 `channel=project-management` payload 契约、审批用途 allowlist、非真实投递边界说明。

## 10. 测试覆盖

新增 `tests/project-management-p1.spec.ts`，在 desktop 和 mobile 两个 Playwright project 中执行。

覆盖范围：

- Schema 约束：
  - 单 Task 单 `CURRENT` Plan。
  - 有效 Tag 名称唯一，归档后可复用。
  - Segment 时间顺序、allocation、completion 检查。
  - Review idempotency key。
  - Conflict fingerprint 唯一。
- 身份：
  - 首次 `User -> Account/Identity/Person` 解析。
  - 重复登录幂等。
  - openId fallback 升级为 unionId。
  - unionId/openId 跨 Account 冲突硬失败。
  - 冲突写脱敏 `DomainAuditEvent`。
  - 禁用 Account 拒绝 actor。
  - backfill dry-run 无写入。
  - APPLY 在隔离 Playwright DB 中幂等。
- 授权：
  - Task owner/viewer/outsider。
  - 范围内 Team Administrator 允许。
  - 范围外 Team Administrator 拒绝。
  - 空 scope Team Administrator 在授权层和 readableWhere 层拒绝。
  - DB 拒绝空 scope Team Administrator。
  - DB 拒绝带 scope System Administrator。
  - 全局 Auditor 可读。
  - Tag 创建人不继承 Task 权限。
  - 自审默认拒绝。
- 通知与审计：
  - 站内通知事务 helper。
  - 审计脱敏。
  - 审计 update/delete trigger。
  - 项目管理 outbox 入队。
  - payloadVersion。
  - botKind 与 purpose 校验。
  - approval_request kind allowlist。
  - adapter 收件人去重。
  - P1 不真实投递飞书，且失败为非可重试错误。

已有回归：

- `tests/feishu-boundaries.spec.ts`
- `tests/legacy-project-management-migration.spec.ts`
- 采购、反馈、附件、notification outbox、Feishu delivery guard、Feishu message、smoke 等全量 E2E。

## 11. 验证记录

最后一次完整验证在 2026-07-28 21:02 CST 前完成。

已执行并通过：

```text
npx prisma validate
  PASS

npx prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --exit-code
  PASS
  No difference detected.

npm run db:deploy
  PASS
  已应用：
  - 20260728220000_project_management_p1_schema
  - 20260728223000_project_management_p1_role_scope_guard
  - 20260728224000_project_management_p1_audit_append_only
  - 20260728225000_project_management_p1_role_scope_guard_strict

npm run test:e2e -- tests/project-management-p1.spec.ts tests/feishu-boundaries.spec.ts
  PASS
  16 passed，desktop + mobile。

npm run check
  PASS
  包含 prisma validate、prisma generate、应用 TypeScript、脚本 TypeScript、ESLint 和 git diff --check。

npm run build
  PASS

npm run pm:p0-baseline
  PASS
  legacyTableCount=0，legacyEnumCount=0，progressOutboxRows=0，projectManagerRoleRows=0，forbiddenLegacyColumns=[]。
  受保护共享表 stableHash 与 P0 基线一致。

npm run pm:identity-backfill
  PASS
  dryRun=true，totalUsers=68，alreadyExisting=0，wouldCreate=68，created=0，conflicts=[]。

npm run test:e2e
  PASS
  204 passed，30 skipped，0 failed，耗时约 2.9m。
  skip 为依赖外部 authenticated/privileged storage state 的 smoke。
  启动日志显示 notificationDeliveryDisabled=true，没有真实飞书投递。
```

历史执行说明：

- `npm run check` 早期曾受 `.next/dev/types/validator.ts` 生成缓存坏行影响，删除该未跟踪生成缓存后通过。源码未为此做兼容性改动。
- 后续每次可执行代码或 migration 变更后均重新跑了 targeted tests、`npm run check`、`npm run build`、`npm run db:deploy`、P0 baseline、identity dry-run 和全量 E2E。

## 12. 独立审查

按 AGENTS.md 要求，已启动独立只读 subagent review。

第一轮审查发现并修复：

1. 空 scope scoped role 可变成全局权限。
   - 修复：授权层拒绝空 scope Team Administrator/Resource Manager。
   - 修复：新增 role scope DB check。
   - 后续发现 `scopedTaskWhere()` 仍可能生成 `{}`，见第二轮。
2. 飞书身份冲突没有进入管理员待处理或写审计。
   - 修复：身份解析冲突和 APPLY backfill 冲突写脱敏 `DomainAuditEvent`。
   - P1 未新增完整管理员待处理 UI，当前以审计事件承载待处理信号。
3. 项目管理通知 `purpose` 与事件类型未绑定。
   - 修复：`approval_request` 只允许 `milestone_review_submitted` 和 `revision_pending_review`。
   - 修复：入队 helper 和 adapter 都校验 type/kind/botKind/purpose。
4. `DomainAuditEvent` append-only 只靠约定。
   - 修复：新增 UPDATE/DELETE trigger，并补测试。

第二轮审查发现并修复：

1. `scopedTaskWhere()` 仍会把空 scope Team Administrator 映射为 `{}`。
   - 修复：新增 `roleCanProduceTaskScopeWhere()`，空 scope Team/Resource 不进入 scoped where。
2. role scope guard migration 仍允许带 scope `SYSTEM_ADMINISTRATOR`。
   - 修复：新增 follow-up migration `20260728225000_project_management_p1_role_scope_guard_strict`，不修改已应用 migration。

最终复审结论：

- 上一轮两个问题均已关闭。
- 未发现新的 actionable issue。
- 剩余风险：`RESOURCE_MANAGER` 空 scope 拒绝没有单独测试，但它和 `TEAM_ADMINISTRATOR` 走同一个 DB check 分支；reviewer 未发现实现层新漏洞。

## 13. 当前工作树状态

最后一次 `git status --short` 显示只有本阶段相关变更：

```text
 M .env.example
 M README.md
 M docs/NOTIFICATIONS.md
 M docs/TECH.md
 M docs/TESTING.md
 M lib/auth.ts
 M lib/feishu-user-sync.ts
 M lib/notification-channels/index.ts
 M lib/prisma.ts
 M package.json
 M prisma/schema.prisma
?? lib/notification-channels/project-management.ts
?? lib/project-management/
?? prisma/migrations/20260728220000_project_management_p1_schema/
?? prisma/migrations/20260728223000_project_management_p1_role_scope_guard/
?? prisma/migrations/20260728224000_project_management_p1_audit_append_only/
?? prisma/migrations/20260728225000_project_management_p1_role_scope_guard_strict/
?? scripts/project-management-identity-backfill.ts
?? tests/project-management-p1.spec.ts
?? handoffs/2026-07-28-p1-schema-identity-authorization-baseline.md
```

`git diff --check` 最后一次执行通过。

## 14. P2 接手注意事项

Task 创建：

- `Task.currentPlanVersionId` 是必填 FK。
- `Task.currentPlanVersionId` 与 `TaskPlanVersion.taskId` 构成循环 FK，已设为 deferrable。
- P2 创建初始 Task + CURRENT Plan 时应使用事务，并执行 `SET CONSTRAINTS ALL DEFERRED`，或使用预生成 UUID 并在事务内写入。
- 不能先创建没有 CURRENT Plan 的 Task。

权限：

- 页面和 Server Action 不得自行拼角色判断。
- 必须调用 `authorize()` 或 readableWhere helper。
- 列表和详情页应使用 readableWhere 防枚举，不要先按 ID 查出对象再内存判断。
- Team Administrator/Resource Manager 只能在 scope 内生效。
- Tag 不能扩大或缩小 Task 可见性。
- 自审默认拒绝；开启 `allowSelfReview` 必须由 System Administrator 在 Task 策略中显式变更并写审计。

通知：

- 项目管理业务操作只能写 `NotificationOutbox`，不得直接导入飞书传输层。
- P1 adapter 真实投递被明确禁用。P6 启用前必须补卡片内容、收件人解析、禁发/allowlist、recipient 级重试和双机器人回归测试。
- 审批用途只允许待审批类事件；普通任务指派、结果、冲突、到期等事件不得使用审批机器人。

审计：

- 使用 `createDomainAuditEventTx()` 写审计。
- 不要尝试 update/delete `DomainAuditEvent`。
- before/after 应尽量只记录业务字段，不复制大 payload、附件正文、token、cookie、文件路径明文。

身份：

- 项目管理新表使用 `accountId/personId`，不要把飞书 `openId` 作为业务外键。
- 采购仍使用 `User.openId/unionId`，不要迁移或重构采购外键。
- 不按姓名、邮箱、头像自动合并 Person。
- 既有用户初始化先 dry-run：`npm run pm:identity-backfill`。
- 写入必须显式：`APPLY_PM_IDENTITY_BACKFILL=true npm run pm:identity-backfill`。
- 当前开发库 dry-run 结果为 68 个可创建、0 冲突；尚未对当前开发库 APPLY。

## 15. 剩余风险与限制

- 当前 P1 只提供底座，不提供可用的新项目管理业务 UI。
- `/progress` 仍是重构占位页，旧 `/progress/*` 仍应保持重定向/占位行为。
- 项目管理飞书真实投递延后到 P6。
- 管理员处理身份冲突的 UI/队列未实现；当前通过脱敏审计事件暴露待处理信号。
- `RESOURCE_MANAGER` 空 scope 拒绝没有单独测试，但 DB check 与 `TEAM_ADMINISTRATOR` 共用严格分支，授权层也共用空 scope 过滤。
- 当前开发库已应用 P1 migrations；identity backfill 仍为 dry-run，未写入当前开发库 Account/Person。
- P1 schema 包含 `SegmentTag` 作为 Segment 与 Tag 的关联表，计划原列表中未单独列出，但用于避免 Tag 权限继承到 Task，同时支持 Segment 分类。

## 16. 下一阶段建议

P2 建议顺序：

1. 先实现 Task/Plan/Node 创建 service，不上复杂 UI。
2. service 边界先定义 Zod input、authorize、状态前置条件、事务、审计和 outbox。
3. 对 Task 创建补 allowed/denied、可见性、防枚举和持久化状态测试。
4. 保持 `/progress` 用户界面小步开启，不一次性实现完整工作台。
5. 每个新增 Server Action 都补 PM 飞书边界静态测试或确认现有扫描覆盖。
6. 每次 schema 变更仍执行 `prisma validate`、migration diff、`npm run db:deploy`、targeted Playwright、`npm run check`、`npm run build` 和全量 E2E。
