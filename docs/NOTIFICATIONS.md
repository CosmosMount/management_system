# 消息发送与投递规则

本文档描述当前通知基础设施、采购、反馈和项目管理通知接入。项目管理使用 `channel=project-management` 的 payload 契约、站内通知、Task 生命周期与 Segment 事件和飞书 adapter。资源冲突通知事件已下线。

## 架构与边界

```text
业务事务
  └─ NotificationOutbox（eventKey 幂等）
       └─ channel adapter（payload 校验、收件人、消息内容、用途）
            ├─ sendFeishuDirectMessage（身份、机器人、禁发闸、HTTP/CardKit）
            └─ email adapter → sendEmail（SMTP 禁发闸、邮箱 allowlist）
                 └─ NotificationOutboxRecipient（逐收件人结果与重试）
```

- `NotificationOutbox` 表示业务事件，`NotificationOutboxRecipient` 表示单个收件人的投递状态。成功收件人不会因其他人失败而重复发送。
- `lib/notification-outbox.ts` 是稳定 façade；通用入队/重试、claim/heartbeat、逐收件人协调和状态汇总分别位于 `lib/notification-outbox/` 下，不解析采购或反馈 payload，也不查询业务角色。`lib/notification-delivery.ts` 是投递组合入口，把通用 outbox 与 channel registry 连接起来。
- `lib/notification-channel-adapter.ts` 定义 adapter 契约，`lib/notification-channel-registry.ts` 只注册明确列出的 adapter；`procurement.ts`、`feedback.ts`、`project-management.ts` 与 `email.ts` 分别校验持久化 payload、`type`、`botKind`，计算并去重收件人、构造完整消息和声明消息用途。采购与反馈业务入队 helper 分别位于 `lib/notification-producers/`，不进入通用 outbox 核心。老师审核邮件使用独立 `channel=email` 逐收件人投递，不再用预写 `SENT` 的哨兵代替真实结果。
- `lib/feishu-message.ts` 是飞书 IM 私信统一传输层，导出 `FeishuMessage`、`FeishuMessagePurpose`、`FeishuSendResult` 和 `sendFeishuDirectMessage()`。它不理解业务状态或业务角色。
- 采购群 Webhook 由独立模块发送，不接入私信接口。SMTP 老师邮件也不属于飞书传输层。
- 采购 CardKit 快照、卡片 sequence 和后续更新仍由采购领域维护；统一传输层负责创建并发送卡片，成功结果返回 `cardId`。
- 采购通知持久化契约、订单明细映射和预算预警 payload 位于纯 `procurement-notification-contract`；采购收件人解析、订单消息、预算预警和每日汇总各自独立，`feishu.ts` 仅保留旧导入路径的兼容 re-export。

项目管理必须在业务事务中使用稳定 `eventKey` 写入 outbox，由自己的 channel adapter 处理。项目管理 Server Action 和领域 service 不得直接导入飞书传输层。Task 生命周期和 Segment 只允许入队站内通知和 `channel=project-management` outbox；真实飞书消息只能由 `lib/notification-channels/project-management.ts` 通过统一传输层发送。

Task、Project、Revision、风险和评论 mutation 的 Server Action 会在业务事务成功提交后调用非阻塞即时 drain，尽快 claim 新 outbox；`NOTIFICATION_DELIVERY_DISABLED`、allowlist 和 adapter 校验仍在原投递边界生效。独立 cron 每 5 秒扫描一次，继续作为进程提前退出、即时 drain 失败和积压消息的兜底；降低 cron 间隔不能替代业务生产者入队。

## 项目管理 P1-P6 通知接入

项目管理通知 payload 位于 `lib/project-management/notifications/contract.ts`，固定包含：

- `payloadVersion=1`
- `purpose=notification|approval_request`
- `category=PROJECT|TASK|MILESTONE|REVIEW|REVISION|WORK_SEGMENT|ACCOUNT_SECURITY`
- `title`、`summary`、`actorName`
- `entityType/entityId`、可选 `taskId/taskTitle`、`linkPath`
- `recipientOpenIds` 和 `mandatory`

入队 helper 位于 `lib/project-management/notifications/events.ts`：

- `createInAppNotificationTx()` 在业务事务内创建站内通知，`eventKey` 幂等。
- `enqueueProjectManagementNotificationTx()` 和非事务版本只写 `NotificationOutbox`，channel 固定为 `project-management`。
- `approval_request` 自动使用审批机器人；普通通知使用通知机器人。`milestone_review_submitted`、`revision_pending_review`、`termination_review_submitted` 和 `project_establishment_submitted` 可以声明 `approval_request`，其他事件不得持久化为审批机器人通知。

Task 生命周期服务和 Segment 服务会在同一业务事务中写站内通知和 `channel=project-management` outbox，事件包括：

| 场景 | outbox type | 用途 | 收件人 |
|------|-------------|------|--------|
| Task 草稿成员加入 | `task_assigned` | 普通通知 | 有效 OWNER/PARTICIPANT |
| Task 基本信息更新 | `task_updated` | 非 mandatory 普通通知 | 操作人和更新前后有效 OWNER/PARTICIPANT，按账号去重 |
| Task 激活 | `task_activated` | 普通通知 | 有效 OWNER/PARTICIPANT |
| Task 草稿删除 | `task_deleted` | 强制普通通知 | 有效 OWNER/PARTICIPANT |
| Milestone 提交验收 | `milestone_review_submitted` | 审批请求 | 所有活跃全局管理员，按账号去重 |
| Milestone 验收结果 | `milestone_review_result` | 普通通知 | 提交人 + 所有 OWNER |
| Revision 待审批 | `revision_pending_review` | 审批请求 | 所有活跃全局管理员，按账号去重 |
| Revision 驳回 | `revision_result` | 普通通知 | 创建人 + 所有 OWNER |
| Revision 生效 | `revision_applied` | 普通通知 | 创建人 + 所有 OWNER |
| Revision 取消 | `revision_cancelled` | 强制普通通知 | 创建人、当前 OWNER、操作人和活跃全局管理员，按账号去重 |
| Planned Segment 到期待确认 | `segment_confirmation_due` | 普通通知 | Segment Person |
| Terminal 结束申请 | `termination_review_submitted` | 审批请求 | 所有活跃全局管理员，按账号去重 |
| Terminal 驳回/要求修订 | `termination_review_result` | 普通通知 | 提交人 + 所有 OWNER |
| Task 结束申请通过 | `task_terminated` | 普通通知 | 有效 OWNER/PARTICIPANT |
| 账号角色变更 | `account_security` | 强制普通通知 | 仅被操作账号 |
| Project 提交/重提立项 | `project_establishment_submitted` | 审批请求 | 两类全局管理员 |
| Project 立项结果 | `project_establishment_result` | 普通通知 | 申请人、提交人和 Project 成员 |
| Project 结束/删除 | `project_completed` / `project_deleted` | 普通通知 | 申请人和 Project 成员 |
| Project 信息更新 | `project_updated` | 非 mandatory 普通通知 | 申请人、操作人和更新前后有效成员，按账号去重 |
| Project/Task 提出风险 | `risk_created` | 非 mandatory 普通通知 | 直接目标负责人、参与人、两类全局管理员和操作人，按账号去重 |
| Project/Task 解决风险 | `risk_resolved` | 非 mandatory 普通通知 | 直接目标负责人、参与人、两类全局管理员和操作人，按账号去重 |
| Project/Task 发布评论 | `comment_created` | 非 mandatory 普通通知 | 直接目标负责人、参与人、两类全局管理员和操作人，按账号去重 |

风险提出、风险解决和评论发布由 collaboration service 在业务记录与领域审计的同一事务内创建站内通知和 outbox。操作人作为普通候选收件人与其他人使用相同的偏好、活跃状态和飞书身份规则；非成员评论者也会收到自己的站内通知，关闭对应飞书偏好时不会获得特殊强制投递。Project 事件使用 `PROJECT` 偏好，Task 事件使用 `TASK` 偏好；FEISHU 关闭只过滤普通飞书候选，站内通知仍保留。除本次操作人外，Task 事件不会额外通知仅属于其 Project、但不是 Task 成员的人员。停用 Person 和没有 Account 的成员不会成为收件人，账号按 `accountId` 去重，飞书 `openId` 只在投递边界解析。评论软删除仅写 `pm.project.comment.delete` / `pm.task.comment.delete` 审计并进入近期动态，不创建站内通知或 outbox。

`updateTaskDraft` 与 `updateActiveTask` 在名称、内容、车组、技术组、优先级或关联 Task 实际变化时产生一条 `task_updated`；成员专属变化继续使用 `task_assigned`，所属 Project 变化继续使用 `project_task_changed`，仅发生这些专属变化时不重复创建 `task_updated`。`updateProject` 对名称、内容、头像和成员的一次组合保存只产生一条 `project_updated`，覆盖更新前后成员并停止在该入口额外产生逐人 `project_member_added`；立项重提和 Task 成员自动同步等其他来源仍保留原成员加入事件。两类更新事件都只记录中文变更项，不把完整描述、内部人员 ID 或头像路径写入消息。

Revision 创建和被驳回后的修改都会直接产生 `revision_pending_review`。事件键包含 `revisionId + reviewRound`；驳回结果键也包含对应 round，因此每轮送审和结果各自 exactly once，不会被上一轮幂等记录吞掉。Revision 不再产生独立 submit 通知或审计事件。

Revision 从 `PENDING_APPROVAL` 或 `REJECTED` 取消时，会在状态、候选计划、审计与新 `revision_cancelled` 通知的同一事务中，把该 Revision 所有轮次仍为 `PENDING/PROCESSING/FAILED` 的审批 outbox 和未完成 recipient 置为 `CANCELED`，并将旧站内审批请求标为已读。冻结时与 worker 一致按 outbox→recipient 加锁，避免处理中取消与 claim heartbeat 形成反向锁序。已发送 recipient 和历史卡片保留。adapter 在收件人规划和真正发送前都会校验 Revision 当前状态与审批轮次，失效轮次不会继续投递；不含 round 的早期 outbox 只按首轮兼容，Revision 已重提时会取消。已经进入飞书网络请求的消息无法撤回。

同一 Task 同时只允许一个未撤出的 `PENDING` Milestone Review、`PENDING_APPROVAL` Revision 或 `PENDING` Termination Review。门禁在 Task 行锁事务内、幂等重放之后检查：原 Review 使用相同请求键时返回原结果，不生成第二份审计或通知；不同请求键以及被其他审批占用的 Revision/Milestone/Terminal 请求均返回状态冲突，且不创建站内通知、outbox 或任何业务写入。审批通过、驳回、要求修订、取消或撤出后才释放门禁。Terminal 申请使用审批机器人；驳回和要求修订使用通知机器人；批准时不重复发送结果通知，而是用既有 `task_terminated` 通知全体有效成员。

Task 激活与结束通知使用持久化的 Terminal 名称表示结束节点，不再以结束条件充当节点名称。零 Milestone Task 激活时，`task_activated` 摘要会明确当前 Terminal 名称；`termination_review_submitted` 包含拟定结束结果、原因和总结，`termination_review_result` 与 `task_terminated` 都包含 Terminal 名称、拟定或批准后的结束结果、原因、总结和审批意见。所有事件继续经过站内通知和 durable outbox，不得直发。

既有 Draft `task_assigned` 入队保持 `mandatory=true`。这里的“普通通知”指 `purpose=notification`、`botKind=notification`，不表示 `mandatory=false`；该事件只使用通知机器人，不得路由到 approval bot。Active `updateActiveTask` 的成员新增/移除/角色变化沿用同一强制成员变化语义：站内 + `mandatory=true` 的 `project-management` outbox，purpose/botKind 仍为 `notification`。

账号安全变更由 `lib/account-management.ts` 在角色事务中写入。事件只通知被操作人，站内分类固定为 `ACCOUNT_SECURITY`，outbox 固定 `mandatory=true`、`purpose=notification` 和通知机器人。摘要包含操作人、角色授予/撤销、组织范围和时间。事件键以 `account-security:<action>:<稳定实体或变更 ID>` 开头，站内和飞书后缀分别保证幂等。报销角色通知也通过 `accountId` 解析当前 Identity；历史 `UserRole.openId` 不作为投递目标。删除项目访问禁用机制的 migration 只写 `source=MIGRATION` 审计，不创建站内通知或飞书 outbox。

Active 成员强制事件不得因缺少飞书 identity 或尚无 Account 而消失；已绑定活跃 Account 仍写按 Account 的站内记录。停用 Person 不创建新的站内通知或飞书候选。飞书候选只允许 `provider=FEISHU`、`tenantId=default` 且 trim 后非空的 `openId`，不会回退其他 tenant，也不会因最早一条 identity 为空而漏掉同一默认 tenant 的后续合法 identity。无法安全解析飞书目标时仍写 `mandatory=true` durable outbox，并在 payload `context.recipientResolution` 记录 `DEFAULT_FEISHU_IDENTITY_MISSING`、`FEISHU_OPEN_ID_MISSING` 或 `ACCOUNT_MISSING`；outbox 保留空候选而不猜测、替代或直发任何真实收件人。成员业务审计、站内记录和 outbox 与成员差异处于同一事务，任一晚失败全部回滚。新建和激活 Task 的常规成员收件人只读取有效 OWNER/PARTICIPANT；历史 LEAD/MEMBER/REVIEWER/VIEWER 不再取得成员通知。所有项目和采购 adapter 会在每次 outbox 重算及真正私信发送前再次校验 Person 为 `ACTIVE`，因此收件人离职后旧重试会取消而不会发送。

Revision 生效事务先把目标 `TaskPlanVersion` 切换为 `CURRENT` 并更新 `Task.currentPlanVersionId`，随后以更新后的 Task 上下文写 `revision_applied`。Work Segment 仅关联 Task，不再产生节点关联失效通知。

入队 helper 和 adapter 会拒绝 `type/payload.kind` 不一致、payload 结构错误、错误机器人类型和越界审批用途，并对 `recipientOpenIds` 去重。项目管理飞书卡片包含操作人、项目、任务、通知内容、相关事项、通知时间和最多 6 项中文业务上下文；审批请求按钮显示“查看并审批”，普通通知按钮显示“查看详情”。项目管理链接在入队前统一解析，同一结果同时写入飞书 payload 和站内通知：有 Task 目标时进入 `/progress/tasks/<taskId>`，即使 payload 同时包含 `projectId` 也以 Task 为准；只有 Project 目标时进入 `/progress/projects/<projectId>`。既有合法深链继续保留，包括 Terminal 的 `focus`、Project 立项的 `#establishment` 锚点和 Segment 到期确认的 `/progress?focus=<segmentId>`。Task 或 Project 已删除时分别进入 `/progress/tasks` 或 `/progress/projects` 列表，避免详情页 404；只有账号安全等没有 Project/Task 业务目标的通知才允许使用 `/progress` 或其既有入口。adapter 在投递前还会为 `linkPath` 为空或仍为旧 `/progress` 的未发送 outbox 按 `taskId/projectId` 重新推导目标，不修改、不撤回也不重发已发送的历史卡片。

用户可见内容统一使用“项目、任务、里程碑、计划修订、计划投入、结束节点”等中文名称；数据库实体名、枚举值、上下文字段名、收件人解析状态和策略版本不得展示。未知对象统一显示“相关事项”，未知上下文直接省略；旧 outbox 与旧站内通知中能够按完整系统模板识别的内部术语会在投递或读取时转换为中文，模板中的项目名、任务名和正文按原值重建。里程碑验收结果会在 payload 中明确记录摘要来自系统默认文案还是审批人意见；只有系统默认摘要允许做状态中文化，用户意见始终按原文展示。缺少来源标记的早期歧义摘要不做猜测性改写。`approval_request` 使用审批机器人用途；所有普通项目管理事件使用通知机器人，不能把审批机器人作为普通通知 fallback。里程碑、Terminal 提交以及计划修订创建/重新送审前会在全局审批人事务锁内重新查询收件人；没有有效全局管理员角色，或所有管理员都缺少 default tenant 非空飞书 openId 时，审批状态、审计、站内通知和 outbox 全部回滚，不生成无人可处理或确定无法投递的待审批记录。

资源冲突下线 migration 会删除 `RESOURCE_CONFLICT` 偏好与站内通知，以及 `resource_conflict_opened`、`resource_conflict_resolved` outbox；收件人投递行随 outbox 级联删除。已经送达飞书的历史消息无法撤回。

Segment 到期确认事件键保持稳定幂等：`pm:segment:confirmation_due:<segmentId>:<endAt>`，安全处理链接为 `/progress?focus=<segmentId>`，在统一“我的工作”详情中完成确认。站内通知在业务事件键后追加 `:inapp:<accountId>`，飞书 outbox 追加 `:feishu`；重复提交依赖唯一事件键保持 exactly once，逐收件人失败只重试失败者。`scanSegmentTransitions` 会把到期 Planned 推到 `PENDING_CONFIRMATION`、把进行中的 Planned 置为 `IN_PROGRESS`，但不会自动生成 Actual。

统一账号和 Task 成员/角色数据库迁移只追加 `source=MIGRATION` 的 `DomainAuditEvent`，不创建站内通知或 outbox，不会在上线时批量触达真实用户。单一 Task 审批门禁迁移同样不新建通知：它保留已发送历史，冻结被撤出审批对应仍可重试的 outbox 与未完成 recipient，并把相关未读站内审批通知标记为已读。

### 单一 Task 审批门禁迁移

`20260805120000_single_task_pending_approval` 必须在应用写入和通知 worker 都停止、`NOTIFICATION_DELIVERY_DISABLED=true` 的维护窗口执行。迁移撤出全部当前 Task Milestone/Revision 待审批并写确定性 `source=MIGRATION` 审计；对应 outbox 的 `PENDING/PROCESSING/FAILED` 状态会永久冻结为不可重试失败，未完成 recipient 同步冻结。只有本轮 `milestone_review_submitted` / `revision_pending_review` 站内审批请求会标记已读，复用同一 Revision ID 的上一轮 `revision_result` 等结果通知保持原读状态。已发送的飞书消息、站内通知、证据和投递历史不会删除，也不会发送额外撤出通知。迁移不选择或修改采购、报销、投入确认和关联复核通知。

### 旧待审批通知修复

早期全局管理员审批收件人切换不会删除已发送给旧 Task Reviewer 或项目 `GROUP_LEADER` 的历史站内/飞书记录，这些记录继续作为审计证据，但旧收件人不再拥有审批能力。在单一审批门禁迁移之前部署该历史版本时，需在通知 worker 保持禁发时运行幂等修复；当前版本会直接撤出仍待处理的 Task 审批，不应再为这些对象补建审批通知：

```bash
# 默认 dry-run，只报告待处理数量、管理员收件人和旧 outbox
npm run pm:repair-task-approval-notifications

# 写入修复；仍只写站内通知/outbox，不直接发送飞书
NOTIFICATION_DELIVERY_DISABLED=true \
npm run pm:repair-task-approval-notifications -- --apply
```

修复脚本只选择持有有效全局 `SUPER_ADMINISTRATOR` 或 `PROJECT_ADMINISTRATOR` 角色的账号，并按账号去重。没有可用全局管理员，或全部管理员都缺少 default tenant 非空飞书 openId 时，APPLY 会在冻结任何旧 outbox 前阻断。对每个仍为 `PENDING` 的 Milestone Review 或 `PENDING_APPROVAL` Revision，脚本在单独事务中冻结对应旧 `:feishu` outbox，以 `global-admin:v2` 版本化事件键创建管理员站内通知和 approval outbox，并写稳定 ID 的 `source=MIGRATION` 审计；任一对象失败只回滚该对象。全部待审批对象成功后，其他可重试的旧审批 outbox 也会被标记为冻结并写入明确原因。重复运行依赖事件键和审计 ID 保持幂等。

该脚本不会调用飞书传输层，也不会绕过 `NOTIFICATION_DELIVERY_DISABLED`、收件人 allowlist、outbox claim 或逐收件人重试。修复完成并核对无真实外发后，才可恢复正常 worker。

项目管理通知偏好按 Task、Milestone、Review、Revision 和 Work Segment 分类。站内通知是审计/待办兜底，始终写入且 UI 不提供关闭；`NotificationPreference(channel=FEISHU, enabled=false)` 只过滤普通飞书候选。`mandatory=true` 的关键状态与安全事件忽略普通关闭偏好，但仍经过 durable outbox、禁发开关、allowlist 和逐收件人重试，不能直发。停用 Person 仍可查看历史偏好，但页面开关为只读；服务端保存事务会重新锁定并复核 Person，停用后直接调用 Action 也返回 `FORBIDDEN` 且不写偏好或审计。

Milestone deadline scanner 使用 Asia/Shanghai 业务日期，事件键为 `pm:milestone:<milestoneId>:milestone_due|milestone_overdue:<YYYY-MM-DD>`；同一天重跑保持 exactly once。每日保留任务分批删除 90 天前已读站内通知、30 天前已发送项目管理 outbox 和 180 天前失败 outbox；未读站内通知不因该规则删除。所有测试继续设置 `NOTIFICATION_DELIVERY_DISABLED=true`。

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
- SMTP 最终出口同样强制检查 `NOTIFICATION_DELIVERY_DISABLED`；配置 `EMAIL_DELIVERY_ALLOWED_ADDRESSES` 时，只允许列表内的规范化邮箱。自动化测试不得绕过该出口保护。
- `FEISHU_DIRECT_MESSAGE_ALLOWED_NAMES / OPEN_IDS / UNION_IDS` 是真实投递 allowlist。业务 payload 和 outbox 保留完整候选人，统一传输层在最后出口拦截不允许的收件人。
- 自动化测试始终启用禁发开关，不得发送真实飞书消息。人工调试脚本还必须显式满足 `CONFIRM_SEND_FEISHU=true`，并继续通过禁发与 allowlist 检查。
- token、凭据、完整卡片 payload、用户敏感数据和飞书原始错误响应不得写入日志或 outbox `lastError`；token、IM 与 CardKit 失败只保留安全的 code/status 和少量已知错误分类。
- 单个收件人失败不回滚业务事务，也不改变其他收件人的成功状态。网络失败、缺少 `union_id` 和临时收件人查询失败按 outbox 退避策略处理；未知 channel、非法 payload、`type/payload.kind` 不一致或非法机器人用途属于终止配置错误，直接冻结为最大重试次数，等待人工修正后重置。
- 审批事件必须至少解析出一个真实私信审批人；群 Webhook 成功不能代替审批待办私信，也不能令只有 Webhook 目标的审批 outbox 标记为 `SENT`。
- 业务状态变化与 outbox 记录应在同一事务中提交；重复入队依赖稳定 `eventKey` 幂等。
- outbox 与 recipient claim 必须比较扫描时的 `status/attempts/lockedUntil` 和可投递时间；外部 SMTP/飞书发送期间会持续在同一事务续租父子 claim，完成与失败回写以最新租约 fencing，慢请求不得被另一 worker 重复发送。
- adapter 每次重试都会重新计算当前合法收件人；尚未发送且已撤权的 recipient 会标为 `CANCELED`，不会继续投递。协调过程不会抢占租约仍有效的 `PROCESSING` recipient；该次投递完成或租约过期后再按最新资格收敛。已成功记录保留为历史审计，不会回滚或伪装成未发送。
- 老师审核邮件同时绑定订单 ID 与本轮 `statusEnteredAt`。订单离开该轮老师审核，或退回后重新进入新一轮老师审核时，旧邮件 outbox 与未完成 recipient 会进入 `CANCELED`，不会恢复投递；`CANCELED` 父 outbox 不允许通过现有人工重试入口恢复。当前通用保留任务不清理采购/邮件 outbox，因此这些记录按审计历史保留，后续如增加保留周期必须单独评审。

## 采购消息

订单状态变化通过现有 `enqueueOrderNotification*` façade 入队，内部由 procurement adapter 投递。`orderNotificationEventKey(order)` 继续使用订单 ID、状态和 `statusEnteredAt` 区分审批轮次。

采购卡片标题按当前环节明确区分管理审核、老师审核、凭证上传、报销资料处理、申请人确认、完成和驳回，不再对所有状态使用同一个“审批提醒”标题。卡片正文只显示中文状态、申请人、车组/技术组、单号、金额、操作提示和必要的业务说明；内部订单状态枚举和回调 action 不得出现在用户可见内容中。

### 订单状态

| 场景/状态 | 用途 | 渠道 | 收件人 |
|---|---|---|---|
| `MANAGEMENT_REVIEW` 管理审核 | 审批 | outbox 私信 + 采购群 Webhook | 匹配车组组长和技术组组长；群内发摘要 |
| `TEACHER_REVIEW` 老师审核 | 审批 | outbox 私信 + Webhook + 邮件 | 匹配技术组指导老师 |
| `PENDING_APPLICANT_DOCS` 待申请人上传凭证 | 通知 | outbox 私信 | 采购申请人 |
| `PENDING_FINANCE_REVIEW` 待报销员处理 | 审批 | outbox 私信 + Webhook | 匹配技术组报销员 |
| `PENDING_APPLICANT_CONFIRM` 待申请人确认 | 审批 | outbox 私信 | 采购申请人 |
| `COMPLETED` 已完成 | 通知 | outbox 触发 Webhook | 采购群摘要，通常无角色私信 |

管理审核的车组组长和技术组组长分别审批；催办只通知尚未完成审批的一侧。
订单进入 `TEACHER_REVIEW` 时，采购私信 outbox 与 `channel=email/type=teacher_review_email` 邮件 outbox 在同一业务事务创建；邮件成功后才标记对应 recipient 为 `SENT`，临时 SMTP 失败按 outbox 退避重试。
所有声明为审批用途的订单状态都要求至少一个真实私信收件人。角色配置为空时，本轮不会发送群 Webhook，outbox 保持可重试失败，避免群摘要成功掩盖无人可审批。

### 结果、运营与催办

| 场景 | outbox type | 用途/渠道 | 收件人 |
|---|---|---|---|
| 采购被驳回 | `procurement_rejected` | 通知；Webhook + 私信 | 群摘要 + 采购申请人 |
| 审批退回草稿 | `procurement_return_draft` | 通知；Webhook + 私信 | 群摘要 + 采购申请人 |
| 要求重新提交凭证 | `applicant_resubmit` | 通知；Webhook + 私信 | 群摘要 + 采购申请人 |
| 预算阈值预警 | `budget_threshold` | 通知；私信 | 对应兵种组组长；按兵种组+周期+阈值生成稳定事件键，不再通知技术方向组长；仅有旧技术方向预算行时，已入队的组级事件键也是恢复最近提醒阈值的持久化事实 |
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
| 新反馈提交 | `created` | 通知 | 所有统一超级管理员 |
| 管理员回复反馈 | `reply` | 通知 | 反馈提交人 |
| 普通用户补充反馈 | `reply` | 通知 | 所有统一超级管理员 |
| 反馈状态更新 | `status` | 通知 | 反馈提交人 |

## 维护门禁与测试

- 飞书 IM 消息 API 只能由 `lib/feishu-message.ts` 调用；CardKit API 只能由 CardKit 模块调用；Webhook URL 只能由 Webhook 模块调用。
- adapter 测试覆盖 payload/元数据校验、真实与独立传输收件人、机器人用途、未知 channel、eventKey 幂等、首次解析恢复、锁恢复和逐收件人重试。
- 传输层使用 mock HTTP 覆盖禁发、allowlist、`open_id`/`union_id`、双机器人凭据、fallback、text/交互卡片/CardKit 和错误脱敏。
- 采购、反馈回归必须验证收件人、消息信息完整性、机器人用途以及 CardKit 跟踪；测试不得联系真实收件人。
- 项目管理测试必须验证 outbox 入队、payloadVersion、机器人用途、生命周期事件、收件人去重、完整卡片内容、recipient 级重试和禁发回归；还必须解析卡片按钮并断言由受信任应用域名与规范 `linkPath` 组成的完整绝对 URL，覆盖旧 `/progress` payload 的投递时推导。自动化测试必须 mock 飞书 HTTP，不能联系真实收件人。
