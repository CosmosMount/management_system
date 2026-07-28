# P0 规则冻结与安全基线 Handoff

日期：2026-07-28

工作区：`/home/pnx/code/management_system_dev`

状态：P0 规则冻结、安全基线和只读基线报告已实现；运行时和 Prisma schema 未变更。

## 1. 本阶段目标与边界

本阶段完成项目管理 v2.1 重构的 P0：冻结规则与安全基线，为后续 P1 schema、身份和授权骨架提供不可变输入。

本阶段没有实现新项目管理业务功能：

- 未新增 Prisma 模型或 migration。
- 未替换 `/progress` 占位页。
- 未新增项目管理 Server Action、领域 service 或 UI。
- 未触碰采购、反馈、附件、通知 outbox 或飞书发送运行时行为。

## 2. 阅读依据

已阅读并采用：

- `handoffs/2026-07-28-legacy-project-cleanup-feishu-refactor.md`
- `docs/plan/README.md` 和 `docs/plan/00` 至 `15`
- `docs/plan/management_plan/项目管理系统设计 v2.1.md`
- `prisma/schema.prisma`
- `tests/legacy-project-management-migration.spec.ts`
- `tests/feishu-boundaries.spec.ts`
- `lib/notification-outbox.ts`
- `lib/notification-channels/*`
- `lib/feishu-message.ts`

## 3. 冻结决策

正式 ADR：`docs/adr/2026-07-28-p0-project-management-rule-freeze.md`。

P0 冻结项：

- 不保留 Project 实体；执行对象统一为 Task，分类只使用 Tag。
- 不导入旧 Project/Task/Stage/审批/周报/风险等数据，不增加 `legacySource*`、迁移映射表或 legacy Tag。
- Revision 默认 `REVIEW_REQUIRED`。
- Task 默认只对成员、范围管理员、系统管理员和授权 Auditor 可见。
- 默认禁止提交人自审；`allowSelfReview` 只能由 System Administrator 显式开启并写审计。
- Task 组织范围使用独立 `team + techGroup` 字段，不从 Tag 继承。
- 业务时区冻结为 `Asia/Shanghai`；cron 业务日期、临期/逾期 event key、UAT 日期和发布报告业务日期按该时区解释，数据库仍存 UTC。
- 项目管理通知首发只支持站内和飞书；飞书只能通过 outbox、项目管理 adapter 和统一私信传输层。

`docs/plan/13-风险依赖与待确认决策.md` 已将 Q-001 至 Q-004、Q-008 转为 D-009 至 D-013。任何改变 D-001 至 D-013 的请求必须走 ADR 和变更控制。

## 4. 只读基线脚本

新增命令：

```bash
npm run pm:p0-baseline
```

脚本：`scripts/project-management-p0-baseline.ts`

行为：

- 只执行 SELECT 和 PostgreSQL metadata 查询。
- 输出 JSON，不打印 `DATABASE_URL`、openId 明文、姓名、文件路径明文或业务正文。
- 对共享表输出行数和脱敏稳定 hash。
- 检查旧表、旧 enum、`channel=progress` outbox、`PROJECT_MANAGER` 角色和 legacy 字段残留；`Task` 按旧字段签名判断，旧 enum 按旧特征值集合判断，避免 P1 新对象误报。
- 输出角色、outbox、文件类型、采购状态、反馈状态和 FK 摘要。

## 5. 基线报告摘要

最后一次执行：2026-07-28T11:46:24Z

```json
{
  "businessTimezone": "Asia/Shanghai",
  "database": "management_system_dev",
  "protectedTables": {
    "User": { "rowCount": 68, "stableHash": "4d616f7a7af2ae857edf178b131115fd" },
    "UserRole": { "rowCount": 37, "stableHash": "0bc92cc5e68a1e10bf5902da6d5d83d1" },
    "ProcurementBudgetPool": { "rowCount": 27, "stableHash": "6a63f104da00bffa15edfde6fd228209" },
    "PurchaseOrder": { "rowCount": 9, "stableHash": "880e19acd55cd5cefa8bc89ef33c41fc" },
    "PurchaseItem": { "rowCount": 37, "stableHash": "05d288b0a5df01f4164598d9b8de5234" },
    "ProcessingVendor": { "rowCount": 3, "stableHash": "eaabecfaac8dc82f8cf3bc0b578279e1" },
    "Feedback": { "rowCount": 3, "stableHash": "e3122be63580d4976e22685e83d81f00" },
    "FeedbackMessage": { "rowCount": 20, "stableHash": "aa64b5b9da44ccd6f8da026dc2be5979" },
    "FeedbackAttachment": { "rowCount": 3, "stableHash": "ccac8f930fbe1adfc06973e2816b9fb5" },
    "FileAsset": { "rowCount": 40, "stableHash": "b9afb4bf91397c5e2c084cc5de246b36" },
    "ProcurementFeishuCard": { "rowCount": 0, "stableHash": "" },
    "NotificationOutbox": { "rowCount": 112, "stableHash": "31df2fcfe9ecb9bfecc022899faea179" },
    "NotificationOutboxRecipient": { "rowCount": 91, "stableHash": "39079ce9f6caa0aaccd485d6be2d8532" }
  },
  "summaries": {
    "userRoles": "FINANCE=1, SUPER_ADMIN=17, TEACHER=1, TEAM_ADMIN=12, TECH_GROUP_ADMIN=6",
    "outbox": "feedback/SENT=20, procurement/FAILED=2, procurement/SENT=90",
    "fileAssets": "FEEDBACK_ATTACHMENT=3, ORDER_ATTACHMENT=26, ORDER_ITEM_IMAGE=4, USER_SIGNATURE=7",
    "purchaseOrders": "COMPLETED=4, DRAFT=1, MANAGEMENT_REVIEW=1, PENDING_FINANCE_REVIEW=3",
    "feedback": "OPEN=3"
  },
  "safetyChecks": {
    "legacyTableCount": 0,
    "legacyTableFindings": [],
    "legacyEnumCount": 0,
    "legacyEnumFindings": [],
    "progressOutboxRows": 0,
    "projectManagerRoleRows": 0,
    "forbiddenLegacyColumns": 0
  },
  "foreignKeys": [
    "FeedbackAttachment.messageId -> FeedbackMessage.id ON DELETE CASCADE",
    "FeedbackMessage.feedbackId -> Feedback.id ON DELETE CASCADE",
    "NotificationOutboxRecipient.outboxId -> NotificationOutbox.id ON DELETE CASCADE",
    "PurchaseItem.orderId -> PurchaseOrder.id ON DELETE CASCADE",
    "PurchaseOrder.initiatorId -> User.id ON DELETE RESTRICT"
  ]
}
```

## 6. 变更文件

新增：

- `docs/adr/2026-07-28-p0-project-management-rule-freeze.md`
- `docs/plan/15-P0规则冻结与安全基线关单.md`
- `scripts/project-management-p0-baseline.ts`
- `handoffs/2026-07-28-p0-rule-freeze-safety-baseline.md`

修改：

- `package.json`
- `docs/plan/README.md`
- `docs/plan/03-领域规则与状态机.md`
- `docs/plan/04-数据库设计与迁移映射.md`
- `docs/plan/08-通知定时任务与外部集成.md`
- `docs/plan/13-风险依赖与待确认决策.md`
- `tests/feishu-boundaries.spec.ts`
- `tests/legacy-project-management-migration.spec.ts`

## 7. 验证记录

已执行：

```text
npm run pm:p0-baseline
  PASS
  旧表/旧 Task 签名/旧 enum 签名/Pm enum/progress outbox/PROJECT_MANAGER/legacy 字段残留均为 0。

npm run check
  PASS
  包含 prisma validate、应用 TypeScript、脚本 TypeScript、ESLint 和 git diff --check。
  复验前曾遇到 `.next/dev/types/validator.ts` 生成缓存坏行；已用 `npx next typegen` 刷新类型并移除该生成缓存文件后通过，仓库源码未为此变更。

npm run test:e2e -- tests/feishu-boundaries.spec.ts tests/legacy-project-management-migration.spec.ts
  PASS
  8 passed，桌面和 Pixel 5 均执行。

npm run test:e2e
  PASS
  192 passed，30 skipped，0 failed，耗时约 2.8m。
  skip 为依赖外部 authenticated/privileged storage state 的 smoke。
  启动日志显示 notificationDeliveryDisabled=true，没有真实飞书投递。
```

第二轮 reviewer findings 修复后已重新保留最终命令结果；若后续修改可执行代码或测试，应同步更新本节。

## 8. 独立审查

第一轮独立只读审查发现 5 项：

1. 缺少 P0 handoff。
2. `docs/plan/13` 仍把 P0 冻结项描述为可调整默认值。
3. `docs/plan/03` 仍提到旧记录迁入新对象。
4. P0 关单只记录行数，缺少 stable hash/FK 摘要。
5. 飞书边界测试只扫描 `app/`，未覆盖未来项目管理 service 路径。

已处理：

- 新增本 handoff。
- 将 Q-001 至 Q-004、Q-008 转为 D-009 至 D-013，并要求走变更控制。
- 修正旧数据迁移表述为“不得导入、映射或回填”。
- 在 P0 关单和 handoff 写入 stable hash、汇总和 FK 摘要。
- 扩展 `tests/feishu-boundaries.spec.ts`，扫描 `app/progress`、`app/actions/project-management`、`components/project-management`、`lib/project-management`。

第二轮独立只读审查发现 2 项：

1. `pm:p0-baseline` 直接把表名 `Task` 当旧表，P1 新 `Task` 表会误报。
2. 飞书边界测试只匹配 `@/lib/feishu-message` 精确导入，不能覆盖相对路径或其他直接传输入口。

已处理：

- 基线脚本改为通过旧 `Task` 字段签名识别残留，允许 P1 新 `Task` 表作为全新 schema 存在。
- `tests/legacy-project-management-migration.spec.ts` 同步改为旧 `Task` 字段签名断言。
- `tests/feishu-boundaries.spec.ts` 改为解析 import specifier，覆盖 alias、相对路径、`lib/feishu` facade、message/webhook/cardkit/procurement card sync 传输入口，并额外拦截直接发送符号。

复验命令见第 7 节。第二轮可行动问题已关闭，最终剩余风险见第 9 节。

第三轮独立只读审查发现 2 项：

1. `docs/plan/04` 仍使用非冻结的 scope 字段命名，与 P0 冻结的 `team + techGroup` 字段不一致。
2. `docs/plan/03` 仍写 Revision 默认可被全局配置，容易误读为全局默认可改。

已处理：

- `docs/plan/04` 统一为 `team/techGroup`，并注明复用现有采购组织值。
- `docs/plan/03` 明确系统默认固定为 `REVIEW_REQUIRED`，`DIRECT_BY_OWNER` 只能作为 Task 策略显式配置，改变全局默认必须走 ADR 和变更控制。

第四轮独立只读审查发现 2 项：

1. `pm:p0-baseline` 按 enum 名称检测旧残留，P1 新 `TaskStatus` 等自然命名 enum 可能误报。
2. 飞书边界测试未覆盖计划中的 `lib/notification-channels/project-management` adapter 路径。

已处理：

- 基线脚本改为对自然命名旧 enum 使用旧特征值集合检测，`Pm*` enum 仍作为废弃开发实现残留直接拦截。
- `tests/feishu-boundaries.spec.ts` 增加未来项目管理 notification channel adapter 文件和目录扫描，并支持待扫描路径为单个 `.ts/.tsx` 文件。

第五轮独立只读审查发现 1 项：

1. 旧 enum 签名清单未覆盖历史追加值和提前删除的 `TaskCategory`，精确相等匹配可能漏报完整历史旧 enum。

已处理：

- 旧 enum 检测改为“旧特征值集合是实际 enum 值集合的子集”，可覆盖追加过值的旧 enum。
- 补入 `TaskCategory` 旧特征值签名。

第六轮独立只读复审结论：

- No actionable findings。
- reviewer 确认最新 diff 无 `prisma/schema.prisma`、migration、`app/`、`lib/`、`components/` 运行时改动。
- reviewer 确认 P0 冻结项、baseline enum/Task 签名检测、Feishu 边界路径和本 handoff 闭环已对齐。

## 9. 剩余风险与 P1 接手条件

剩余风险：

- P0 使用当前开发库作为只读基线，不替代 P7/P8 的生产快照演练、恢复演练或发布报告。
- P1 尚未实现 Account/Person、Task、权限和站内通知；P0 只冻结规则。
- `ProcurementFeishuCard` 当前行数为 0；后续如果采购卡片跟踪数据存在，P7 对账必须按脚本输出重新记录。

P1 接手条件：

- 只能新增 migration，不编辑已应用 migration。
- 不读取、rename、drop 或回填旧项目管理表。
- 不创建 Project、legacy mapping、`legacySource*` 或 `legacy-import` Tag。
- Account/Person 初始化只能读取共享 `User`，不得改变采购 `User.openId/unionId` 语义。
- 授权骨架第一版必须包含允许和拒绝路径；不能先全员可见。
- 项目管理通知只能入队到独立 adapter，不得直接导入飞书发送层。
