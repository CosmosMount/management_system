# 02. 统一时间画布 TimeCanvas 设计

## 1. 定位

`TimeCanvas` 不是一个固定业务页面，而是项目管理模块的时间可视化与直接操作内核。它同时承载：

- Milestone/Termination 等时间锚点。
- Planned/Actual Work Segment 等时间区间。
- 人员、Task、Node 等行分组。
- 当前时间、工作日、临期、逾期、冲突等覆盖层。
- 框选、拖动、缩放、多选、平移、键盘调整等交互。

页面通过配置决定“显示什么、允许操作什么”，而不是复制一套甘特代码。

## 2. 四种业务模式

```ts
type TimeCanvasMode =
  | "TASK_COMPOSER"      // 创建 Task，编辑计划锚点
  | "TASK_WORKBENCH"     // Task 详情，计划 + 人员 Segment
  | "RESOURCE_PLANNER"   // 多人/多 Task 资源甘特
  | "PERSONAL_TIMELINE"; // 单人可编辑日程
```

| 模式 | 主分组 | 可编辑对象 | 默认范围 | 典型入口 |
|---|---|---|---|---|
| `TASK_COMPOSER` | 单一计划轨道 | Milestone、Termination | 自动适配整个计划 | `/progress/tasks/new` |
| `TASK_WORKBENCH` | 计划轨道 + 参与人 | 有权限的 Planned Segment；Draft 计划节点 | 当前阶段附近 | `/progress/tasks/[id]` |
| `RESOURCE_PLANNER` | Person / Task 切换 | 有权限的 Planned Segment | 14 天 | `/progress/resources` |
| `PERSONAL_TIMELINE` | 当前用户 | 本人的 Segment | 当前周 | `/progress/my-timeline` |

## 3. 画布整体结构

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ Toolbar: 日期范围 | 今天 | 缩放 | 分组 | 筛选 | 图例 | 冲突 | 更多       │
├────────────────┬───────────────────────────────────────────────────────────┤
│ 左侧行标题区    │ 时间轴：周 / 日 / 小时                                    │
│ sticky 240px   ├───────────────────────────────────────────────────────────┤
│ 计划            │ ◆ M1 ────────── ◆ M2 ───────── ◆ M3 ─────── ⚑ 结束       │
├────────────────┼───────────────────────────────────────────────────────────┤
│ 张三  80%       │      ░░ 计划 A ░░░        █ 实际 A █                      │
│ 前端 / Owner    │                  ! 冲突                                   │
├────────────────┼───────────────────────────────────────────────────────────┤
│ 李四  60%       │  ░ 其他占用 ░     ░ 当前 Task 计划 ░░░                    │
├────────────────┼───────────────────────────────────────────────────────────┤
│ 王五            │              [拖选创建中的半透明区间]                     │
└────────────────┴───────────────────────────────────────────────────────────┘
                                                ┌────────────────────────────┐
                                                │ 右侧 Inspector 360px      │
                                                │ Segment / Milestone 详情   │
                                                └────────────────────────────┘
```

### 3.1 固定区域

- **Toolbar**：56px，高优先级操作保持在一行；次要筛选进入 Popover。
- **Row Header**：桌面默认 240px，可在 200–360px 调整并记忆。
- **Time Axis**：两级或三级表头，随缩放粒度变化。
- **Canvas Body**：唯一的横向滚动容器；页面本身不能横向溢出。
- **Inspector**：桌面 360px 右侧面板；移动端为底部抽屉。

### 3.2 图层顺序

从底到顶：

1. 工作日/非工作日背景。
2. 网格线。
3. 计划阶段背景带（可选）。
4. 其他占用 Busy Block。
5. Planned Segment。
6. Actual Segment。
7. Milestone/Termination 锚点。
8. 冲突、逾期、待确认覆盖层。
9. 选择框、拖拽预览、吸附辅助线。
10. 当前时间线和悬浮提示。

图层顺序必须统一，否则不同页面会出现选中框被条形遮住、冲突标识压住文本等问题。

## 4. 时间坐标模型

### 4.1 核心函数

```ts
type TimeScale = {
  rangeStartMs: number;
  rangeEndMs: number;
  viewportWidthPx: number;
  contentWidthPx: number;
  msPerPixel: number;
  snapMs: number;
};

function timeToX(timeMs: number, scale: TimeScale): number;
function xToTime(x: number, scale: TimeScale): number;
function snapTime(timeMs: number, snapMs: number, mode: "round" | "floor" | "ceil"): number;
function intervalToRect(startMs: number, endMs: number, scale: TimeScale): { left: number; width: number };
```

所有 Milestone、Segment、当前时间线和框选区间都使用同一套函数，不允许组件自行计算比例。

### 4.2 缩放档位

| 档位 | 可见范围建议 | 主刻度 | 次刻度 | 默认吸附 |
|---|---|---|---|---|
| 小时 | 1–3 天 | 日 | 30 分钟/1 小时 | 30 分钟 |
| 日 | 7–21 天 | 周 | 日 | 1 天 |
| 周 | 4–12 周 | 月 | 周 | 1 天或 1 周 |
| 月 | 3–12 月 | 月/季度 | 周/月 | 1 周 |

用户通过 `− / +`、Ctrl/Cmd + 滚轮或菜单调整。缩放中心保持在鼠标位置或当前选择对象，而不是每次跳回范围起点。

### 4.3 默认范围策略

- Task 创建：计划开始时间到 Termination，左右各增加约 10% 留白。
- Task 详情：默认“当前阶段”，从上一个 Milestone 前 3 天到下一个 Milestone后 7 天；若没有上下节点则自动扩展。
- 资源甘特：当前日期起 14 天，可切 7/14/30 天或自定义。
- 个人时间线：当前周；“今天”按钮将今天滚到视口中央。

### 4.4 时区

前端内部统一使用绝对时间戳，显示层根据系统确定的业务时区格式化。当前服务端工具固定为 Asia/Shanghai，前端不能自行按浏览器本地时区重解释。时区策略应在页面工具栏或用户设置中清晰显示。

## 5. 行模型与分组

```ts
type TimeCanvasRow = {
  id: string;
  kind: "PLAN" | "PERSON" | "TASK" | "GROUP";
  label: string;
  sublabel?: string;
  avatarUrl?: string;
  height: number;
  collapsed?: boolean;
  editable: boolean;
  capacity?: number | null;
  children?: TimeCanvasRow[];
};
```

### 5.1 Person 分组

左侧显示：头像、姓名、Task 角色、范围内 Allocation 概览、冲突数。可按团队/技术组折叠。

### 5.2 Task 分组

左侧显示：Task 名、状态、优先级、当前 Milestone。适合从多个 Task 角度看时间点与投入。

### 5.3 行高

- 普通 Segment 行：48px。
- 同行重叠需要泳道时：每增加一层 +24px，上限 120px；超出后显示 `+N` 聚合。
- 计划轨道：96–128px，可展示节点标题和日期。
- Group 行：36px。

不要让所有行无限增高，否则滚动性能和空间利用率会恶化。

## 6. 时间锚点视觉语义

| 对象 | 形态 | 附加信息 |
|---|---|---|
| Milestone Pending | 空心菱形 | 下方标题、日期 |
| Milestone Active | 实心/高对比菱形 + 外环 | “当前”标签、距截止时间 |
| Milestone Submitted | 菱形 + 时钟/待审图标 | “待验收” |
| Milestone Completed | 菱形 + 对勾 | 实际完成日期 Tooltip |
| Milestone Revised | 弱化菱形 + 分支箭头 | 指向新版本或 Revision |
| Revision | 分支节点/橙色圆角标记 | 原因摘要、版本号 |
| Termination | 旗帜/终点线 | 计划终止时间 |
| Overdue | 状态图标 + 警示描边 | 显示逾期天数，不只变红 |

同一天多个节点采用垂直堆叠与轻微横向错位；缩小到月级时聚合为 `3 个节点` 标记，点击展开 Popover。

## 7. Segment 视觉语义

### 7.1 Planned

- 浅填充或斜纹。
- 虚线/弱实线边框。
- 左侧显示内容，空间不足时省略。
- 末端显示 Allocation 或时长摘要。

### 7.2 Actual

- 实填充。
- 较稳定的实线边框。
- 可叠加完成比例进度层，但不改变区间长度。

### 7.3 状态覆盖

| 状态 | 表达 |
|---|---|
| 待确认 | 右上角时钟徽标 + “待确认” Tooltip |
| 部分确认 | Planned 剩余区间与 Actual 已确认区间同时显示，并用来源连线/同组标识 |
| 取消 | 默认不在主画布显示；开启历史后以低透明度和删除线显示 |
| 需重新关联 | 链接断开图标 + 警示边框 |
| 冲突 | 区间顶部警示条 + 冲突图标；选中后显示涉及对象和规则 |
| 无权限详情 | 中性“忙碌”块，只显示时间和占用程度 |

### 7.4 重叠布局

同一行重叠 Segment 采用小型泳道，不允许完全覆盖。若重叠数量过多：

- 行高达到上限后聚合。
- 聚合块显示数量、总 Allocation 和冲突状态。
- 点击聚合块在 Inspector 中列出全部区间。

## 8. 核心交互状态机

```ts
type InteractionMode =
  | { type: "IDLE" }
  | { type: "PANNING"; originX: number }
  | { type: "BRUSH_CREATING"; rowId: string; anchorMs: number; cursorMs: number }
  | { type: "DRAGGING_SEGMENT"; segmentId: string; originalStartMs: number; originalEndMs: number }
  | { type: "RESIZING_SEGMENT"; segmentId: string; edge: "START" | "END" }
  | { type: "DRAGGING_MILESTONE"; nodeId: string; originalAtMs: number }
  | { type: "RANGE_SELECTING"; ids: string[] }
  | { type: "KEYBOARD_MOVING"; entityId: string };
```

同一时刻只能处于一个主交互状态。打开 Inspector 不算主交互状态。

### 8.1 点击

- 单击空白：清除选择。
- 单击对象：选中并打开/更新 Inspector。
- Ctrl/Cmd + 单击：加入或移出多选。
- 双击空白行：在吸附后的时间创建默认长度 Segment。
- 双击计划轨道：创建 Milestone。

### 8.2 框选创建 Segment

1. 鼠标在可编辑人员行空白处按下。
2. 横向拖动显示半透明预览区间和起止时间。
3. 松开后若区间小于最小单位，则按默认时长扩展。
4. 打开轻量 Quick Create 卡片，预填 person、task、node、start、end。
5. 用户输入内容后保存；按 Esc 取消。
6. 服务端成功后变成正式 Segment；失败则移除预览并保留表单输入。

按住 Space 或中键应切换为平移，防止用户想滚动画布却误创建。

### 8.3 拖动 Segment

- 只能拖动 Planned 且具备权限的 Segment。
- 默认保持时长不变，按当前缩放档位吸附。
- 拖动时显示原位置轮廓、新起止时间、与相邻对象的对齐线。
- 超出当前范围时边缘自动滚动，但速度有上限。
- 松开后先保持乐观位置，调用 move/update action。
- 成功：显示轻量 Toast，并更新版本时间。
- 冲突或权限失败：原位回滚，Inspector 显示服务端原因。
- 陈旧数据：回滚并提示“该安排已被其他人修改”，提供刷新后重新应用。

### 8.4 缩放 Segment

- Hover/选中时显示左右 Resize Handle，最小可点击宽度 12px。
- 开始端不能超过结束端减最小区间。
- 跨日与工作时段限制只做提示，除非业务规则明确禁止。
- 按 Alt 可临时关闭吸附；键盘路径使用精确日期输入。

### 8.5 移动 Milestone

- 仅 Task Composer 或 Draft Plan 模式可直接拖动。
- Active Task 当前计划只显示锁图标，拖动时不启动；点击后给出“发起 Revision”。
- 移动时自动重排节点顺序，但相同日期节点保留显式 sequence。
- 若拖到相邻节点之外，显示“将从第 2 节点移动至第 4 节点”。
- Termination 只能沿时间轴移动，不能拖到最后一个 Milestone 之前。
- 完成节点在 Revision 画布只读。

### 8.6 多选与批量操作

- Ctrl/Cmd 点击或框选多个 Segment。
- 批量工具条浮在画布下方：平移、取消、确认、批量修改 Task/Node、清除选择。
- 只展示所有已选对象共同允许的动作。
- 混合 Planned/Actual 时禁止不适用动作并解释原因。
- 批量平移显示统一偏移量，不逐项输入新日期。

## 9. Inspector 设计

Inspector 是统一详情编辑容器，不是每个页面单独做一套 Drawer。

```ts
type InspectorEntity =
  | { kind: "MILESTONE"; id: string }
  | { kind: "TERMINATION"; id: string }
  | { kind: "REVISION"; id: string }
  | { kind: "SEGMENT"; id: string }
  | { kind: "MULTI_SEGMENT"; ids: string[] }
  | { kind: "CONFLICT"; id: string }
  | null;
```

### 9.1 Inspector 层级

1. 标题与状态。
2. 起止/截止时间和核心字段。
3. Task/Node/Person 关联。
4. 产出、Allocation、Role、Priority 等高级字段。
5. 冲突、权限、历史提示。
6. 主操作和危险操作。

### 9.2 保存策略

- 文本和复杂字段：显式“保存”。
- 简单选择和日期：仍进入 dirty state，不建议每个字段立即请求。
- 关闭有未保存内容时提示保存/放弃。
- 拖拽产生的时间更新是独立原子 mutation，不与尚未保存的文本表单混合。

## 10. Toolbar 设计

从左至右建议：

1. 范围标题：`2026/07/27 – 08/09`。
2. 上一范围、今天、下一范围。
3. 缩放 `− / +` 与档位菜单。
4. `适应计划` / `适应选择`。
5. 分组选择：人员 / Task。
6. 筛选入口，显示已启用数量。
7. 冲突开关、其他占用开关、Actual 开关。
8. 图例。
9. 更多：导出、复制视图链接、重置布局。

Task Composer 模式替换为：计划开始、适应计划、添加 Milestone、撤销、重做、校验。

## 11. 键盘操作

| 操作 | 快捷键建议 |
|---|---|
| 移动焦点 | 方向键 |
| 选中/打开 | Enter |
| 开始拖动 | Space |
| 移动一个吸附单位 | 拖动状态下方向键 |
| 移动较大单位 | Shift + 方向键 |
| 取消拖动 | Esc |
| 删除草稿节点/可删除 Segment | Delete / Backspace，需确认 |
| 新建 Milestone | M |
| 新建 Segment | S |
| 适应选择 | F |
| 回到今天 | T |
| 撤销/重做 | Ctrl/Cmd + Z / Shift + Ctrl/Cmd + Z |

屏幕阅读器 live region 需要播报：“已选中张三的计划区间，7 月 30 日 09:00 至 17:00”“已移动到 7 月 31 日，按空格放下”。

## 12. 性能设计

### 12.1 虚拟化

- 纵向只渲染可见 Person/Task 行和前后 overscan。
- 横向按时间列或可见时间窗口计算，避免全年每日格全部进入 DOM。
- Segment 先在数据层按可见时间范围过滤，再进行碰撞/泳道布局。
- 固定 Row Header 与 Canvas 使用同一个纵向虚拟列表，防止滚动错位。

### 12.2 渲染边界

- 行组件使用稳定 key 和 memo。
- 交互中的光标位置使用 `requestAnimationFrame` 合并更新。
- 拖动预览尽量使用 transform，不在 pointermove 时触发服务端或全列表排序。
- Tooltip 延迟加载详情，不把全部历史随初次画布数据返回。
- 当前时间线按分钟级更新，不按秒触发整画布重渲染。

### 12.3 数据窗口

API 按 `rangeStart/rangeEnd` 返回相交区间；不能获取所有历史后在浏览器筛选。人员分页与时间范围分页需要分别考虑：

- 人员很多：按人员游标/搜索加载。
- 时间很长：改变范围时重新查询。
- 画布移动少量范围：可预取前后一个窗口。

## 13. 空、加载和错误状态

- 初次加载：显示时间轴骨架和 5–8 行 Skeleton，保留列宽，避免布局跳动。
- 无人员：显示“选择人员或 Task 后查看计划”，不是空白网格。
- 有人员无 Segment：仍显示可拖选空行，并在行内给创建提示。
- 查询失败：画布区域内显示重试，不丢失筛选与范围。
- mutation 失败：仅回滚受影响对象，不整页刷新。
- 权限只读：画布仍可缩放、筛选、查看；编辑控制统一锁定并说明。

## 14. 移动端替代视图

`TimeCanvas` 在移动端不直接缩放为完整甘特图，而通过相同数据模型渲染 `TimeAgenda`：

```text
7 月 29 日 周三
├── 09:00–11:00  Task A / 前端实现      Planned
├── 13:00         Milestone：原型评审
└── 14:00–18:00  其他占用               Busy

7 月 30 日 周四
└── 10:00–12:00  Task A / 接口联调      Actual
```

- 日期为折叠分组。
- Milestone 是时间点卡片，Segment 是区间卡片。
- 新建使用浮动按钮和日期表单。
- 调整时间使用底部抽屉，不依赖精细拖动。
- 个人模式可支持长按后简单上下移动，但不是 P0 必需。
