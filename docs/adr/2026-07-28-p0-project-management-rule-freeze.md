# ADR: P0 项目管理规则冻结与安全基线

> 状态（2026-08-01）：本文涉及资源冲突、冲突中心、投入比例、冲突通知或冲突扫描的设计已由“删除资源冲突与投入比例”决策取代，仅保留历史背景，不代表当前实现。

日期：2026-07-28

状态：Accepted

## 背景

旧项目管理运行时、专用 schema 和开发数据已经删除，`/progress` 当前仅保留重构占位页和旧地址安全重定向。后续 v2.1 实现必须从空项目管理数据集开始，同时保护仍在运行的采购、反馈、用户、附件、通知 outbox 和飞书 CardKit 跟踪数据。

上游《项目管理系统设计 v2.1》中的 Project、邮箱账号、密码登录和项目管理邮件通知设定已被后续产品决策覆盖。本 ADR 冻结 P0 阶段必须遵守的产品规则、安全边界和默认值，作为 P1 schema、授权、通知和 UI 实现的输入。

## 决策

1. 新项目管理不保留 Project 实体，所有执行对象统一为 Task，分类只使用 Tag。
2. 不导入旧 Project、旧 Task、Stage、审批、周报、风险、评论、关注、提醒或旧附件关系，不增加 `legacySource*`、迁移映射表、`migrationNeedsReview` 或 `legacy-import` Tag。
3. Revision 默认策略为 `REVIEW_REQUIRED`。Task 级策略后续可以支持 `DIRECT_BY_OWNER`，但默认必须走复核。
4. Task 默认只对 Task 成员、范围内 Team Administrator、System Administrator 和授权 Auditor 可见。Tag 不扩大或缩小 Task 可见性。
5. 默认禁止提交人自审 Milestone Review 或 Revision。只有 System Administrator 可在 Task 策略中显式开启 `allowSelfReview`，并必须写审计。
6. Task 组织范围使用独立 `team + techGroup` 字段，复用现有采购组织值；该范围独立于 Tag。
7. 项目管理业务时区冻结为 `Asia/Shanghai`。cron 业务日期、临期/逾期 event key、UAT 日期和发布报告中的业务日期都按该时区解释；数据库仍存 UTC。
8. 项目管理通知首发只支持站内和飞书。飞书只能通过 notification outbox、项目管理 channel adapter 和统一私信传输层投递；项目管理 action/service 不得直接导入飞书发送层。
9. P0 不新增项目管理运行时代码、不改 Prisma schema、不替换 `/progress` 占位页。

## 影响

- P1 schema 直接设计 Task、Tag、TaskMember、Plan Version、Node、Review、Segment、Conflict、InAppNotification、Audit、Account/Person，不设计 Project 表或旧数据迁移表。
- 授权骨架必须从第一版实现 `readableWhere` 和单一 `authorize` 入口，不能先做全员可见再补权限。
- 发布和回归必须把采购、反馈、`User`、`UserRole`、`FileAsset`、`NotificationOutbox`、`NotificationOutboxRecipient`、`ProcurementFeishuCard` 作为共享保护基线。
- 任何改变本 ADR 的请求必须新增 ADR，更新 schema、WBS、测试和发布方案，并由 BO/TL/QA/DBA/SEC 共同确认。

## 验证

- `npm run pm:p0-baseline` 输出共享表行数、稳定 hash、外键清单和旧项目管理残留检查；`Task` 残留按旧字段签名识别，旧 enum 残留按旧特征值集合识别，避免 P1 新对象误报。
- `npm run check` 必须通过。
- `tests/feishu-boundaries.spec.ts` 必须继续证明飞书 IM/CardKit/Webhook 边界和项目管理入口不直接依赖飞书传输层。
- `tests/legacy-project-management-migration.spec.ts` 必须继续证明旧项目管理 schema/数据删除且共享数据保留。
