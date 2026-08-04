# Revision 时间标记与候选计划状态机

日期：2026-08-04

状态：Accepted

本文取代 2026-08-03 Task 全员可见 ADR 中关于 Revision 草稿、编辑和单独提交动作的描述；成员可见性、审批角色和 Milestone 审批规则保持不变。

## 决策

Revision 是 Current Plan 上用户选择时间的事件标记，表示 Task 在该时刻发生过计划变化。它不形成新的阶段边界，不接受 Work Segment 关联，也没有 Milestone 式提交或完成流程。

Revision 创建时携带完整候选计划并直接进入 `PENDING_APPROVAL`。被驳回后保留候选版本，负责人或原创建人修改时递增 `reviewRound`、清除上一轮审批结果并直接重新送审。允许的状态转换为：

`PENDING_APPROVAL → EFFECTIVE | REJECTED | CANCELLED`

`REJECTED → PENDING_APPROVAL | CANCELLED`

每个 Task 最多存在一个 `status=DRAFT` 的 Revision 候选计划；取消时候选计划转为 `ABANDONED`，批准时原子切换为 `CURRENT`。

## 时间与计划

- `revisionAt` 必须位于 Current Start 与 Candidate Terminal 之间，不早于最后完成 Milestone，也不早于上一条已生效 Revision；所有边界允许相等。
- Revision 时间不参与 Milestone 严格递增，不限制未完成计划的替换范围，也不切割 TimeCanvas 阶段带。
- Candidate Start 固定沿用 Current Start。服务端保留全部已完成 Milestone 和已生效 Revision，并用请求中的完整后续 Milestone 与 Terminal 重建未完成部分。
- 待审批或被驳回 Revision 只进入历史；批准后 Revision 标记及候选计划才进入正式时间轴。

## 并发、审计与通知

创建、重新送审和审批均锁定 Task 行。数据库 partial unique index 作为单候选的最终约束。审计事件为 `pm.revision.create/resubmit/reject/cancel/apply`，不再存在 `pm.revision.submit`。

创建和重新送审使用审批机器人发送 `revision_pending_review`；事件键包含 `revisionId + reviewRound`。驳回结果键同样包含 round，保证每轮 exactly once。没有可用全局审批人时整个业务事务回滚。

## 迁移

迁移仅支持 `RevisionNode` 为空的环境。发现旧 Revision 数据时必须在删除字段和状态前 fail-fast，不静默删除或猜测历史转换。迁移增加 `revisionAt/reviewRound`，删除 `revisedFromNodeId/submittedAt` 与 `DRAFT` Revision 状态，并增加每 Task 单候选索引。
