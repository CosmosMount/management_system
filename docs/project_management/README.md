# 项目管理文档状态

旧项目管理实现和开发数据已直接清理，本目录原有的项目、阶段、旧任务、审批、周报、风险和提醒说明已删除，以免继续被误认为当前行为。

当前状态：

- `/progress` 已开放项目管理入口，包含 Project、统一“我的工作”、Task 列表/工作台、人员计划和站内通知中心。个人完整时间线已合并进“我的工作”，旧 `/progress/my-timeline` 返回 404。Project 是 Task 上层文件夹和立项对象，不恢复 Stage。
- 所有已登录统一账号都可查看全部未删除 Task、计划版本、成员、Milestone/Revision 审批与 Task 审计，也可查看全员完整 Planned/Actual Work Segment 和变更历史；停用 Person 的历史投入继续显示并标记“已停用”。账号级项目访问启用/禁用状态已经删除。
- 所有已登录统一账号都可创建合法车组/技术组的 Task，创建者自动成为负责人。Task 有效成员只允许 `OWNER`（负责人）和 `PARTICIPANT`（参与人），支持多负责人但至少一名，同一 Person 在同一 Task 中只能有一个有效角色。
- 非成员只有读取权；Participant 可编辑 Task/计划、提交验收与 Revision 并管理自己的关联投入；Owner 另可管理成员、Task 状态、任意未生效 Revision 和该 Task 全部投入；全局 `SUPER_ADMINISTRATOR/PROJECT_ADMINISTRATOR` 可执行全部项目操作。
- Milestone 和 Revision 的最终决定只允许两类全局管理员，允许自审，但 Revision 提交后仍必须先进入 `PENDING_APPROVAL` 并执行显式批准。Task 级流程策略、允许自审开关和 Task Reviewer 已删除。
- 项目 `GROUP_LEADER` 已退役并只保留撤销历史。采购报销的车组/技术组角色不受影响；Work Segment 的 `REVIEWER` 工作职责也继续保留，但不授予 Task 审批权。
- 每条关联 Task 的有效 Work Segment 必须属于该 Task 的 Owner/Participant。Participant 只能写自己的关联投入，Owner 可写该 Task 全部投入，全局管理员可写全部；无 Task 关联的 Segment 仍由本人管理。
- `WorkSegment` 不再保存或展示投入比例；完成比例也已从新写入、普通 DTO 和 UI 退役，旧数据库列仅保留兼容历史。多个 Segment 可以时间重叠，系统不检测、提示、阻止或通知资源冲突。
- 当前系统不兼容旧项目管理接口或旧数据；旧 `/progress/task/:id` 会重定向到 `/progress/tasks/:id`，`/progress/projects/*` 是当前正式路由，旧 `/progress/kanban` 回到 `/progress`。
- 项目管理通知事件已使用 `channel=project-management` outbox、站内通知和飞书 adapter；Milestone/Revision 待审批只面向活跃全局管理员并使用审批机器人，其他事件使用通知机器人，项目管理领域服务仍不得直接调用飞书传输层。
- 现行成员、可见性和审批决策见 [Task 全员可见、双成员角色与全局管理员审批 ADR](../adr/2026-08-03-task-global-visibility-participants-admin-approval.md)。新系统的历史目标方案见 [`../plan/README.md`](../plan/README.md)；该目录大部分文件是实施计划或历史设计，若与 ADR、schema 和当前代码冲突，以 ADR、schema 和当前实现为准。

已有数据发布必须先在旧 schema 上运行 `npm run pm:task-access-preflight`，再执行 `npm run db:deploy`。迁移会归一化历史成员、回填 Task 关联 Segment 的 Participant、撤销旧项目角色、保存旧审批策略审计，并且自身不写通知。部署后在 `NOTIFICATION_DELIVERY_DISABLED=true` 的维护窗口先 dry-run、再执行 `npm run pm:repair-task-approval-notifications -- --apply`，冻结旧审批 outbox 并为待审批对象补建全局管理员通知。
