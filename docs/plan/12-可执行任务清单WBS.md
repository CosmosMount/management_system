# 可执行任务清单（WBS）

## 使用方式

- `Owner` 是主执行人，`Review` 是必须审查人。
- `PD` 为人日粗估，不含等待业务确认。
- 每项关闭前必须提交代码/文档、测试证据和审查结论。
- 真实排期时把代号替换为姓名，不要多人共同 Owner。
- P0–P8 是原领域 WBS，任务存在不等于已经关单；当前代码状态和 S0–S10 的关单证据见本文后半部分。
- 状态只使用：**已实现**（当前代码及当前验证证据齐全）、**计划**（尚未完成阶段门禁）、**延期**（不进入本轮）。`345b5b0` 的首批卡片/列表 UI 只能作为接入基线，不能作为 TimeCanvas、Task Composer 或页面完成态证据。

## P0 规则与基线

| ID | 工作 | Owner | Review | 依赖 | 交付与测试 | PD |
|---|---|---|---|---|---|---:|
| P0-01 | 固化“无 Project，仅 Task + Tag”ADR | TL | BO/SEC | 无 | ADR 签字 | 0.5 |
| P0-02 | 固化 Task/Node/Review/Revision 状态表 | BO | TL/QA | P0-01 | 状态矩阵用例 | 1 |
| P0-03 | 确认 Revision 审批与自审策略 | BO | TL/SEC | P0-02 | 决策记录 | 0.5 |
| P0-04 | 确认 Task 可见性与组织范围 | BO | TL/SEC | P0-01 | 权限矩阵 | 0.5 |
| P0-05 | 盘点采购/反馈/共享表数量、关系与稳定 hash | DBA | TL/QA | 无 | 只读 JSON 报告 | 1 |
| P0-06 | 建立采购“不允许改变行为”基线 | QA | TL | 无 | 采购回归清单 | 1 |
| P0-07 | 确认 schema 发布共享数据保护清单 | TL | BO/DBA/SEC | P0-05 | 模型/FK/数据清单 | 1 |
| P0-08 | 建 UAT、性能和发布成功标准 | QA | BO/TL/DBA | P0-02 | 签字模板 | 1 |

## P1 Schema、身份与授权骨架

| ID | 工作 | Owner | Review | 依赖 | 交付与测试 | PD |
|---|---|---|---|---|---|---:|
| P1-01 | 设计 Account/Identity/Person Prisma 模型 | BE-B | TL/SEC | P0 | schema + ER | 1.5 |
| P1-02 | 设计 Task/Tag/TaskMember 模型 | BE-A | TL/DBA | P0 | schema + constraints | 1.5 |
| P1-03 | 设计 Plan/Node 三子类型模型 | BE-A | TL/DBA | P1-02 | schema + migration SQL | 2 |
| P1-04 | 设计 Review/Evidence 模型 | BE-A | TL/SEC | P1-03 | schema | 1 |
| P1-05 | 设计 Segment/Source/History 模型 | BE-B | TL/DBA | P1-01 | schema + checks | 1.5 |
| P1-06 | 设计 Conflict 模型和 fingerprint | BE-B | TL/QA | P1-05 | schema +规则说明 | 1 |
| P1-07 | 设计 InAppNotification/Preference/Audit | BE-B | TL/SEC | P1-01 | schema | 1 |
| P1-08 | 编写部分唯一索引与 check migration | BE-A | DBA/TL | P1-02~07 | isolated PG 通过 | 2 |
| P1-09 | 实现飞书 User -> Account/Person 解析 | BE-B | TL/SEC | P1-01 | 登录集成测试 | 2 |
| P1-10 | 实现 action enum 与 authorize 骨架 | BE-B | TL/SEC | P0-04 | 允许/拒绝测试 | 2 |
| P1-11 | 实现 readableWhere 骨架 | BE-B | TL/SEC | P1-10 | 列表防枚举测试 | 1.5 |
| P1-12 | 建共享身份 backfill dry-run/APPLY 框架 | BE-A/BE-B | DBA/TL/SEC | P1-01 | 幂等/无写入测试 | 1.5 |
| P1-13 | 更新 Prisma 生成、连接和 stale client 检查 | BE-A | TL | P1-08 | `npm run check` | 1 |
| P1-14 | 执行采购身份/权限/通知基线回归 | QA | TL | P1-09 | 回归报告 | 1.5 |

## P2 Task、Plan 与 Node

| ID | 工作 | Owner | Review | 依赖 | 交付与测试 | PD |
|---|---|---|---|---|---|---:|
| P2-01 | 实现 Task/Plan/Node 纯状态机 | BE-A | TL/QA | P1 | 表驱动测试 | 2 |
| P2-02 | 实现计划单链和 Termination 验证 | BE-A | TL/QA | P2-01 | 非法链测试 | 2 |
| P2-03 | 实现 createTaskDraft 事务 | BE-A | TL/SEC | P2-02 | 幂等/回滚测试 | 2 |
| P2-04 | 实现 activateTask 与唯一 Active | BE-A | TL/DBA | P2-03 | 并发测试 | 2 |
| P2-05 | 实现 Task metadata/Tag 更新 | BE-A | TL | P2-03 | 乐观锁测试 | 1.5 |
| P2-06 | 实现 TaskMember 管理 | BE-B | TL/SEC | P1-10 | 权限变化测试 | 1.5 |
| P2-07 | 实现 Tag CRUD | BE-B | TL | P1-02 | 不影响 Task 测试 | 1 |
| P2-08 | 实现 getTaskWorkspace 查询 | BE-A | TL/FE-A | P2-03 | query count/权限 | 2 |
| P2-09 | 实现 Plan Version/Node 查询和分页 | BE-A | TL | P2-03 | 200 Node 测试 | 1.5 |
| P2-10 | 实现 DomainAuditEvent 事务 helper | BE-B | TL/SEC | P1-07 | append-only 测试 | 1.5 |
| P2-11 | 实现 InAppNotification 事务 helper | BE-B | TL | P1-07 | 回滚一致性测试 | 1.5 |
| P2-12 | P2 独立设计/代码审查与修复 | TL | SEC/QA | P2-01~11 | 无高风险问题 | 2 |

## P3 Revision、Review、Termination

| ID | 工作 | Owner | Review | 依赖 | 交付与测试 | PD |
|---|---|---|---|---|---|---:|
| P3-01 | 实现 Plan diff（结构/字段） | BE-A | TL/QA | P2 | diff fixtures | 2 |
| P3-02 | 实现 Revision draft CRUD | BE-A | TL/SEC | P3-01 | 乐观锁测试 | 2 |
| P3-03 | 实现 Revision submit/reject/cancel | BE-A | TL | P3-02 | 状态测试 | 1.5 |
| P3-04 | 实现 Revision approve 与防自审 | BE-A | SEC/TL | P3-03 | 允许/拒绝测试 | 1.5 |
| P3-05 | 实现 applyRevision 原子事务 | BE-A | TL/DBA | P3-04 | 故障注入测试 | 3 |
| P3-06 | 实现并发基线冲突和草稿重建 | BE-A | TL/QA | P3-05 | 双 Revision 测试 | 2 |
| P3-07 | 实现 Review evidence/submit | BE-A | TL/SEC | P2 | 附件权限测试 | 2 |
| P3-08 | 实现 Review 四结果与多次记录 | BE-A | TL/QA | P3-07 | 历史/最新结果测试 | 2 |
| P3-09 | 实现 Approved 推进下一 Node | BE-A | TL/DBA | P3-08 | 并发审批测试 | 2 |
| P3-10 | 实现 Review revoke/受限纠错 | BE-A | SEC/TL | P3-09 | 补偿审计测试 | 2 |
| P3-11 | 实现四种 Termination | BE-A | TL/QA | P3-09 | 前置/幂等测试 | 2 |
| P3-12 | 新事件入队和收件人计算 | BE-B | TL/SEC | P3-03~11 | 禁发通知测试 | 2 |

## P4 Task UI

| ID | 工作 | Owner | Review | 依赖 | 交付与测试 | PD |
|---|---|---|---|---|---|---:|
| P4-01 | 重做导航和 Task 列表 | FE-A | BO/QA | P2-08 | URL 筛选 E2E | 2 |
| P4-02 | 实现单页 Task Plan Composer | FE-A | BO/QA/TL | P2-03/S2 | 本地草稿/表单/E2E | 3 |
| P4-03 | 实现计划节点编辑与键盘排序 | FE-A | QA/SEC | P2-02 | a11y E2E | 3 |
| P4-04 | 实现 Task 工作台骨架 | FE-A | BO/TL | P2-08 | 空/只读/错误 | 2 |
| P4-05 | 实现 Current Plan 时间线 | FE-A | BO/QA | P2-09 | 200 Node | 2 |
| P4-06 | 实现 Revision 编辑器 | FE-A | TL/QA | P3-02 | 冲突 UI E2E | 3 |
| P4-07 | 实现版本比较 | FE-A | BO/QA | P3-01 | 新删移改用例 | 2 |
| P4-08 | 实现 Review/Termination 面板 | FE-A | BO/QA | P3-08~11 | 主流程 E2E | 3 |
| P4-09 | 实现 Tag 管理 | FE-B | QA | P2-07 | 删除不删 Task | 1.5 |
| P4-10 | 移动端与极端状态修复 | FE-A | QA | P4-01~09 | Pixel 5 报告 | 2.5 |

## P5 Work Segment 与 Conflict

| ID | 工作 | Owner | Review | 依赖 | 交付与测试 | PD |
|---|---|---|---|---|---|---:|
| P5-01 | 实现 Segment 校验和状态机 | BE-B | TL/QA | P1-05 | 边界测试 | 2 |
| P5-02 | 实现 Planned/Actual CRUD | BE-B | TL/SEC | P5-01 | 权限/乐观锁 | 2 |
| P5-03 | 实现批量创建/移动 | BE-B | TL/QA | P5-02 | 100 条全回滚 | 2 |
| P5-04 | 实现拆分/合并 | BE-B | TL/QA | P5-02 | 覆盖守恒测试 | 2 |
| P5-05 | 实现确认/部分确认与来源关系 | BE-B | TL/DBA | P5-02 | 多对多来源 | 2.5 |
| P5-06 | 实现取消/软删除/重关联 | BE-B | TL/SEC | P5-02 | 历史测试 | 1.5 |
| P5-07 | Revision 标记受影响 Planned | BE-A | TL/BE-B | P3-05/P5-02 | Actual 不变测试 | 1 |
| P5-08 | 实现 Allocation 重叠算法 | BE-B | TL/QA | P5-01 | 边界时间测试 | 2 |
| P5-09 | 实现 Conflict 规则和 fingerprint | BE-B | TL/QA | P5-08 | 幂等扫描 | 2 |
| P5-10 | 实现 acknowledge/resolve/ignore | BE-B | TL/SEC | P5-09 | 状态/权限 | 1.5 |
| P5-11 | 实现 suggestion preview/apply 分离 | BE-B | TL/QA | P5-10 | preview 无写入 | 1.5 |
| P5-12 | 实现增量 cron 与完整性巡检 | BE-B | DBA/TL | P5-09 | 重入/性能 | 2 |
| P5-13 | 100k Segment 性能与索引调优 | DBA | TL/BE-B | P5-12 | query plan 报告 | 2 |

### P5 重新关单工作包

`2499952` 中的 handoff 是 `e0317cc` 在 2026-07-29 01:00 CST 的历史快照；`345b5b0` 是后续 notification adapter 与首批 UI，`f96ddd37` 冻结了再次关单的执行基线。S1 现已完成 P5-R01～R05：R01=`87635a5b`，R02/R03=`bb72c469`（同一提交），R04=`414d14f4`，R05=`8d0e494`。R04 中 merge 31 天与缺失 Allocation 回归随 `bb72c469` 先落地，操作者与 Current Plan 通知由 `414d14f4` 最终关闭。R02/R03 的既有归档记录为 `npm run check`、四个 spec 双视口 `104/104`、关键 13 标题三轮 `39/39`；R01 以 Conflict 权限/capability 定向回归、R04 以三份受影响 Playwright spec 的通过归档和当前全量回归取证，不补造各自未留档的测试数字。

R05 是最终安全与回归关单：真实 100 条末项 stale 对 Segment/change/audit/outbox 全回滚、完整来源关系、stale apply 及 scan/reopen/transition 等并发用例已进入当前回归；`8d0e494` 又补齐 Playwright 飞书外联 fail-closed、Prisma checkpoint 禁用和 callback 身份隔离。最终实际结果只有以下一套：`npm run check` 通过；`tests/feishu-delivery-guard.spec.ts`、`tests/feishu-procurement-confirm-card.spec.ts`、`tests/business-flows.spec.ts` 双视口 `62/62`；`npm run build` 通过；全量 E2E `326 passed`、30 条既有条件性 skip、`0 failed`；`strace` 定向集 `16/16`，无 DNS 流量、非回环 INET 连接或 Feishu/Lark/Prisma checkpoint 外联。

S1 完成不等于原 P5 全部完成。P5-12/P5-13 的 cron 跨实例运维、checkpoint/增量与每日完整扫描、100k Segment 性能和索引报告仍明确留在 S9；S3–S8 的 TimeCanvas/TimeAgenda 与页面完成态也仍为计划。

| ID | 工作 | Owner | Review | 依赖 | 交付与测试 | 状态 |
|---|---|---|---|---|---|---|
| P5-R01 | 收紧 suggestion preview 隐私与 Conflict capability | BE-B | SEC/TL | P5-10/11 | 隐藏 Segment/只读用户/允许拒绝/capability 测试 | 已实现（`87635a5b`） |
| P5-R02 | 并发关单（与 P5-R03 同一提交）：transition guarded update 与 scanner/人工处理竞争控制 | BE-B | TL/DBA | P5-09/10 | 并发无重复 change/audit/outbox | 已实现（`bb72c469`） |
| P5-R03 | 并发关单（与 P5-R02 同一提交）：person 级 transaction advisory lock、fingerprint 首次竞争与 reopen | BE-B | DBA/QA | P5-09 | 数据库级 person 互斥/首次并发/reopen 测试 | 已实现（`bb72c469`，同 R02） |
| P5-R04 | 补 merge 31 天、缺失 Allocation、操作者和 Current Plan 通知不变量 | BE-A/BE-B | TL/QA | P3/P5 | 31 天/完整解释/人工与系统 actor/新 Current Plan payload 回归 | 已实现（`414d14f4`） |
| P5-R05 | 补真实 100 条回滚、来源、stale apply、并发及测试外联安全回归 | QA/BE-B | TL/SEC | P5-R01~04 | P5 定向 + 双视口 + build + 全量 E2E + strace | 已实现（`8d0e494`） |

## P6 Resource UI 与通知

`345b5b0` 已落地本次 P4/P6 的首批接入基线：`/progress` 四卡片总览、Task 列表、纵向卡片 Task 工作台、表单/卡片资源页、资源冲突中心、站内通知中心和项目管理 notification channel adapter。该状态不等于 P4/P6 已关闭；TimeCanvas/TimeAgenda、单页 Composer、个人时间线、待办、Tag、通知偏好和完成态页面仍按 S3–S8 实施，S9 只负责性能、无障碍、运维和正式文档关单。

| ID | 工作 | Owner | Review | 依赖 | 交付与测试 | PD |
|---|---|---|---|---|---|---:|
| P6-01 | 实现资源时间轴查询 | BE-B | TL/DBA | P5 | p95 测试 | 2 |
| P6-02 | 实现桌面资源时间轴 | FE-B | BO/QA | P6-01 | 拖拽 E2E | 3 |
| P6-03 | 实现移动端人员日列表 | FE-B | QA | P6-01 | Pixel 5 | 2 |
| P6-04 | 实现批量/确认/拆分交互 | FE-B | BO/QA | P5/P6-02 | 业务 E2E | 3 |
| P6-05 | 实现 Conflict 中心与详情 | FE-B | BO/QA | P5-10 | 解释/解决 E2E | 2 |
| P6-06 | 实现站内通知列表与未读 | FE-B/BE-B | TL/QA | P2-11 | 事务/跳转测试 | 2 |
| P6-07 | 实现通知偏好和强制规则 | BE-B | SEC/TL | P6-06 | 偏好矩阵 | 1.5 |
| P6-08 | 改造 outbox claim/worker | BE-B | DBA/TL | P3-12 | recipient 重试 | 2 |
| P6-09 | 实现 deadline/segment/conflict cron | BE-B | TL/QA | P5-12 | eventKey 幂等 | 2 |
| P6-10 | 采购 outbox 与飞书完整回归 | QA | TL | P6-08 | 回归报告 | 2 |
| P6-11 | 实现项目管理 notification channel adapter | BE-B | TL/SEC | P3-12/P6-08 | payload/recipient/purpose 测试 | 2 |

## P7 Schema 发布准备

| ID | 工作 | Owner | Review | 依赖 | 交付与测试 | PD |
|---|---|---|---|---|---|---:|
| P7-01 | 实现 User -> Account/Person 幂等初始化（若需要） | BE-B | TL/SEC | P1 | dry-run/APPLY 冲突与计数 | 2 |
| P7-02 | 验证新 schema 从空库完整部署 | BE-A/DBA | TL/QA | P1~P6 | migration diff/约束 | 1.5 |
| P7-03 | 实现共享数据行数/hash 对账报告 | QA/BE-A | TL/DBA | P0-07 | 采购/反馈/附件/outbox | 1.5 |
| P7-04 | 静态检查禁止 legacy 字段、旧接口和飞书直连 | QA/BE-B | TL/SEC | P6-11 | `rg` 门禁 | 1 |
| P7-05 | 含共享数据快照发布演练一 | DBA | TL/QA | P7-01~04 | 异常/耗时报告 | 2 |
| P7-06 | 修复演练一问题 | BE-A/BE-B | TL | P7-05 | 回归 | 2 |
| P7-07 | 含共享数据快照发布演练二 | DBA | TL/QA/BO | P7-06 | 零手工 DB 操作 | 2 |
| P7-08 | 整库与上传 volume 恢复演练 | DBA | TL/SEC | P7-07 | 恢复时间/对账 | 1.5 |
| P7-09 | 更新正式 README/TECH/TESTING/NOTIFICATIONS | TL | BO/QA | P7-07 | 文档审查 | 2 |
| P7-10 | 清理后基线审计 | QA/TL | SEC/BO | P7-09 | 无旧数据导入或兼容层 | 1 |

## P8 UAT 与上线

| ID | 工作 | Owner | Review | 依赖 | 交付与测试 | PD |
|---|---|---|---|---|---|---:|
| P8-01 | 执行 `npm run check/build` 与 migration diff | QA | TL | P7 | 命令日志 | 1 |
| P8-02 | 执行领域/集成/E2E 全回归 | QA | TL | P7 | 测试报告 | 2 |
| P8-03 | 执行性能与安全测试 | DBA/SEC | TL/QA | P7 | p95/安全报告 | 2 |
| P8-04 | 业务 UAT | BO | PM/QA | P8-02 | 签字 | 2 |
| P8-05 | 整库备份恢复演练复核 | DBA | TL/QA | P7-08 | 恢复时长 | 1.5 |
| P8-06 | 发布桌面演练和联系人确认 | PM | TL/DBA/BO | P8-01~05 | runbook 签字 | 1 |
| P8-07 | 正式维护窗口 schema 发布 | DBA/TL | BO/QA | P8-06 | 发布记录 | 1 |
| P8-08 | 上线冒烟与采购回归 | QA | TL/BO | P8-07 | 冒烟报告 | 1 |
| P8-09 | 7 天值守、完整性巡检和复盘 | TL/DBA | PM/BO | P8-08 | 复盘与遗留项 | 3 |

## 当前 S0–S10 执行工作包

以下是 P4–P8 的实际执行顺序与当前关单状态。阶段状态必须在代码、测试、独立审查和文档证据齐全后才能由“计划”改为“已实现”。

| 阶段 | 工作包 | 关键交付 | 映射 WBS | 状态 |
|---|---|---|---|---|
| S0 | 基线与追踪矩阵 | 前端 ADR、handoff/345b5b0 时序、计划冲突消除；移动残留 `.next` 到 `.tmp/next-cache-stale-*` 后建立当前检查基线 | P4–P8 协调 | 已实现（`f96ddd37`） |
| S1 | P5 重新关单 | P5-R01~R05；含 person 级 transaction advisory lock、首次 fingerprint、通知不变量和最终安全回归 | P5-03~11（不含 P5-12/13） | 已实现（`87635a5b`～`8d0e494`） |
| S2 | 计划/画布服务端契约 | S2-01~S2-05：计划编辑、Active 可变字段、聚合查询/预览、安全 DTO、错误码与查询上限 | P2/P3/P5/P6-01 | 计划 |
| S3 | Shell 与只读画布 | 左侧导航、TimeCanvas/TimeAgenda、时间数学、`@tanstack/react-virtual`、四种只读模式 | P4-01/04/05,P6-02/03 | 计划 |
| S4 | Segment 画布交互 | Pointer Events brush/drag/resize、键盘/Inspector、全 mutation、stale、批量全成全败；不引入 dnd-kit/日期库 | P5-02~06,P6-04 | 计划 |
| S5 | Task Composer | 单页创建、同日节点、localStorage、撤销重做、幂等和 Pixel 5 | P4-02/03/10 | 计划 |
| S6 | Task 工作台 | 默认计划与资源、Revision/Review/Termination/Audit、角色矩阵 | P4-04~08,P6-01 | 计划 |
| S7 | 资源与个人时间 | Resource Planner、`/progress/my-timeline`、结构化 Conflict Center | P6-01~05 | 计划 |
| S8 | 驾驶舱与通知 | Dashboard、`/progress/approvals`、Tag、偏好、deadline/retention/integrity cron | P4-09,P6-06~11 | 计划 |
| S9 | 性能与运维 | cron 跨实例全局互斥、checkpoint、增量扫描 + 每日完整扫描、100k fixture、p95、无障碍、正式文档 | P5-12/13,P7-09 | 计划 |
| S10 | 发布准备与 UAT 证据 | 空库/快照演练、恢复、全回归、安全、runbook、四方签字 | P7/P8 | 计划 |

S1 的“已实现”仅关闭上述 P5-R01～R05。P5-12/P5-13 仍在 S9，S3–S8 前端阶段仍全部为计划；不得据此把整个 P5 或 TimeCanvas UI 标记为完成。

### S2 服务端契约子任务

| ID | 工作 | 关键契约与验收 | 状态 |
|---|---|---|---|
| S2-01 | 三类 Draft action 与计划版本 | 实现 `updateTaskDraftMetadata`、`replaceTaskDraftMembers`、`replaceTaskDraftPlan`；三者只限 `Task.status=DRAFT`、服务端授权、接收 `expectedLockVersion`，事务写审计并在成功后递增/返回 `lockVersion`。`createTaskDraft`/member replace 收紧为恰好一个 active OWNER、无重复 person+role；只有 plan action 处理 `plannedStartAt?`、chronology、nodeId/clientKey、Segment 引用拒删和整包计划回滚 | 计划 |
| S2-02 | 三类 Active-only action | 实现 `updateTaskMetadata`、`replaceTaskMembers`、`replaceTaskTags`；仅 ACTIVE、服务端授权、`expectedLockVersion`、锁 Task、事务 mutation + DomainAuditEvent + lockVersion increment，并返回新锁；终态/Archived/stale/无权零写入，三者不得改变 plan/node。member replace 保持恰好一个 active OWNER 和 person+role 唯一 | 计划 |
| S2-03 | 搜索与页面查询基础 | People/Task/Tag 游标搜索；Task-scoped、personal timeline、`getMyWorkDashboard` 查询基础 | 计划 |
| S2-04 | TimeCanvas 与放置预览 | `getTimeCanvasData`、Busy 响应级脱敏、对象 capability/versionToken、只读 `previewSegmentPlacement`；最终冲突以 mutation 后服务端复扫为准 | 计划 |
| S2-05 | 稳定错误与查询保护 | `PLAN_CHRONOLOGY_INVALID`、`STALE_TASK`、`STALE_SEGMENT`、`ASSOCIATION_INVALID`、`QUERY_LIMIT_EXCEEDED`；范围最多 366 天，Person/Task/Tag 显式 ID 各最多 50，超过 5,000 个可见 Segment 明确报错且不静默截断 | 计划 |

S2-01 测试必须逐 action 覆盖：具权限 Draft 成功、无权拒绝、非 Draft 拒绝、stale lock 拒绝、成功审计及锁递增/返回、失败零写入；并验证 metadata/member 输入不能进入 `replaceTaskDraftPlan`。`createTaskDraft`/`replaceTaskDraftMembers` 拒绝 0 OWNER、2 个及以上 OWNER、重复 person+role，允许同人不同 role 且权限取并集；保留既有 Draft `task_assigned` 站内 + `mandatory=true` outbox，purpose/botKind 为 notification 且只用通知机器人。plan action 另测关联节点拒删和事务整包回滚。

S2-02 测试必须逐 action 覆盖 ACTIVE 成功，以及 Draft、全部终态、Archived、stale、无权拒绝和同锁并发。`replaceTaskMembers` 另测 active member 整包差异、`removedAt` 历史、恰好一个 active OWNER、0/多 OWNER 拒绝、重复 person+role 拒绝、同人不同 role 权限并集，以及新增/移除/角色变化的完整站内 + `mandatory=true` `project-management` outbox；purpose/botKind 固定 notification、只用通知机器人而非 approval bot。`replaceTaskTags` 另测只改 TaskTag/audit 且不广播，Draft tags 只走 `updateTaskDraftMetadata`。

## 本轮延期工作包

| ID | 能力 | 状态 | 重新纳入前置条件 |
|---|---|---|---|
| DFR-01 | Unavailable Time 模型与扫描 | 延期 | 数据所有权、可见性、审计和冲突规则 ADR |
| DFR-02 | 跨人员 Segment 重新指派 | 延期 | reassign 权限、并发、审计和通知契约 |
| DFR-03 | 保存资源视图 | 延期 | 所有权、分享范围和存储模型 |
| DFR-04 | 自动资源平衡 | 延期 | proposal、人工确认、审计和回滚规则 |
| DFR-05 | 复杂依赖线 | 延期 | 领域模型和可视化性能方案 |
| DFR-06 | Task 创建时初始 Segment | 延期 | 原子创建、权限、失败回滚和草稿契约 |

## 工作包模板

每个任务卡必须包含：

```text
目标：
用户可见结果：
状态前置条件：
允许/拒绝角色：
数据表与事务：
审计事件：
站内/飞书通知：
幂等与并发：
自动化测试：
手工验证：
Schema/共享数据影响：
文档更新：
Owner / Reviewer：
```

## 阶段关单检查

- [ ] 所有任务卡有代码/文档链接。
- [ ] 实际命令和测试结果已记录。
- [ ] 允许与拒绝权限路径已测。
- [ ] 通知未真实误发。
- [ ] 采购回归通过。
- [ ] 独立审查完成且问题关闭。
- [ ] 下一阶段依赖已满足。
