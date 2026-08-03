# ADR: 移除账号级项目访问状态

日期：2026-08-04

状态：Accepted

## 背景

Task 已采用全员可见、按成员控制写入的模型。继续保留 `Account.projectAccessStatus` 会形成独立于登录、Task 成员和全局角色之外的第四套项目入口开关，并使读取、审批收件人和永久管理员门禁继续依赖已经不需要的账号状态。

本 ADR 取代 [Task 全员可见、双成员角色与全局管理员审批](./2026-08-03-task-global-visibility-participants-admin-approval.md) 中关于账号启用/禁用、`projectAccessStatus=ACTIVE` 读取边界和账号状态门禁的部分；该 ADR 的成员、写权限和管理员审批规则继续有效。

## 决策

- 删除 `Account.projectAccessStatus` 和数据库枚举 `AccountStatus`，不提供替代的项目访问禁用字段、页面或 server action。
- 所有已登录并成功解析到统一 `Account/Person` 的账号都可进入项目管理、读取全部未删除 Task/计划/验收/审计/Segment，并可创建合法 Task。
- Task 写权限仍只由有效 `OWNER/PARTICIPANT`、两类全局管理员、业务状态机和服务端 capability 决定；删除账号状态不扩大非成员写权限。
- 历史 `DISABLED` 账号恢复项目入口。迁移为这些账号追加 `source=MIGRATION` 的审计事件，但不创建站内通知或飞书 outbox。
- 全局审批管理员收件人只按有效全局角色和 default tenant 非空飞书 `openId` 解析，不再过滤账号状态。
- 存在 Task 数据时，永久数据库门禁仍要求至少一名飞书可达的全局管理员。门禁继续覆盖首个 Task、账号删除、飞书身份和全局角色写入，但移除 Account 状态更新触发器及函数中的旧字段引用。
- 采购报销角色、审批流程、通知机器人路由和 Person 的在职/停用业务状态不受影响。

## 迁移与发布

- `20260803185000_prepare_global_administrator_guard_for_project_access_removal` 在锁定相关表后先重写永久管理员门禁并删除账号状态更新触发器。
- `20260803190000_remove_project_access_status` 记录历史禁用账号审计，再删除列和枚举；两个 migration 均不产生通知副作用。
- 旧应用仍读取已删除列，因此必须在受控维护窗口停止旧 Web、cron 和飞书 WS 进程，部署 schema 与新应用后再恢复服务。

## 验证

- 隔离 PostgreSQL 回归必须从完整前置 migration 链执行，验证历史禁用账号审计、列/枚举删除和通知/outbox 零增量。
- 迁移后必须保留六个管理员门禁，且 `assert_usable_global_approval_administrator_v2` 不得再引用 `projectAccessStatus`。
- 账号管理、项目授权、审批通知、人员与 Task 搜索以及桌面/移动 UI 都必须验证不存在账号状态入口或旧字段依赖。
