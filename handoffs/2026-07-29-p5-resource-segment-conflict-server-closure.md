# P5 Resource Segment 与 Conflict 服务端闭环 Handoff

日期：2026-07-29

最后更新：2026-07-29 01:00 CST

工作区：`/home/pnx/code/management_system_dev`

代码提交：`e0317cc feat(project-management): add resource segment conflict services`

状态：P5 Resource Segment 与 Conflict 服务端闭环已实现并通过验证。`/progress` 仍为占位页；资源时间轴 UI、冲突中心 UI、移动端业务 UI、通知中心页面和真实项目管理飞书卡片投递仍留到 P6。

## 1. 本阶段目标与边界

本阶段在 P1 schema 与 P2/P3 Task 生命周期服务端底座上，完成资源投入与冲突管理的服务端能力：

- Planned/Actual Work Segment 创建、更新、批量创建、移动、拆分、合并、取消。
- Planned Segment full confirm、partial confirm。
- Actual Segment 创建、无来源创建、多 Planned 来源创建、一 Planned 多 Actual 覆盖。
- Planned/Actual 来源关系、拆分来源、合并来源历史。
- Planned Segment 重关联和 Actual Segment 逻辑删除。
- Segment 列表、详情、change history 查询 facade。
- Resource Conflict 扫描、列表、详情、防枚举解释。
- Conflict acknowledge、resolve、ignore、preview suggestion、apply suggestion。
- Segment lifecycle transition cron：到期 Planned 推到 `PENDING_CONFIRMATION`，进行中 Planned 推到 `IN_PROGRESS`。
- Resource Conflict cron：每 15 分钟扫描，带进程内运行中保护。
- WorkSegmentChange、DomainAuditEvent、站内通知和 `channel=project-management` outbox。

本阶段明确未实现：

- 未新增人员不可用时间模型；`UNAVAILABLE_TIME` enum 仍仅为 P1 预留，scanner 不产生该冲突。
- 未新增 Prisma migration，继续复用 P1 表。
- 未实现资源时间轴 UI、冲突中心 UI 或移动端 P5 业务 E2E。
- 未启用真实项目管理飞书卡片构造或投递；项目管理 adapter 仍保持 P6 未启用边界。
- Segment 和 Conflict 操作不推进 Task、Node、Milestone、Termination 状态。

## 2. 阅读依据

实现和收尾时已阅读或对齐：

- `handoffs/2026-07-28-p2-p3-task-lifecycle-server-closure.md`
- `docs/plan/03-领域规则与状态机.md`
- `docs/plan/05-服务端操作与接口计划.md`
- `docs/plan/07-身份权限与审计计划.md`
- `docs/plan/08-通知定时任务与外部集成.md`
- `docs/plan/10-测试策略与验收用例.md`
- `docs/plan/12-可执行任务清单WBS.md`
- `docs/plan/13-风险依赖与待确认决策.md`
- `prisma/schema.prisma`
- `lib/project-management/authorization/index.ts`
- `lib/project-management/application/lifecycle-service.ts`
- `lib/project-management/notifications/events.ts`
- `lib/notification-channels/project-management.ts`
- `tests/project-management-p1.spec.ts`
- `tests/project-management-lifecycle.spec.ts`
- `tests/feishu-boundaries.spec.ts`

P1/P2/P3 的关键接手规则仍适用：项目管理业务只能写 outbox，不得直连飞书传输层；详情查询必须用 readableWhere 防枚举；审计只追加；业务状态变更要使用事务和显式状态机校验。

## 3. 变更文件

新增：

- `app/actions/project-management/segments.ts`
- `app/actions/project-management/conflicts.ts`
- `lib/project-management/application/segment-service.ts`
- `lib/project-management/application/conflict-service.ts`
- `lib/project-management/application/notification-utils.ts`
- `lib/project-management/queries/resource-queries.ts`
- `lib/project-management/validations/segments.ts`
- `tests/project-management-segments.spec.ts`
- `tests/project-management-conflicts.spec.ts`

修改：

- `README.md`
- `docs/NOTIFICATIONS.md`
- `docs/TECH.md`
- `docs/TESTING.md`
- `lib/project-management/application/lifecycle-service.ts`
- `scripts/cron.ts`
- `tests/project-management-lifecycle.spec.ts`

未修改：

- `prisma/schema.prisma`
- `prisma/migrations/*`
- `lib/notification-channels/project-management.ts`

## 4. Schema 与数据模型

本阶段不新增 migration，复用 P1 已存在模型：

- `WorkSegment`
- `SegmentTag`
- `WorkSegmentSource`
- `WorkSegmentChange`
- `ResourceConflict`
- `ConflictSegment`
- `DomainAuditEvent`
- `InAppNotification`
- `NotificationOutbox`

重要模型约定：

- `WorkSegment.type` 仅 `PLANNED` / `ACTUAL`。
- Planned 可处于 `PLANNED`、`IN_PROGRESS`、`PENDING_CONFIRMATION`、`CONFIRMED`、`CANCELLED`。
- Actual 创建后为 `CONFIRMED`；逻辑删除会置 `deletedAt` 并把 status 置为 `CANCELLED`。
- Full confirm 创建 Actual，并写 `WorkSegmentSource` 覆盖完整 Planned 范围，原 Planned 置 `CONFIRMED`。
- Partial confirm 创建 Actual 和 source，原 Planned 置 `CANCELLED`，未覆盖范围生成剩余 Planned 子段，子段写 `sourceSplitFromId`。
- Split 将原 Planned 置 `CANCELLED`，子段完整覆盖原时间范围且写 `sourceSplitFromId`。
- Merge 将原 Planned 置 `CANCELLED`，新 Planned 通过 `WorkSegmentChange.after.mergedFromSegmentIds` 保留来源。

## 5. Segment 服务与 Actions

服务入口位于 `lib/project-management/application/segment-service.ts`：

- `createWorkSegment`
- `batchCreatePlannedSegments`
- `updateWorkSegment`
- `movePlannedSegments`
- `splitPlannedSegment`
- `mergePlannedSegments`
- `cancelPlannedSegment`
- `confirmPlannedSegment`
- `partiallyConfirmSegment`
- `createActualSegment`
- `relinkPlannedSegment`
- `softDeleteActualSegment`
- `scanSegmentTransitions`

Server Actions 位于 `app/actions/project-management/segments.ts`，包装当前登录 actor、统一 action result、revalidate 和错误处理。

关键校验：

- `endAt > startAt`。
- 单条 Segment 最长 31 天。
- `allocation` 可空；非空时 `0 < allocation <= 100`。
- `completionPercent` 仅 Actual 可用，范围 `0..100`。
- `nodeId` 非空时必须有 `taskId`，且 Node 必须属于该 Task。
- Planned 关联 Node 必须在当前计划中，且节点未 `REVISED` / `CANCELLED`。
- Actual 可保留历史 Node，不要求在 Current Plan。
- Confirmed Planned 不能再被 update/move/split/merge/cancel/relink。
- Partial confirm 不允许完整覆盖，完整覆盖必须使用 full confirm。
- Merge 允许 `PLANNED` / `IN_PROGRESS` / `PENDING_CONFIRMATION` 非终态状态混合，但仍要求同人、同类型、同内容、同 role/customRole、同 priority、同 Task/Node、同 expectedOutput、同 tag set，且时间相邻或重叠。

权限规则：

- 本人可管理本人 Segment。
- 管理他人 Segment 需要 System Admin，或通过关联 Task 命中 scoped Team Admin / Resource Manager。
- 无 Task 关联的他人 Segment 只允许 System Admin 管理。
- 更新或重关联他人 Segment 时，目标 Task 也必须命中 scoped manager 权限，不能只凭目标 Task 可见性重关联。
- 本人 Segment 关联 Task 时要求目标 Task 对本人可见。

## 6. Conflict 服务与 Actions

服务入口位于 `lib/project-management/application/conflict-service.ts`：

- `scanConflictsForPerson`
- `scanResourceConflicts`
- `scanResourceConflictsForDefaultWindow`
- `acknowledgeConflict`
- `resolveConflict`
- `ignoreConflict`
- `previewConflictSuggestion`
- `applyConflictSuggestion`

Server Actions 位于 `app/actions/project-management/conflicts.ts`，包含：

- `scanConflictsForPerson`
- `scanResourceConflicts`
- `listResourceConflicts`
- `getResourceConflict`
- `acknowledgeConflict`
- `resolveConflict`
- `ignoreConflict`
- `previewConflictSuggestion`
- `applyConflictSuggestion`

扫描规则：

- 半开区间 `[startAt, endAt)`；边界相接不算重叠。
- 默认窗口：`now - 7d` 到 `now + 90d`。
- 检测：
  - `ALLOCATION_OVER_LIMIT`
  - `MISSING_ALLOCATION`
  - `HIGH_PRIORITY_OVERLAP`
  - `LEAD_ROLE_OVERLAP`
  - `REVISION_OVERLAP`
  - `ACTUAL_OVERLOAD`
- 不检测 `UNAVAILABLE_TIME`，因为 P5 不新增人员不可用时间模型。
- fingerprint basis：`v1|kind|personId|startAt|endAt|sortedSegmentIds`，sha256。
- fingerprint 使用真实冲突区间，不用滑动扫描窗口裁剪后的区间，避免 cron 每次扫描反复打开同一长冲突。
- 重复扫描不重复创建。
- 冲突消失后置 `RESOLVED`。
- `ignoredUntil` 未到期时保持 ignored；到期后仍命中则重新打开，并使用 reopen 专用 outbox event key。

处理权限：

- Conflict 查看允许涉及本人、相关 Task 可见者、范围内 Resource Manager / Team Admin。
- Resolve / ignore / apply 允许 System Admin、所有关联 Task 范围内 Resource Manager / Team Admin。
- Task Owner 只可处理所有关联 Task 都由其 OWN 的冲突。
- 只要冲突包含任何无 Task Segment，非 System Admin 不能 resolve / ignore / apply。
- Preview 不写库。
- Apply 必须 `confirmApply=true`，并要求每个移动 Segment 的 `expectedUpdatedAt` 乐观锁匹配。

通知收件人：

- `resource_conflict_opened` 收件人只从当前 conflict 关联的 segments 推导。
- 不再使用扫描窗口里的全部 `scanSegments` 扩大 Task owner / manager 收件范围，避免无关 Task owner 收到冲突通知。

## 7. 查询 Facade 与防枚举

查询入口位于 `lib/project-management/queries/resource-queries.ts`：

- `listWorkSegments`
- `getWorkSegment`
- `listWorkSegmentChanges`
- `listResourceConflicts`
- `getResourceConflict`

防枚举规则：

- Segment 查询使用 `segmentReadableWhere(actor)`。
- Conflict 查询通过冲突本人或关联 readable Segment / readable Task 过滤。
- Segment detail 的 `plannedSources` / `actualSources` 会按 actor 过滤 linked Segment；不可读端不返回 ID、时间或状态。
- Conflict detail 只返回 actor 可读的 Segment。
- Conflict explanation 会过滤不可读 `segmentIds`、`segments`、`changedSegmentIds`，并在存在隐藏段时加入 `hiddenSegmentCount`。

## 8. Lifecycle 与 Cron

`lib/project-management/application/lifecycle-service.ts` 更新：

- Revision apply 后，受替换节点影响的非终态 Planned Segment 会置 `associationNeedsReview=true`。
- 只标记 `PLANNED` / `IN_PROGRESS` / `PENDING_CONFIRMATION` 且未删除的 Planned Segment。
- 标记时使用 guarded `updateMany`，带 status、deletedAt 和当前 `associationNeedsReview=false` 条件。
- 只有实际更新成功才写 `WorkSegmentChange` 和 `DomainAuditEvent`。
- 终态 `CONFIRMED` / `CANCELLED` Planned 不被修改，也不写误导审计。
- 汇总写 `segment_association_invalidated` 通知。

`scripts/cron.ts` 更新：

- `scanSegmentTransitions` 每 10 分钟运行一次，带运行中保护。
- `scanResourceConflictsForDefaultWindow` 每 15 分钟运行一次，带运行中保护。
- 仍使用项目管理 outbox，不直接触发真实飞书投递。

## 9. 通知与飞书边界

新增或扩展的项目管理事件：

- `segment_confirmation_due`
- `segment_association_invalidated`
- `resource_conflict_opened`
- `resource_conflict_resolved`

实现位置：

- `lib/project-management/application/notification-utils.ts`
- `lib/project-management/application/segment-service.ts`
- `lib/project-management/application/conflict-service.ts`
- `lib/project-management/application/lifecycle-service.ts`

边界说明：

- 所有 P5 项目管理通知都写 `channel=project-management` outbox。
- 普通通知使用 `botKind=notification`。
- 不新增真实飞书卡片构造。
- 不绕过 `NOTIFICATION_DELIVERY_DISABLED`、allowlist、delivery guard 或 outbox。
- `tests/feishu-boundaries.spec.ts` 已继续扫描新增 project-management 文件，确保没有直接依赖飞书传输层。

## 10. 测试覆盖

新增：

- `tests/project-management-segments.spec.ts`
  - 中文校验错误、self/others 权限、denied path。
  - 乐观锁冲突。
  - 单条和批量创建，事务回滚。
  - split / merge 覆盖守恒、来源历史、tag 和语义校验。
  - full confirm、partial confirm、一 Planned 多 Actual、多 Planned 一 Actual、无来源 Actual。
  - confirmed Planned 不可更新。
  - partial confirm 完整覆盖被拒绝。
  - source relation 查询不泄不可读 linked Segment。
  - cancel、soft delete、relink。
  - 操作不改变 Task / Milestone 状态。
  - transition scan 写 change history、audit 和 confirmation_due outbox。

- `tests/project-management-conflicts.spec.ts`
  - 100% 不冲突，100.01% 冲突。
  - 半开区间边界相接不重叠。
  - missing allocation、High/Critical、Owner/Lead、revision overlap、actual overload。
  - 连续 slice 同语义合并。
  - 默认窗口扫描保持长冲突 fingerprint 稳定。
  - conflict detail 只暴露 actor 可读 segments。
  - explanation 过滤不可读 `changedSegmentIds`。
  - fingerprint 幂等、消失后 resolved、ignoredUntil 到期重开。
  - acknowledge / resolve / ignore 权限与状态机。
  - 含无 Task Segment 的冲突非 System Admin 不能处理。
  - preview 无写入。
  - apply 需要显式确认和 expectedUpdatedAt。
  - opened notification 收件人只来自 involved segments。

更新：

- `tests/project-management-lifecycle.spec.ts`
  - Revision applied 后验证 affected Planned Segment `associationNeedsReview`。
  - 验证 Segment change history、DomainAuditEvent 和 `segment_association_invalidated` outbox。
  - 验证终态 Planned 不被 Revision apply 标记。

## 11. 已运行验证

最终验证命令：

```bash
npm run check
npm run test:e2e -- tests/project-management-p1.spec.ts tests/project-management-lifecycle.spec.ts tests/project-management-segments.spec.ts tests/project-management-conflicts.spec.ts tests/feishu-boundaries.spec.ts
npm run test:e2e
```

结果：

- `npm run check` 通过。
- 目标集通过：`66 passed`。
- 全量 E2E 通过：`254 passed, 30 skipped`。
- 30 个 skipped 是未配置登录态的 authenticated smoke，属于既有测试环境行为。
- `npm run db:deploy` 未运行，因为本阶段没有 Prisma schema 或 migration 变更。

审查：

- 独立 subagent 做了三轮审查。
- 前两轮发现的问题已修复并补回归。
- 第三轮结果：无新的 actionable issue。

环境说明：

- 测试过程中 Next 生成过损坏的 `.next/dev/types/validator.ts` 缓存；处理方式是将 `.next` 移到 `.tmp/next-cache-stale-*` 后重跑 `npm run check`。
- `.tmp/` 未提交。
- Playwright 中出现的 pg nested query deprecation warning 为既有非阻塞警告。
- Feishu 失败/跳过日志来自受控测试场景和 `NOTIFICATION_DELIVERY_DISABLED=true`，未发送真实飞书消息。

## 12. 接手注意事项

P6 或后续开发请注意：

- 不要绕开 P5 service 直接写 `WorkSegment` / `ResourceConflict`；否则会漏 `WorkSegmentChange`、`DomainAuditEvent` 和 outbox。
- UI 调用 mutation 时必须携带 `expectedUpdatedAt`，尤其是 move、split、merge、confirm、relink、apply suggestion。
- Conflict suggestion 当前只提供基础的“低优先级顺延”方案；复杂排程策略属于 P6/P7。
- 若新增人员不可用时间，需要先设计可授权、可审计的 unavailable-time 模型，再启用 `UNAVAILABLE_TIME` 扫描。
- 若启用真实项目管理飞书投递，必须在 `lib/notification-channels/project-management.ts` 内实现 adapter，不得从 P5 服务直接调用飞书传输层。
- Resource timeline UI 和 Conflict center UI 需要继续使用 `resource-queries.ts`，不要在客户端或 route handler 直接拼 Prisma 查询。
- P5 当前没有新增数据库约束来表达所有服务层不变量；后续若暴露更多写入口，必须复用服务层或补 migration 约束。

## 13. 推荐下一步

P6 建议拆分为：

1. Resource timeline UI：Segment 列表、详情、创建、编辑、移动、拆分、合并、确认、重关联。
2. Conflict center UI：列表、详情、acknowledge、resolve、ignore、preview/apply suggestion。
3. Notification center UI：站内通知读取、已读、跳转。
4. Project-management Feishu adapter：真实卡片 payload、allowlist、delivery guard、outbox retry 和边界测试。
5. 移动端 E2E：资源时间轴和冲突中心核心流程。
