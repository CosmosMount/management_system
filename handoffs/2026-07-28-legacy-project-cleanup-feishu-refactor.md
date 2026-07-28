# 旧项目管理清理与飞书发送层重构 Handoff

日期：2026-07-28

工作区：`/home/pnx/code/management_system_dev`

状态：实现完成，数据库已应用，完整检查与双端 E2E 已通过，最终独立复审无 actionable findings。

## 1. 任务边界与最终结果

本阶段用于给 `rm_management` 的新项目管理实现腾出干净基线。按开发环境不可逆清理的明确授权，旧项目、阶段、任务、审批、周报、风险、评论、关注、模板和提醒实现及其开发数据已删除，不提供数据迁移或兼容入口。

保留并重构了共享飞书通知基础设施。采购和反馈继续使用原有 enqueue façade，但内部已经切换为 notification outbox、业务 channel adapter 和统一私信 transport。新项目管理业务与通知事件、卡片内容不在本阶段定义。

最终可见行为：

- `/progress` 是中文“项目管理正在重构”占位页。
- 任意旧 `/progress/*` 地址由 catch-all 路由重定向到 `/progress`。
- 首页仍保留项目管理入口，便于新版后续复用；入口不再暴露旧功能。
- 管理员、个人中心、实时刷新、cron、路由和权限代码不再查询或展示旧项目管理数据。
- 采购、反馈、用户、附件、预算、飞书 CardKit 跟踪和通知 outbox 等共享功能继续保留。

## 2. 旧实现删除范围

主要删除范围如下：

- `app/actions/progress/` 下全部旧项目管理 server actions。
- `app/progress/` 下旧项目、任务、审批、归档、看板、列表和新建页面；只保留新占位页和 catch-all 重定向。
- `components/progress/` 下全部旧项目管理组件。
- `lib/progress-*`、`lib/permissions-progress.ts`、`lib/import-progress-tasks.ts`、`lib/validations/progress.ts` 等旧领域、权限、导入和校验代码。
- `lib/feishu-progress.ts` 及其中旧项目管理事件、payload、收件人规则和卡片模板。
- 旧项目管理专项测试，包括审批、评论、关注、通知、阶段负责人和任务导入测试。
- 旧项目管理 seed、去重、补数和维护脚本及对应 npm scripts。
- 旧管理员验收清单、项目模板和提醒页面与组件。
- `docs/project_management/` 中描述已删除实现的旧文档；该目录 README 现只说明下线状态。

关联清理包括：

- 从管理员角色与客户端权限中删除 `PROJECT_MANAGER`。
- 从首页、Header、管理员页、个人中心和管理员删除工具中移除旧记录入口。
- 从 live-version 轮询和 cron 中移除项目管理刷新、提醒和日报分支。
- 删除旧 `PROGRESS_*` 环境变量及 Docker 映射。
- 修订业务流程、fixture、smoke 和安全测试，不再创建旧项目管理记录。

## 3. 路由实现

关键文件：

- `app/progress/page.tsx`：中文占位页，明确旧项目、阶段和任务功能已下线。
- `app/progress/[...legacy]/page.tsx`：对所有旧子路由执行服务端 `redirect(routes.progress.root)`。
- `lib/routes.ts`：只保留新的项目管理根入口。

生产构建的路由表中存在且仅存在项目管理根入口与统一旧路由接收器：

```text
/progress
/progress/[...legacy]
```

## 4. 数据库收缩

### 4.1 Schema 与 migration

关键文件：

- `prisma/schema.prisma`
- `prisma/migrations/20260728210000_remove_legacy_project_management/migration.sql`
- `tests/legacy-project-management-migration.spec.ts`

收缩 migration 执行以下操作：

1. 删除 `NotificationOutbox.channel = 'progress'` 的旧通知；收件人记录通过外键级联删除。
2. 删除 `UserRole.role = 'PROJECT_MANAGER'` 数据。
3. 删除全部旧 `Project` / `ProjectStage` / `Task` / 审批 / 周报 / 风险 / 评论 / 关注 / 模板 / 提醒表，以及废弃开发实现的 `Pm*` 表。
4. 重建 `UserRoleType`，删除 `PROJECT_MANAGER` enum 值并保留共享角色。
5. 删除全部旧项目管理 enum。
6. 使用顶层 `BEGIN` / `COMMIT` 包裹整个收缩，防止 enum 重建或批量删除中断后留下半完成 schema。

既有 migration 历史没有被改写；上述文件是本次新增的第 34 个 migration。开发库已部署，无待应用 migration。

保留的共享数据模型包括：

- 用户、会话、OAuth 身份和共享角色。
- 采购、采购明细、预算池、报销记录和采购附件。
- 反馈、反馈回复和反馈附件。
- `NotificationOutbox`、`NotificationOutboxRecipient`。
- 飞书卡片跟踪和 CardKit sequence 数据。

### 4.2 开发库实际核验

最终只读核验结果：

```json
{"legacyTableCount":0,"users":68,"orders":9,"feedback":3,"progressOutbox":0}
```

这说明抽样核验的旧表已不存在，旧 progress outbox 已清空，而共享用户、采购和反馈记录仍在。

## 5. 统一飞书私信传输层

### 5.1 接口

新入口位于 `lib/feishu-message.ts`：

```ts
sendFeishuDirectMessage({
  recipientOpenId,
  botKind,
  purpose,
  message,
  logContext,
  deliveryOptions,
})
```

`FeishuMessage` 支持：

- `text`
- 普通 `interactive` 卡片
- `cardkit` 卡片

发送结果为明确的判别联合：

- `status: "sent"`：返回实际 `botKind`、`receiveId`、`receiveIdType`、`fallbackUsed`，CardKit 可额外返回 `cardId`。
- `status: "skipped"`：当前原因是 `delivery_disabled` 或 `recipient_not_allowed`。

`logContext` 只接收 action、channel、event key、entity type/id 等安全元数据，不接收完整业务 payload。

### 5.2 transport 责任

统一私信层负责：

- 在凭据解析和 HTTP 前检查 `NOTIFICATION_DELIVERY_DISABLED`。
- 检查姓名、`open_id`、`union_id` allowlist。
- 按机器人解析 `open_id` 或 `union_id` 收件目标。
- 获取对应 tenant access token。
- 发送文本、普通交互卡片或 CardKit 实例消息。
- 返回实际路由和 fallback 结果。
- 使用结构化 logger，并将远端 token、IM、CardKit 错误压缩为安全 code/status，避免敏感响应进入日志或 outbox `lastError`。

飞书 API 边界保持分离：

- IM message endpoint 只能出现在 `lib/feishu-message.ts`。
- CardKit endpoint 只能出现在 `lib/feishu-cardkit.ts`。
- Webhook `fetch` 只能出现在 `lib/feishu-webhook.ts`。
- 静态回归门禁扫描 `app/`、`components/`、`lib/`、`scripts/`。

Webhook 仍是独立传输方式，不混入 `sendFeishuDirectMessage()`。

### 5.3 机器人路由

- 普通状态通知、提醒和反馈必须指定通知机器人，不能选择审批机器人。
- 只有 `purpose: "approval_request"` 的审批请求允许指定审批机器人。
- 未配置独立审批机器人时，审批路由沿用通知机器人凭据。
- 配置独立审批机器人时，收件人按 `union_id` 发送；缺少 `union_id` 会失败，交由 outbox 重试。
- 飞书明确返回“机器人对该用户不可用”时，审批消息可回退通知机器人；结果会记录实际机器人与 `fallbackUsed: true`。
- 普通通知绝不会回退到审批机器人。

## 6. Notification outbox 与 channel adapters

### 6.1 数据流

```text
业务事务
  -> enqueueNotificationTx / 现有采购或反馈 enqueue façade
  -> NotificationOutbox（稳定 event key）
  -> outbox drain / 收件人级投递状态
  -> channel adapter
       - 校验持久化 payload、type、botKind
       - 解析和去重收件人
       - 生成完整业务消息/卡片
       - 明确选择机器人和 purpose
  -> sendFeishuDirectMessage 或独立 Webhook transport
  -> sent / skipped / retry / terminal failure
```

新增模块：

- `lib/notification-channels/types.ts`
- `lib/notification-channels/index.ts`
- `lib/notification-channels/procurement.ts`
- `lib/notification-channels/feedback.ts`

`NotificationChannelAdapter` 提供收件人计划解析、按收件人发送、组合发送和可选投递前处理。未知 channel、无效 payload、损坏的 type/botKind 和不合法机器人选择使用 `NonRetryableNotificationError` 终止，避免无意义重试。

### 6.2 保留并加固的 outbox 行为

`lib/notification-outbox.ts` 继续保留：

- event key 幂等。
- outbox 级和收件人级状态。
- 锁、过期锁恢复、退避和最大重试。
- 单个收件人失败不会让已成功收件人重复发送。
- 首次收件人解析临时失败后可恢复重试。
- 收件人重试耗尽时同步冻结父 outbox。
- 未知 channel 和确定性配置错误立即终止。
- delivery disabled 安全闸。

采购审批还增加了约束：必须解析出真实私信审批人；群 Webhook 不能单独把审批 outbox 标为成功。采购 CardKit 仍由采购领域维护卡片跟踪记录和 sequence，transport 返回的实际 `cardId` 与 fallback 机器人会写入跟踪。

采购、采购催办和反馈现有 enqueue façade 签名保持不变，调用方无需大范围修改。

## 7. 新项目管理接入约束

后续实现新项目管理时必须遵守：

1. 在业务数据库事务中调用 `enqueueNotificationTx()`，使用稳定、可重放的 event key。
2. 新增自己的 channel adapter，并在 `lib/notification-channels/index.ts` 注册。
3. adapter 持有 payload schema、收件人规则、卡片/文本内容、机器人和 purpose 选择。
4. 项目管理 action、route handler 和领域服务不得直接导入 `lib/feishu-message.ts`，也不得直接调用飞书 IM/CardKit/Webhook endpoint。
5. 普通通知只能使用通知机器人；审批请求才可使用审批机器人。
6. 不得恢复任何旧 `ProgressNotifyPayload`、旧 progress 事件 key、旧卡片模板或旧收件人规则。
7. 新事件、状态机、收件人和消息内容必须在后续业务实现阶段单独定义和测试。

## 8. 配置与安全默认值

保留配置：

- OAuth 主应用：`FEISHU_APP_ID`、`FEISHU_APP_SECRET`。
- 通知机器人：`FEISHU_NOTIFICATION_APP_ID`、`FEISHU_NOTIFICATION_APP_SECRET`。
- 审批机器人：`FEISHU_APPROVAL_APP_ID`、`FEISHU_APPROVAL_APP_SECRET`。
- OAuth、事件回调、长连接相关配置。
- 飞书姓名/open ID/union ID allowlist。
- `NOTIFICATION_DELIVERY_DISABLED`。
- `CONFIRM_SEND_FEISHU`。

`.env.example` 和 Docker Compose 默认 `NOTIFICATION_DELIVERY_DISABLED=true`。自动化测试启动器会强制禁发，即使外部环境误设也不会真实投递。人工调试脚本仍需同时满足显式 `CONFIRM_SEND_FEISHU=true`、禁发规则和 allowlist；生产启用真实投递必须显式确认环境配置。

## 9. 文档更新

已更新：

- `README.md`
- `docs/TECH.md`
- `docs/TESTING.md`
- `docs/NOTIFICATIONS.md`
- `docs/FULL_FUNCTIONAL_TEST_PLAN.md`
- `docs/plan/README.md` 及 `docs/plan/00` 至 `14`
- `docs/project_management/README.md`

`docs/plan` 现在统一以“旧项目管理数据已直接删除”为基线，不再规划旧 Project/Task 数据迁移、legacy source 映射或兼容层；同时记录新项目管理必须通过 adapter/outbox 使用统一飞书 transport。新项目管理事件和卡片仍明确留待后续阶段。

## 10. 测试与实际结果

### 10.1 最终必需验证

```text
npm run check
  PASS
  包含 prisma validate、应用 TypeScript、脚本 TypeScript、全量 ESLint、git diff --check

npm run build
  PASS
  Next.js 生产构建成功；17 个静态页面生成完成；路由边界正确

npm run db:deploy
  PASS
  PostgreSQL ready；34 migrations；No pending migrations to apply

npm run test:e2e
  PASS
  222 tests：192 passed，30 skipped，0 failed，耗时 3.1m
  桌面 1440x1000 与 Pixel 5 均执行
```

30 个 skip 是依赖外部 authenticated/privileged storage state 的可选 smoke；其余全部通过。完整 E2E 启动日志明确记录 `notificationDeliveryDisabled: true`，没有真实飞书投递。

### 10.2 定向回归

```text
npm run test:e2e -- tests/feishu-message.spec.ts tests/notification-outbox-adapters.spec.ts
  46 passed

npm run test:e2e -- tests/legacy-project-management-migration.spec.ts
  4 passed（桌面 + Pixel 5；在 pg Client/SQL splitter 和顶层事务最终修改后复跑）

npm run test:e2e -- tests/feishu-boundaries.spec.ts
  4 passed（桌面 + Pixel 5；在扫描范围扩展到 app/components 后复跑）

npm run typecheck
  PASS

npx eslint tests/legacy-project-management-migration.spec.ts --max-warnings=0
  PASS
```

migration 回归使用隔离 PostgreSQL 测试数据库，加载真实前置 migration 链，并验证旧对象/数据删除以及共享用户、采购、反馈、附件、outbox 和卡片数据保留。

### 10.3 最终残留与边界扫描

旧符号扫描只命中 migration 回归 fixture 中用于验证删除的 `PROJECT_MANAGER`；应用源码无残留：

```text
ProgressNotifyPayload
sendProgressNotification*
resolveProgressBotKind
enqueueProgressNotification*
PROJECT_MANAGER
```

飞书 endpoint 最终分布：

```text
lib/feishu-message.ts   -> /open-apis/im/v1/messages
lib/feishu-cardkit.ts   -> /open-apis/cardkit/v1/cards
lib/feishu-webhook.ts   -> fetch(webhookUrl)
```

`channel = "progress"` 只存在于 migration 回归断言/fixture，不存在于运行时代码。

## 11. 独立复审与闭环项

最终 reviewer 结论：`No actionable findings`。

多轮自审和独立复审推动并确认了以下修复：

- `.env.example` 与 Docker 的 delivery disabled 安全默认值。
- 临时收件人解析失败可恢复，过期 outbox/收件人锁可恢复。
- 未知 channel、无效 payload、损坏 type/botKind、错误机器人配置转为确定性终止。
- 审批通知必须存在真实私信收件人，Webhook 不能伪装成功。
- 收件人重试耗尽时同步冻结父 outbox。
- IM、CardKit、token/auth 远端错误和 outbox `lastError` 脱敏。
- 采购审批完整卡片、机器人路由与 fallback CardKit tracking。
- 全量 fixture allowlist 动态包含测试超级管理员，避免测试顺序依赖。
- migration 测试从系统 `psql` 改为现有 `pg` Client，数据库 URL 不再出现在子进程参数。
- `splitPostgresStatements()` 支持单/双引号、行/块注释和 PostgreSQL dollar-quoted `DO $$` block。
- migration 加入顶层 `BEGIN/COMMIT`，收缩过程具备原子性。
- 飞书 API 静态边界扫描扩展到 `app/`、`components/`、`lib/` 和 `scripts/`。

reviewer 最终只读复核通过 Prisma validate、应用/脚本 TypeScript、全量 ESLint 和 `git diff --check`。

## 12. `.next` 缓存说明

Playwright/Next dev 服务退出时偶发留下截断的 `.next/dev/types/validator.ts`，表现为：

```text
.next/dev/types/validator.ts TS1109 / TS1434
```

这是 Next 生成缓存，不是源码错误。处理方式是把整份 `.next` 移到 `/tmp` 留档后重新执行检查。此次与此前保留的缓存备份：

```text
/tmp/management-system-next-check-XVK5Ho/.next
/tmp/management-system-next-final-6qdTXe/.next
/tmp/management_system_dev-next-stale-20260728
/tmp/management-system-next-finalcheck-xi9rDh/.next
/tmp/management-system-next-handoffcheck-eet1z1/.next
```

不要把这些缓存恢复到工作区；若以后再次出现同样的生成文件截断，移动新的 `.next` 后重跑即可。

## 13. 剩余风险与后续工作

- 新项目管理领域模型、状态机、权限、事件、收件人和飞书卡片尚未实现，这是本阶段有意保留的后续工作，不是遗留兼容缺口。
- 旧项目管理数据已不可逆删除；需要恢复时只能使用任务执行前的数据库备份，不存在应用级回滚或兼容读取路径。
- 自动化验证覆盖禁发、mock HTTP、allowlist 和路由逻辑，但没有向真实飞书用户发送消息。首次生产启用应使用最小 allowlist、小范围审批人和明确的 delivery 开关做人工验证。
- 30 个 authenticated smoke 依赖外部 storage state；本轮主业务 E2E 已通过受控 fixture 覆盖，若需要额外 smoke，应在隔离测试环境提供对应 storage state。
- `.next` 截断是工具生成缓存问题，可能在 Playwright/Next dev 异常结束后再次出现，按上一节处理。

## 14. 关键文件索引

新增或重点修改：

- `app/progress/page.tsx`
- `app/progress/[...legacy]/page.tsx`
- `lib/feishu-message.ts`
- `lib/feishu-auth.ts`
- `lib/feishu-cardkit.ts`
- `lib/feishu-procurement-card-sync.ts`
- `lib/feishu-feedback.ts`
- `lib/notification-outbox.ts`
- `lib/notification-channels/index.ts`
- `lib/notification-channels/types.ts`
- `lib/notification-channels/procurement.ts`
- `lib/notification-channels/feedback.ts`
- `prisma/schema.prisma`
- `prisma/migrations/20260728210000_remove_legacy_project_management/migration.sql`
- `tests/feishu-message.spec.ts`
- `tests/notification-outbox-adapters.spec.ts`
- `tests/feishu-boundaries.spec.ts`
- `tests/legacy-project-management-migration.spec.ts`
- `.env.example`
- `docker-compose.yml`
- `README.md`
- `docs/TECH.md`
- `docs/TESTING.md`
- `docs/NOTIFICATIONS.md`
- `docs/FULL_FUNCTIONAL_TEST_PLAN.md`
- `docs/plan/`

接手时应保留当前 dirty worktree；这些修改均属于本任务，不要回滚或清理。
