# “我的时间”与通用 TimeCanvas 自适应改造计划

## 1. 文档状态

- 状态：已按冻结决策完成实现、完整验证与独立复审。
- 已确认：D1-D19、D21 选择 A，D5 最大逻辑跨度为 3 个上海日历年；D20 因 D14=A 为 N/A。
- 验证结果：`npm run check`、`npm run build`、Playwright 数据库生命周期/安全检查均通过；完整
  Desktop 与 Pixel 5 E2E 在 `3003` 端口通过（683 passed，39 skipped）。测试使用每次新建的隔离
  PostgreSQL 目标库和影子库，runner 最终报告 `cleanupSucceeded: true` 且两库均已删除。
- 复审结果：独立复审未发现新的可执行问题；完整 E2E 中发现并修复的管理员历史弹窗刷新竞态已在
  Desktop、Pixel 5 定向测试及后续完整 E2E 中复验通过。
- 本文作为本次实现、验收和复审的行为基线；如需偏离必须先更新决策记录。
- 参考现状：
  - “我的时间”当前界面：[`images/current-my-time.png`](./images/current-my-time.png)
  - 当前时间线顶部：[`images/current-time-line-top.png`](./images/current-time-line-top.png)
  - 目标视觉参考：[`images/target-time-line.png`](./images/target-time-line.png)

## 2. 背景与问题

当前 `/progress/my-timeline` 使用固定的日/周查询窗口：日视图加载 1 个上海自然日，周视图加载
7 个上海自然日。页面顶部、日期选择区和 TimeCanvas 工具栏分别提供了一组存在重复的日期/范围
控制。通用 TimeCanvas 虽然通过 `ResizeObserver` 获取容器宽度，但仍存在以下限制：

1. “我的时间”显式把日视图初始缩放固定为 `HOUR`、周视图固定为 `DAY`，没有按内容跨度和
   可用宽度选择初始尺度。
2. TimeCanvas 的 `chooseFitZoom` 只按范围天数选 `HOUR/DAY/WEEK/MONTH`，不考虑容器宽度。
3. 行标题固定为 240px，剩余时间轴宽度才参与缩放计算。
4. 当前“适应范围”只改变缩放等级，不改变服务端已加载的数据范围。
5. 当前单次 TimeCanvas 查询最多允许 366 天、5,000 个可见时间对象、50 个 anchor Task 和
   5,000 个 anchor Node。目标图展示的跨度可能超过一年，不能直接把查询范围无限扩大。
6. “我的时间”当前依赖 URL 中的 `date`、`mode`、`focus` 和 `taskCursor`；人员计划还会为范围外
   `focus` 扩展 `from/to/person/task` 筛选，Task/Project 详情则使用 `timelineDate/timelineFocus`
   （Project anchor 还包含 `project-start:`/`project-node:` 前缀）。删除日期控件后仍需逐页定义旧
   深链接、浏览器前进/后退和跨范围聚焦行为。

本次目标不是简单隐藏现有按钮，而是把“数据加载范围”“时间轴显示尺度”“当前滚动位置”拆成
三个独立概念，避免缩放、滚动或切换 Task 页时触发不必要的大查询。

## 3. 已确认需求

以下内容来自当前计划和参考图，除非第 8 节另行修改，视为已确认：

1. `/progress/my-timeline` 保留“我的时间”标题。
2. 删除标题区域右侧的“今天”和“日视图/周视图”按钮。
3. 删除标题下方的“日/周视图 · 开始日期至结束日期”描述。
4. 删除独立的日期选择表单，包括“选择日期”“打开日期”和旁边的说明文字。
5. 删除 TimeCanvas 中“日期平移”整行及其 `-31` 到 `+31` 天滑杆。
6. TimeCanvas 底部增加可见的横向滚动条，用于浏览已加载时间范围。
7. 时间范围以当前画布需要展示的时间对象为基础，并在内容两端增加两个月缓冲；“两个月”的
   精确定义仍由 D4 决定。
8. 新时间轴的视觉层级参考目标图：冻结左侧行标题、上方多级日期轴、今天线、右上范围尺度和
   导航控制、底部横向滚动。
9. 不开发单独的移动端时间线或 Agenda；对于当前已经渲染 TimeCanvas 的页面，移动端复用与
   桌面端相同的数据、功能和 TimeCanvas。当前移动端不渲染 Composer 画布，是否借本次改造补齐
   由 D1 决定。画布可以在自身容器内滚动，但不得造成整个页面横向溢出。
10. 参与 Task 列表、每页 25 条稳定分页、Task Current Plan 与列表同步、本人投入创建和详情、
    到期确认队列等现有业务行为不因本次视觉改造而改变。
11. 所有查询和 mutation 继续执行现有服务端鉴权、状态机、乐观并发、审计和通知 outbox 规则。

## 4. 非目标

1. 不修改 Task、Project、WorkSegment、PlanVersion 或 PlanNode 数据模型。
2. 不新增数据库 migration。
3. 不改变 Task/Segment 可见性和写权限。
4. 不恢复已移除的资源冲突、投入比例、批量修改、直接拆分或合并能力。
5. 不修改到期确认的业务状态机、飞书路由、通知事件或接收人。
6. 不为了接近参考图而引入新的甘特图库；优先扩展现有 TimeCanvas、时间数学函数和
   `@tanstack/react-virtual`。
7. 不在总览画布中恢复对既有投入的直接拖动保存；仍通过投入详情 Dialog 修改。
8. 本轮不重新设计“参与 Task”和“到期计划与确认队列”的卡片布局。

## 5. 术语与模型

### 5.1 三类范围

实现中必须区分：

| 名称 | 含义 | 是否触发服务端查询 |
| --- | --- | --- |
| 内容范围 | 当前 scope、筛选和行分页下，允许参与画布范围计算的最早、最晚时间 | 是 |
| 加载范围 | 内容范围加前后缓冲后，服务端已经授权加载的数据范围 | 是 |
| 可视窗口 | 用户当前在画布上看到的时间片段 | 否，只改变客户端滚动位置和显示尺度 |

缩放和底部滚动只改变可视窗口，不得在每次滚动时重新请求整张画布。只有加载范围需要扩展、筛选
改变、Task/人员分页改变或业务 mutation 成功时，才允许重新查询数据。

范围同时支持两种互斥策略，具体页面由 D14 决定：

| 策略 | 内容/加载/逻辑范围 | 空状态 |
| --- | --- | --- |
| `CONTENT_DRIVEN` | 授权内容边界按 D4 增加缓冲；超过上限按 D5 裁剪/分块 | 没有候选对象时使用 D4 的今天附近 fallback |
| `EXPLICIT_FILTER` | 用户选择的 `[from,to)` 同时是硬查询和逻辑画布边界；内容边界只用于初始尺度/定位，不得在范围外加缓冲 | 保持用户选择的历史/未来窗口并显示为空，不能跳回今天 |

`EXPLICIT_FILTER` 下 D4 的两个月缓冲停用，也不能为了预取越过 `from/to`。如果页面保留 31 天窗口，
同样按显式硬范围处理。唯一可能改变硬范围的入口是 D21=A 的授权 focus：它先生成并写回一组新的
规范化筛选，后续加载仍受新 `from/to` 约束。这样日期筛选和纯显示滚动不会产生两套互相覆盖的
查询边界。

### 5.2 候选时间对象

“内容范围”可从以下已授权对象的时间字段计算，最终集合由 D2、D3 决定：

| 对象 | 起点候选 | 终点候选 |
| --- | --- | --- |
| Task Current Plan | `plannedStartAt`、可显示节点 `plannedAt` | 最后一个可显示节点 `plannedAt` |
| Planned Segment | `startAt` | `endAt` |
| Actual Segment | `startAt` | `endAt` |
| 授权后的 Busy 投影（当前权限策略下不会产生） | `startAt` | `endAt` |
| Composer 草稿节点 | 草稿 Start/Node 时间 | 草稿最后一个 Node 时间 |

只允许在服务端授权过滤之后计算 query-backed 画布的边界。DTO 和查询代码保留了 `BUSY_ONLY`
投影能力，但当前 `segmentReadableWhere` 允许所有已登录 actor 读取全部未删除 Segment，所以当前
权限策略下 Busy 分支不可达，实际对象均为 `FULL`。本次改造不改变 Segment 可见性，不能为了使用
Busy 而收紧权限；范围查询必须验证当前仍不产生 Busy。若未来另一个独立权限需求使 Busy 可达，
才允许它在 `includeBusyBlocks=true` 的 scope 中以脱敏起止时间参与边界，并且不能恢复源 Segment
ID、Task、Node、标题或精确计数。除此之外，边界查询不能通过聚合结果泄露不可读 Task、Person
或 Segment 的存在。

## 6. 目标交互规格

### 6.1 “我的时间”页面

1. `PageCommandBar` 只显示“我的时间”，不再显示日期范围描述或页面级日期按钮。
2. 页面进入后直接显示投入操作条和 TimeCanvas，不再显示独立日期表单。
3. 当前页参与 Task、当前人的可见 Segment 和 Task Current Plan 共同决定画布内容范围。
4. Task Plan 行继续位于本人投入行上方并保持只读；本人行是否可创建继续由服务端 capability
   决定。
5. 切换“只看进行中/显示全部”或 Task 下一页后，内容范围按新的 Task 页和筛选重新计算，不得把
   上一页不可见 Task 留在边界或画布中。
6. 通过通知或 URL `focus` 打开投入时，必须验证该 Segment 属于当前人且可读，然后加载包含它的
   时间块、滚动到对应时间并按 D17 产生已决定的选中/Dialog 结果；失败时不得泄露对象信息。
7. 创建、更新、确认、取消或软删除投入成功后重新计算必要边界，但应按 D11 规定保持用户上下文。

### 6.2 通用 TimeCanvas 顶部

参考目标图，拟将现有顶部结构收敛为：

1. 时间轴头部直接显示多级日历刻度，不再单独占一行显示“日期范围、Asia/Shanghai、半开区间”。
2. 右上角提供显示尺度选择：`周 / 月 / 季 / 年`。
3. 右上角只提供“今天”；不显示上一窗口、下一窗口箭头。
4. 是否保留当前 `+ / -`、`适应范围` 和图例由 D7 决定。
5. `周/月/季/年` 表示显示密度，不直接等于服务端加载范围；具体语义由 D6 决定。显示密度与创建、
   节点移动、Segment 变换和键盘操作的时间吸附精度是两个概念，二者关系由 D13 决定。
6. 日期轴按尺度显示两级标题，例如年视图显示“年 + 月”，月视图显示“月 + 周/日”。精确层级由
   D8 决定。
7. 今天线只在今天落入加载范围时显示；“今天”按钮在范围内滚动到今天，在范围外按 D5 的加载
   策略处理。

### 6.3 底部滚动条

1. 在 TimeCanvas 可视区域底部提供与主体横向滚动位置双向同步的滚动条。
2. 行数很多、主体发生纵向滚动时，横向滚动条仍应可访问；是否 sticky 由 D9 决定。
3. 滚动条只控制时间轴，冻结的行标题列不随之水平移动。
4. 滚动必须连续，不按日期步进，不为每次滚动创建浏览器历史，也不触发业务 mutation；是否在
   滚动停止后用 `replaceState` 保存视角由 D10 决定。只有 D5 选定的预取阈值允许触发数据块加载。
5. 当内容宽度不超过时间轴视口时，滚动条应进入禁用或隐藏状态，不能产生假滚动距离。
6. 顶部日期轴、时间对象、今天线和底部滚动条必须使用同一 `scrollLeft`，不得出现肉眼可见的
   不同步。

### 6.4 自适应尺度

1. 使用现有 `ResizeObserver` 获取扣除行标题后的真实时间轴宽度。
2. URL/调用方没有显式尺度时，所有画布固定使用周尺度；Resize 只更新可用宽度，不改变尺度。
3. 每种尺度定义最小可读刻度间距；不能通过把一年压缩到几十像素来声称“已适应”。
4. `contentWidthPx` 至少等于视口宽度；跨度较大时允许大于视口并由底部滚动条浏览。
5. 用户手动选择尺度后，在当前页面生命周期中保持选择，不应被 ResizeObserver 或数据刷新重置。
6. 容器宽度变化时保持当前可视中心对应的时间，避免侧栏折叠、Dialog 尺寸变化或窗口缩放造成
   时间跳动。
7. 不使用 viewport width 直接缩放字体；文字使用既有字号并通过刻度密度、截断或 tooltip 保持
   可读。
8. 行标题宽度不再作为未说明的 240px 常量；响应式宽度、折叠能力和移动端默认值由 D16 决定。

### 6.5 空状态与异常状态

1. 没有任何候选时间对象时，使用 D4 确认的空范围；仍显示时间轴和现有中文空状态。
2. 单个零跨度节点至少获得一个可读的最小时间范围，不能产生除零或 1px 宽的整张画布。
3. 无效、极端或历史脏时间不能让页面申请无限宽画布；采用 D5 的跨度上限策略并显示明确中文反馈。
4. 范围边界查询失败时，画布进入独立错误态，不影响参与 Task 和到期确认队列。
5. 后续分块加载失败时保留已加载数据和用户滚动位置，并提供重试，不能静默显示为空；单块对象
   超限时的自动细分和最小块失败行为由 D18 决定。

## 7. 建议技术方案

本节是供决策使用的基线方案，不代表已经批准。

### 7.1 范围查询与装配

1. 为 query-backed TimeCanvas 增加受约束的范围查询/装配函数。它复用现有
   `taskReadableWhere`、`segmentReadableWhere`、PERSONAL/TASK_SCOPED scope、人员/Task 行
   universe 和筛选条件，返回最小必要的 `minAt/maxAt`，不返回对象标题或不可读 ID。
2. “我的时间”新增受约束的 `MY_TIMELINE_PAGE` 请求分层：结构页选择器永远只接受
   `taskCursor/showAll`；单独的范围策略只接受 `CONTENT_AUTO`，或 D5=B 错误恢复态下严格验证的
   `EXPLICIT_FILTER_RECOVERY(from,to)`；Segment 块再接受服务端返回的 `rowPageKey` 和块范围。恢复
   范围进入数据查询签名与 `rowPageKey`，但不改变 Task 页选择器。任何层都不接受客户端提交
   `taskIds/personIds`。服务端必须用当前 actor 和现有参与 Task 排序规则重新得到同一页最多 25 个
   Task，再派生 Current Plan anchors 与本人 Segment universe；稳定结构响应同时返回 Task 页数据
   和画布结构，Task 列表与 Plan 行消费同一份结果，不能分别查询后在客户端用 ID 拼接。伪造、越页
   或已不属于该 Task 页的 ID 没有输入位置。
3. Current Plan 节点边界与 Segment 边界在服务端合并；已软删除节点、已删除 Segment，以及 D3
   未选择纳入边界的非渲染状态不得意外扩大范围。
4. 范围使用上海自然日/月函数计算和对齐，继续采用半开区间 `[start, end)`。
5. 若 D5 选择分块加载，必须把现有“一次返回行页、全部 anchor 和范围内 Segment”的契约拆为：
   - 稳定结构响应：返回授权后的行页、Current Plan anchors、内容边界和 `rowPageKey`；
   - Segment 块响应：只返回绑定相同语义 scope、筛选、分页游标和时间块的 Segment/Busy，以及
     服务端重新计算的 `rowPageKey`。
6. 客户端不能把任意 Person/Task 行 ID 作为块查询授权依据。块请求提交原始语义 scope、筛选和
   分页游标，服务端重新执行授权与行页解析；`rowPageKey` 只用于识别陈旧响应和去重，不能代替
   服务端鉴权。客户端只接纳 key 与当前结构相同的响应。
7. 结构游标签名必须区分“会改变行资格的语义范围”和“只用于取 Segment 的 leaf block 范围”：
   - `EXPLICIT_FILTER` 的规范化完整 `from/to` 会影响活跃/停用人员和 Tag 匹配行，必须保留在结构
     游标与 `rowPageKey` 中；改变硬筛选范围必须使旧游标失效；
   - leaf block 的 `blockStart/blockEnd` 不进入结构游标，只单独验证并绑定当前 `rowPageKey`；
   - `CONTENT_DRIVEN` 只有在按 D20 建立与 leaf block 无关的行 universe 后，结构游标才能排除块
     时间；`MY_TIMELINE_PAGE` 的 Task 游标仍绑定 `showAll` 和现有 Task 排序，`PROJECT_PAGE` 游标
     仍绑定 Project 与 Task 页条件。
   每个块还必须是有限、正向且完整包含在结构响应给出的当前授权逻辑范围内：显式页使用硬
   `from/to`，内容页使用 D5 裁剪后的逻辑范围。完全越界、部分越界、超过 366 天或伪造超大块均
   在查询前拒绝；D18 自动二分产生的子块也只能细分父块且不得跨出该范围。旧游标继续由原入口
   兼容或明确失效，不能跨语义范围、筛选或结构页复用。
8. anchors 只在稳定结构响应中传输一次，不随每个 Segment 块重复返回。FULL Segment 以 ID 和
   `versionToken` 合并；Busy 没有源 ID，不能使用 Segment ID 去重。Busy 先裁剪到请求块，再由
   客户端按 Person 对所有同一 `rowPageKey` 的已加载区间做规范化并集：重叠或首尾相接的投影合并，
   渲染键只由 `personId + 合并后的可见 startAt/endAt` 生成。该键不进入 DTO、不对应源 Segment，
   也不能恢复隐藏对象数量或关联身份。
9. 每个数据块仍遵守当前最多 366 天；对象上限默认 5,000，D18=C 时使用经性能验证后决定的新
   上限。客户端只缓存当前页面、scope、筛选和分页对应的数据块，筛选改变后立即失效。缓存容量和
   淘汰行为由 D19 决定。
10. 不允许静默截断。任何块超过 D18 决定的对象上限时，按 D18 的细分、失败或提限行为处理；显示
    尺度本身不缩小查询结果，因此错误提示不能把“缩放时间轴”当成恢复动作。
11. Project 详情不能把 Server Component 派生出的任意 `personIds/taskIds` 交给客户端重放。D14
    让 Project 使用内容范围时，新增受约束的 `PROJECT_PAGE` 装配输入，仅接受 `projectId`、Task 页
    游标和现有 Task 状态/分页条件；服务端先验证 Project 可见性，再重新派生当前 Task 页、
    ProjectMember/TaskMember 人员。D5=A 返回结构/块响应，D5=B/C 返回受约束单窗口响应；客户端
    在任何方案下都不能覆盖派生 ID。
12. D21=A 的 Project 跨页 focus 使用独立受约束 locator，只接受 `projectId + focus token`。服务端
    解析合成 anchor/Node，验证目标属于可读 Project，再按既有稳定排序计算包含目标的 Task 页并返回
    规范化页游标；locator 结果随后进入 `PROJECT_PAGE`。块接口本身仍不接受客户端 Task ID，目标已
    删除、移出 Project 或不可读时返回统一未找到结果。
13. `rowPageKey` 是服务端生成的不透明结构指纹，至少覆盖 actor、语义 scope、规范化筛选、会影响
    行资格的显式 `from/to`、分页游标、有序行 ID/capability、Current Plan/version tokens、内容
    边界和相关 Segment/成员权限 epoch；它不覆盖 leaf block 的起止时间。响应不暴露指纹输入。
    块响应重算 key，不一致时客户端丢弃块并刷新结构。
14. 每个块按“整体替换”而不是只追加记录。相同 FULL Segment 出现在多个同 key 块时，较新的
    `versionToken` 胜出；相同 token 却内容不同视为契约错误，失效相关块并重拉。Plan、成员权限、
    Segment 更新/移动/删除使结构 epoch 改变并清空旧块，避免已删除对象只因相邻旧块仍在而残留。

### 7.2 时间数学与状态

计划扩展现有 `time-math.ts`，而不是在页面组件中复制日期算法：

- `contentTimeBounds(timestamps)`：计算有限候选值边界。
- `padShanghaiCalendarRange(bounds, months)`：按 D4 规则增加缓冲并对齐。
- 默认尺度固定为 `WEEK`；URL 或调用方显式尺度优先。
- `preserveTimeAtViewportCenter(previousScale, nextScale)`：缩放/Resize 后保持视觉中心。
- `visibleRangeFromScroll(...)`：继续作为虚拟化和可见对象裁剪依据。
- `snapForInteraction(mode, operation)`：按 D13 将编辑精度与视觉尺度解耦或明确映射。

显示状态建议拆为：

```ts
type TimeCanvasViewportState = {
  scale: "WEEK" | "MONTH" | "QUARTER" | "YEAR";
  scrollLeftPx: number;
  viewportWidthPx: number;
  userSelectedScale: boolean;
};
```

这只是客户端显示状态，不得进入服务端权限判断。是否写入 URL 由 D10 决定。

### 7.3 通用组件边界

1. `TimeCanvas` 负责日期轴、尺度、滚动同步、键盘操作、虚拟化和对象绘制，并通过显式的
   `FULL/COMPACT` presentation 配置决定工具栏与底部滚动条，不能靠页面 CSS 偶然隐藏。
2. 页面/adapter 负责提供已经授权的模型和加载范围，不让 `TimeCanvas` 自行请求任意业务对象。
3. `ResourcePlannerCanvasClient` 负责查询块装配、mutation 后刷新、focus 恢复和详情 Dialog。
4. Task Composer 继续以本地草稿范围为事实源，不调用 query-backed 范围接口。
5. Dashboard 预览、投入详情 Dialog、Composer 移动端等场景的 presentation 由 D1 决定。

### 7.4 性能与安全边界

1. 保留行虚拟化和时间可视窗口过滤；不一次渲染加载范围内的全部 DOM 对象。
2. 边界聚合必须有与数据查询一致的授权和业务过滤条件，并为所需数据库条件复用已有索引。当前
   权限策略下只应聚合 `FULL` Segment，并用回归测试证明 Busy 仍不可达；未来若通过独立权限变更
   使 Busy 可达，它也只能贡献脱敏时间边界。实现阶段用 `EXPLAIN` 或测试数据验证，不先假设需要
   migration。
3. 分块请求必须去重、可取消并防止旧 scope 响应覆盖新页面；不得在拖动滚动条时逐像素发请求。
4. 对超长跨度设置明确上限，避免构造数千万像素宽的 DOM；具体上限由 D5 决定。对块内对象过密
   另按 D18 处理，跨度上限和对象密度上限不能混为一谈。
5. `focus`、Task 分页、筛选和 URL 参数继续视为不可信输入，在服务端验证。
6. 本改造不产生 Feishu 消息；自动化测试继续设置通知禁用保护，不接触真实收件人。

## 8. 待决策项

以下适用决策均已选择 A，D20 按组合约束为 N/A。实现不得自行改用其他选项。

| 决策组 | 编号 | 需要决定什么 |
| --- | --- | --- |
| 覆盖范围 | D1、D14 | 哪些 TimeCanvas/页面采用新交互，旧日期控件去留 |
| 数据范围 | D2-D5、D18-D20 | 哪些对象/人员行参与边界、两个月定义、超长/超密数据和缓存策略 |
| 显示方式 | D6-D9、D16 | 尺度语义、默认工具、多级轴、滚动条和行标题宽度 |
| 导航状态 | D10-D12、D17、D21 | URL、首次定位、前后移动、focus 结果和旧链接兼容 |
| 编辑行为 | D13、D15 | 时间吸附精度和快速新增默认时间 |

### D1：通用改造覆盖范围

- **A（建议）**：所有 TimeCanvas 统一采用新的日期轴、尺度数学和滚动内核，但显式区分展示模式：
  - 我的时间、人员计划、Task 详情、Project 详情使用 `FULL`，桌面和移动端都有完整工具栏及底部
    滚动条；范围策略另按 D14 决定；
  - Composer 桌面端使用 `FULL` 和本地草稿范围；维持现有移动端表单/节点表，不借本次改造新增
    移动画布；
  - Dashboard 预览与投入详情 Dialog 使用 `COMPACT`，不显示完整工具栏，只有内容溢出时显示
    容器内横向滚动。
- **B**：只改 `/progress/my-timeline`，其他 TimeCanvas 保持现状。改动最小，但与“影响所有使用
  时间线的部分”不一致，并会长期保留两套交互。
- **C**：每个 TimeCanvas，包括 Dashboard 预览、Composer 桌面/移动端和投入详情 Dialog，都使用
  相同的 `FULL` 工具栏和底部滚动；Composer 仍只使用本地草稿范围，不调用业务范围查询。视觉最
  统一，但会新增移动 Composer 画布且使紧凑场景冗余。

**决定：A。**

### D2：“当前时间线需要显示的所有时间”的数据范围

- **A（建议）**：只按当前页面、当前筛选、当前人员/Task 分页中实际会渲染的对象计算。我的时间
  即“当前 25 条参与 Task 的 Current Plan + 当前人的可见 Segment”。切页后重新计算。
- **B**：按当前人全部参与 Task 计算，即使 Task 列表仍每页 25 条。时间范围稳定，但范围会受
  当前画布没有展示的 Task 影响，并需要额外全量 Task 边界查询。
- **C**：按 actor 可读的全部 Task/Segment 计算。范围最全，但与页面 scope 脱节，性能和信息
  密度不可控。

**决定：A。**

### D3：哪些对象参与边界计算

- **A（建议）**：只使用画布实际渲染的 Current Plan 节点、Planned、Actual；若未来权限策略使
  Busy 可达，再包括按模式实际显示的 Busy。已删除对象以及已确认/取消的 Planned 不扩大边界。
- **B**：包括历史事实中已确认/取消的 Planned，即使它们不渲染。范围更接近完整历史，但可能出现
  画布两端大片空白。
- **C**：只使用 Current Plan，不让人员投入改变范围。计划稳定，但独立投入或计划外 Actual 可能
  落在加载范围之外。合法且可读的 Segment `focus` 是明确例外：仅本次导航把目标起止时间作为临时
  边界候选，并按 D5 重建包含目标的逻辑窗口；它不让其他 Segment 永久参与常规边界。

**决定：A。**

### D4：“前后两个月”和空状态的精确定义

本项只适用于 D14 选择的 `CONTENT_DRIVEN` 页面；`EXPLICIT_FILTER` 页面严格保留所选范围，空数据也
不跳回今天。

- **A（建议）**：使用上海时区的两个日历月，并向外对齐到完整月边界。例如内容最早 8 月 20 日、
  最晚 9 月 10 日，加载范围为 6 月 1 日 00:00 至 12 月 1 日 00:00 的半开区间。空状态使用今天
  所在月前后各两个完整日历月。
- **B**：内容起点精确减 60 天，终点精确加 60 天，不对齐月份。算法简单，但月轴首尾通常是不完整
  月份。
- **C**：缓冲改为可配置值；需要同时决定默认值、上下限、保存位置和是否进入 URL，会扩大范围。

**决定：A。**

### D5：超过 366 天或极端跨度时如何加载

目标图本身可能超过一年，而当前单次查询硬上限是 366 天，因此这是阻断实现的关键决策。

- **A（建议）**：逻辑画布允许更长范围，但按不超过 180 天的相邻块惰性加载；进入可视窗口前预取
  前后一块。保留单块 366 天和 D18 决定的对象上限，并额外设置最大逻辑跨度（本次决定 3 个上海
  日历年），超过时明确
  进入标记为“已裁剪”的滚动窗口：边界查询仍返回完整 `minAt/maxAt`，再按
  `focus > center > D11 fallback` 选择不超过最大跨度的逻辑窗口；D11=A 时只有今天位于完整内容
  加缓冲范围内才围绕今天，否则使用最早内容，不能建立与内容完全无交集的空窗口。画布显示范围外
  内容提示，并允许
  “最早内容/最新内容”重建另一个裁剪窗口。不能先让结构查询失败再提供无效的定位按钮。行页/
  anchor 与 Segment 块按第 7.1 节拆分。实现复杂度最高，但能兼顾目标和查询安全。
- **B**：将单次查询上限提升到一个固定值（例如 5 年），一次返回全部对象。实现较简单，但可能
  超过默认 5,000 对象、响应过大或查询超时；必须按 D18 决定对象超限处理，不能静默截断。内容跨度超过
  所选单次上限或对象上限时，正常画布停止加载并显示错误恢复面板。由于“我的时间”没有常驻日期
  筛选，面板必须提供仅在错误态出现的 `from/to`，默认按 D11 定位并限制在单次上限内；提交后本次
  页面进入明确标记的 `EXPLICIT_FILTER_RECOVERY`，URL 保存恢复范围，并可“重试完整范围”。若最小
  一日仍因 D18 失败，只能显示密度错误。选择本项等于接受异常时重新出现日期范围控件和无法一次
  浏览全部内容，不作为建议方案。
- **C**：继续限制为 366 天，内容跨度超限时与 D5=A 一样按
  `focus > center > D11 fallback` 选择裁剪窗口，并提示还有范围外内容；D11=A 时今天只有落在完整
  内容加缓冲范围内才可作为 fallback。最简单，但不满足“加载所有需要显示的时间”。

**决定：A；选 A 时填写最大逻辑跨度：3 年；选 B 时填写单次查询/恢复范围上限：____ 年。**

实现参数：3 年指上海时区的 3 个日历年，不是固定 1,095 天。围绕目标时刻重建窗口时，先取目标
所在上海自然月月初，向前 18 个日历月作为候选起点，再以 `addShanghaiCalendarYears(start, 3)`
得到候选终点；最后整体平移并夹在完整“内容 + D4 缓冲”范围内。完整范围不足 3 年时直接使用完整
范围。闰日、月长和跨年均由上海日历函数处理。

### D6：`周/月/季/年` 的含义与宽度

- **A（建议）**：按钮只改变像素密度和刻度层级，不改变加载范围。每个尺度采用稳定的最小像素
  密度，内容宽度可能超过一屏，由底部滚动查看。
- **B**：按钮表示“一屏显示一个周/月/季度/年”，像素密度随容器宽度变化。语义直观，但同一
  Segment 在不同屏幕上的宽度差异较大。
- **C**：按钮同时改变服务端查询范围。接近当前日/周模式，但滚动到已加载范围外会频繁请求，
  与内容驱动加载范围冲突。

**决定：A。**

实现参数：自适应的事实源统一为“当前逻辑范围”，即 D4 后且经 D5 裁剪的范围，或显式硬范围；
不能使用当前已加载 leaf blocks。四档最小密度为：周 `40px/日`、月 `12px/日`、季 `4px/日`、年
`1.5px/日`。`contentWidthPx = max(timelineViewportWidthPx, logicalDays * density)`；初次进入按
周 -> 月 -> 季 -> 年选择第一档满足 `contentWidthPx <= 4 * timelineViewportWidthPx` 的尺度，均不
满足时选年。用户手动选择后不再自动覆盖。

### D7：默认尺度和现有工具

- **A（建议）**：初次进入时根据当前逻辑范围跨度和容器宽度自动选 `周/月/季/年`；保留四档选择，删除
  `+ / -` 和“适应范围”，图例移入 tooltip/帮助菜单。刷新是否记忆按 D10 处理。
- **B**：默认固定“年”，与目标图一致；保留四档选择，删除 `+ / -` 和“适应范围”。短任务可能
  显得过度压缩。
- **C**：保留当前 `+ / -`、“适应范围”和图例，再增加四档尺度。能力最全，但工具栏重复且窄屏
  很拥挤。若 D13=A，`+ / -` 只遍历内部视觉密度且不改变吸附；若 D13=B，`+ / -` 遍历六个离散
  尺度并按所选档改变吸附；若 D13=C，则按新四档的吸附映射改变精度。
- **D（2026-08-11 选定）**：保留四档选择，所有 presentation 和业务模式在没有显式尺度时固定
  使用 `WEEK`；Resize 只调整布局宽度和保持中心，不自动修改尺度。

**决定：D。**

### D8：多级日期轴的标签层级

- **A（建议）**：周=`年月 + 日`，月=`年月 + 周/日`，季=`年/季度 + 月`，年=`年 + 月`；标签
  使用上海时区，空间不足时跳过部分次级标签但不重叠。
- **B**：所有尺度固定为`年 + 月`，最接近参考图但周/月尺度不够精确。
- **C**：只保留单级刻度，开发简单但达不到参考图的层级效果。

**决定：A。**

### D9：底部滚动条的位置

- **A（建议）**：滚动条 sticky 在 TimeCanvas 容器底部，纵向浏览多行时始终可操作；隐藏主体原生
  横向滚动条，使用一个同步滚动源。
- **B**：滚动条只在全部行的最底部，视觉接近表格，但长列表需要先滚到底才能横向移动。
- **C**：顶部和底部各保留一条同步滚动条。操作方便，但视觉重复。

**决定：A。**

### D10：URL 与分享链接保存什么

旧“我的时间”参数的解释对三个选项都相同，并使用上海日历运算：`date + mode=day` 表示旧 1 日
半开窗口，首选中心为 `date 12:00`、新尺度为“周”；`date + mode=week` 表示旧 7 日半开窗口，
首选中心为 `date + 3 日 12:00`、新尺度为“月”。旧 `zoom=HOUR/DAY/WEEK/MONTH` 在 D13=B 的六档
方案下保留同名档位，否则依次映射为新 `WEEK/MONTH/QUARTER/YEAR`。缺失 `mode` 按当前默认日视图
解释；非法日期不参与定位。D10=A 把转换结果写成规范化 `center/scale`，D10=B/C 只用它完成首次
定位后移除旧显示参数。其他页面的 `timelineDate/timelineFocus` 由 D21 按 D14 范围语义处理。

- **A（建议）**：URL 保存 `scale` 和当前可视中心时刻 `center`；滚动停止后使用 `replaceState` 更新，
  不为每次滚动制造浏览器历史。首次定位优先级为“合法且可读的 `focus` > 合法且在逻辑范围内的
  `center` > D11 fallback”。非法或范围外参数被规范化替换。浏览器前进/后退只响应真实导航历史，
  不记录连续滚动。
- **B**：URL 只保存 `scale`，范围和滚动位置每次按内容重新计算。链接简洁，但不能分享相同视角。
- **C**：不保存任何显示状态，只保留 `focus`、筛选和分页。实现最简单，刷新后回到默认视角。

**决定：A。**

### D11：首次进入及数据刷新后的定位

- **A（建议）**：遵守 D10 的 `focus/center` 优先级；没有有效深链接状态时，今天在范围内则居中
  今天，今天不在范围内则定位最早内容。mutation/刷新后先保持原可视中心；目标被删除或中心落到
  新范围外时，将旧中心夹到新的逻辑范围，并定位离旧中心最近的仍存内容；没有内容时使用下述空硬
  范围规则。mutation 后不重新套用“今天优先”，避免用户正在查看历史时跳回今天。
- **B**：先遵守 D10 的有效 `focus/center`；没有深链接状态时从加载范围最左端开始。最接近传统
  甘特图，但查看当前工作经常需要额外滚动。
- **C**：先遵守 D10 的有效 `focus/center`；没有深链接状态时定位最早内容而不是缓冲左缘，前置
  两个月缓冲仍可向左滚动查看。

对没有任何内容的 `EXPLICIT_FILTER`/`EXPLICIT_FILTER_RECOVERY`，不存在“最早内容”：D11=B 从硬
范围左缘开始，D11=A/C 适配并定位硬范围中点；任何选项都不能跳到硬范围外的今天。

**决定：A。**

### D12：上一/下一按钮的移动单位

- **A（建议）**：按当前视口可见时长的 80% 移动，保留少量上下文；到加载边缘时按 D5 预取或提示。
- **B**：严格按当前尺度移动一周/一月/一季度/一年。规则稳定，但视口宽度与移动量可能不一致。
- **C**：删除上一/下一，只允许底部滚动条和“今天”。工具更少，但键盘和精确浏览效率下降，且与
  目标图不一致。

**决定：C。**

当前选择下没有前后按钮。底部滚动触发相邻块预取，超过三年范围使用“最早内容/最新内容”入口
切换逻辑窗口。内容驱动页的可导航范围额外包含今天附近窗口，因此“今天”始终启用；点击后按 D5
重建逻辑窗口，但默认定位仍遵守 D11，不因今天窗口存在而跳离历史内容。`EXPLICIT_FILTER` 不重建
范围，“今天”在显式硬范围外时禁用。这些显示导航不创建业务记录。

### D13：显示尺度与编辑吸附精度

当前 `HOUR/DAY/WEEK/MONTH` 同时决定像素密度和 `snapMs`；直接换成 `周/月/季/年` 会让现有半小时
创建、节点拖动或键盘移动退化，因此必须显式决定。

- **A（建议）**：完全解耦。`周/月/季/年` 只决定视觉密度；吸附精度由业务模式和操作决定，例如
  下表。放大或缩小不改变将要保存的业务时间粒度。

  | 模式/操作 | 固定吸附步长 |
  | --- | --- |
  | Person 行空白拖选创建 Planned/Actual | 30 分钟 |
  | Segment 详情内拖动、调整开始/结束 | 30 分钟 |
  | Segment 键盘移动/调整 | 30 分钟 |
  | 快速新增默认开始时间 | 30 分钟向下取整；持续 1 小时 |
  | Composer 点击创建节点 | 1 个上海自然日 |
  | Composer 节点拖动 | 1 个上海自然日 |
  | Composer 节点键盘移动 | 1 个上海自然日 |
  | 只读 Plan anchor/Busy | 不提供编辑吸附 |

  精确表单仍按现有服务端 validation 接受合法时间，不因画布尺度额外改写用户输入。
- **B**：保留并扩展为 `小时/日/周/月/季/年` 六档，让尺度决定吸附：小时=30分钟、日=1个上海
  自然日、周=1个上海自然日、月=7个上海自然日、季=14个上海自然日、年=1个上海日历月。精确
  表单不被改写。工具栏更拥挤，用户缩放可能无意改变编辑精度。
- **C**：新的四档直接映射吸附：周=1个上海自然日、月=7个上海自然日、季=14个上海自然日、
  年=1个上海日历月；精确表单不被改写。实现较直接，但会失去半小时画布排期能力，不建议。

**决定：A。**

### D14：其他页面现有日期控件与内容范围的关系

人员计划的 `from/to/zoom` 当前是服务端硬筛选；Task/Project 详情有 31 天窗口、上一/下一和日期表单。
不能在保留这些语义的同时声称所有页面都由内容自动决定范围。

- **A（建议）**：我的时间删除全部页面级日期控件并使用内容范围；人员计划保留 `from/to` 作为
  明确业务筛选，新的尺度/滚动只作用于筛选结果；Task/Project 详情删除 31 天控件并改用内容范围。
- **B**：所有 `FULL` 画布都删除页面级日期窗口，统一使用内容范围；人员计划只保留人员、Task、
  Tag、类型和状态筛选。体验最统一，但会移除人员计划的精确日期筛选能力。
- **C**：只在我的时间使用内容范围；人员计划、Task 和 Project 详情保留现有硬查询窗口，只替换
  日期轴和底部滚动。改动较小，但其他页面不能浏览窗口外的全部内容。

**决定：A。**

### D15：“新增投入”的默认时间

删除固定日期窗口后不能再使用 `model.range.startMs`，否则默认值可能落在最早内容之前两个月。

- **A（建议）**：使用当前可视窗口中心，按 D13 的 Segment 创建精度向下取整，默认持续 1 小时；
  用户先滚到目标日期再点击“新增投入”即可得到对应时间。
- **B**：始终使用上海当前时间取整并持续 1 小时；适合记录当下，但用户浏览历史/未来时仍需手动
  修改日期。今天不在已加载范围时先加载或定位今天。
- **C**：使用当前可视窗口左缘取整并持续 1 小时；与旧范围起点行为最接近，但不一定是用户关注点。

**决定：A。**

### D16：行标题列宽度

- **A（建议）**：响应式 `clamp`。桌面在约 200-280px 间随容器调整，Pixel 5 使用约 120-140px；
  保持冻结并通过截断+tooltip 查看全名，不新增折叠状态。
- **B**：保留固定 240px。视觉稳定但 Pixel 5 的时间区仍非常窄，不能完整解决自适应问题。
- **C**：桌面默认 240px，提供仅图标按钮折叠到约 48px并记住当前页面状态；移动端默认折叠。
  时间区最大，但需要新增状态、可访问名称和长标题查看入口。

**决定：A。**

### D17：`focus` 深链接的可见结果

- **A（建议）**：加载并滚动到目标，选中且自动打开本人 `FULL` Segment 的详情 Dialog；关闭后仍
  保持目标在可视窗口内。通知深链可一步到达操作上下文。
- **B**：只滚动并选中目标，不自动打开 Dialog；用户需双击或按 Enter 打开，干扰更小。
- **C**：只滚动，不保持选择。实现简单，但目标在密集时间线中不够明确。

**决定：A。**

### D18：单个时间块超过 5,000 对象

- **A（建议）**：从 180 天块自动二分，直到成功或达到一个上海自然日；单日仍超限时仅该块显示
  明确错误和重试，其他块继续可浏览。错误引导用户缩小人员/Task/类型/状态筛选；我的时间若没有
  可缩小筛选，则提示该日数据密度超限，不把视觉尺度当成解决方式。此选项要求 D5=A；若 D5=B
  后再选择本项，实际已经变为分块方案，应改选 D5=A。
- **B**：任一块超限就让整张画布失败，要求用户缩小筛选。行为简单一致，但超长范围中一个密集日
  会阻断其他正常区间。
- **C**：提高 5,000 对象上限。需要先用性能证据决定新值，并评估响应、DOM虚拟化和数据库负载；
  不能只为通过个别数据集取消上限。

**决定：A。**

### D19：分块缓存预算与淘汰

- **A（建议）**：LRU 同时限制为最多 20,000 个时间对象和 16 个 leaf block；优先保留当前可视块、
  前后各一个预取块以及包含选中/focus/已打开 Dialog 对象的块，其他最远块先淘汰。被淘汰范围再次
  进入视口时重取；scope、筛选、`rowPageKey` 改变时全部清空。若当前可视块本身超过预算，显示
  局部密度错误而不在后台无限累积。
- **B**：只保留当前可视块、前后各一个预取块，以及包含 focus/已打开 Dialog 的一个固定块（去重后
  最多 4 个逻辑块），不另设对象数预算。内存通常更低、规则简单，但频繁来回滚动会增加请求。
- **C**：不做 LRU，在当前页面生命周期内保留已加载块，但设置不可配置的安全阈值 100,000 个对象
  或 80 个 leaf block（任一先到即停止加载新块并显示“缓存容量已达上限”，用户可清空缓存后继续）。
  阈值内回看最快，但会比 A/B 占用更多内存，且达到阈值后的浏览不连续，不建议。

**决定：A；对象预算 20,000，leaf block 上限 16。**

### D20：内容驱动页面的 Person 行 universe

现有 Person 行资格依赖请求日期范围：活跃人员可出现，停用人员只有在范围内有匹配 Segment 才
出现，Tag 筛选也只保留范围内有匹配对象的行。`CONTENT_DRIVEN` 不能再用尚未计算出的日期范围
决定行页，否则边界、分页和 leaf block 会形成循环依赖。`MY_TIMELINE_PAGE` 的 Person 行固定为
actor；内容驱动的 Task/Project 页则固定使用服务端派生的当前有效成员，这两类都不受本项影响。
本项只决定 D14=B 时取消 `from/to` 后的人员计划默认 Person 行。

- **A（建议）**：使用所有授权活跃人员，并保留在全部时间内存在匹配非时间筛选对象的停用人员。
  Tag/类型/状态等筛选在全部授权时间上判断行资格，再由当前行页对象计算内容边界。最接近现有
  “活跃人员可排期、历史停用人员有记录时可见”的行为，但无日期筛选时可能出现没有时间对象的
  活跃空行。
- **B**：只保留在全部授权时间内至少有一个匹配边界对象的人员行；没有 Segment/Plan 的活跃人员
  也不显示。时间线更紧凑，但人员计划不能再对空白活跃人员直接排期。
- **C**：内容驱动人员计划必须先显式选择 Person；只为选中的最多 50 人建立行，未选择时显示引导
  空状态。查询规模最可控，但改变当前默认展示全部活跃人员的工作流。

**决定：N/A（D14=A）。**

### D21：其他页面旧链接与范围外 focus 的兼容

D10 主要决定新的显示状态以及“我的时间”的 `date/mode/focus`。还需处理人员计划现有的
`from/to/person/task/focus`，以及 Task/Project 详情的 `timelineDate/timelineFocus` 和 Project
合成 anchor ID。

- **A（建议）**：至少保留一个发布周期并规范化旧链接，具体按页面范围语义处理：
  - D14=A/B 的内容驱动 Task/Project 将旧 31 日窗口起点 `timelineDate` 转为上海时间
    `timelineDate + 15 日 12:00` 的首选 `center`；D14=C 则保留它的硬范围含义，规范化为
    `[from=timelineDate 00:00, to=timelineDate+31日 00:00)`，显示中心才取范围中点，不能只写 center；
  - `timelineFocus` 继续接受当前 Node ID 和 `project-start:<taskId>`/
    `project-node:<nodeId>`。Project 服务端 locator 只接受 `projectId + focus`，验证目标 Task/Node
    属于可读 Project 后按既有 Task 排序反查并重建包含目标的 25 条 Task 页，返回新的规范化 cursor；
    客户端仍不能提交派生 Task ID。旧 cursor 陈旧或目标移页时以 locator 结果为准；
  - D14=C 的 Task/Project focus 若在硬范围外，由 locator 重建一个包含目标的 31 日硬范围；人员
    计划若使用 `EXPLICIT_FILTER`，范围外但可读的 Segment focus 继续像当前实现一样最小扩展
    `from/to` 和必要 Person/Task 筛选。重建筛选或分组后清除旧行 cursor，由服务端生成新 cursor；
  - 人员计划按 Task 分组且 focus 指向独立 Segment 时，验证目标可读后自动切换为 Person 分组并
    写回规范化 URL，因为独立 Segment 没有可承载的 Task 行。
  这些行为都是一次明确的范围/筛选/分页重建，不是越过当前硬范围预取。不可读或无效目标只显示
  统一错误，不泄露对象信息。
- **B**：兼容解析旧参数但不扩展范围、筛选、分组或 Task 页。内容驱动页面按上述上海中点解释
  `timelineDate`；D14=C 页面仍把它规范化为 31 日硬 `from/to`。只有目标已在当前服务端派生行页和
  范围内时才定位；Project 跨页/陈旧 cursor、人员计划范围外目标，以及 Task 分组下的独立 Segment
  均显示统一的“不在当前视图”错误。规则最严格，但现有通知/分享链接可能不能一步到达目标。
- **C**：不兼容 `timelineDate/timelineFocus` 或 Project 合成 anchor 旧参数，旧链接进入默认视角；
  新链接只使用 `scale/center/focus` 以及 D14 保留的业务筛选。D14=A/C 的人员计划
  `from/to/person/task/tag/type/status/groupBy` 仍是有效业务筛选，不能因删除旧显示别名而丢弃。
  实现最简单，但会主动破坏现有书签、通知链接和 Project 合成 anchor 定位，不建议。

**决定：A。**

### 8.1 决策组合约束

| 条件 | 有效组合/处理 | 无效组合 |
| --- | --- | --- |
| D1=B | D14/D20/D21=N/A，只改我的时间；D4 仍必填 | D14/D20/D21=A/B/C |
| D1=A/C | 必须选择 D14=A/B/C 与 D21=A/B/C | D14 或 D21=N/A |
| D14=B | D20=A/B/C | D20=N/A |
| D14=A/C | D20=N/A | D20=A/B/C |
| D5=A | D18=A/B/C，且必须选择 D19=A/B/C | D19=N/A |
| D5=B | D18=B/C，D19=N/A；接受仅在错误态出现日期恢复面板 | D18=A、任意 D19=A/B/C |
| D5=C | D18=B/C，D19=N/A | D18=A、任意 D19=A/B/C |
| D18=C + D19=A | D19 对象预算必须不小于 D18 新单块对象上限 | 单个合法块大于整个缓存预算 |
| D18=C + D19=C | D18 新单块对象上限不得超过 100,000 | 单个合法块超过 C 的安全阈值 |
| D7=A/B + D13=A/C | 工具栏四档 | 六档 |
| D7=A/B + D13=B | D13 覆盖为六档 | 仍声明四档 |
| D7=C | `+/-` 按 D13 中对应映射工作 | 未定义独立吸附步长 |
| D10=A | D11 先执行 `focus > center` 再 fallback | D11 覆盖合法 focus/center |
| D10=B/C | D11 只处理 focus、今天、左缘/最早内容 | 尝试恢复不存在的 center |
| D14 保留 `from/to`/31天 | D4 仍为全局必填，但不应用于这些 `EXPLICIT_FILTER` 页面；center 裁剪到硬范围 | 在硬范围外增加两个月或空状态跳到今天 |
| D21=A + `EXPLICIT_FILTER` | 授权 focus 先重建并规范化一组新的硬筛选，之后块加载不能越界 | 在不改变 URL 筛选时越过硬范围预取 |
| D5=B + `EXPLICIT_FILTER_RECOVERY` | 恢复 `from/to` 进入数据签名/`rowPageKey`，D4 暂停；Task 页仍只由 `taskCursor/showAll` 决定 | 恢复范围携带 Task/Person ID 或复用旧 key |

D9 只约束 D1 中使用 `FULL` 的画布；`COMPACT` 是否在溢出时显示容器滚动按 D1 决定。D4 在所有
组合中都适用于内容驱动的“我的时间”，绝不能整体填 N/A。D4=C、D18=C、D19=A 还要求填写回复
模板中的条件参数，缺少参数时决策不完整。

## 9. 页面/模式影响矩阵

最终矩阵受 D1、D14 约束，建议基线如下。D14 未决定前，“内容或显式筛选”不能在实现中自行选择：

| 使用位置 | 范围事实源 | 桌面/移动 presentation | 底部滚动 | 是否允许 mutation |
| --- | --- | --- | --- | --- |
| `/progress/my-timeline` | 当前 Task 页 Plan + 本人 Segment | `FULL/FULL` | 是 | 创建；详情内修改 |
| `/progress/resources` | D14：内容或显式 `from/to` 筛选 | `FULL/FULL` | 是 | 创建；详情内修改 |
| Task 详情 | D14：内容或现有 31 天窗口 | `FULL/FULL` | 是 | 仅详情内按权限修改，不创建 |
| Project 详情 | D14：内容或现有 31 天窗口 | `FULL/FULL` | 是 | 只读 |
| Task Composer | 当前本地草稿 Start/Nodes | D1：`FULL/NONE` 或 `FULL/FULL` | 按 D1 | 本地草稿编辑 |
| `/progress` Dashboard 预览 | 既有 Dashboard 查询窗口 | D1：`COMPACT/COMPACT` 或 `FULL/FULL` | 按 D1 | 只读 |
| 投入详情 Dialog 内画布 | 当前投入及同一行参考对象 | D1：`COMPACT/COMPACT` 或 `FULL/FULL` | 按 D1 | 只修改目标投入 |
| TimeCanvas 测试夹具 | fixture 模型 | 可配置 | 可配置 | 按 fixture |

## 10. 分阶段实施计划

### 阶段 0：决策冻结与基线

1. 完成第 8 节全部决策，并把结果写回本文“决策记录”。
2. 用 Playwright 保存当前桌面 `1440x1000` 和 Pixel 5 的基线截图、浏览器错误和滚动尺寸。
3. 固定受影响页面、URL兼容策略、最大跨度和性能数据集。
4. 确认现有 `npm run check` 与相关 E2E 基线；若基线失败，先记录既有失败，不把它混入实现。

### 阶段 1：纯时间数学与契约

1. 新增内容边界、上海日历月缓冲、固定默认周尺度和视口中心保持的纯函数。
2. 扩展 TimeCanvas 类型，明确加载范围、viewport state、`FULL/COMPACT` presentation 和 D13
   决定的 interaction snap，避免复用含义不清的 `zoom`。
3. 若 D5=A，定义稳定结构 DTO 与 Segment 块 DTO；把结构游标和时间块范围拆开，明确
   `rowPageKey` 只是响应一致性标识而不是授权凭证；`EXPLICIT_FILTER` 的完整 `from/to` 留在结构
   签名，只有 leaf block 起止时间被拆出。
4. 为月长差异、闰年、跨年、空集合、单点、无效值、极端跨度、容器宽度和各操作吸附精度编写
   回归测试。
5. 保留旧 adapter/fixture 的兼容层，直到所有页面迁移完成。

### 阶段 2：授权边界查询与数据加载

1. 实现与现有 scope/筛选完全一致的授权边界查询；当前权限策略下只返回 `FULL` Segment，并验证
   `includeBusyBlocks` 不会意外产生 Busy 或改变边界。
2. 按 D5 实现单次或分块加载、请求去重、失效和错误恢复；分块时结构响应只返回一次 rows/anchors，
   块响应重新解析语义 scope、筛选和分页，且不接受任意行 ID。
3. 按第 7.1 节拆分结构签名与 leaf block：显式 `from/to` 改变时使行游标失效，纯块时间变化不使
   结构游标失效；用覆盖结构版本/权限 epoch 的 `rowPageKey` 丢弃陈旧块响应，并按整体块替换和
   `versionToken` 合并 FULL Segment。保留 dormant Busy DTO 的规范化逻辑，但本次不能改变权限使
   它实际出现。
4. 为 `MY_TIMELINE_PAGE` 实现“actor -> showAll/taskCursor -> 当前 25 条参与 Task -> anchors + 本人
   Segment”的单一服务端装配；结构响应同时供 Task 列表和 Plan 行使用，不接受任意 Task/Person ID。
5. 为 `PROJECT_PAGE` 输入实现“Project 可见性 -> 当前 Task 页 -> ProjectMember/TaskMember 并集”
   的服务端派生；Server Action 和 HTTP dispatcher 共用同一 query/validation，不接受派生 ID。
6. D21=A 时实现 Project focus locator，以已验证 anchor 反查并重建包含目标的 Task 页；覆盖陈旧
   cursor、目标移页、已删除/移出 Project 和不可读目标，且不把派生 Task ID 暴露为块查询输入。
7. D5=A 时按 D19 实现缓存、focus/Dialog pin、容量保护、淘汰或停止加载；D5=B/C 不创建分块缓存。
   任何方案都不能只依赖 DOM 虚拟化控制 JavaScript 数据内存。
8. 验证 PERSONAL scope 不能查询他人边界，`MY_TIMELINE_PAGE` 不能注入越页 Task，TASK_SCOPED
   不能扩大到其他 Task，Project 装配不能通过客户端 Task/Person ID 越权；当前权限策略下 Busy
   必须保持不可达。
9. 验证显式范围变更时活跃/停用 Person 与仅 Tag 匹配行的游标失效；内容驱动 Task/Project 行页按
   固定成员语义、人员计划按 D20，不受 leaf block 变化影响。
10. 验证 D18 决定的 Segment 对象上限、50 Task、5,000 Node、所选 D18 超限行为和跨度上限；达到
   或超过各边界时必须严格执行已选方案，不静默截断。
11. 对典型和极端数据运行查询计划检查；只有证据表明需要时才新增索引和 migration。

### 阶段 3：TimeCanvas 通用交互

1. 实现目标日期轴、尺度选择、“今天”、D16 行标题宽度和底部同步滚动条。
2. 删除日期平移 bar；按 D7 处理旧缩放、适应范围和图例。
3. 按 D13 把视觉尺度与交互吸附解耦或显式映射；缩放不得未经决定改变保存精度。
4. 按 D15 让快速新增从可视窗口/今天/左缘取得默认时间，不再使用加载范围起点。
5. 保持行虚拟化、时间对象裁剪、选择、键盘导航、双击详情和 reduced motion。
6. 处理 ResizeObserver、侧栏折叠、Dialog 尺寸变化和尺度切换时的中心保持。
7. 验证长行标题、长节点标签、空行、密集重叠 Segment 和 5,000 对象下无布局跳动。

### 阶段 4：“我的时间”接入

1. 删除页面级日期/模式控件和日期说明。
2. 接入 `MY_TIMELINE_PAGE`，以同一受约束响应驱动当前 Task 页、Plan 行、本人 Segment 的内容边界
   和加载策略。
3. 保持 Task 列表、Plan 行、Task 分页、状态切换和创建 Task 选择器同步。
4. 按 D10、D11、D17 迁移 `focus` 深链接、首次定位及旧 `date/mode` URL。
5. 按 D15 验证按钮新增和拖选新增的默认时间，不允许落到无关的两个月缓冲起点。
6. 验证新建、编辑、确认、部分确认、取消、Actual 软删除后范围与定位稳定。

### 阶段 5：其余 TimeCanvas 接入

1. 按 D1、D14、D20、D21 和第 9 节矩阵逐页迁移人员计划、Task/Project 详情、Composer 和紧凑
   画布；每页明确删除、保留或转换既有日期控件、旧 URL 与范围外 focus，不允许同时出现互相冲突
   的硬查询范围和内容范围。
2. 每迁移一个模式，单独自审 diff、运行相关测试并请求独立 subagent review。
3. 修复所有 actionable finding 后重跑受影响测试，再请求复审，直到无新问题。

### 阶段 6：文档与完整验证

1. 更新 `README.md` 中所有被 D1/D14 改变的入口：我的时间、人员计划、Task/Project 详情窗口，
   以及 D1=C 时新增的移动 Composer 画布。
2. 更新 `docs/TECH.md` 中 TimeCanvas 范围、分块、URL、上限和组件职责。
3. 更新 `docs/TESTING.md` 中桌面、Pixel 5、极端跨度和旧链接验收步骤。
4. 若通知事件没有变化，不修改 `docs/NOTIFICATIONS.md`；若实现意外触及通知，必须停止并重新
   评审范围。
5. 完成全量命令和最终独立复审。

## 11. 验收标准

### 11.1 “我的时间”

1. 页面不再出现标题区“今天”“日视图/周视图”、日期范围描述、日期选择表单或日期平移 bar。
2. 页面保留一个“今天”入口，位于 TimeCanvas 工具栏；同一动作不重复出现。
3. 当前 Task 页中的每个 Task Plan 行与列表一一对应，二者来自同一次受约束的
   `MY_TIMELINE_PAGE` 装配；状态切换和下一页后同步更新，客户端无法注入越页 Task。
4. 内容范围严格符合 D2-D5；最早和最晚边界各有已决定的缓冲，不因不可读或不渲染对象扩大。
   D3=B 明确选择的历史非渲染 Planned 除外。D14 保留的硬日期筛选不得应用缓冲，历史/未来空窗口
   不得跳回今天。
5. 底部滚动条可以到达加载范围两端，顶部日期轴、Plan、Segment、anchor 和今天线始终对齐。
6. `focus` 链接按 D17 定位/选中/打开本人可读投入；他人或无效 ID 不显示目标信息。合法 `center`
   与 `focus` 同时存在时遵守 D10 的明确优先级；D3=C 时目标 Segment 仅作为本次窗口重建的临时
   边界候选，关闭/清除 focus 后恢复 Current Plan 边界语义。
7. 按钮新增使用 D15 决定的默认时间，拖选新增使用用户所选范围；二者都遵守 D13 的精度，不能
   默认落到加载范围的两个月缓冲起点。
8. 新建独立/关联投入、双击详情、保存、完整/部分确认、取消和 Actual 软删除继续工作，服务端状态
   与审计记录正确。

### 11.2 通用画布

1. D13=A/C 时四种尺度、D13=B 时六种尺度在已决定的适用页面可用；切换后不丢选择、不重置行
   分页、不触发无关业务查询。
2. 没有显式尺度时固定使用周；用户手动选择后，窗口 Resize、数据刷新和节点聚焦不覆盖其选择。
3. 改变 D13 决定的可用尺度后，各业务模式的创建、拖动和键盘吸附严格符合 D13，不发生未决定的
   精度降级。
4. D14 涉及的每个页面只有一种明确的数据范围语义；保留的日期筛选与纯显示滚动在文案和 URL 上
   可区分，不出现两套互相覆盖的日期控件。
5. 内容驱动 Task/Project Person 行固定使用服务端派生的有效成员，人员计划行资格符合 D20；显式
   `from/to` 改变会使相关行游标失效，leaf block 变化不会使同一稳定结构页跳行、重复或丢行。
6. 1440x1000、Pixel 5、侧栏展开/折叠和 Dialog 宽度下，D16 行标题与时间区均可用，且无页面级
   横向滚动、文字重叠或按钮溢出。
7. 长 Task/Person/Segment 名称截断或换行合理，并可通过 `title`/tooltip 或详情获得完整内容。
8. 空数据、单时间点、跨年、超过一年、达到上限、请求失败和慢加载均有稳定且可理解的中文状态。
9. 键盘可操作尺度、今天、滚动区域和时间对象；焦点可见，ARIA 名称明确，且不存在前后箭头。
10. reduced motion 下不强制平滑滚动；滚动同步无明显抖动或循环更新。
11. Dashboard、详情 Dialog 和 Composer 移动端严格使用 D1 决定的 presentation，不因共享组件
    改造偶然显示或隐藏完整工具栏。
12. 人员计划、Task 和 Project 的旧参数、合成 anchor ID 与范围外 focus 严格执行 D21；任何兼容
    路径都先做服务端可读性验证，并把结果规范化为唯一的新 URL 状态。

### 11.3 安全与性能

1. 范围聚合和数据加载使用相同授权 universe；不返回不可读对象 ID、标题、精确时间或计数侧信道。
   当前权限策略下所有未删除 Segment 保持 `FULL`，`includeBusyBlocks` 不产生 Busy 或改变边界；未来
   的 Busy 权限变更不属于本次范围。
2. `MY_TIMELINE_PAGE`、PERSONAL、TASK_SCOPED 和 Project 详情的允许/拒绝路径均有自动化测试。
3. 单块超过 D18 决定的对象上限、50 anchor Task、5,000 Node 或已决定跨度上限时，分别执行已选
   细分/失败/提限策略或明确拒绝，绝不静默截断。
4. 分块方案下，结构响应不随块重复传输 anchors，块接口不接受任意行 ID；leaf block 变化不使
   稳定行游标失效，但会改变 Person 行资格的显式 `from/to` 必须使游标失效。伪造
   scope/筛选/cursor/rowPageKey 均不能扩大授权结果。我的时间块只能用
   `taskCursor + showAll` 重建当前 Task 页，Project 块只能用受约束的 `projectId + Task页条件`
   重建，二者都不能回传 Server Component 派生 ID。每个 leaf block 必须完整位于结构响应授权的
   当前逻辑范围内，完全/部分越界、超长或超大请求在数据库查询前拒绝。
5. 滚动不逐像素请求；相同块不重复并发请求，旧 `rowPageKey`/旧筛选响应不能覆盖新筛选。对象
   超限按 D18 自动细分、整体失败或使用已验证新上限，不把缩放当成恢复动作。
6. 跨块 FULL Segment 使用最新 `versionToken`，相同 token/不同内容触发失效重拉；dormant Busy
   DTO 仍以人员和可见区间做规范化并集，不生成或暴露稳定源对象标识，但本次测试必须证明当前
   权限策略不会实际返回它。
7. D19=A/B 的预算、淘汰、focus/Dialog pin 和重取符合所选规则；D19=C 在 100,000 对象/80 leaf
   block 安全阈值停止加载并可清空。跨多个 3 年逻辑窗口连续浏览至少 5 年数据时，任何选项都不能
   无限增长内存。
8. 自动化测试不发送真实飞书消息，不绕过测试数据库、端口、allowlist 或通知禁用保护。

## 12. 测试计划

### 12.1 纯函数/契约回归

- 上海时区月边界、不同月份天数、闰年和跨年。
- 空范围、单点范围、Segment 跨午夜、超长 Actual、Plan 与 Segment 混合边界。
- D3=C 时常规边界排除 Segment，但合法 focus 将目标临时纳入窗口；清除 focus 后恢复 Plan-only
  边界，非法/不可读目标不影响范围。
- 不同 viewport 宽度和 presentation 均默认周，显式尺度仍优先，并验证最小可读刻度。
- 每种 presentation、业务模式和尺度下的创建/拖动/键盘吸附精度。
- 缩放和 Resize 前后中心时间保持。
- 今天、左右滚动边界与分块触发，并验证工具栏没有上一/下一箭头。
- 稳定结构/Segment 块 DTO、显式范围绑定的结构游标、leaf-block-independent 游标、`rowPageKey`
  陈旧响应和跨块 Segment 去重。
- leaf block 完全越界、部分越界、负/零跨度、超过 366 天、伪造超大范围和 D18 子块越过父块均在
  查询前拒绝；合法相邻块仍可加载。
- 显式范围改变前后的活跃人员、停用人员和仅 Tag 匹配人员分页：旧 cursor 必须拒绝，新分页不得
  跳行或重复；内容驱动 Task/Project 成员行和 D20 人员计划行在 leaf block 改变时保持稳定。
- `rowPageKey` 覆盖 Plan/成员权限/Segment epoch；同 ID 新旧 version、同 token 冲突、移动和删除。
- 当前 `segmentReadableWhere` 下 `includeBusyBlocks=true` 仍不产生 Busy；保留 DTO 单元测试验证 dormant
  Busy 在块边界的裁剪/合并不会恢复源数量，但不通过修改授权构造可达 Busy 集成路径。
- `MY_TIMELINE_PAGE` 的结构选择器只接受 `taskCursor/showAll`；恢复范围策略和 leaf block 分层且
  严格验证。Task 列表与 Plan 行同源；协议中没有任意 Task/Person ID 输入，伪造或越页 ID 不能
  进入结果。
- `PROJECT_PAGE` 只接受 Project/Task页语义参数，伪造 Task/Person ID 没有输入位置且不能越权。
- DTO/URL 对旧 `date/mode/zoom`、`timelineDate/timelineFocus`、Project 合成 anchor ID 的兼容，
  `focus/center` 优先级、D21 范围外 focus、前进后退和恶意参数拒绝。
- 旧日/周/31 日窗口按上海半开区间中点精确转换；D14=C 的 `timelineDate` 生成硬 `from/to` 而非
  纯 center。Project locator 覆盖陈旧 cursor、目标移到另一页、目标不属于 Project 和已删除 Node。

### 12.2 Playwright E2E

- `/progress/my-timeline` 默认进入、目标控件删除、新工具栏和底部滚动。
- 当前 Task 页边界、`tasks=all`、Task 下一页和 Plan 行同步。
- 无 Task、无 Segment、仅独立 Segment、仅 Plan、跨年、超过 366 天和极端长名称。
- `focus` 位于初始可视窗口内外、无权 focus、旧 URL 进入。
- 按 D17 验证 focus 的选中/Dialog 状态；按 D15 验证当前、历史和未来视角中的快速新增默认时间。
- 所有尺度下新建 Planned/Actual、Composer 节点编辑、详情修改、完整确认、部分确认、取消和软删除
  的精度及定位保持。
- 人员计划、Task 详情、Project 详情、Composer、Dashboard 和详情 Dialog 的共享回归。
- 按 D14 验证各页面被删除/保留/转换的日期控件与 URL 查询结果，不允许两种范围语义冲突。
- 按 D20 验证内容驱动的活跃空行、停用历史行、Tag-only 行和 Person 显式选择；按 D21 验证人员
  计划范围外 focus、Task 分组下独立 Segment、行 cursor 清理，以及 Task/Project 旧 anchor 深链接
  在当前页、目标移页和陈旧 cursor 下的规范化结果。
- D5=A 时验证 180 天块边界、跨块 Segment 和 anchor 只传一次；D18=A 验证自动二分、单日仍超限
  和局部块失败重试，D18=B 验证整体失败，D18=C 验证新上限边界与性能保护。
- 超过最大逻辑跨度时显示裁剪状态，按 `focus > center > D11 fallback` 建立窗口，并可跳到最早/最新
  内容；D11=A 时今天不在完整内容加缓冲范围内就使用最早内容。
- D19=A 验证双预算、最远块淘汰、pin 和重取；D19=B 验证最多四个逻辑块；D19=C 验证
  100,000 对象/80 leaf block 停止加载与清空恢复。所有方案覆盖长时间往返滚动。
- Desktop `1440x1000` 与 Pixel 5 两个配置项目均验证：无 Next.js error overlay、无新增未处理
  browser error、无页面横向溢出、滚动同步和控件可操作。
- 通知 outbox/guard 断言保留，测试数据库中验证必要状态，不联系真实外部服务。

### 12.3 完成前命令

必须实际运行并成功：

```bash
npm run check
npm run test:e2e
```

由于改造涉及共享客户端/服务端边界和多个 Next.js 页面，还应运行：

```bash
npm run build
```

没有 Prisma schema/migration 变化时不运行 `npm run db:deploy`；若实施过程中确需索引 migration，
必须先更新计划并在隔离 PostgreSQL 执行 `npm run db:deploy` 验证。

## 13. 预计修改文件

决策确认后，预计涉及但不限于：

- `app/progress/my-timeline/page.tsx`
- `app/progress/resources/page.tsx`
- `app/progress/tasks/[id]/page.tsx`
- `app/progress/projects/[id]/page.tsx`
- `app/progress/page.tsx`
- `components/project-management/time-canvas/time-canvas.tsx`
- `components/project-management/time-canvas/time-math.ts`
- `components/project-management/time-canvas/types.ts`
- `components/project-management/time-canvas/adapter.ts`
- `components/project-management/time-canvas/url-state.ts`
- `components/project-management/resource-planner-canvas-client.tsx`
- `components/project-management/project-task-timeline.tsx`
- `components/project-management/task-workbench.tsx`
- `components/project-management/task-composer-plan-editor.tsx`
- `app/actions/project-management/canvas.ts`
- `app/api/project-management/canvas/route.ts`
- `lib/project-management/application/canvas-query-dispatcher.ts`
- `lib/project-management/queries/time-canvas-queries.ts`
- `lib/project-management/types/time-canvas.ts`
- `lib/project-management/validations/time-canvas.ts`
- `tests/project-management-s2-canvas-query-security.spec.ts` 及相关 Playwright/纯函数回归测试
- `README.md`、`docs/TECH.md`、`docs/TESTING.md`

最终以 D1、D5、D10、D14、D18-D21 的选择为准；不得为了匹配本列表而修改未受影响文件。

## 14. 风险与回滚

| 风险 | 控制措施 |
| --- | --- |
| 超长范围导致查询或响应过大 | D5 明确策略；保留对象上限；分块、预取、取消和错误态 |
| 边界聚合泄露不可读数据 | 复用授权 where；允许/拒绝测试；不返回对象详情 |
| 共享组件使其他页面回归 | D1 影响矩阵；逐模式迁移；fixture、桌面和移动 E2E |
| Resize/缩放导致视角跳动 | 保存中心时间；区分自动尺度与用户已选尺度 |
| 双滚动条不同步 | 单一 scroll state；双向同步防循环；滚动 E2E |
| mutation 后范围变化导致对象消失 | D11 定位优先级；保留 focus/中心；删除目标有明确 fallback |
| 旧链接失效 | D10 兼容策略；旧参数回归测试 |
| 显式范围变化后复用旧行游标 | `from/to` 进入结构签名；leaf block 单独签名；停用/Tag 行回归 |
| 我的时间 Task 列表与 Plan 行分叉 | 受约束 `MY_TIMELINE_PAGE` 单一响应；拒绝客户端派生 ID |
| 画布宽度过大造成浏览器性能问题 | 最大逻辑跨度和最大像素宽度；可视窗口裁剪 |
| 分块长期浏览导致客户端内存增长 | D19 双预算 LRU；淘汰重取；focus/Dialog 有界 pin |
| Project 块接口接受派生 ID 导致越权 | 受约束 PROJECT_PAGE 语义输入；服务端重新派生当前页 universe |
| Busy 跨块重复或泄露源数量 | 当前策略断言 Busy 不可达；dormant DTO 按人员/可见区间规范化且不传源 ID |

回滚应按阶段保持可逆：先保留旧 URL parser 和旧 TimeCanvas props 兼容层；所有页面迁移并通过完整
回归后再删除旧分支。任何回滚都不得回退数据库事实、审计记录或已执行的 Segment mutation。

## 15. 决策记录

2026-08-10：用户授权 Codex 选择最优方案并完成实现，冻结如下：

```text
D1=A, D2=A, D3=A, D4=A, D5=A（3个上海日历年）, D6=A, D7=A, D8=A, D9=A,
D10=A, D11=A, D12=A, D13=A, D14=A, D15=A, D16=A, D17=A,
D18=A, D19=A（20,000对象/16 leaf blocks）, D20=N/A, D21=A
```

理由：采用能满足所有 TimeCanvas 统一交互、保留精确业务筛选和旧链接、支持超 366 天范围且保持
查询/内存有界的建议组合。实施中如发现选择与权限、安全上限或现有业务规则冲突，必须回到本文
新增决策，不得静默改变。

2026-08-11：根据实际使用反馈追加纠偏决策；以下内容覆盖上方 D7 初始尺度和 D12 导航选择，其余
决策保持不变：

1. 所有 TimeCanvas presentation 和业务模式在 URL/调用方未显式指定尺度时固定默认 `WEEK`；不再
   根据范围跨度或 ResizeObserver 自动改成月、季或年。用户选择的尺度在 Resize、服务端刷新和
   Task 节点聚焦期间保持不变。
2. D12 改为 C：删除“今天”两侧的上一/下一箭头，只保留“今天”、尺度选择和底部横向滚动条；
   超过三年范围继续使用已有“最早内容/最新内容”入口。
3. 有效（非 `CONFIRMED/CANCELLED`）Planned Segment 的创建和编辑时间参与内容边界。内容驱动页
   刷新权威 `rowPageKey` 后，将 Planned 所在 180 天块及相邻块加入加载集合，因此 Planned 之前的
   两个上海日历月缓冲也会进入逻辑范围和可加载范围；当前视口与尺度保持不变，不自动居中到新
   Planned。目标落在三年逻辑窗口外时只扩大 `fullRange`，由已有最早/最新入口切换窗口。
4. 人员计划显式 `from/to` 仍为硬范围，不因 Planned 创建或编辑而向外扩展。
5. 2026-08-11 实际使用反馈：内容驱动页的“今天”改为始终可用；服务端把今天附近窗口并入
   `fullRange`，但 `contentRange` 和其两个月缓冲规则不变，且默认中心仍优先内容。显式 `from/to`
   继续在今天位于硬范围外时禁用。
6. 2026-08-11 实际使用反馈：同一逻辑范围内点击“今天”改为单次即时居中，不再对跨年距离使用
   会被视口状态回写打断的平滑滚动，避免按钮每次只缓慢移动一小段。
