# ADR: Task 全员可见、双成员角色与全局管理员审批

> 状态（2026-08-05）：本文关于 Work Segment 职责、Task Node 关联和关联复核的决策已由 [删除 Work Segment 职责与 Task Node 关联](./2026-08-05-remove-work-segment-role-node-association.md) 取代；成员、可见性和审批角色继续有效。
>
> 状态（2026-08-04）：本文关于 `Account.projectAccessStatus`、禁用账号和账号状态门禁的决策已由 [移除账号级项目访问状态](./2026-08-04-remove-project-access-status.md) 取代；Revision 草稿、编辑和单独提交动作已由 [Revision 时间标记与候选计划状态机](./2026-08-04-revision-time-marker.md) 取代。成员、可见性和审批角色继续有效。

日期：2026-08-03

状态：Accepted

## 背景

项目管理此前按 Task 成员和组织范围控制读取，并提供 `OWNER/LEAD/MEMBER/REVIEWER/VIEWER` 多种成员角色、Task 级 Revision 审批策略和自审开关。该模型把“执行成员”“只读可见性”和“审批人”混在同一成员表中，也使同一 Task 的读取、编辑和审批能力依赖多套范围规则。

本次产品决策将项目管理改为透明协作模型：所有项目账号共享完整业务视图，Task 执行权限只由负责人、参与人和全局管理员决定，Milestone 与 Revision 的最终决定统一收口到全局管理员。采购报销的独立角色和审批状态机不在本 ADR 范围内。账号访问状态的后续删除见 2026-08-04 ADR。

本 ADR 取代以下历史决策中与 Task 可见性、项目 `GROUP_LEADER`、Task Reviewer、Revision 直通和自审策略有关的部分：

- [P0 项目管理规则冻结与安全基线](./2026-07-28-p0-project-management-rule-freeze.md)
- [项目管理前端 v1.0 执行基线](./2026-07-30-project-management-frontend-v1-execution-baseline.md)

## 决策

### 1. 账号与读取边界

- “所有人”指所有已登录并成功解析到统一 `Account/Person` 的项目管理账号；不再存在项目访问启用/禁用状态。
- 所有账号可读取全部未逻辑删除 Task、计划版本、成员、Milestone Review、Revision、Task 审计和 Work Segment 变更历史。
- 所有账号可读取所有未逻辑删除 Work Segment 的完整内容，包括 Planned/Actual、时间、内容、产出、完成度和 Task/Node/Tag 关联。
- 读取范围扩大不授予写权限；已删除对象仍不能通过列表、搜索或显式 ID 枚举。
- 所有绑定在职 `Person` 的账号都可创建使用固定合法车组/技术组选项的 Task，创建者始终成为负责人；2026-08-20 起，通讯录同步标记为 `INACTIVE` 的人员仅保留全局历史读取能力，不能执行业务写入。

### 2. Task 成员

- 有效 Task 成员角色只允许 `OWNER`（负责人）和 `PARTICIPANT`（参与人）。
- 一个 Task 可以有多名负责人，但任何时刻至少有一名有效负责人。
- 同一 Person 在同一 Task 中最多一条有效成员关系，因此不能同时兼任负责人和参与人。
- 整包替换成员必须先锁 Task，并在事务内校验至少一名负责人、人员唯一、角色合法、审计、通知和乐观锁版本。
- `LEAD/MEMBER/REVIEWER/VIEWER` 只保留为已结束成员历史的数据库枚举值，不能再成为有效成员。
- Work Segment 的工作职责 `REVIEWER` 是 Segment 内容字段，不是 Task 成员角色，也不授予审批权限。

### 3. 项目系统角色

- 活跃项目系统角色只允许全局 `SUPER_ADMINISTRATOR` 和全局 `PROJECT_ADMINISTRATOR`，二者在项目业务中统一视为全局管理员。
- 全局角色撤销和审批提交共同串行维护可用全局管理员集合；存在 Task 数据时至少保留一名具有 default tenant 非空飞书 openId 的全局管理员，否则整事务失败。
- `GROUP_LEADER` 及其他旧项目角色全部撤销并只保留历史；账号后台不能再授予。
- 报销 `TEAM_ADMIN`、`TECH_GROUP_ADMIN`、`TEACHER`、`FINANCE` 及采购审批流程保持不变。

### 4. 写权限

| 操作 | 非成员 | 参与人 | 负责人 | 全局管理员 |
| -------------------------------------------------- | -----: | -----: | -----: | ---------: |
| 查看未删除 Task、计划、验收、审计和投入 | ✓ | ✓ | ✓ | ✓ |
| 创建 Task | ✓ | ✓ | ✓ | ✓ |
| 修改 Task 元数据、Tag、Draft 计划 | — | ✓ | ✓ | ✓ |
| 创建自己的 Revision、修改并重新送审被驳回 Revision | — | ✓ | ✓ | ✓ |
| 管理该 Task 的任意未生效 Revision | — | — | ✓ | ✓ |
| 提交 Milestone 验收证据 | — | ✓ | ✓ | ✓ |
| 管理成员、激活 Task | — | — | ✓ | ✓ |
| 提交 Terminal 结束申请                             |      — |      ✓ |      ✓ |          ✓ |
| 决定 Milestone、Revision 或 Terminal 结束申请 | — | — | — | ✓ |
| 修改自己的 Task 关联投入 | — | ✓ | ✓ | ✓ |
| 修改该 Task 其他人的投入 | — | — | ✓ | ✓ |

无 Task 关联的个人 Segment 仍由本人管理，全局管理员可管理全部。所有写操作继续执行 Task/Segment 状态机、终态只读、时间和关联合法性、乐观锁、事务与审计规则。

### 5. 固定审批策略

- Owner、Participant 和全局管理员可以提交 Milestone 验收证据、Terminal 结束申请、创建自己的 Revision，并修改后重新送审被驳回的 Revision。
- Revision 创建即进入 `PENDING_APPROVAL`；不存在 Draft、单独 Submit 或 Owner 直接生效路径。
- 只有两类全局管理员可以批准或驳回 Revision，以及通过、驳回或要求修订 Milestone 和 Terminal 结束申请。
- 全局管理员可以处理自己提交的 Milestone、Terminal 结束申请或自己创建的 Revision，但必须执行一次显式审批动作。
- Terminal 审批通过后才写入结束结果并将 Task 置为终态；驳回或要求修订保留历史并释放 Task 单一待审批门禁。
- Revision 仅能在批准事务内生效；Current Plan 切换、旧版本历史化和受影响 Segment 待复核标记继续原子提交。
- 删除 `Task.revisionApprovalMode`、`Task.allowSelfReview` 和 `RevisionApprovalMode`；旧配置先写入 `source=MIGRATION` 的审计记录。
- 历史 `MilestoneReview`、`RevisionNode`、审批账号、时间、意见和状态全部保留；界面统一称为“审批人”。

### 6. Work Segment 成员一致性

- 每条未删除且关联 Task 的 Work Segment，其 Person 必须是该 Task 的有效负责人或参与人。
- 历史迁移会把已有 Task 关联投入的非成员持有人补为参与人；已有负责人不降级。
- 新建、更新、拆分、合并、确认、重关联等会创建或改变 Task 关联的写路径都在服务端复核该不变量；既有 Segment 写入先锁 Task、再锁 Segment，避免并发成员降级后继续使用旧 Owner 权限。
- Participant 只能管理自己的 Task 关联 Segment；Owner 可管理该 Task 全部成员的 Segment；全局管理员可管理全部；非成员只有读取权。

### 7. 通知与迁移

- Milestone、Revision 和 Terminal 结束申请的待审批收件人是所有活跃全局管理员，按账号去重，使用审批机器人用途。
- Milestone 结果通知发送给提交人和所有负责人；Revision 结果通知发送给创建人和所有负责人；Terminal 驳回或要求修订通知发送给提交人和所有负责人，批准通知发送给全部有效 Task 成员。
- Task 成员事件只面向有效负责人和参与人，使用通知机器人。
- 已发送给旧 Reviewer 或组长的历史通知保留；尚未发送或正在重试的旧审批 outbox 被明确冻结。
- 对部署时仍待处理的 Milestone/Revision，以版本化事件键为全局管理员补建站内通知和 outbox；发布预检同时统计待处理的 Terminal 结束申请。修复脚本必须幂等、逐审批对象事务化并继续经过禁发、allowlist 和 outbox guard。
- 数据迁移归一化旧成员、回填 Segment 参与人、撤销旧项目角色并保留审计，不产生成员变更通知或 outbox。

### 8. 客户端兼容

- Task Composer 不再展示流程策略、Reviewer 和允许自审控件。
- 本地草稿 schema 升级到 v2：Owner 保留，Lead/Member 转为 Participant，Reviewer/Viewer 删除，人员按 Owner 优先去重，创建者补为 Owner，旧审批字段删除。
- 旧页面提交已删除字段或旧角色时，服务端返回可理解的中文版本/校验错误，客户端不得静默删除本地草稿。

## 影响

- 项目管理从“最小可见”改为“全员可见、按成员写入”；任何 UI capability 都必须来自服务端计算，不能替代服务端鉴权。
- 项目 `GROUP_LEADER` 不再有运行时权限，但采购报销中的组长角色和流程完全独立。
- 多负责人和单 Person 单角色成为数据库与服务端共同维护的不变量；历史成员行继续可审计。
- 审批待办数量可能扩大到所有全局管理员，需要在发布窗口先冻结旧 outbox、补建新事件，再恢复 worker。

## 验证

- 迁移前执行只读 `npm run pm:task-access-preflight`；零 Owner 或孤立 Task 关联 Segment 必须阻断。
- 不可逆 Task migration 之前另有数据库级只读管理员门禁和永久串行延迟约束；已有 Task 但没有活跃且飞书可达的全局管理员时，必须在任何 schema 或数据改写前失败，并防止部署中断、空库首条 Task 或旧实例并发写入使已通过的检查失效。
- 在隔离 PostgreSQL 中验证旧角色归一化、多 Owner、重复成员、Segment 回填、旧项目角色撤销、策略审计和零通知副作用。
- 运行待审批修复脚本的 dry-run，再在通知禁发环境以 `--apply` 参数执行并验证幂等。
- 授权、生命周期、Segment、通知、桌面和 Pixel 5 Playwright 回归必须覆盖允许与拒绝路径。
- 发布门禁为 `npm run check`、`npm run db:deploy`、`npm run build` 和 `npm run test:e2e`。
