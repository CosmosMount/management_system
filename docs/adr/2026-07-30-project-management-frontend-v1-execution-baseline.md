# ADR: 项目管理前端 v1.0 执行基线

> 状态（2026-08-05）：本文关于 Segment 与 Task Node 关联、节点删除阻断和关联复核的决策已由 [删除 Work Segment 职责与 Task Node 关联](./2026-08-05-remove-work-segment-role-node-association.md) 取代，仅保留历史背景。
>
> 状态（2026-08-03）：本文关于单 Owner、多成员角色、Reviewer、自审开关和 Task 流程策略的决策已由 [Task 全员可见、双成员角色与全局管理员审批](./2026-08-03-task-global-visibility-participants-admin-approval.md) 取代，仅保留历史背景。
>
> 状态（2026-08-01）：本文涉及资源冲突、冲突中心、投入比例、冲突通知或冲突扫描的设计已由“删除资源冲突与投入比例”决策取代，仅保留历史背景，不代表当前实现。

日期：2026-07-30

状态：Accepted

## 背景

项目管理 P0、P1、P2/P3 的服务端主体已经落地。P5 服务端 handoff 由提交 `2499952` 记录，其实现基线是 `e0317cc`；该 handoff 是 2026-07-29 01:00 CST 时点的历史快照，因此其中“`/progress` 仍为占位页”“项目管理飞书 adapter 未启用”等描述不能代表当前仓库状态。后续提交 `345b5b0` 已加入 `/progress`、Task 列表、Task 工作台、资源列表、冲突中心、通知中心和真实项目管理 notification channel adapter。

`345b5b0` 交付的是首批卡片/列表式 P4/P6 接入基线，不是后来完成的前端形态。统一 TimeCanvas、Task Composer、我的工作、行动待办和资源计划现已落地；本 ADR 保留当时的决策背景，当前行为以代码、schema、后续 ADR、`docs/TECH.md` 和 `docs/TESTING.md` 为准。

本 ADR 解决旧计划与前端 v1.0 之间的冲突，冻结剩余 P4–P8 实施所需的产品、数据、权限、交互和技术默认值。它不表示这些功能已经实现。

## 来源优先级

发生冲突时按以下顺序判定：

1. 当前代码、Prisma schema、migration 和实际执行的测试。
2. 已接受且未被取代的 ADR、`docs/TECH.md` 与 `docs/TESTING.md`。
3. 已完成阶段 handoff；若与后续提交冲突，以后续实现为准。
4. 本 ADR 的历史决策；其中已被页首状态说明或后续 ADR 取代的内容不再作为现行规范。

所有计划和追踪文档使用三种状态：

- **已实现**：当前代码存在，并有与当前 HEAD 对应的验证证据。
- **计划**：已经冻结目标和实施顺序，但尚未完成代码、测试和审查门禁。
- **延期**：明确不进入本轮 S0–S10；重新纳入必须新增决策和相应权限、审计、通知与测试契约。

## 决策

### Task、计划与成员

1. Task 创建采用单页 Plan Composer，覆盖旧“三步向导”描述。
2. Task 详情默认标签为“计划与资源”，Current Plan、参与人 Segment、Busy 和 Conflict 在同一主视图呈现；“概览”等内容作为次级标签。
3. Milestone 日期允许相同，并按 `sequence` 非递减排序；Termination 不得早于最后一个 Milestone。
4. `TaskPlanVersion.plannedStartAt` 使用可空数据库字段以兼容旧数据；新建 Task 和新 Revision 的计划必须填写。
5. Draft Task 继续使用 `TaskPlanVersion.status=CURRENT + activatedAt=null`，不引入另一套 Draft Plan 状态。
6. Draft 更新拆为三个独立 action：`updateTaskDraftMetadata`、`replaceTaskDraftMembers`、`replaceTaskDraftPlan`。三者都只允许 `Task.status=DRAFT`、验证服务端权限、接收 `expectedLockVersion`，并在各自事务中写审计、递增 Task lockVersion、返回新的 `lockVersion`。Draft tags 只通过 `updateTaskDraftMetadata` 更新。只有 `replaceTaskDraftPlan` 处理 `plannedStartAt` 和计划节点整包 replace：合法的已有 `nodeId` 必须保留，新节点通过 `clientKey` 映射；被 Segment 引用的节点不得被隐式删除或迁移关联。metadata 和 members 不得塞入 plan replace。
7. 新建 Task 不创建初始 Segment；创建完成后在 Task 工作台中排期。
8. 每个 Task 恰好有一个 active OWNER。`createTaskDraft`、`replaceTaskDraftMembers`、`replaceTaskMembers` 都必须拒绝 0 OWNER、2 个及以上 OWNER，以及同一 Person 的重复相同 role。同一 Person 可兼任多个不同 role，权限取并集。S2 必须把当前“至少一个 OWNER”校验收紧为该不变量并补回归。`createTaskDraft` 仍须产生既有 `task_assigned` 站内通知和 `mandatory=true` 的 `project-management` outbox；其 purpose/botKind 是 `notification`，只用通知机器人，不得使用 approval bot。
9. `allowSelfReview` 默认关闭，只有 System Administrator 可以开启，并且必须写审计。
10. `team` 和 `techGroup` 复用现有固定选项，不开放任意文本。
11. Active 直接更新只提供 `updateTaskMetadata`、`replaceTaskMembers`、`replaceTaskTags`。三者仅允许 `Task.status=ACTIVE`，验证服务端权限和 `expectedLockVersion`，锁 Task，并在同一事务完成 mutation、DomainAuditEvent、lockVersion 递增，成功返回新 `lockVersion`；stale、无权、终态或 Archived 请求零写入。`replaceTaskMembers` 差异更新 active members、用 `removedAt` 保留历史、保证恰好一个 active OWNER 和多角色不重复规则，并对新增/移除/角色变化写完整站内通知和 `mandatory=true` 的 `project-management` outbox；purpose/botKind 仍为 `notification`，只使用通知机器人，不得使用 approval bot。`replaceTaskTags` 只差异更新 TaskTag 和审计，不广播。

### Segment、冲突与隐私

12. Actual 不支持在画布中拖动；只有具备服务端权限的用户可以在 Inspector 中精确修改，且必须保留变更历史。
13. 禁止把 Segment 拖到其他人员行，直至另行设计 reassign 的权限、审计、通知和并发契约。
14. Busy Block 必须由服务端脱敏生成。前端不得先取得完整 Segment 再进行遮挡；Busy DTO 不含原 Segment ID、标题、Task、Node、Tag、创建人或版本令牌。
15. Conflict suggestion preview 与 resolve/apply 使用相同的处理权限。普通只读用户不能取得隐藏 Segment 的 proposal；响应通过 capability flags 决定可用操作。
16. 批量 Segment mutation 保持服务端事务式全成全败，不采用客户端逐条、无上限并发请求。

### 前端技术与本地状态

17. 纵向人员/Task 行使用 `@tanstack/react-virtual`，依赖变更必须同步 lockfile。
18. 连续时间拖动、Resize 和框选使用 Pointer Events；本轮不引入 dnd-kit 或新的日期库。所有拖动仍必须有键盘和精确表单等价路径。
19. Task 本地草稿使用 localStorage，key 按部署环境和 `accountId` 隔离，并携带 `schemaVersion`；提交成功才清理草稿。
20. 桌面使用 `TimeCanvas`，Pixel 5 等窄屏使用共享 DTO 的 `TimeAgenda`/纵向节点编辑，不缩小桌面甘特图来替代移动交互。

## 本轮延期

以下能力不进入 S0–S10：

- Unavailable Time 数据模型及 `UNAVAILABLE_TIME` 冲突扫描。
- 跨人员重新指派 Segment。
- 保存资源视图。
- 自动资源平衡。
- 复杂依赖线。
- Task 创建时的初始 Segment。

延期不等于允许以客户端临时逻辑实现。重新纳入时必须先冻结服务端授权、事务、审计、通知、隐私和测试契约。

## 执行与关单影响

- 原 P0–P8 保留为领域阶段和历史 WBS；剩余工作按 S0–S10 顺序关单，二者不得混写为同一套完成状态。
- P5 handoff 不能直接作为当前 P5 关单证据。必须重新验证 preview 隐私、capability、并发 transition/scanner、fingerprint 首次竞争、scanner 与人工处理竞争、31 天 merge 上限、缺失 Allocation 解释、通知操作者和 Revision 切换后的版本上下文，并补足相应回归测试。
- `345b5b0` 的已有页面和 adapter 应复用、升级和回归，不重复实现；只有完成 TimeCanvas/TimeAgenda、页面闭环、权限拒绝路径、桌面/移动 E2E 和独立审查后，才能把对应 P4/P6 项标记为完成。
- schema、公共 DTO、共享路由或锁文件由单一实施工作包串行修改。每个阶段均执行“实现 → 独立审查 → 修复 → QA → 再审”循环。
- 生产维护窗口不属于自动执行范围。必须获得用户明确授权以及 BO、TL、QA、DBA 四方签字后，才能执行正式发布。

## 验证

每个阶段只采用当前提交上实际运行的结果。最终至少必须执行：

```bash
npm run check
npm run test:e2e
npm run build
npm run db:deploy # 仅在隔离 PostgreSQL，且存在 schema/migration 变化时
```

历史 handoff 中的通过结果不能替代当前 HEAD 的验证。自动化测试必须保持 `NOTIFICATION_DELIVERY_DISABLED=true`，不得发送真实飞书消息。
