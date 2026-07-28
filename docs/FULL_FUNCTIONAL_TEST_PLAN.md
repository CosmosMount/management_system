# 全功能测试规划

本文档定义“全功能测试”的范围、数据准备、执行顺序和通过标准。它不是简单页面冒烟；完整通过需要测试库、测试上传目录、至少 4 类账号或等价的本地 storage state。

## 测试分层

### L0 静态与构建

目标：确认代码、Prisma schema、迁移和构建链路可复现。

必跑命令：

```bash
npm run check
npx prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --exit-code
npm run build
```

通过标准：

- Prisma validate、generate、TypeScript、scripts TypeScript、ESLint、`git diff --check` 全部通过。
- migration diff 无差异。
- build 成功；warning 必须记录并分级。

### L1 页面与权限冒烟

目标：确认主要面板在桌面和移动端可进入、不 500、不出现 Next error overlay、不横向溢出。

入口：

- `/`
- `/profile`
- `/feedback`
- `/procurement`
- `/procurement/list`
- `/procurement/dashboard`
- `/procurement/new`
- `/procurement/workshop-fee`
- `/progress`
- `/admin`
- `/admin/roles`
- `/admin/budget-pools`
- `/admin/system`
- `/not-exists-for-playwright`
- `/uploads/playwright-missing-file.png`

通过标准：

- 未登录访问受保护页面不 500，可跳登录或显示无权限。
- 登录后上述页面不跳登录。
- `/uploads/...` 未登录不可直接读取，首跳为 3xx/401/404。
- 桌面 `1440x1000` 和移动端 Pixel 5 无横向溢出。

执行：

```bash
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3002 \
PLAYWRIGHT_STORAGE_STATE=/path/to/playwright-liqixuan-storage.json \
PLAYWRIGHT_ADMIN_STORAGE_STATE=/path/to/playwright-admin-storage.json \
npm run test:e2e
```

### L2 单账号浅交互

目标：确认常用筛选、URL 状态和基础点击没有明显回退。

场景：

- 反馈中心：点击“全部”，点击反馈项，URL `selected` 与详情保持稳定。
- 项目管理占位：`/progress` 展示中文重构状态，代表性旧 `/progress/*` 地址重定向到该入口。
- 采购列表：切换状态筛选，进入草稿/订单详情。
- 管理面板：进入角色、预算池和系统同步页面。

通过标准：

- URL query 可刷新复现。
- 列表或空状态文案正常。
- 控制台无 uncaught error。

### L3 业务闭环

完整通过必须准备可写测试数据，并在独立 PostgreSQL 测试库执行。不得使用生产 3000 和生产数据库。

#### 采购

账号：

- 申请人
- 车组组长
- 技术组组长
- 老师或超级管理员
- 报销员

场景：

1. 新建采购申请，必填校验显示中文错误。
2. 保存草稿，从列表进入编辑，再保存草稿。
3. 草稿编辑后提交申请。
4. 管理审核：车组组长通过、技术组组长通过。
5. 老师审核通过。
6. 申请人上传发票、每行实物照片，生成验收清单。
7. 缺少签名、发票、照片时失败并清理临时上传。
8. 报销员上传截图。
9. 申请人确认报销，订单完成。
10. 驳回路径：管理驳回、老师驳回、报销退回、申请人重传。
11. 工坊加工费：创建、草稿、提交、审批。
12. 附件权限：匿名 401/3xx，越权 403/404，有权可读，伪 MIME/超大小拒绝。

重点断言：

- 每次状态变化写入动态或审批记录。
- outbox 有对应通知，重复 drain 不重复发送成功项。
- 失败路径不留下孤儿 `FileAsset` 或磁盘文件。

#### 项目管理占位与清理

场景：

1. 桌面和 Pixel 5 打开 `/progress`，展示中文“项目管理重构中”。
2. 打开 `/progress/new`、`/progress/list`、`/progress/dashboard`、`/progress/archive`、`/progress/task/legacy-id` 和 `/progress/legacy-id`，均重定向到 `/progress`。
3. 管理页面无 `PROJECT_MANAGER`、旧验收条例、项目模板或进度提醒配置。
4. 在含旧项目管理数据的隔离 migration fixture 上执行收缩 migration，确认旧表、旧 enum、`channel=progress` outbox/recipient 被删除。

重点断言：

- 采购、反馈、用户、角色、附件、其他 channel outbox 和 CardKit 跟踪数据不变。
- 没有旧项目、阶段、任务、审批、周报、风险、提醒页面或 Server Action 可调用。
- 占位页和重定向无 500、Next error overlay、未处理错误或横向溢出。

#### 反馈

场景：

1. 新建反馈，图片类型、数量、单张 20MB、合计 50MB 校验。
2. 回复反馈，管理员/提交人双方可见。
3. 状态切换：开放、处理中、已关闭。
4. 点击“全部”后选择已关闭/活动反馈，筛选不被 URL selected 强制覆盖。
5. 直接打开 `/feedback?selected=<closedId>` 可进入能看到该反馈的筛选视图。

#### 管理员

场景：

1. 角色增删改，重新登录后权限生效。
2. 预算池增删改，采购触发预算提醒。
3. 系统同步：飞书用户同步失败/成功均有明确提示。
4. 旧项目管理角色、模板和提醒入口不存在。

### L4 并发与一致性

场景：

- 订单号并发创建。
- 管理审核双击/双账号同时通过。
- outbox drain 部分失败后只重试失败收件人。
- cron/app 多实例不能重复 claim 同一 outbox。
- procurement/feedback adapter 对重复 eventKey、无效 payload、收件人去重和未知 channel 的处理。
- 飞书统一传输层的禁发、allowlist、机器人用途、`open_id`/`union_id`、fallback、text/卡片/CardKit 与错误脱敏。

通过标准：

- 使用 `updateMany` 条件锁或唯一键保证只推进一次。
- 重复请求返回中文可读错误，不产生重复状态记录。

## 测试数据建议

至少准备：

- 5 个测试用户：申请人、车组组长、技术组组长、超管、报销员。
- 2 个车组、3 个技术组，含 `宣运`。
- 采购订单：草稿、待管理审核、待老师审核、待上传凭证、待报销截图、待确认、已完成、已驳回。
- 反馈：开放、处理中、已关闭，含图片附件。
- 通知 fixture：procurement/feedback outbox 各状态、多收件人部分失败、过期锁和非法 channel/payload。
- migration fixture：包含旧项目管理表/数据与需保留共享数据的迁移前 schema。

## 报告格式

每次全功能测试输出：

```text
环境:
- commit:
- baseURL:
- database: <脱敏>
- storage state:
- 执行人:

命令:
- npm run check:
- migrate diff:
- npm run build:
- Playwright:

结果:
- L0:
- L1:
- L2:
- L3:
- L4:

失败:
- 严重级别:
- 路径:
- 复现步骤:
- 期望:
- 实际:
- 证据截图/trace/html:

未覆盖:
- 原因:
- 需要的账号/fixture:
```

## 当前自动化覆盖边界

页面 smoke 只覆盖 L1 和部分 L2，不能等同于全功能通过。完整结论还需要带 fixture 的采购、反馈、项目管理占位/清理、管理员、飞书传输层、channel adapter、outbox 并发和 migration spec。
