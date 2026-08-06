# Project 文件夹与立项流程实施计划

> 状态：产品边界已明确，可据此拆分实施。
>
> 更新时间：2026-08-06。
>
> 本文中的“全局管理员”同时指全局 `SUPER_ADMINISTRATOR` 和全局
> `PROJECT_ADMINISTRATOR`；只有涉及账号与角色后台时，两者才继续保持现有差异。

## 1. 文档定位与依据

本计划在当前 Project Management v2.1 上重新增加 Project。Project 只是一层位于
Task 之上的文件夹和立项对象，不恢复旧系统中的 Project Stage、项目 DDL、周报、风险、
评论、模板或旧审批角色。

实施依据按以下优先级排列：

1. 当前分支代码、`prisma/schema.prisma`、现行 migration、权限和测试；
2. 本文已经明确的产品规则；
3. [`current-progress-page.png`](./image/current-progress-page.png) 表达的导航位置；
4. `main` 分支旧 Project 创建页只作为纵向表单、成员选择、字段错误和提交反馈的视觉参考。

不得直接复制 `main` 的旧 `Project/ProjectStage` schema、旧 `openId` 授权、旧
`permissions-progress.ts` 或旧 `channel=progress` 通知。旧 Project 实现已经由
`20260728210000_remove_legacy_project_management` 正式删除，新实现必须使用当前统一
`Account/Person`、全局管理员、领域审计、站内通知和
`channel=project-management` outbox。

## 2. 目标与非目标

### 2.1 本轮目标

1. 在项目管理侧栏中增加“Project”，位置在“Task”上方。
2. 提供 Project 列表、搜索、创建立项、详情、修改、审批、驳回重提、结束和删除。
3. 一个 Task 最多归属一个 Project，也可以不属于任何 Project。
4. Project 对所有已登录统一账号可见；成员身份只影响写权限和“只看我参与”。
5. Task 加入 Project 时，持续保证其有效负责人和参与人也是 Project 成员。
6. Project 不改变 Task 的计划、成员权限、审批、Revision、Milestone、Terminal、
   Work Segment 或通知状态机。

### 2.2 明确不做

- Project Stage、Project 时间计划、Project TimeCanvas；
- Project 级 Tag、风险、评论、周报、模板、资源配额和独立验收；
- Project 对 Task 的批量状态操作或权限继承；
- 一个 Task 同时属于多个 Project；
- Project 嵌套、父子 Project；
- 恢复已删除 Project、硬删除 Project 或批量导入；
- 迁回旧 `/progress/[id]`、`/progress/list` 等路由；
- 让报销车组/技术组角色参与 Project 立项审批。

## 3. 核心产品规则

### 3.1 Project 属性

Project 持久化以下业务信息：

- Project 名称：必填，trim 后 `1–200` 字符；允许重名；
- Project 内容：必填，trim 后 `1–8,000` 字符；
- Project 负责人：至少 1 人，最多 50 人；
- Project 参与人员：可为 0 人，最多 50 人；
- Project 头像：可上传；未上传时使用统一默认图标；
- 状态、申请人、立项轮次、版本号和生命周期时间；
- 当前归属的 Task；
- 立项申请历史、审计和通知记录。

负责人和参与人互斥，同一 Person 在同一 Project 中最多有一个有效角色：

- 参与人提升为负责人时，在同一事务中结束参与人身份并建立负责人身份；
- 负责人降为参与人时执行相反操作；
- Project 始终至少保留一名负责人；
- 负责人不能执行会让自己失去 Project 修改权限的自我移除或自我降级；
- 全局管理员即使移除自己的 Project 负责人身份，仍保有全局权限，因此不受上一条限制；
- 其他负责人或全局管理员可以在满足“至少一名负责人”的前提下移除某位负责人。

Project 参与人本轮只有只读、成员展示和通知接收语义，不获得修改 Project 或 Task 的权限。

### 3.2 默认头像与自定义头像

- `avatarPath=null` 表示使用默认头像；数据库不为每个 Project 复制默认图片。
- 默认头像由共享 UI 组件使用 `FolderKanban` 图标和稳定背景色渲染，列表、详情、
  选择器和通知保持一致。
- 自定义头像仅支持 PNG、JPEG、WebP，单文件不超过 2 MiB；同时校验声明 MIME、
  文件内容、大小和存储路径。
- 上传、替换和清理复用当前受保护上传、`FileAsset` 和失败补偿机制；不得把原始
  文件系统路径暴露给客户端。
- Project 对所有登录账号可见，因此 `PROJECT_AVATAR` 文件也对所有登录账号可读；
  未登录和非法路径仍返回 401/404。

### 3.3 全员可见

所有已登录统一账号都可以：

- 查看全部未删除 Project 及其基本信息、成员、状态和关联 Task；
- 搜索 Project；
- 申请创建 Project。

Project 的负责人和参与人不限制 Project 可见性。Person 为 `INACTIVE` 时仍保留历史
展示，但不能被新选为负责人或参与人；现有停用成员不会因同步或编辑被静默删除。

## 4. 生命周期与立项审批

### 4.1 状态定义

| 持久化状态 | 中文展示 | 含义 |
|---|---|---|
| `DRAFT` | 草稿 | 立项被驳回，等待原申请人修改并重提 |
| `PENDING_APPROVAL` | 立项审批中 | 完整立项申请等待全局管理员决定 |
| `ACTIVE` | 进行中 | 立项已通过，可正常修改和接收 Task |
| `COMPLETED` | 已结束 | Project 已结束，业务信息和 Task 关系只读 |

删除不增加 enum 状态，统一使用 `deletedAt/deletedByAccountId` 软删除。

### 4.2 状态迁移

| 当前状态 | 操作 | 下一状态 | 操作者 |
|---|---|---|---|
| 尚不存在 | 提交完整立项 | `PENDING_APPROVAL` | 任意登录账号 |
| `PENDING_APPROVAL` | 通过 | `ACTIVE` | 全局管理员 |
| `PENDING_APPROVAL` | 驳回 | `DRAFT` | 全局管理员 |
| `DRAFT` | 修改并重新提交 | `PENDING_APPROVAL` | 原申请人、Project 负责人、全局管理员 |
| `ACTIVE` | 结束 Project | `COMPLETED` | Project 负责人、全局管理员 |
| `DRAFT/PENDING_APPROVAL/ACTIVE` | 删除 | 软删除 | Project 负责人、全局管理员 |

本轮不提供首次立项前的“保存不完整草稿”。创建页只有“提交立项”，提交时必须完整满足
第 3.1 节。`DRAFT` 专门表示被驳回后可修改的同一 Project，不复制新 Project。

### 4.3 立项申请轮次

- 创建时同时写 Project 和第 1 轮 `PENDING` 立项申请。
- `PENDING_APPROVAL` 状态下 Project 信息、成员、头像和申请 Task 全部只读；管理员只能
  通过或驳回，不能先改申请内容再批准。
- 驳回意见必填，批准意见可选。
- 驳回后原申请人即使不是 Project 负责人，也可修改全部申请字段并重新提交；这是对
  “Project 信息只能由负责人和全局管理员修改”的显式例外。Project 负责人和全局管理员
  在 `DRAFT` 同样可以修改并重提。重提创建新轮次，旧轮次永久保留。
- Project 始终保留最初 `requesterAccountId`，每轮申请另外记录实际
  `submittedByAccountId`，避免由负责人或管理员重提后丢失原申请人。
- 全局管理员允许审批自己提交或自己担任负责人的 Project，但仍必须执行显式审批动作，
  不得在提交时自动通过。
- 同一 Project 同时最多存在一轮待审批申请，数据库和服务层都必须保证。
- 审批操作必须重新确认操作者仍是全局管理员，并在锁内复核状态和轮次。

批准后立即进入 `ACTIVE`，本轮不增加独立“启动 Project”步骤。

### 4.4 结束条件

Project 从 `ACTIVE` 进入 `COMPLETED` 时必须同时满足：

1. 至少关联一个未删除 Task；
2. 所有关联且未删除 Task 的状态都严格为 `COMPLETED`；
3. 不存在正在审批的 Project 立项申请；
4. Project `expectedLockVersion` 未过期。

`FAILED/CANCELLED/TIMEOUT/ARCHIVED/DRAFT/ACTIVE` 均不视为“Task 已完成”。服务端返回
阻塞 Task 的有界列表和总数，UI 展示名称与状态并链接到 Task；客户端计数不能替代事务内
复核。Project 完成后不能修改资料、成员、头像或 Task 归属。

### 4.5 删除语义

- “中途删除”只允许 `DRAFT/PENDING_APPROVAL/ACTIVE`，不允许删除 `COMPLETED`。
- 删除必须软删除 Project，不物理删除成员、申请轮次、审计或通知历史。
- 同一事务把所有当前关联 Task 的 `projectId` 置空；不得删除、结束或修改这些 Task 的
  其他字段，也不得改动 Task 成员和计划。
- 待审批申请同时进入 `CANCELLED`，尚未投递的对应审批 outbox 安全冻结；已经投递的卡片
  回调必须幂等返回“Project 已删除或申请已处理”。
- 数据库成功后再补偿清理自定义头像；失败进入现有 durable cleanup，不回滚业务删除。
- 删除后所有普通查询、选择器和直达详情返回脱敏 404。本轮不提供恢复入口。

## 5. Project 与 Task 的关系

### 5.1 关系基数与独立性

- `Task.projectId` 可空，一个 Task 最多属于一个未删除 Project。
- Project 可以没有 Task；Task 也可以没有 Project。
- Project 负责人/参与人不自动成为 Task 成员。
- Task 负责人/参与人不会因为 Task 归属而获得 Project 修改权。
- Project 负责人身份不授予 Task metadata、计划、成员、Revision、验收、结束或 Segment
  权限；Task 权限继续完全由当前 `TaskMember` 和全局管理员决定。
- 更改 `Task.projectId` 被视为 Task metadata mutation，因此 Project 负责人身份本身不足以
  加入或移除 Task；操作者仍须具有该 Task 的 `task.update_metadata` 权限。

这保证 Project 只是文件夹，不成为第二套 Task 权限系统。

### 5.2 在立项申请中选择已有 Task

创建和驳回重提时可以选择 0–50 个当前没有 Project 的 Task。候选必须同时满足：

- `deletedAt=null` 且 `projectId=null`；
- 申请人对该 Task 具有 `task.update_metadata` 权限；
- 候选通过服务端授权搜索返回，不能通过伪造 ID 越权选择。

提交申请时只把 Task ID 和必要版本信息写入该轮立项申请，不立即设置
`Task.projectId`。这样未通过立项不会占用或改变 Task。

批准时在一个事务中重新加载并锁定所有申请 Task，复核：

- Task 仍未删除且仍无 Project；
- 本轮实际提交人仍具有该 Task 的 metadata 修改权限；
- 所有 Task 引用完整有效。

任一 Task 冲突时整轮批准失败，不允许部分加入。错误必须指出冲突数量和有界 Task 名称；
管理员可以驳回，让申请人调整后重提。批准成功后才统一设置 `projectId`、递增各 Task
`lockVersion`、写 Task/Project 审计并执行成员同步。

### 5.3 ACTIVE Project 与 Task 表单

Task 创建、DRAFT 编辑和 ACTIVE 基本信息编辑增加可空的“所属 Project”字段：

- 只列出 `ACTIVE && deletedAt=null` 的 Project；
- 所有 Project 全员可见，不要求操作者已经是 Project 成员；
- Server Action 仍先验证操作者有 Task metadata 修改权；
- 允许从无 Project加入、从一个 Project移动到另一个 Project、或设为空；
- `PENDING_APPROVAL/DRAFT/COMPLETED/已删除` Project 不可作为新目标；
- stale 表单中原 Project 状态已变化时，保存整笔失败，不静默设为空；
- Revision 不允许修改 Project 归属，也不把 Project 字段写入候选计划。

Project 详情中的 Task 列表主要用于浏览。只有同时对某个 Task 具有
`task.update_metadata` capability 的用户才显示“移出 Project/修改归属”，操作仍调用统一的
Task metadata mutation；Project Owner 身份不能绕过该检查。

### 5.4 Task 成员向 Project 成员单向同步

系统持续维护以下不变量：

> 对每个已归属未删除 Project 的 Task，其全部有效 `OWNER/PARTICIPANT` 必须是该 Project
> 的有效 `OWNER` 或 `PARTICIPANT`。

同步规则：

1. Task 首次加入 Project 时，把尚非 Project 成员的所有有效 Task 成员加入为 Project
   Participant；已有 Project Owner 保持 Owner，不降级。
2. Task 已属于 Project 时，后续新增 Task Owner/Participant 同样在该 Task 成员事务内加入
   Project Participant。
3. Project Participant 被提升为 Project Owner 时只保留 Owner 身份。
4. Task 成员被移除、Task 移出 Project或 Project 删除时，不自动移除 Project Participant；
   因为该人员可能由人工加入、参与其他 Task，或仍需查看 Project 上下文。
5. 只要某人仍是任一关联 Task 的有效成员，Project 编辑页就不能把该人从 Project 成员中
   移除；服务端返回阻塞 Task，避免保存后立即被自动加回。
6. 同步只增加成员，不改变 Task、Project 既有负责人身份。

自动新增 Project Participant、Task 归属变化和人工成员变化都必须在同一业务事务写审计，
不能依赖异步 cron 最终修复。可以保留只读完整性巡检，但巡检不得成为正常一致性路径。

## 6. 权限模型

新增稳定 action 字符串：

- `project.create`
- `project.view`
- `project.update`
- `project.manage_members`
- `project.submit_establishment`
- `project.review_establishment`
- `project.complete`
- `project.delete`

权限矩阵：

| 操作 | 普通非成员 | Project Participant | Project Owner | 全局管理员 |
|---|---:|---:|---:|---:|
| 查看所有未删除 Project | ✓ | ✓ | ✓ | ✓ |
| 申请创建 Project | ✓ | ✓ | ✓ | ✓ |
| 查看 Project 内 Task | ✓ | ✓ | ✓ | ✓ |
| 修改 ACTIVE Project 信息/头像 |  |  | ✓ | ✓ |
| 管理 ACTIVE Project 成员 |  |  | ✓ | ✓ |
| 审批或驳回立项 |  |  |  | ✓ |
| 结束 ACTIVE Project |  |  | ✓ | ✓ |
| 删除未结束 Project |  |  | ✓ | ✓ |

状态约束优先于角色能力：例如 Owner 不能编辑 `PENDING_APPROVAL`，全局管理员也不能修改
`COMPLETED`。`DRAFT` 的修改和重提按第 4.3 节授予原申请人、Owner 和全局管理员；原申请人
走独立 action 分支，不因此被永久视为 Owner。

查询层增加 `projectReadableWhere(actor) => { deletedAt: null }`。UI 只能消费服务端 DTO 中的
capability；隐藏按钮不能替代 Server Action 的 session、角色、成员、状态和版本复核。

## 7. 数据模型与 migration

### 7.1 Prisma 模型

新增或调整以下模型，字段命名可在实现时按 Prisma 关系要求微调，但语义不得缩水。

`Project`：

- `id`, `name`, `description`, `avatarPath?`；
- `status: ProjectStatus`；
- `requesterAccountId`；
- `establishmentRound`, `lockVersion`；
- `submittedAt`, `startedAt`, `completedAt`；
- `reviewedAt`, `reviewedByAccountId?`, `reviewComment` 作为当前状态摘要；
- `deletedAt`, `deletedByAccountId?`；
- `createdAt`, `updatedAt`；
- members、requests、tasks、audit、notifications 和 avatar asset 关系。

`ProjectMember`：

- `projectId`, `personId`, `role: ProjectMemberRole(OWNER/PARTICIPANT)`；
- `createdByAccountId`, `removedByAccountId?`, `removedAt`, `createdAt`；
- PostgreSQL partial unique index 保证同一 Person 在同一 Project 最多一个有效身份。

`ProjectEstablishmentRequest`：

- `projectId`, `round`, `status: PENDING/APPROVED/REJECTED/CANCELLED`；
- `submittedByAccountId`, `reviewerAccountId?`, `reviewComment`；
- 有界 `snapshot`，保存该轮名称、内容、头像、成员和申请 Task ID 的权威快照；
- `submittedAt`, `reviewedAt`；
- `@@unique([projectId, round])`，并以 partial unique index 保证每个 Project 最多一轮
  `PENDING`。

`ProjectEstablishmentRequestedTask`：

- `requestId`, `taskId`, `sortOrder`, `createdAt`；
- `@@unique([requestId, taskId])`；
- 仅表示某轮申请内容，不代表 Task 已归属 Project。

调整现有模型：

- `Task.projectId String?`，外键 `ON DELETE SET NULL`，增加 `[projectId, status]` 索引；
- `FileAssetKind.PROJECT_AVATAR` 和 `FileAsset.projectId?`；
- `DomainAuditEvent.projectId?`；
- `InAppNotification.projectId?`；
- `ProjectManagementNotificationCategory.PROJECT`。

Project 名称不建唯一索引。业务引用和 URL 始终使用 UUID。

### 7.2 Migration 约束

- 新建 migration，不修改已应用的旧 migration。
- 当前数据库没有需要迁入的新 Project 数据；既有 Task 全部回填 `projectId=null`。
- 虽然新表再次使用名称 `Project`，不得误认为旧表仍存在，也不得恢复旧列。
- migration 同时建立有效成员、单一待审批申请、必要外键、索引和检查约束。
- 更新 `legacy-project-management-migration.spec.ts` 时必须继续证明历史收缩 migration 在其
  当时时点删除旧 Project；HEAD 校验则改为证明新 Project 不含旧 Stage/ownerOpenId 等签名，
  不能简单删除历史迁移测试。
- 在 runner 管理的随机 PostgreSQL target/shadow 库验证空库部署和完整前置链升级。

## 8. 服务端应用层与并发

### 8.1 模块边界

建议新增：

- `lib/project-management/project-authorization.ts` 或并入现有 authorization；
- `lib/project-management/application/project-service.ts`；
- `lib/project-management/queries/project-queries.ts`；
- `lib/project-management/validations/project.ts`；
- `app/actions/project-management/projects.ts`。

浏览器不得直接访问 Prisma。Project action 复用当前统一 action runner、中文错误脱敏、
structured logging 和 `ProjectManagementActionResult`。

### 8.2 原子性和锁顺序

以下操作必须原子完成：

- 创建 Project + members + 第 1 轮申请 + requested Tasks + audit + notification/outbox；
- 驳回/重提/批准及其 request、状态、Task 归属、自动成员、审计和通知；
- ACTIVE Project 的 metadata/avatar/member 更新；
- Task projectId 更新和自动 Project Participant；
- Task 成员更新和自动 Project Participant；
- Project 完成；
- Project 删除、Task 脱离、待审批取消和通知冻结。

所有 Project mutation 接受 `expectedLockVersion`；实际变化时只递增一次 Project
`lockVersion`，无变化保存不写数据、不递增版本。Task 归属变化沿用 Task `lockVersion`。

跨 Task/Project 事务统一采用以下顺序，避免成员同步、删除和审批竞争死锁：

1. 获取固定的 transaction advisory lock `pm-project-cross-aggregate`；
2. 按 Task ID 排序锁定所有相关 Task；
3. 按 Project ID 排序锁定所有相关 Project；
4. 锁定 request/member 等子记录；
5. 基于锁后 actor、成员、状态和关系重新授权；
6. 写业务数据、审计、站内通知和 outbox 后提交。

Project-only metadata 修改不必获取跨聚合 advisory lock。任何可能查询、增加、移动或清空
`Task.projectId` 的路径都必须获取该锁。Project 完成和删除必须在锁后重新查询 Task，不能使用
页面计数作决定。

### 8.3 幂等与失败

- 立项提交和重提使用稳定 client idempotency key，并绑定规范化请求 hash；同 key 不同正文拒绝。
- 审批以 `requestId + round + decision` 防重复；第一次成功后重复回调返回已处理结果，不重复
  写审计或通知。
- Task 批量归属不能部分成功。
- 头像先完成安全暂存，再进入数据库事务；事务失败清理本次文件，替换成功后补偿清理旧头像。
- 并发冲突返回可理解的中文错误和最新版本提示，不泄露 SQL、Zod 或内部 ID。

## 9. 路由与 UI

### 9.1 导航与路由

侧栏和移动导航在“Task”之前增加 `FolderKanban` 图标的“Project”。路由统一为：

- `/progress/projects`：Project 列表；
- `/progress/projects/new`：提交立项；
- `/progress/projects/[id]`：Project 详情；
- `/progress/projects/[id]/edit`：ACTIVE 修改或 DRAFT 修改重提。

同时在 `lib/routes.ts` 增加类型安全 route helper。现有旧 URL 重定向规则需要调整：新的
`/progress/projects/*` 不得再被当成旧路由重定向到 `/progress`。

### 9.2 Project 列表与搜索

列表页结构与当前 Task 列表一致：顶部 `PageCommandBar`、搜索筛选卡和 Project 卡片列表。

筛选项：

- 搜索 Project 名称或内容；
- 状态：全部、草稿、立项审批中、进行中、已结束；
- “只看我参与”：申请人或当前 Project Owner/Participant；
- 筛选按钮。

无显式 URL 参数时默认“只看我参与 + 进行中”；显式 `status=` 和 `mine=0` 必须允许取消
默认值，刷新、复制 URL 和前进后退后状态不丢失。

搜索复用当前 NFKC、拼音首字母、顺序匹配和有界候选排序：最多读取 501 个候选，返回最
相关的 50 条，并显示“继续输入关键词”提示，不把全表加载到客户端。无关键词按
`updatedAt desc, id asc` 稳定分页。

Project 卡片至少展示：

- 默认/自定义头像、名称、状态；
- 内容摘要；
- 负责人、参与人数；
- 已完成 Task 数 / Task 总数；
- “打开 Project”链接。

长名称、长成员名和长内容必须换行或截断，桌面和 Pixel 5 均不得产生页面横向滚动。

### 9.3 创建与编辑表单

视觉沿用 `main` 旧 Project 表单的纵向卡片、标签、异步反馈和首个错误定位，但只包含本计划
字段：

1. Project 头像：默认预览、上传、恢复默认；
2. Project 名称；
3. Project 内容：使用 Textarea；
4. Project 负责人；
5. Project 参与人员；
6. 纳入已有 Task（创建/重提时可选）；
7. 单一主按钮。

成员选择复用当前异步 Person 搜索和已选项 resolver，不一次性 SSR 全部人员。负责人和参与人
两个输入共享同一成员状态：

- 选择参与人后再选为负责人，自动从参与人移除；
- 负责人改为参与人时执行反向转换；
- 删除当前操作者自己的负责人身份若会失权，前端禁用并解释，服务端再次拒绝；
- 停用人员只可作为既有成员只读恢复，不能新增。

创建主按钮为“提交立项”；DRAFT 编辑为“修改并重新提交”；ACTIVE 编辑为“保存修改”。
提交期间禁用重复操作，错误就近显示并聚焦首个字段；服务器错误留在表单内。离开有未提交
修改的表单需要确认。自定义头像失败不能留下无业务归属文件。

### 9.4 Project 详情

详情页采用纵向信息架构，不引入 TimeCanvas：

1. 返回 Project 列表；
2. 头像、名称、状态和生命周期操作；
3. Project 内容；
4. 负责人和参与人员；
5. 立项申请状态、当前轮次和审批意见；
6. Task 列表及完成进度；
7. 最近 Project 审计事件。

能力与状态决定按钮：

- `PENDING_APPROVAL`：全局管理员显示“通过/驳回”；其他人只读；
- `DRAFT`：原申请人、Owner、管理员显示“修改并重新提交”，Owner/管理员另显示删除；
- `ACTIVE`：Owner/管理员显示编辑、结束、删除；
- `COMPLETED`：全部只读。

结束和删除均使用明确的二次确认 Dialog。结束确认展示阻塞 Task；删除确认明确说明
“Project 会删除，Task 不会删除，只会变为无所属 Project”。

Task 列表复用现有 Task 状态、优先级、成员和工作台入口，但查询固定在当前 Project；支持
长列表分页，不把所有 Task 或计划节点一次加载。详情页不得因某个 Task 数据异常而泄露内部
错误或使整个页面产生 Next.js error overlay。

### 9.5 Task 页面联动

- Task Composer 基本信息增加可选“所属 Project”，与“关联 Task”是两个独立字段。
- ACTIVE Task 统一编辑 Dialog 同样增加该字段，仍使用单一“保存修改”按钮。
- Task 详情和 Task 列表卡片存在归属时展示 Project 头像、名称和详情链接；为空不占位。
- 从 Project 详情点击“新建 Task”进入 `/progress/tasks/new?projectId=...` 并预选当前 ACTIVE
  Project；服务端仍验证 Project 状态。
- Task 模板复制可以继承 `projectId` 作为预填，但目标已不可用时清空并提示，不静默提交旧 ID。
- Revision Composer 顶部只读展示所属 Project，不允许借 Revision 修改关系。

## 10. 审计、审批待办与通知

### 10.1 审计事件

至少记录：

- `pm.project.establishment.submit/resubmit/approve/reject`；
- `pm.project.metadata.update`、`pm.project.avatar.update`；
- `pm.project.members.update`、`pm.project.member.auto_add`；
- `pm.task.project.assign/move/remove`；
- `pm.project.complete/delete`。

审计保存 actor Account/Person、Project、必要 Task、前后状态、轮次、成员/Task 数量和有界差异。
Project 内容等长正文使用摘要或 hash，不能在审计 metadata 中无界复制。自动成员新增必须说明
来源 Task。

### 10.2 Action Inbox

新增 `PROJECT_ESTABLISHMENT` 待办类型：

- 仅两种全局管理员可以看到；
- 指向 Project 详情审批区域；
- 同一 request 只产生一项；
- 审批、驳回或删除后立即消失；
- 与现有 Milestone/Revision 待办一起排序并计入首页行动待办数量。

### 10.3 通知事件

扩展 `PROJECT` category 和项目通知 payload，至少包含操作者、Project 名称/ID、动作、状态变化、
轮次、负责人、Task 数量和详情链接。

| 事件 | 收件人 | purpose / bot |
|---|---|---|
| 提交/重提立项 | 全部可用全局管理员 | `approval_request` / 审批机器人 |
| 通过/驳回 | 原申请人、本轮提交人、Project 成员 | `notification` / 通知机器人 |
| 人工或自动加入成员 | 被加入人员 | `notification` / 通知机器人 |
| Task 加入、移动、移出 | Task 成员、相关 Project Owner | `notification` / 通知机器人 |
| Project 结束或删除 | 申请人、Project 成员 | `notification` / 通知机器人 |

事件键必须绑定 `projectId + request round`、Project `lockVersion` 或 Task `lockVersion`，保证重试
幂等。业务状态、站内通知和 outbox 在同一事务写入；Service 不直接发送飞书。自动化测试设置
`NOTIFICATION_DELIVERY_DISABLED=true`，只验证站内通知、outbox、payload、botKind、收件人
去重和投递保护，绝不联系真实收件人。

Project 普通内容更新本轮只写审计，不给所有成员发送消息，避免每次文字保存产生通知噪音；
成员、归属、审批、结束和删除仍按上表通知。

## 11. 查询、性能和安全边界

- Project 列表只 select 卡片需要的字段和计数，不 include 全部 Task、成员或申请历史。
- Project 详情的 Task、审计和申请历史分别有界分页，单页默认 50、最大 100。
- Project option 搜索和批量 resolver 遵守现有 50/501、游标绑定、授权过滤和请求竞态规则。
- 所有 ID、URL 参数、图片、成员、Task 和状态都在 Server Action 边界用 Zod 验证。
- 选择器静默丢弃不可见/不可用对象；mutation 对伪造引用返回中文字段错误。
- Project 头像走受保护 `/uploads/...`，校验路径、所有权、真实 MIME 和大小，禁止 SVG 和路径穿越。
- Project 删除、审批、完成、成员同步和 Task 移动都必须考虑重复请求、stale 版本和并发状态变化。
- 所有列表和详情保持全员可见，但删除对象统一脱敏 404；不通过不同错误暴露对象存在性。

## 12. 实施拆分

### 阶段 1：Schema、migration 与基础授权

- 新增 Project、成员、申请轮次、申请 Task、Task.projectId、头像和 Project 审计/通知关联；
- 建立数据库约束和索引；
- 增加 Project action 字符串、`projectReadableWhere` 和 capability；
- 完成 migration 空库/前置链测试。

### 阶段 2：立项生命周期与通知契约

- 实现创建、驳回、重提、批准、ACTIVE 修改、完成和删除；
- 同步完成审计、站内通知、outbox、审批机器人 contract 和 Action Inbox；
- 覆盖幂等、权限撤销、状态竞争和 late-failure 全事务回滚。

### 阶段 3：Task 关系与成员同步

- 为 Task create/DRAFT/ACTIVE metadata 契约传播 `projectId`；
- 实现申请批准批量挂载、Task 移动/移除和持续成员同步；
- 实现统一跨聚合锁顺序、Task/Project lockVersion 和关系审计；
- 覆盖 Project 删除脱离 Task、完成门禁和并发移动。

### 阶段 4：Project UI

- 侧栏、路由、列表搜索、创建/编辑、详情、审批和确认 Dialog；
- 默认/自定义头像、异步成员和 Task 选择器；
- Desktop `1440x1000` 与 Pixel 5 的完整响应式、错误和极端状态。

### 阶段 5：Task UI 联动与文档

- Task Composer、ACTIVE 编辑 Dialog、Task 列表/详情的 Project 字段和链接；
- Project 详情预填新建 Task；
- 更新 `README.md`、`docs/TECH.md`、`docs/TESTING.md`、`docs/NOTIFICATIONS.md`；
- 清理已经不正确的“旧 `/progress/projects/*` 全部重定向”说明。

每个阶段都必须是可迁移、可回滚代码版本；不能先上线允许 `projectId` 写入但没有服务端授权和
成员同步的半成品。

## 13. 自动化测试要求

### 13.1 领域与权限

- 普通账号可创建/查看，但不能修改、审批、结束或删除非本人管理 Project；
- Participant 只读，Owner 允许路径，Owner 自我移除拒绝；
- 两种全局管理员均可审批，旧项目角色和报销角色不能审批；
- pending 只读、DRAFT 仅原申请人/Owner/全局管理员重提、COMPLETED 全面只读；
- 负责人/参与人互斥、至少一名 Owner、停用人员和 50 项上限；
- approve/reject/self-review、重复回调、角色撤销竞争和 request 单一 pending 约束。

### 13.2 Task 关系与生命周期

- 立项提交不改变 Task，批准后原子挂载全部 Task；
- 伪造 Task、无 Task 编辑权、Task 已被其他 Project 占用时整笔失败；
- Task 创建、DRAFT 编辑、ACTIVE 编辑的 assign/move/remove；
- Task 加入和后续新增成员自动成为 Project Participant；Project Owner 不降级；
- Task 移除成员/移出 Project 不自动删除 Project Participant；
- 仍关联 Task 的 Project Participant 不能人工删除；
- 0 Task、混合状态、FAILED/CANCELLED/TIMEOUT/ARCHIVED 和全部 COMPLETED 的结束门禁；
- 删除 Project 后 Task 保留且 `projectId=null`；
- 并发 approve/move/delete/complete/member change exactly-once，无部分成员、关系、审计或通知。

### 13.3 通知与上传

- 每个事件的站内通知、outbox、收件人、完整 payload、event key 和 botKind；
- late outbox failure 回滚业务写入；删除冻结 pending 审批；
- `NOTIFICATION_DELIVERY_DISABLED=true` 下不发生真实发送；
- 头像类型伪造、超限、路径穿越、未登录、替换失败、事务失败补偿和删除清理。

### 13.4 Playwright UI

所有新/改 UI 在 Desktop 和 Pixel 5 两个项目执行：

- Project 导航位于 Task 之前，选中状态和移动 Drawer 正确；
- 列表默认“我的 + 进行中”，也能显式取消并由 URL 恢复；
- 搜索、状态、空结果、50 条提示、超长名称/内容/成员；
- 默认头像、自定义头像和失败反馈；
- 创建必填、互斥成员、可选 0 参与人/0 Task、重复提交；
- 申请人待审、管理员审批/驳回、DRAFT 重提、Owner 修改/结束/删除；
- Task 表单 Project 选择、详情链接、自动成员结果和 stale Project；
- 权限受限按钮、脱敏 404、无 Next.js error overlay、无未捕获浏览器错误、无横向滚动。

执行完成前必须实际运行：

```bash
npm run check
npm run test:e2e
npm run build
npm run db:deploy
```

测试只能使用 Playwright runner 创建的隔离 PostgreSQL 和禁发通知环境；不能为了运行测试绕过
数据库、端口、收件人或 outbox 安全门禁。

## 14. 验收标准

1. 所有登录用户能在 Task 上方进入 Project，查看和搜索全部未删除 Project。
2. 任意登录用户能提交字段完整的立项；只有全局管理员能批准或驳回。
3. 驳回保持同一 Project 和历史轮次，原申请人能修改重提。
4. Project 成员满足负责人/参与人互斥和至少一名负责人；Owner 不能让自己意外失权。
5. Project 不授予任何 Task 权限，Task 也不授予 Project 修改权限。
6. Task 可空归属且最多属于一个 Project；只有 ACTIVE Project 可成为新归属目标，立项未批准
   前不改变 Task。
7. Task 加入 Project 及后续新增 Task 成员时，缺少的 Project Participant 在同一事务自动补齐。
8. Project 只有在至少一个关联 Task 且全部严格 `COMPLETED` 时才能结束。
9. 中途删除 Project 后 Project 不可见，Task、计划、成员和历史仍存在且 `projectId=null`。
10. 所有写操作通过服务端权限、状态和乐观锁校验，并产生正确的审计及必要通知。
11. 自定义头像安全受控；没有头像时所有页面一致显示默认图标。
12. Desktop 与 Pixel 5 完成主流程、长内容、空状态、错误、只读和并发提示验收，无横向溢出。

## 15. 完成定义

只有在 schema/migration、服务端授权、状态机、Task 联动、成员同步、审计通知、Project UI、
Task UI、双视口 E2E 和文档全部完成后，才可认为本计划实现完成。仅增加 Project 表、仅增加
侧栏页面、或只在客户端隐藏按钮都不构成可发布版本。
