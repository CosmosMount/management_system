# 技术文档

本文档面向开发者，描述 pnx management 的架构、数据模型与关键实现。使用说明见根目录 [`README.md`](../README.md)。

## 技术栈

| 层级 | 选型 |
|------|------|
| 框架 | Next.js 16（App Router, TypeScript） |
| 数据库 | Prisma 7 + SQLite（`@prisma/adapter-better-sqlite3`） |
| UI | Tailwind CSS 4 + shadcn/ui（Base UI） |
| 表单 | React Hook Form + Zod |
| 认证 | Auth.js v5（飞书 OAuth） |
| 定时任务 | node-cron（`scripts/cron.ts`，独立进程） |

## 架构

```
用户 → Next.js 页面 → Server Actions → Prisma/SQLite
                    ↘ 飞书 Webhook / 私信（卡片通知）
定时脚本 cron.ts → Prisma → 采购日报 + 进度逾期/周报提醒
```

- 无独立后端服务，业务逻辑集中在 `app/actions/` 与 `lib/`
- 文件上传写入 `public/uploads/`，由 Next.js 静态托管
- 飞书集成拆分为 OAuth（`lib/feishu-oauth.ts`）、通讯录（`lib/feishu-contact.ts`）、消息（`lib/feishu.ts`）、进度通知（`lib/feishu-progress.ts`）

## 目录结构

```
app/
  actions/          # Server Actions（采购 + 进度 + 管理）
  api/auth/         # Auth.js 路由
  apply/ orders/    # 采购报销页面
  progress/         # 进度管理页面
  admin/            # 角色管理
components/         # UI 组件（含 progress/ 子目录）
lib/                # 业务逻辑、权限、飞书、校验
prisma/
  schema.prisma     # 数据模型
  seed.ts           # 初始角色 seed
scripts/            # cron、数据迁移/fix 脚本
public/uploads/     # 采购附件（运行时生成）
```

## 认证与中间件

Auth.js 不能在中件件中 import 含 Prisma 的模块，因此拆分：

| 文件 | 用途 |
|------|------|
| `lib/auth.config.ts` | Edge 可用配置 |
| `lib/auth-edge.ts` | middleware 使用 |
| `lib/auth.ts` | 完整 auth（含 signIn 时 upsert User） |

登录后 `User` 表记录 `openId`、姓名、头像；`UserRole` 表单独维护审批角色。

## 权限

| 模块 | 文件 | 说明 |
|------|------|------|
| 采购 | `lib/permissions.ts` | 服务端角色查询 |
| 采购（客户端） | `lib/permissions-client.ts` | 纯函数，无数据库依赖 |
| 进度 | `lib/permissions-progress.ts` | 项目/任务/验收权限 |

角色类型见 `UserRoleType` enum：`SUPER_ADMIN`、`TEAM_ADMIN`、`TECH_GROUP_ADMIN`、`TEACHER`、`FINANCE`、`PROJECT_MANAGER`。

## 数据模型

### 采购报销

| 模型 | 说明 |
|------|------|
| `User` | 飞书用户 |
| `UserRole` | 角色分配（可带 team / techGroup 范围） |
| `PurchaseOrder` | 采购主单 |
| `PurchaseItem` | 明细（含购买链接） |

**状态机：**

```
DRAFT → MANAGEMENT_REVIEW → TEACHER_REVIEW → PENDING_APPLICANT_DOCS
      → PENDING_FINANCE_REVIEW → PENDING_APPLICANT_CONFIRM → COMPLETED
```

状态变更与审批逻辑在 `app/actions/updateOrderStatus.ts`、`approveManagementReview.ts` 等。

### 进度管理

| 模型 | 说明 |
|------|------|
| `Project` | 项目（车组、技术组、宏观状态） |
| `ProjectMilestone` | 验收里程碑（飞书文档链接） |
| `Task` | 任务（负责人、指标、截止、类别） |
| `TaskSubmission` | 交付 / 里程碑提交 |
| `WeeklyReport` | 周报 |
| `ApprovalRecord` | 验收记录 |
| `ProgressActivityLog` | 操作留痕 |

**项目状态流转**（`lib/progress-flow.ts`，服务端强制校验）：

```
DRAFT → IN_PROGRESS → NORMAL | ABNORMAL
NORMAL → OUTCOME_GOOD
ABNORMAL → UNDER_INTERVENTION
UNDER_INTERVENTION → NORMAL | OUTCOME_GOOD | OUTCOME_POOR
OUTCOME_GOOD | OUTCOME_POOR → ARCHIVED
```

**任务状态流转：**

```
TODO → IN_PROGRESS →（提交交付）→ PENDING_ACCEPTANCE →（验收）→ COMPLETED → ARCHIVED
```

`IN_PROGRESS → PENDING_ACCEPTANCE` 由 `submitTaskDelivery` 触发；`PENDING_ACCEPTANCE → COMPLETED` 由 `approveTaskSubmission` 触发。UI 通过 `getNextProjectStatuses()` / `StatusStepper` 仅展示允许的下一步。

里程碑须按 `sortOrder` 顺序提交与验收；归档前要求全部里程碑 `PASSED` 且项目处于 `OUTCOME_GOOD` 或 `OUTCOME_POOR`。

## 路由一览

### 采购报销

| 路径 | 功能 |
|------|------|
| `/` | 首页导航 |
| `/login` | 飞书登录 |
| `/apply` | 采购申请 |
| `/orders` | 订单列表 |
| `/orders/[id]` | 订单详情与审批 |
| `/dashboard` | 采购汇总看板 |
| `/admin` | 角色与通讯录管理 |

### 进度管理

| 路径 | 功能 |
|------|------|
| `/progress` | 进度首页 |
| `/progress/projects/new` | 新建项目 |
| `/progress/projects/[id]` | 项目详情 |
| `/progress/tasks/[id]` | 任务详情 |
| `/progress/kanban` | 任务看板 |
| `/progress/archive` | 归档检索 |

## 飞书集成要点

- **OAuth 回调**：`/api/auth/callback/feishu`，须与 `AUTH_URL` 完全一致
- **Webhook 签名**：`HmacSHA256("", timestamp + "\n" + secret)` 后 Base64
- **私信**：`im:message:send_as_bot`，收件人须曾登录以建立机器人会话
- **通讯录同步**：`app/actions/syncFeishuUsers.ts`，需 `contact:*` 只读权限

进度模块交付物以飞书文档 URL 形式提交，审批人在飞书中打开核对；系统不做文档访问记录 API 校验。

## Prisma 与数据库

- SQLite 文件默认位于仓库根目录 `dev.db`（`DATABASE_URL=file:./dev.db`）
- Prisma 7 要求传入 driver adapter，路径解析见 `lib/prisma.ts`
- dev 热更新可能导致 client 缓存过期；`lib/prisma.ts` 中 `isPrismaClientStale()` 会在缺少新 model delegate 时重建 client
- schema 变更后执行 `npx prisma generate` 并重启 dev server

### 常用命令

```bash
npm run db:push      # 同步 schema 到 SQLite
npm run db:seed      # 写入初始 SUPER_ADMIN 等角色
npm run db:fix-roles # 清理异常角色数据后重新 seed
npm run db:studio    # Prisma Studio
npm run cron         # 启动定时任务（独立进程）
```

## 文件上传

- 实现：`lib/file-upload.ts`，采购附件元数据：`lib/order-attachments.ts`
- 存储：`public/uploads/<订单ID>/`
- 单文件 20MB，Server Actions 总上限 100MB（`next.config.ts` 中 `serverActions.bodySizeLimit`）
- **无访问鉴权**，适用于本地/内网可信环境

## 定时任务

`scripts/cron.ts` 使用 `node-cron`：

| 调度 | 内容 |
|------|------|
| 每日 09:00 | 采购日报、任务逾期警报、当日截止提醒 |
| 每周一 09:00 | 活跃任务周报填写提醒（私信负责人） |

与 Next.js 主进程分离，生产环境用 PM2、systemd 或下文 **Docker** 中的 `cron` 服务单独拉起。

## Docker 部署

仓库提供 `Dockerfile` + `docker-compose.yml`，包含 **app**（Web）与 **cron**（定时任务）两个服务。

```bash
docker compose up -d --build
```

### 镜像说明

- 基础镜像 `node:20-bookworm-slim`（兼容 `better-sqlite3` 原生模块）
- 构建阶段：`prisma generate` + `next build`
- 启动入口 `docker/entrypoint.sh`：创建数据目录 → `prisma db push` → 可选 seed → 启动进程

### 持久化

| 挂载点 | 用途 |
|--------|------|
| `app-data` → `/app/data` | SQLite（`app.db`） |
| `app-uploads` → `/app/public/uploads` | 采购附件 |

### 环境变量

Compose 将 `DATABASE_URL` 固定为 `file:/app/data/app.db`。其余变量从宿主机 `.env` 注入（见 `.env.example`）。

| 变量 | 说明 |
|------|------|
| `APP_PORT` | 宿主机映射端口，默认 `3000` |
| `RUN_DB_SEED` | 设为 `true` 时启动 app 会执行 `prisma/seed.ts`（仅首次） |

### 注意

- `AUTH_URL` / `NEXT_PUBLIC_APP_URL` 必须填用户浏览器实际访问的地址，与飞书 OAuth 重定向一致
- 更新代码：`docker compose up -d --build`
- 不建议将 SQLite 卷放在 NFS 等多节点共享存储上

## 已知限制

- 采购订单首版无驳回流程，状态只能向前流转
- 附件与 SQLite 需手动备份
- `UserRole` 不会随首次登录自动分配，须 seed 或 `/admin` 配置
- Serverless 部署需替换 SQLite 并将 cron 迁出
- `lib/feishu-doc.ts` 保留 URL 解析工具，当前审批流未使用访问记录 API

## 环境变量

完整列表见 [`.env.example`](../.env.example)。局域网调试可设置 `LAN_HOST` 或 `ALLOWED_DEV_ORIGINS`。
