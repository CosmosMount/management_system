# 可执行任务清单（WBS）

## 使用方式

- `Owner` 是主执行人，`Review` 是必须审查人。
- `PD` 为人日粗估，不含等待业务确认。
- 每项关闭前必须提交代码/文档、测试证据和审查结论。
- 真实排期时把代号替换为姓名，不要多人共同 Owner。

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
| P4-02 | 实现 Task 创建三步向导 | FE-A | BO/QA/TL | P2-03 | 表单/E2E | 3 |
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

## P6 Resource UI 与通知

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
