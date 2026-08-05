# ADR: 删除 Work Segment 职责与 Task Node 关联

日期：2026-08-05

状态：Accepted

## 决策

Work Segment 只保留可空的 `taskId`，不再保存职责、`TaskNode` 关联或关联复核状态。重关联 action、Node 过滤、Revision 生效后的关联失效处理及其通知全部删除；旧输入由 strict 服务端校验拒绝，不提供兼容读取。

迁移永久删除现有职责与 Node 关联数据、`RELINK` 和关联失效历史、站内通知及 outbox。普通 Segment 历史中与其他业务行为共同存在的快照继续保留，但会永久移除已删除字段。

Task、TaskNode、Milestone、Revision、Termination 和 Task Composer 节点编辑不受影响。Task 关联 Segment 仍必须满足成员和权限规则，并继续通过 Task 行锁保证并发一致性。

TimeCanvas 的当前时间改用客户端实时钟；空白时间行的短拖或点击按最小吸附区间创建，并保留虚线选区直到创建成功或取消。
