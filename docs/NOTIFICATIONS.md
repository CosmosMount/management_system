# 消息发送与投递规则

本文档描述当前通知基础设施、采购、反馈和项目管理 P1 通知底座。旧项目管理事件、payload、卡片模板和收件人规则已经删除；新项目管理已新增 `channel=project-management` 的 payload 契约和 adapter 骨架，但完整事件发送和飞书卡片投递尚未启用。

## 架构与边界

```text
业务事务
  └─ NotificationOutbox（eventKey 幂等）
       └─ channel adapter（payload 校验、收件人、消息内容、用途）
            └─ sendFeishuDirectMessage（身份、机器人、禁发闸、HTTP/CardKit）
                 └─ NotificationOutboxRecipient（逐收件人结果与重试）
```

- `NotificationOutbox` 表示业务事件，`NotificationOutboxRecipient` 表示单个收件人的投递状态。成功收件人不会因其他人失败而重复发送。
- `lib/notification-outbox.ts` 只负责入队、claim、按 channel 调度、重试和状态更新，不解析采购或反馈 payload，也不查询业务角色。
- `lib/notification-channels/types.ts` 定义 adapter 契约；`procurement.ts`、`feedback.ts` 与 `project-management.ts` 分别校验持久化 payload、`type`、`botKind`，计算并去重收件人、构造完整消息和声明消息用途。采购 adapter 还会区分真实私信收件人与 Webhook 等独立传输目标；项目管理 adapter 当前只提供 P1 契约校验和收件人计划，不执行真实飞书投递。
- `lib/feishu-message.ts` 是飞书 IM 私信统一传输层，导出 `FeishuMessage`、`FeishuMessagePurpose`、`FeishuSendResult` 和 `sendFeishuDirectMessage()`。它不理解业务状态或业务角色。
- 采购群 Webhook 由独立模块发送，不接入私信接口。SMTP 老师邮件也不属于飞书传输层。
- 采购 CardKit 快照、卡片 sequence 和后续更新仍由采购领域维护；统一传输层负责创建并发送卡片，成功结果返回 `cardId`。

项目管理必须在业务事务中使用稳定 `eventKey` 写入 outbox，由自己的 channel adapter 处理。项目管理 Server Action 和领域 service 不得直接导入飞书传输层。P1 仅允许入队和校验 payload 契约；真实飞书消息构造与投递将在后续阶段启用。

## 项目管理 P1 通知底座

项目管理通知 payload 位于 `lib/project-management/notifications/contract.ts`，固定包含：

- `payloadVersion=1`
- `purpose=notification|approval_request`
- `category=TASK|MILESTONE|REVIEW|REVISION|WORK_SEGMENT|RESOURCE_CONFLICT|ACCOUNT_SECURITY`
- `title`、`summary`、`actorName`
- `entityType/entityId`、可选 `taskId/taskTitle`、`linkPath`
- `recipientOpenIds` 和 `mandatory`

入队 helper 位于 `lib/project-management/notifications/events.ts`：

- `createInAppNotificationTx()` 在业务事务内创建站内通知，`eventKey` 幂等。
- `enqueueProjectManagementNotificationTx()` 和非事务版本只写 `NotificationOutbox`，channel 固定为 `project-management`。
- `approval_request` 自动使用审批机器人；普通通知使用通知机器人。P1 只允许 `milestone_review_submitted` 和 `revision_pending_review` 声明 `approval_request`，其他事件不得持久化为审批机器人通知。

P1 入队 helper 和 adapter 会拒绝 `type/payload.kind` 不一致、payload 结构错误、错误机器人类型和越界审批用途，并对 `recipientOpenIds` 去重。`sendToRecipient()` 与 `sendComposite()` 当前会以非可重试错误明确失败“项目管理飞书通知投递将在 P6 启用”，避免把尚未实现的飞书投递误标为成功或反复重试。

## 飞书统一私信传输层

`sendFeishuDirectMessage()` 的调用方必须提供：

- 系统中的收件人 `openId`；传输层按实际机器人解析为 `open_id` 或 `union_id`。
- 明确的 `botKind`；用途校验会拒绝普通通知使用审批机器人。
- 明确的消息用途；普通通知不能选择审批机器人，只有审批请求可使用审批用途。
- `text`、普通交互卡片或 CardKit 三种消息之一。
- 只含事件键、实体类型等非敏感字段的日志上下文。

返回值明确区分 `sent` 和 `skipped`：成功结果报告实际机器人、`receiveIdType`、是否发生 fallback，以及 CardKit 的可选 `cardId`；跳过结果报告禁发或收件人不在 allowlist 的原因。调用方不得根据原始飞书响应自行拼接业务成功状态。

机器人路由：

- 通知机器人使用 `FEISHU_NOTIFICATION_APP_ID / FEISHU_NOTIFICATION_APP_SECRET`，未配置时回退 OAuth 主应用凭据。
- 审批机器人使用 `FEISHU_APPROVAL_APP_ID / FEISHU_APPROVAL_APP_SECRET`；未配置独立审批机器人时沿用通知机器人凭据。
- 独立审批机器人优先通过 `User.unionId` 以 `receive_id_type=union_id` 发送。缺少 `union_id` 属于投递失败，由 outbox 重试，不能静默跳过。
- 保留既有的“用户对独立审批应用不可用时改用通知机器人”fallback；结果和结构化日志必须标明实际机器人及 fallback。
- 普通通知没有审批机器人 fallback，也不能通过伪造 `botKind` 使用审批机器人。

## 投递安全与错误处理

- `NOTIFICATION_DELIVERY_DISABLED=true` 时，outbox drain 和即时 drain 触发不会真实投递；飞书私信、群 Webhook、IM 素材上传也必须在出口处跳过网络请求。
- `FEISHU_DIRECT_MESSAGE_ALLOWED_NAMES / OPEN_IDS / UNION_IDS` 是真实投递 allowlist。业务 payload 和 outbox 保留完整候选人，统一传输层在最后出口拦截不允许的收件人。
- 自动化测试始终启用禁发开关，不得发送真实飞书消息。人工调试脚本还必须显式满足 `CONFIRM_SEND_FEISHU=true`，并继续通过禁发与 allowlist 检查。
- token、凭据、完整卡片 payload、用户敏感数据和飞书原始错误响应不得写入日志或 outbox `lastError`；token、IM 与 CardKit 失败只保留安全的 code/status 和少量已知错误分类。
- 单个收件人失败不回滚业务事务，也不改变其他收件人的成功状态。网络失败、缺少 `union_id` 和临时收件人查询失败按 outbox 退避策略处理；未知 channel、非法 payload、`type/payload.kind` 不一致或非法机器人用途属于终止配置错误，直接冻结为最大重试次数，等待人工修正后重置。
- 审批事件必须至少解析出一个真实私信审批人；群 Webhook 成功不能代替审批待办私信，也不能令只有 Webhook 目标的审批 outbox 标记为 `SENT`。
- 业务状态变化与 outbox 记录应在同一事务中提交；重复入队依赖稳定 `eventKey` 幂等。

## 采购消息

订单状态变化通过现有 `enqueueOrderNotification*` façade 入队，内部由 procurement adapter 投递。`orderNotificationEventKey(order)` 继续使用订单 ID、状态和 `statusEnteredAt` 区分审批轮次。

### 订单状态

| 场景/状态 | 用途 | 渠道 | 收件人 |
|---|---|---|---|
| `MANAGEMENT_REVIEW` 管理审核 | 审批 | outbox 私信 + 采购群 Webhook | 匹配车组组长和技术组组长；群内发摘要 |
| `TEACHER_REVIEW` 老师审核 | 审批 | outbox 私信 + Webhook + 邮件 | 匹配技术组指导老师 |
| `PENDING_APPLICANT_DOCS` 待上传凭证 | 通知 | outbox 私信 | 采购申请人 |
| `PENDING_FINANCE_REVIEW` 财务审核 | 审批 | outbox 私信 + Webhook | 匹配技术组报销员 |
| `PENDING_APPLICANT_CONFIRM` 待确认报销 | 审批 | outbox 私信 | 采购申请人 |
| `COMPLETED` 已完成 | 通知 | outbox 触发 Webhook | 采购群摘要，通常无角色私信 |

管理审核的车组组长和技术组组长分别审批；催办只通知尚未完成审批的一侧。
所有声明为审批用途的订单状态都要求至少一个真实私信收件人。角色配置为空时，本轮不会发送群 Webhook，outbox 保持可重试失败，避免群摘要成功掩盖无人可审批。

### 结果、运营与催办

| 场景 | outbox type | 用途/渠道 | 收件人 |
|---|---|---|---|
| 采购被驳回 | `procurement_rejected` | 通知；Webhook + 私信 | 群摘要 + 采购申请人 |
| 审批退回草稿 | `procurement_return_draft` | 通知；Webhook + 私信 | 群摘要 + 采购申请人 |
| 要求重新提交凭证 | `applicant_resubmit` | 通知；Webhook + 私信 | 群摘要 + 采购申请人 |
| 预算阈值预警 | `budget_threshold` | 通知；私信 | 对应预算池车组组长和技术组组长 |
| 采购日报 | 无 outbox | Webhook | 采购群 |
| 在途订单停留催办 | 无 outbox | 当前状态决定的私信 | 当前处理人 |
| 采购人手动催促 | `manual_reminder` 仅作限流哨兵 | 当前状态决定的私信；老师环节可附加邮件 | 当前处理人 |

不经 outbox 的采购日报和催办仍必须通过统一飞书传输层或独立 Webhook 模块，继续受禁发开关、allowlist、机器人用途和日志脱敏约束，不能自行获取 token 或直接调用 IM API。

### CardKit 与回调

| 场景 | 规则 |
|---|---|
| 审批/确认私信卡片 | 使用统一传输层发送 CardKit，采购领域保存返回的 `cardId`、快照和 sequence |
| 卡片状态刷新 | `lib/feishu-procurement-card-sync.ts` 按订单状态刷新已有卡片，防止展示过期按钮 |
| 卡片按钮回调 | `scripts/feishu-ws.ts` 按 `FEISHU_WS_BOT_KIND=notification|approval` 接收；发送审批卡的机器人必须有对应 WS worker |
| 回调鉴权 | 操作人映射回系统用户后复用服务端采购权限和状态校验 |

## 反馈消息

反馈事件通过现有 enqueue façade 写入 `channel=feedback` 的 outbox，由 feedback adapter 校验 payload、解析收件人并构造普通通知消息。

| 场景 | outbox type | 用途 | 收件人 |
|---|---|---|---|
| 新反馈提交 | `created` | 通知 | 所有超管 |
| 管理员回复反馈 | `reply` | 通知 | 反馈提交人 |
| 普通用户补充反馈 | `reply` | 通知 | 所有超管 |
| 反馈状态更新 | `status` | 通知 | 反馈提交人 |

## 维护门禁与测试

- 飞书 IM 消息 API 只能由 `lib/feishu-message.ts` 调用；CardKit API 只能由 CardKit 模块调用；Webhook URL 只能由 Webhook 模块调用。
- adapter 测试覆盖 payload/元数据校验、真实与独立传输收件人、机器人用途、未知 channel、eventKey 幂等、首次解析恢复、锁恢复和逐收件人重试。
- 传输层使用 mock HTTP 覆盖禁发、allowlist、`open_id`/`union_id`、双机器人凭据、fallback、text/交互卡片/CardKit 和错误脱敏。
- 采购、反馈回归必须验证收件人、消息信息完整性、机器人用途以及 CardKit 跟踪；测试不得联系真实收件人。
- 项目管理 P1 测试必须验证 outbox 入队、payloadVersion、机器人用途、收件人去重和 adapter 不真实投递；后续启用真实投递前必须补充完整卡片内容、recipient 级重试和禁发回归。
