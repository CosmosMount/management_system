# 04. Task 详情工作台

> 状态（2026-08-01）：本文涉及资源冲突、冲突中心、投入比例、冲突通知或冲突扫描的设计已由“删除资源冲突与投入比例”决策取代，仅保留历史背景，不代表当前实现。

## 1. 页面定位

Task 详情应从“对象资料页”升级为“执行工作台”。默认回答四个问题：

1. 当前正在执行哪个 Milestone，什么时候到期？
2. 从现在到下一阶段，参与人分别安排了什么？
3. 计划是否存在资源冲突、未确认投入或关联失效？
4. 当前用户接下来能做什么：创建 Segment、提交验收、发起 Revision、确认终止？

## 2. 推荐页面结构

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ ← Task 列表 | Task 名称 [Active] [高] [Tag]       v3  锁版本 12  [主要动作 ▼] │
│ 当前：M2 前端实现 · 8 月 12 日截止 · 剩余 8 天     2 个冲突 · 1 个待确认       │
├──────────────────────────────────────────────────────────────────────────────┤
│ [计划与资源] [概览] [修订与历史] [验收] [审计]                               │
├──────────────────────────────────────────────────────────────────────────────┤
│ TimeCanvas Toolbar                                                           │
├───────────────┬────────────────────────────────────────────────┬──────────────┤
│ 计划           │ ┃──◆ M1───◆ M2 当前────◆ M3────⚑              │ Inspector    │
├───────────────┼────────────────────────────────────────────────┤              │
│ 张三 / Owner   │    █ Actual █    ░ Planned ░░░   !             │              │
│ 李四 / Dev     │ ░ Busy ░           ░ 当前 Task ░               │              │
│ 王五 / Reviewer│                       ░ Review ░               │              │
└───────────────┴────────────────────────────────────────────────┴──────────────┘
```

## 3. 顶部 Task Header

### 3.1 第一行

- 返回 Task 列表。
- Task 标题，超长时两行或省略 + Tooltip。
- 状态、优先级、关键 Tag。
- 当前计划版本 `vN`。
- 主要动作 Split Button。

### 3.2 第二行执行摘要

- 当前 Active Milestone。
- 截止时间、剩余/逾期天数。
- 当前阶段时间跨度。
- 参与人数。
- Planned/Actual 数量。
- 开放冲突、待确认、需重新关联数量。

摘要项可点击定位对应对象或打开过滤后的 Inspector。

### 3.3 主要动作规则

按状态和权限动态显示：

| 条件 | 主动作 |
|---|---|
| Draft 且可编辑 | `继续编辑计划` |
| Draft 且可激活 | `激活 Task` |
| Active 且可创建 Revision | `发起 Revision` |
| Active Milestone 可提交 | `提交验收` |
| 有待 Review 且当前用户可审 | `处理验收` |
| 到达 Termination 且可终止 | `确认结束` |
| 只读 | `复制链接` 或无主动作 |

其余动作进入 `更多`，不要同时堆十个按钮。

## 4. 标签页

### 4.1 计划与资源（默认）

统一 TimeCanvas，显示计划锚点、参与人 Segment、冲突和其他占用。

### 4.2 概览

- Task 描述。
- team / techGroup。
- Tag 与关联 Task。
- 成员与角色。
- Revision/Review 策略。
- 创建、更新、开始、结束时间。
- 权限摘要。

可编辑字段使用右侧抽屉或内联区块；不应回到一页多个大卡片。

### 4.3 修订与历史

- Current Plan + 历史版本列表。
- Revision 状态、原因、发起人、审批人、时间。
- 版本比较入口。
- Draft Revision 继续编辑。
- 当前版本时间线只读，历史版本默认折叠。

### 4.4 验收

- 当前 Milestone 的目标、条件、验收要求。
- 提交证据。
- Review 历史。
- Approve / Reject / Revision Required 操作。
- 过往 Milestone 验收记录。

### 4.5 审计

- Task 创建、激活、Revision、Review、终止、成员与元数据变化。
- 按事件类型和操作者筛选。
- 只显示业务可读摘要，必要时展开 before/after。

## 5. “计划与资源”默认视图

### 5.1 默认范围

优先围绕当前阶段：

- 左边界：上一个 Milestone 前 3 天；若无上一个则计划开始。
- 右边界：下一个 Milestone 后 7 天；若无下一个则 Termination 后少量留白。
- 若阶段跨度太大，自动切换周/月档位。
- 提供 `适应 Task`、`适应当前阶段`、`今天` 三个快捷入口。

### 5.2 计划轨道

计划轨道固定在人员行上方：

- Current Plan 高对比实线。
- Active Milestone 有外环和“当前”。
- 已完成节点显示实际完成时间。
- Revision 位置显示分支标记。
- Termination 显示终点旗帜。
- Hover 显示目标、完成条件摘要、截止、状态。
- 点击打开节点 Inspector。

### 5.3 人员行

默认只显示当前 Task 的 active members，左侧显示：

- 人员姓名和头像。
- Task role。
- 当前范围内对本 Task 的 Allocation/时长。
- 总占用摘要。
- 冲突数量。

排序默认：Owner → 当前 Milestone 负责人（若模型有）→ 其他角色 → 姓名。支持按冲突、负载、角色排序。

### 5.4 Segment 类型

- 当前 Task 的 Planned/Actual：完整颜色和标题。
- 当前 Task 但其他 Node：颜色一致，节点标签不同。
- 参与人的其他 Task 占用：中性 Busy Block；有权限时可展开标题。
- 独立 Segment：显示“独立安排”或 Busy。
- 已取消：默认隐藏。

### 5.5 关联安排

“与这个 Task 有关的时间安排”包括：

1. 直接 `taskId = 当前 Task` 的 Segment。
2. 直接 `nodeId` 属于当前 Task 的 Segment。
3. relatedTask 的关键 Milestone（可选叠加）。
4. 当前 Task 成员在相同范围内的其他占用（默认 Busy）。
5. 由 Revision 导致 `associationNeedsReview` 的 Segment。
6. 与当前 Segment 形成资源冲突的安排。

每类都必须在图例和筛选中可开关，避免画布信息过载。

## 6. 在 Task 时间线上创建 Segment

### 6.1 主路径

1. 用户在某个人员行拖选一段时间。
2. 画布显示起止时间、时长、与 Milestone 的对齐关系。
3. 松开后弹出 Quick Create：
   - Person：当前行，锁定。
   - Task：当前 Task，锁定但可选择“独立安排”（视权限）。
   - Node：默认当前 Active Milestone，可改为其他可关联节点。
   - Type：默认 Planned。
   - Content：必填。
   - Allocation：默认空或用户个人默认值。
4. 保存后原位生成 Segment。

### 6.2 快速创建卡

保持小而快：

```text
新建计划投入
张三 · 当前 Task · M2
7/30 09:00 — 7/31 18:00

内容 * [前端时间轴交互]
Allocation [80%]

[更多字段]                 [取消] [创建]
```

“更多字段”切换到右侧完整 Inspector，包含 Role、Priority、expectedOutput、Tag 等。

### 6.3 创建权限

- 用户能否为自己创建。
- Task Owner 能否为成员创建。
- 管理者能否跨人员创建。
- Viewer 只能查看。

行的可编辑性由服务端返回 permission flags 决定，不能仅按当前账号是否等于 personId 推断。

## 7. Segment 详情与操作

点击 Segment 后 Inspector 显示：

- Person、Type、Status。
- Start/End、时长、Allocation。
- Content、Role、Priority。
- Task、Node、Tag。
- Expected/Actual Output、Completion %。
- 关联需复核提示。
- 冲突摘要。
- 变更历史入口。

动作按状态显示：

- 编辑 Planned。
- 移动/调整时间。
- 拆分。
- 与相邻兼容 Segment 合并。
- 取消 Planned。
- 确认一致并生成 Actual。
- 部分确认。
- 重新关联 Node。
- Actual 的允许编辑/软删除动作。

危险动作必须使用 Alert Dialog 并说明审计结果。

## 8. Milestone 点击与编辑语义

### 8.1 Draft Task

若当前 Task 为 Draft 且用户有权限：

- 节点 Inspector 可编辑。
- 可进入完整 Draft Plan Composer。
- 修改后保存到服务端草稿接口（需要新增）。

### 8.2 Active Task

- 当前计划节点默认只读。
- Inspector 中显示 `发起 Revision 修改此节点`。
- 点击后以该节点为 revisedFrom/起始上下文创建 Revision Draft。
- 不显示误导性的“保存”按钮。

### 8.3 历史版本

- 只读。
- 提供与 Current 比较。
- 不允许在历史画布中创建或移动 Segment。

## 9. 冲突展示

### 9.1 行内

- 冲突区间顶部显示警示条。
- 冲突点显示图标，点击选中冲突而非单个 Segment。
- 左侧人员行显示范围内冲突数量和最高严重级别。

### 9.2 Inspector

展示：

- 冲突时间范围。
- 涉及 Segment。
- Allocation 总和或触发规则。
- Task、Node、Priority。
- 服务端 explanation。
- 可选建议预览。
- `确认已知`、`调整安排`、`解决`、`忽略至某日`。

不能在 UI 中自动应用建议，必须明确确认。

## 10. 计划与实际对比

在 Toolbar 开启“计划/实际对比”后：

- Planned 与来源 Actual 按同一组显示。
- Actual 可放在 Planned 下方细轨或覆盖进度层。
- 显示偏移：提前/延后、实际时长差、Allocation 差。
- 对部分确认，保留 Planned 未覆盖区间。
- 不把 Actual 简单替换掉 Planned，否则失去计划偏差信息。

## 11. Revision 入口与比较

### 11.1 发起 Revision

从以下位置可发起：

- Header 主动作。
- Milestone Inspector。
- 发现计划时间无法满足时的冲突提示。

创建 Revision 时预填：

- 基线版本和 lockVersion。
- 修订起始节点。
- 修订原因（用户填写）。
- 受影响 Segment 预览。

### 11.2 版本比较

比较视图分三层：

1. **结构差异**：新增、删除、移动、延续节点。
2. **字段差异**：目标、条件、时间、验收要求。
3. **资源影响**：哪些 Planned Segment 需要重新关联或确认。

Task 详情只显示摘要，完整比较可在同路由子视图或全屏 Dialog 中进行。

## 12. 成员与元数据编辑

概览标签内使用轻量 section：

- 标题/描述/组织/优先级/Tag/关联 Task。
- 成员角色表。
- 策略字段。

需要新增后端 metadata/member/tag mutations。保存成功后更新 Header 和 TimeCanvas 行，不整页刷新。

## 13. 权限呈现

- 可编辑：正常控件。
- 只读但可见：文本 + 锁图标，Tooltip 说明原因。
- 不可见字段：不渲染，不用灰色占位泄露存在性。
- 操作因状态禁止：按钮可见但 disabled，并说明“Task 已激活，请通过 Revision 修改”。
- 操作因权限禁止：可选择隐藏或 disabled，统一由产品规则决定；高风险操作倾向隐藏。

## 14. 空状态

| 情况 | 页面表现 |
|---|---|
| 无关联 Segment | 人员空行仍可见；有权限者显示“拖动创建计划投入”。 |
| 无其他占用权限 | 不查询或只显示 Busy；图例解释。 |
| 无成员 | 计划轨道正常显示，主提示“添加成员后安排投入”。 |
| Task Draft 无 Active Milestone | 显示完整计划，Header 主动作“激活 Task”。 |
| Task Archived | 全页只读，显示归档原因/时间（若有）。 |
| 对象已删除/无权限 | 安全不可用页，不展示 Task 名称。 |

## 15. 移动端

- Header 压缩为标题 + 状态 + `•••`。
- 标签页可横向滚动，但页面正文不横溢。
- “计划与资源”改为：
  1. 当前 Milestone 摘要。
  2. 纵向节点时间线。
  3. 按日期分组的成员 Segment 列表。
  4. 浮动 `+ Segment`。
- Inspector 为底部抽屉/全屏表单。
- 冲突和待确认作为可展开提示条。

## 16. P0 验收

- 默认视图能同时看到计划锚点和参与人 Segment。
- 默认范围围绕当前阶段，不要求用户先调日期。
- 在人员行拖选可创建 Planned Segment。
- 点击 Segment 可编辑、移动、取消或确认，权限/状态正确。
- Active Task 节点不能直接修改，能清楚进入 Revision。
- 可切换显示其他占用、Actual、冲突。
- 50 人、当前 30 天范围下滚动和选择可用。
- 刷新 URL 后保留范围、筛选和分组。
- 移动端有独立 Agenda，不显示不可读的缩小甘特图。
