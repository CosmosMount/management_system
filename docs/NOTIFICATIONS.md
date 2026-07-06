# 消息发送矩阵

本文档描述当前系统在什么场景下发送什么消息、走哪个发送渠道、使用哪个飞书机器人、发给哪些人。维护通知相关代码时，请同步更新本文档和对应测试。

## 核心概念

| 概念 | 说明 |
|---|---|
| 业务通道 `channel` | `NotificationOutbox.channel` 的业务域，目前为 `progress`、`procurement`、`feedback`。 |
| 机器人 `botKind` | `notification` 为普通通知机器人；`approval` 只用于审批、验收、确认等待办消息。 |
| 私信 | 飞书 `im/v1/messages` 或 CardKit 私信，按用户 `open_id` 或 `union_id` 发送。 |
| 群 Webhook | 采购群摘要与采购日报使用 Webhook，不参与 `notification/approval` 私信分流。 |
| 邮件 | 老师审核采购时额外发送 SMTP 邮件，不属于飞书机器人。 |
| Outbox | `NotificationOutbox` 表示业务事件，`NotificationOutboxRecipient` 表示单个收件人投递状态。已成功收件人不会因其他人失败而重复发送。 |
| CardKit 回调 | 采购审批/确认卡片的按钮回调由飞书 WS worker 接收，回调处理不产生新通知，除非业务状态变更后重新入队。 |
| 进度关注 | 项目/任务关注只影响进度模块飞书推送收件人，不改变页面可见性、审批权限或审批看板。 |

机器人配置规则：

- 普通通知机器人：`FEISHU_NOTIFICATION_APP_ID / FEISHU_NOTIFICATION_APP_SECRET`；未配置时回退 `FEISHU_APP_ID / FEISHU_APP_SECRET`。
- 审批机器人：`FEISHU_APPROVAL_APP_ID / FEISHU_APPROVAL_APP_SECRET`；未配置时回退普通通知机器人。
- 独立审批机器人发送私信时优先使用 `union_id`。缺少 `union_id` 会导致审批私信失败并等待 outbox 重试；用户登录或通讯录同步可补齐。
- `FEISHU_DIRECT_MESSAGE_ALLOWED_NAMES / OPEN_IDS / UNION_IDS` 是真实投递安全栏；业务 payload 和 outbox 仍保留完整收件人列表，投递层再拦截不在 allowlist 的人。
- `NOTIFICATION_DELIVERY_DISABLED=true` 会阻止 outbox drain 和 `drainNotificationOutboxSoon()` 触发真实投递，也会让飞书群 Webhook 和 IM 素材上传在底层直接跳过 `fetch`。只有代码显式传入 bypass 且处于 Playwright 测试或 `CONFIRM_SEND_FEISHU=true` 人工确认场景，才允许越过这道禁发闸。

## 机器人路由

### 进度模块审批待办

以下 `ProgressNotifyPayload.type` 走审批机器人：

| 类型 | 含义 |
|---|---|
| `project_establishment_requested` | 项目立项待审批 |
| `stage_pending_acceptance` | 项目阶段待验收 |
| `project_stage_extension_requested` | 阶段延期待审批 |
| `project_stage_batch_due_change_requested` | 阶段批量提前/延期待审批 |
| `project_stage_due_change_requested` | 单阶段 DDL 修改待审批 |
| `task_ddl_change_requested` | 任务 DDL 修改待审批 |
| `task_delete_requested` | 任务删除待审批 |
| `task_creation_requested` | 新任务创建待审批 |
| `task_bulk_creation_requested` | 批量任务创建待审批 |
| `task_pending_acceptance` | 任务待验收 |

除上表外，进度模块其他消息都走普通通知机器人，包括审批通过/驳回结果、项目状态变化、任务指派/更新、风险、提醒。

### 采购模块审批待办

以下采购状态走审批机器人：

| 采购状态 | 含义 |
|---|---|
| `MANAGEMENT_REVIEW` | 管理审核 |
| `TEACHER_REVIEW` | 老师审核 |
| `PENDING_FINANCE_REVIEW` | 报销员审核/上传截图 |
| `PENDING_APPLICANT_CONFIRM` | 采购人确认报销 |

其他采购消息走普通通知机器人，包括驳回结果、退回草稿、要求重新提交凭证、预算预警、待上传凭证通知。

## 进度管理消息

实现入口主要在 `app/actions/progress/*`、`lib/feishu-progress.ts`、`lib/progress-reminders.ts`、`lib/notification-outbox.ts`。

进度模块通知会先计算业务候选收件人，再套用项目/任务关注偏好。普通动态候选人来自项目或任务的有效关注者；审批待办候选人只来自现有审批权限规则，再经过关注过滤。关注只影响飞书/outbox 私信，不影响页面可见性、审批权限或 `/progress/approvals` 审批看板。

项目默认关注人包括项目负责人、参与人、阶段负责人、项目下未删除任务负责人、项管、匹配车组组长、匹配技术组组长和超管。其中项管、匹配车组组长、匹配技术组组长、项目内成员不可取消关注；仅“与该项目没有直接关系的超管”等非强制身份可以取关。任务默认关注继承项目有效关注，并额外包含任务负责人、项目负责人、项管、匹配车组组长、匹配技术组组长和超管；任务负责人、项目负责人、项管、匹配车组组长、匹配技术组组长不可取消关注，其他人可自由关注/取关单个任务。

### 项目消息

| 场景 | 类型 | 机器人 | 渠道 | 收件人 |
|---|---|---|---|---|
| 提交立项或驳回后重提 | `project_establishment_requested` | 审批 | outbox 私信 | 匹配车组组长、匹配技术组组长、项管、超管；重提会额外尊重该项目已有关注偏好。 |
| 立项通过 | `project_establishment_approved` | 通知 | outbox 私信 | 申请人 + 项目有效关注者；申请人不会因取关漏收审批结果。 |
| 立项驳回 | `project_establishment_rejected` | 通知 | outbox 私信 | 申请人。 |
| 项目启动/完成/取消 | `project_started` / `project_completed` / `project_canceled` | 通知 | outbox 私信 | 项目有效关注者。 |
| 项目信息更新 | `project_updated` | 通知 | outbox 私信 | 新旧项目有效关注者合并去重。 |
| 项目流程回退 | `project_stage_rollback` | 通知 | outbox 私信 | 项目有效关注者。 |
| 项目评论发布 | `project_comment_created` | 通知 | outbox 私信 | 项目有效关注者，排除评论作者；评论发布时可选择自动关注项目，自动关注不额外发送确认通知。 |
| 关注/取消关注项目 | `project_followed` / `project_unfollowed` | 通知 | outbox 私信 | 仅操作人。 |

### 阶段消息

| 场景 | 类型 | 机器人 | 渠道 | 收件人 |
|---|---|---|---|---|
| 阶段提交验收 | `stage_pending_acceptance` | 审批 | outbox 私信 | 可审批人经过项目关注过滤；提交人仅在允许负责人自审且具备审批资格时收到。 |
| 阶段验收通过/驳回 | `stage_approved` / `stage_rejected` | 通知 | outbox 私信 | payload 显式收件人；缺省为阶段负责人。 |
| 阶段延期申请 | `project_stage_extension_requested` | 审批 | outbox 私信 | payload 显式审批人并排除申请人；缺省为项管、超管并排除申请人。 |
| 阶段批量提前/延期申请 | `project_stage_batch_due_change_requested` | 审批 | outbox 私信 | 可审批管理角色经过项目关注过滤，并排除申请人。 |
| 单阶段 DDL 修改申请 | `project_stage_due_change_requested` | 审批 | outbox 私信 | 可审批项目负责人/项管/超管经过项目关注过滤，并排除申请人。 |
| 阶段 DDL/延期申请通过或驳回 | `project_stage_extension_approved` / `project_stage_extension_rejected` / `project_stage_batch_due_change_approved` / `project_stage_batch_due_change_rejected` / `project_stage_due_change_approved` / `project_stage_due_change_rejected` | 通知 | outbox 私信 | 申请人 + 项目有效关注者；申请人不会因取关漏收审批结果。 |
| 阶段风险新增/同步 | `project_stage_risk_synced` | 通知 | outbox 私信 | 项目负责人、项目参与人、阶段负责人、匹配车组组长、匹配技术组组长、项管、超管。 |
| 阶段风险取消 | `project_stage_risk_resolved` | 通知 | outbox 私信 | 与阶段风险新增相同，由 payload 固化。 |

### 任务消息

| 场景 | 类型 | 机器人 | 渠道 | 收件人 |
|---|---|---|---|---|
| 直接创建任务 | `task_assigned` | 通知 | outbox 私信 | payload 显式收件人；缺省为任务负责人。卡片包含阶段、负责人、技术组、紧急/重要、DDL、指标、说明、周报、线下确认、验收清单摘要。 |
| 关注/取消关注任务 | `task_followed` / `task_unfollowed` | 通知 | outbox 私信 | 仅操作人。 |
| 任务信息更新 | `task_updated` | 通知 | outbox 私信 | payload 显式收件人；缺省为新旧任务负责人、项目负责人、新旧 scope 下的车组组长/技术组组长、项管、超管。 |
| 任务重启 | `task_restarted` | 通知 | outbox 私信 | payload 显式收件人；缺省为任务负责人、项目负责人、匹配车组组长、匹配技术组组长、项管、超管。 |
| 任务 DDL 修改申请 | `task_ddl_change_requested` | 审批 | outbox 私信 | 可审批人经过任务关注过滤。 |
| 任务 DDL 修改通过/驳回 | `task_ddl_change_approved` / `task_ddl_change_rejected` | 通知 | outbox 私信 | 申请人 + 任务有效关注者；申请人不会因取关漏收审批结果。 |
| 任务删除申请 | `task_delete_requested` | 审批 | outbox 私信 | 可审批项目管理者经过任务关注过滤。 |
| 任务已删除 | `task_deleted` | 通知 | outbox 私信 | payload 显式收件人；缺省为任务负责人、项目负责人、匹配车组组长、匹配技术组组长、项管、超管。 |
| 任务删除驳回 | `task_delete_rejected` | 通知 | outbox 私信 | payload 显式收件人；缺省为申请人和任务负责人。 |
| 新任务申请 | `task_creation_requested` | 审批 | outbox 私信 | 可审批项目管理者经过任务关注过滤。 |
| 任务申请通过 | `task_creation_approved` | 通知 | outbox 私信 | payload 显式收件人；缺省为申请人、任务负责人、项目负责人、匹配车组组长、匹配技术组组长、项管、超管。 |
| 任务申请驳回 | `task_creation_rejected` | 通知 | outbox 私信 | payload 显式收件人，通常为申请人。 |
| 批量导入真实任务 | `task_bulk_imported` | 通知 | outbox 私信 | payload 显式收件人，通常为项目相关人和管理角色。 |
| 批量任务创建申请 | `task_bulk_creation_requested` | 审批 | outbox 私信 | 可审批项目管理者经过任务关注过滤。 |
| 任务提交验收 | `task_pending_acceptance` | 审批 | outbox 私信 | 可审批人经过任务关注过滤。 |
| 任务验收通过/驳回 | `task_approved` / `task_rejected` | 通知 | outbox 私信 | payload 显式收件人；缺省为任务负责人。 |
| 任务风险新增/同步 | `task_risk_synced` | 通知 | outbox 私信 | payload 显式收件人；缺省为任务负责人、项目负责人、匹配车组组长、匹配技术组组长、项管、超管。 |
| 任务风险解除 | `task_risk_resolved` | 通知 | outbox 私信 | payload 显式收件人。 |

### 进度提醒

| 场景 | 类型 | 机器人 | 渠道 | 收件人 |
|---|---|---|---|---|
| 规则型任务逾期 | `progress_reminder`，kind `TASK_OVERDUE` | 通知 | outbox 私信 | 默认任务负责人、项目负责人、项目参与人、阶段负责人、管理角色；可由提醒规则配置裁剪。 |
| 规则型任务临期 | `progress_reminder`，kind `TASK_DUE_SOON` | 通知 | outbox 私信 | 同上。 |
| 任务待验收停留 | `progress_reminder`，kind `TASK_PENDING_ACCEPTANCE_STALE` | 通知 | outbox 私信 | 同上。 |
| 周报未交 | `progress_reminder`，kind `WEEKLY_REPORT_MISSING` | 通知 | outbox 私信 | 同上；只扫描 `IN_PROGRESS`、`PENDING_ACCEPTANCE` 且需要周报的任务。 |
| 任务长期无动态 | `progress_reminder`，kind `TASK_STALE_ACTIVITY` | 通知 | outbox 私信 | 同上。 |
| 当前阶段临期/逾期/停滞 | `progress_reminder`，kind `STAGE_STALE_OR_DUE_SOON` | 通知 | outbox 私信 | 阶段负责人、项目负责人、项目参与人、阶段内任务负责人、管理角色。 |
| 手动项目催促 | `progress_reminder` | 通知 | outbox 私信 | 项目负责人、项目参与人、阶段负责人、活跃任务负责人、管理角色。 |
| 手动任务催促 | `progress_reminder` | 通知 | outbox 私信 | 任务负责人、项目负责人、项目参与人、阶段负责人、管理角色。 |
| 每日个人进度摘要 | `progress_daily_summary` | 通知 | outbox 私信 | 默认每天 19:00 入队，可在 `/admin/reminders` 的“每日卡片”页内设置启停、时间和单人测试发送；按项目/任务关注规则为每个用户汇总自己的任务列表、关注项目状态、未来 7 天和逾期 DDL。 |

历史/兼容函数 `runProgressOverdueCheck()`、`runWeeklyReportReminders()`、`runProgressDailyReminders()` 已废弃并会直接报错，避免绕过关注过滤和 outbox。当前 cron 使用 `runDueProgressReminderRules()` 的 outbox 路径。

## 采购报销消息

实现入口主要在 `app/actions/*Order*`、`lib/procurement-*`、`lib/feishu.ts`、`lib/notification-outbox.ts`。

采购订单进入新状态后通常通过 `enqueueOrderNotification` 入队；`orderNotificationEventKey(order)` 使用订单 ID、状态和 `statusEnteredAt` 做幂等，避免同一审批轮次重复通知。

### 订单状态消息

| 场景/状态 | 机器人 | 渠道 | 收件人 |
|---|---|---|---|
| `MANAGEMENT_REVIEW` 管理审核 | 审批 | outbox 私信 + 采购群 Webhook | 私信给匹配车组组长和匹配技术组组长；群 Webhook 发采购群摘要。 |
| `TEACHER_REVIEW` 老师审核 | 审批 | outbox 私信 + 采购群 Webhook + 邮件 | 私信给匹配技术组的指导老师；群 Webhook 发采购群摘要；同时向有邮箱的老师发送 SMTP 邮件。 |
| `PENDING_APPLICANT_DOCS` 待上传凭证 | 通知 | outbox 私信 | 采购申请人；不发采购群 Webhook。 |
| `PENDING_FINANCE_REVIEW` 财务/报销截图审核 | 审批 | outbox 私信 + 采购群 Webhook | 私信给匹配技术组的报销员；群 Webhook 发采购群摘要。 |
| `PENDING_APPLICANT_CONFIRM` 待采购人确认 | 审批 | outbox 私信 | 采购申请人；不发采购群 Webhook。 |
| `COMPLETED` 已完成 | 通知 | outbox 触发采购群 Webhook | 采购群摘要；通常无角色私信。 |

管理审核有双角色状态：车组组长和技术组组长分别审批。采购催办会只通知尚未完成审批的一侧。

### 采购结果与运营消息

| 场景 | outbox type | 机器人 | 渠道 | 收件人 |
|---|---|---|---|---|
| 采购被驳回 | `procurement_rejected` | 通知 | outbox 复合发送：采购群 Webhook + 私信 | 采购群摘要；私信采购申请人。 |
| 审批退回草稿 | `procurement_return_draft` | 通知 | outbox 复合发送：采购群 Webhook + 私信 | 采购群摘要；私信采购申请人。 |
| 报销员要求重新提交凭证 | `applicant_resubmit` | 通知 | outbox 复合发送：采购群 Webhook + 私信 | 采购群摘要；私信采购申请人。 |
| 预算阈值预警 | `budget_threshold` | 通知 | outbox 私信 | 对应预算池的车组组长和技术组组长。 |
| 采购日报 | 无 outbox | Webhook | 采购群 Webhook | 采购群。 |
| 在途订单停留超 24 小时自动催办 | 无 outbox | 当前状态决定 | 直接私信 | 当前处理人：管理审核为未审批的车组组长/技术组组长；老师审核为指导老师；财务审核为报销员；申请人上传/确认为采购申请人。 |
| 采购人手动催促当前环节审批人 | `manual_reminder` 仅作 1 分钟限流哨兵 | 当前状态决定 | 直接私信 | 当前环节处理人；老师审核时还会尝试发送老师邮件。 |

采购状态对应角色来自 `lib/permissions-client.ts`：

| 状态 | 私信角色 |
|---|---|
| `MANAGEMENT_REVIEW` | `TEAM_ADMIN` + `TECH_GROUP_ADMIN`，按订单车组/技术组匹配 |
| `TEACHER_REVIEW` | `TEACHER`，按订单技术组匹配 |
| `PENDING_FINANCE_REVIEW` | `FINANCE`，按订单技术组匹配 |
| `PENDING_APPLICANT_DOCS` | 采购申请人 |
| `PENDING_APPLICANT_CONFIRM` | 采购申请人 |

常见触发入口：

| 触发 | 主要入口 | 后续消息 |
|---|---|---|
| 采购申请提交或重新提交 | `lib/procurement-order-side-effects.ts` | 进入 `MANAGEMENT_REVIEW`，发管理审核待办。 |
| 车组/技术组管理审核完成 | `app/actions/approveManagementReview.ts` | 两侧都通过后进入 `TEACHER_REVIEW`，发老师审核待办和老师邮件。 |
| 老师审核通过 | `lib/procurement-approve-by-open-id.ts` | 进入 `PENDING_APPLICANT_DOCS`，通知采购人上传凭证。 |
| 采购人上传凭证 | `app/actions/uploadApplicantDocs.ts` | 进入 `PENDING_FINANCE_REVIEW`，发报销员待办。 |
| 报销员上传报销截图 | `app/actions/uploadFinanceScreenshot.ts` | 进入 `PENDING_APPLICANT_CONFIRM`，发采购人确认待办。 |
| 任一审批环节驳回或退回 | `app/actions/rejectOrder.ts` / `lib/procurement-reject-by-open-id.ts` | 发驳回、退回草稿或重新提交凭证通知。 |
| 订单金额导致预算池跨阈值 | `lib/procurement-budget-alerts.ts` | 发预算阈值预警。 |

### 采购交互卡片与回调

| 场景 | 渠道 | 说明 |
|---|---|---|
| 采购审批/确认私信卡片 | CardKit 私信 | 管理审核、老师审核、财务审核、采购人确认等支持按钮操作的卡片会用 CardKit，并记录卡片快照。 |
| 卡片状态刷新 | CardKit 更新 | `lib/feishu-procurement-card-sync.ts` 会按订单状态刷新已发送卡片，避免审批人看到过期按钮。 |
| 卡片按钮回调 | 飞书 WS worker | `scripts/feishu-ws.ts` 按 `FEISHU_WS_BOT_KIND=notification|approval` 启动。审批机器人发送的审批卡需要审批机器人 WS worker 接回调。 |
| 回调鉴权 | 服务端权限校验 | `lib/feishu-card-action-handler.ts` 会把飞书操作人映射回系统用户，再复用采购审批权限校验。 |

## 反馈消息

实现入口在 `app/actions/feedback.ts`、`lib/feishu-feedback.ts`。

| 场景 | outbox type | 机器人 | 渠道 | 收件人 |
|---|---|---|---|---|
| 新反馈提交 | `created` | 通知 | outbox 私信 | 所有超管。 |
| 管理员回复反馈 | `reply` | 通知 | outbox 私信 | 反馈提交人。 |
| 普通用户补充反馈 | `reply` | 通知 | outbox 私信 | 所有超管。 |
| 反馈状态更新 | `status` | 通知 | outbox 私信 | 反馈提交人。 |

## 收件人规则附录

### 进度关注过滤

进度模块项目/任务通知在入队前统一经过关注过滤，最终 payload 中保存过滤后的 `recipientOpenIds`：

- 项目强制关注：项管、匹配项目车组组长、匹配项目技术组组长、项目负责人、参与人、阶段负责人、项目下未删除任务负责人。
- 项目默认关注：强制关注人 + 超管。非直接相关超管可以取消关注项目。
- 任务强制关注：任务负责人、项目负责人、项管、匹配任务车组组长、匹配任务技术组/任务多技术组组长。
- 任务默认关注：继承项目有效关注 + 任务强制关注。项目取关会静音任务继承通知；用户可再显式关注单个任务。
- 显式 `FOLLOWING` 会订阅对应项目/任务；显式 `MUTED` 会静音对应项目/任务，但不能覆盖强制关注。
- 审批待办飞书也会经过关注过滤；审批权限和 `/progress/approvals` 审批看板不受关注状态影响。
- 申请人、审批结果接收人等个人结果通知可以显式保留，不因关注过滤丢失。

### 项目相关人

`collectProjectNotificationRecipients(project)` 汇总并去重：

- 项目负责人。
- 项目参与人。
- 阶段负责人。
- 项目下未删除任务负责人。
- 匹配项目车组的车组组长。
- 匹配项目技术组的技术组组长。
- 项管。
- 超管。
- 显式关注项目的人；显式取关且非强制关注的人会被过滤。

### 任务相关人

`collectTaskNotificationRecipients(task)` 汇总并去重：

- 任务负责人。
- 项目负责人。
- 项目参与人。
- 匹配任务车组的车组组长。
- 匹配任务技术组和任务多技术组的技术组组长。
- 项管。
- 继承项目有效关注的人。
- 显式关注任务的人；显式取关且非强制关注的人会被过滤。

### 阶段风险相关人

`collectProjectStageRiskNotificationRecipients(project, stage)` 汇总并去重：

- 项目负责人。
- 项目参与人。
- 阶段负责人。
- 匹配项目车组的车组组长。
- 匹配项目技术组的技术组组长。
- 项管。
- 超管。

### 立项审批人

`collectProjectEstablishmentReviewRecipients(scope)` 汇总并去重：

- 匹配车组组长。
- 匹配技术组组长。
- 项管。
- 超管。

## 投递与失败处理

- 大多数通知先写 `NotificationOutbox`；cron 或 `drainNotificationOutboxSoon()` 负责 drain。
- 支持收件人级投递的 outbox 会先生成 `NotificationOutboxRecipient`，每个收件人独立 claim、重试和标记成功。
- 进度通知只要 payload 中有 `recipientOpenIds` 就支持收件人级投递；`project_establishment_rejected` 兼容旧事件回退到申请人，`task_creation_rejected` 必须显式写入申请人收件人。
- 采购订单通知会把采购群 Webhook 建模为特殊伪收件人 `__procurement_order_webhook__`；待上传凭证和待申请人确认不生成该伪收件人。
- `procurement_rejected`、`applicant_resubmit`、`procurement_return_draft`、`feedback` 目前仍是复合发送 fallback，失败会按整条 outbox 重试。
- allowlist 拦截会把该收件人视为已处理并记录日志，不会真实发送私信。
- 审批机器人不可用且飞书返回 “Bot has NO availability to this user” 时，发送层会尝试回退普通通知机器人；如果独立审批机器人缺少收件人的 `union_id`，会直接失败并等待重试。

## 定时任务与 Worker

| 进程/函数 | 默认频率 | 发送内容 |
|---|---|---|
| `scripts/cron.ts` -> `drainNotificationOutbox` | 每 2 分钟 | 发送 outbox 中待投递的进度、采购、反馈消息。 |
| `scripts/cron.ts` -> `runDueProgressReminderRules` | 每 10 分钟扫描到期规则 | 进度规则型提醒，入队 `progress_reminder`。 |
| `scripts/cron.ts` -> `runProgressDailySummariesIfDue` | 每 5 分钟检查一次 DB 设置 | 个人进度摘要，默认 19:00，可在管理员面板“每日卡片”中启停、改时间和单人测试发送，入队 `progress_daily_summary`，走通知机器人；`PROGRESS_DAILY_SUMMARY_CHECK_CRON` 只控制检查频率，旧 `PROGRESS_DAILY_SUMMARY_CRON` 仅用于首次初始化兼容。 |
| `scripts/cron.ts` -> `runProcurementBudgetAlerts` | 每 10 分钟 | 采购预算阈值预警，入队 `budget_threshold`。 |
| `scripts/cron.ts` -> `sendFeishuDailySummary` | 每天 09:00 | 采购日报，直接发采购群 Webhook。 |
| `scripts/cron.ts` -> `runProcurementStaleReminders` | 每天 09:00 | 在途采购停留超 24 小时催办，直接私信当前环节处理人。 |
| `scripts/cron.ts` -> `syncFeishuContactUsers` | 默认每天 08:30 | 通讯录同步，不发送业务消息。 |
| `scripts/feishu-ws.ts` | 常驻进程 | 接收飞书消息和卡片按钮回调；审批机器人回调需要审批机器人 worker。 |

## 维护清单

新增或修改消息时，至少检查以下文件：

- `lib/feishu-bot-routing.ts`：是否是审批待办，是否需要审批机器人。
- `lib/feishu-progress.ts` / `lib/feishu.ts` / `lib/feishu-feedback.ts`：卡片标题、中文字段、按钮链接。
- `lib/notification-outbox.ts`：是否支持收件人级投递，是否需要稳定 `eventKey`。
- 触发它的 `app/actions/**` 或 `lib/**`：收件人是否由权限 helper 计算并去重。
- `tests/progress-notifications.spec.ts` 或相关 e2e：断言 `botKind`、收件人、卡片内容和不重复发送。
- 本文档：补充场景、机器人、渠道和收件人。
