# 项目管理文档状态

旧项目管理实现和开发数据已直接清理，本目录原有的项目、阶段、旧任务、审批、周报、风险和提醒说明已删除，以免继续被误认为当前行为。

当前状态：

- `/progress` 已开放新项目管理首批入口，包含我的工作总览、Task 列表/工作台、人员计划时间轴、资源冲突中心和站内通知中心。
- 当前系统不兼容旧项目管理接口或旧数据；旧 `/progress/task/:id` 会重定向到 `/progress/tasks/:id`，旧 `/progress/projects/*` 和 `/progress/kanban` 回到 `/progress`，其他未映射旧目录没有业务页面。
- 项目管理通知事件已使用 `channel=project-management` outbox、站内通知和飞书 adapter；项目管理领域服务仍不得直接调用飞书传输层。
- 新系统的目标方案见 [`../plan/README.md`](../plan/README.md)；该目录是实施计划，不等同于完整已实现功能说明。
