# 技术文档

本文档面向开发者，描述 pnx management 的架构、数据模型与关键实现。使用说明见根目录 [`README.md`](../README.md)。

## 技术栈

| 层级 | 选型 |
|------|------|
| 框架 | Next.js 16（App Router, TypeScript） |
| 数据库 | Prisma 7 + PostgreSQL（`@prisma/adapter-pg`） |
| UI | Tailwind CSS 4 + shadcn/ui（Base UI） |
| 表单 | React Hook Form + Zod |
| 认证 | Auth.js v5（飞书 OAuth） |
| 定时任务 | node-cron（`scripts/cron.ts`，独立进程） |

## 架构

```
用户 → Next.js 页面 → Server Actions → Prisma/PostgreSQL
                    ↘ 飞书 Webhook / 私信（卡片通知）
定时脚本 cron.ts → Prisma → 采购日报 + 进度逾期/周报提醒
```

- 无独立后端服务，业务逻辑集中在 `app/actions/` 与 `lib/`
- 文件上传写入私有目录 `storage/uploads/`，通过 `/uploads/...` 鉴权 route 返回
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
scripts/            # cron、seed/fix 脚本
storage/uploads/    # 私有上传附件（运行时生成）
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
| `ProcurementBudgetPool` | 车组+技术组配对采购预算池（按周期，含描述） |

**采购明细 Excel 导入**（`lib/import-procurement-items.ts`）：采购申请页支持从 Excel 导入条目，列包括物品名称、规格、种类、采购链接、加工商、数量、行总价。加工费条目导入后仍需手动上传图片。

**预算池**（`lib/procurement-budget.ts`、`lib/procurement-budget-alerts.ts`）：

- 超级管理员在 `/admin` 通过 Excel 导入预算（描述、车组、技术组、预算、周期默认 2026）；每行一条车组+技术组配对，单次最多 300 行；支持追加或覆盖同周期数据
- 已使用金额 = 同一车组且同一技术组、状态非 `DRAFT`/`REJECTED` 的订单 `totalPrice` 之和
- 使用率首次达到 70%、80%、90%、100% 时向对应车组组长或技术组组长发送飞书私信
- 采购看板 `/procurement/dashboard` 按车组/技术组 Tab 展示预算使用率

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
| `/procurement` | 采购管理首页 |
| `/procurement/new` | 采购申请 |
| `/procurement/list` | 订单列表 |
| `/procurement/[id]` | 订单详情与审批 |
| `/procurement/dashboard` | 采购汇总看板 |
| `/admin` | 角色与通讯录管理 |

### 进度管理

| 路径 | 功能 |
|------|------|
| `/progress` | 进度首页 |
| `/progress/new` | 新建项目 |
| `/progress/list` | 项目列表 |
| `/progress/[id]` | 项目详情 |
| `/progress/task/[id]` | 任务详情 |
| `/progress/dashboard` | 任务看板 |
| `/progress/archive` | 归档检索 |

## 飞书集成要点

- **OAuth 回调**：`/api/auth/callback/feishu`，须在飞书后台为每个允许入口分别配置完整 URL
- **Webhook 签名**：`HmacSHA256("", timestamp + "\n" + secret)` 后 Base64
- **私信**：`im:message:send_as_bot`，收件人须曾登录以建立机器人会话
- **通讯录同步**：手动入口 `app/actions/syncFeishuUsers.ts`，定时入口 `scripts/cron.ts`，共用 `lib/feishu-user-sync.ts`；需 `contact:*` 只读权限

进度模块交付物以飞书文档 URL 形式提交，审批人在飞书中打开核对；系统不做文档访问记录 API 校验。

## Prisma 与数据库

本地开发使用 **PostgreSQL**。推荐只启动 compose 中的 `postgres` 服务，应用在宿主机 3000 端口运行：

```bash
docker compose up -d postgres
npm run db:deploy
```

- 连接串：`DATABASE_URL=postgresql://postgres:<密码>@localhost:5432/management_system`（见 `.env.example`）
- Prisma 7 通过 `prisma.config.ts` 读取 `DATABASE_URL`；客户端使用 `@prisma/adapter-pg` + `pg` Pool（`lib/prisma.ts`）
- `SHADOW_DATABASE_URL` 用于 `prisma migrate diff`，库名建议以 `_shadow` 结尾，并与业务库分离
- dev 热更新可能导致 client 缓存过期；`lib/prisma.ts` 中 `isPrismaClientStale()` 会在缺少新 model delegate 时重建 client
- schema 变更后执行 `npx prisma generate` 并重启 dev server
- 旧 SQLite 数据不迁移；首次部署从空 PostgreSQL 库开始

### 常用命令

```bash
npm run db:deploy              # prisma migrate deploy（等待 PG 就绪）
npm run db:seed                # 写入初始 SUPER_ADMIN 等角色
npm run db:fix-roles           # 清理异常角色数据后重新 seed
npm run db:studio              # Prisma Studio
npm run cron                   # 启动定时任务（独立进程）
```

## 文件上传

- 实现：`lib/file-upload.ts`，采购附件元数据：`lib/order-attachments.ts`
- 存储：`storage/uploads/<订单ID>/`
- 单文件 20MB，Server Actions 总上限 100MB（`next.config.ts` 中 `serverActions.bodySizeLimit`）
- 访问：浏览器 URL 保持 `/uploads/...`，由 `app/uploads/[...path]/route.ts` 校验登录和 FileAsset 权限后读取

### 验收清单自动生成

采购人上传凭证时，系统根据 `templates/material-acceptance-list-base.docx`（由学校官方模板转换）自动填充表格、**电子签名图片**与日期，并按明细行数扩表；有实物照片时嵌入清单末尾照片区。

- 签名来源：用户在「个人设置」上传的 PNG/JPG（`User.signaturePath`）
- 验收人 1/2：对应车组、技术组组长；领用人：采购发起人
- 正式提交凭证前校验三方均已上传签名；预览可不含签名

- 实现：`lib/generate-reimbursement-docx.ts`（docxtemplater + image module）
- 模板源文件：`templates/material-acceptance-list-source.docx`
- 生成用 base 模板：`templates/material-acceptance-list-base.docx`（`npm run prepare:template` 产出）
- 更新官方模板后运行：`npm run prepare:template`
- 明细最多 50 行（与 Word 模板行数一致，超出会自动扩行直至该上限）

## 定时任务

`scripts/cron.ts` 使用 `node-cron`：

| 调度 | 内容 |
|------|------|
| 默认每日 08:30 | 从飞书通讯录扫描并同步本地人员（可用 `FEISHU_CONTACT_SYNC_CRON` 调整） |
| 每日 09:00 | 采购日报、任务逾期警报、当日截止提醒 |
| 每周一 09:00 | 活跃任务周报填写提醒（私信负责人） |

与 Next.js 主进程分离，生产环境用 PM2、systemd 或下文 **Docker** 中的 `cron` 服务单独拉起。

## Docker 部署

### 本地开发

```bash
docker compose up -d postgres
# 无 docker 组权限：./scripts/docker-compose-sudo.sh up -d postgres
```

应用在宿主机运行，`DATABASE_URL` 指向 `localhost:5432`。

### 全栈（app + cron）

仓库提供 `Dockerfile` + `docker-compose.yml`，包含 **postgres**、**app**（Web）与 **cron**（定时任务）三个服务：

```bash
docker compose up -d --build
```

当前用户没有 Docker socket 权限时，可在 `.env` 或当前 shell 设置 `SUDO_PASSWORD` 后执行：

```bash
./scripts/docker-compose-sudo.sh up -d --build
```

`SUDO_PASSWORD` 仅在宿主机侧供 `sudo -S docker compose ...` 使用，不会注入容器运行时环境。

### 镜像说明

- 基础镜像 `node:20-bookworm-slim`
- 构建阶段：`prisma generate` + `next build`（构建时 `DATABASE_URL` 为占位 PostgreSQL 串）
- 启动入口 `docker/entrypoint.sh`：创建数据目录 → `npm run db:deploy` → 可选 seed → 启动进程

### 持久化（全栈 Compose）

| 挂载点 | 用途 |
|--------|------|
| `app-uploads` → `/app/storage/uploads` | 私有上传附件 |
| `postgres-data` → `/var/lib/postgresql/data` | PostgreSQL 数据目录 |

### 环境变量

全栈 Compose 会为 app/cron 注入容器内 PostgreSQL 连接串。应用所需变量通过 `${VAR}` 从宿主机 `.env` 读取后显式注入容器（见 `.env.example`）；宿主机辅助变量如 `SUDO_PASSWORD` 不会传入容器。

| 变量 | 说明 |
|------|------|
| `APP_PORT` | 宿主机映射端口，默认 `3000` |
| `RUN_DB_SEED` | 设为 `true` 时启动 app 会执行 `prisma/seed.ts`（仅首次） |

### 注意

- 双入口访问时不要设置 `AUTH_URL` / `NEXTAUTH_URL`；使用 `APP_ALLOWED_ORIGINS` 允许域名、内网 IP 和本机调试入口
- `NEXT_PUBLIC_APP_URL` 仅作为后台任务/cron 无请求上下文时的默认系统地址
- 更新代码：`docker compose up -d --build`

## 已知限制

- 采购订单首版无驳回流程，状态只能向前流转
- 附件需手动备份；PostgreSQL 使用 `postgres-data` 卷或 `pg_dump`
- `UserRole` 不会随首次登录自动分配，须 seed 或 `/admin` 配置
- Serverless 部署需将 cron 迁出
- `lib/feishu-doc.ts` 保留 URL 解析工具，当前审批流未使用访问记录 API

## 环境变量

完整列表见 [`.env.example`](../.env.example)。局域网调试可设置 `LAN_HOST` 或 `ALLOWED_DEV_ORIGINS`。
