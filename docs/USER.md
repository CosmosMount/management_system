# 采购报销系统 — 使用说明

## 快速启动

```bash
cp .env.example .env   # 填写飞书凭证与 AUTH_SECRET
npm install
npm run db:push
npm run dev
```

访问 http://localhost:3000 ，使用飞书登录。

## 环境变量

| 变量 | 说明 |
|------|------|
| `DATABASE_URL` | SQLite 路径，默认 `file:./dev.db`（数据库文件在仓库根目录） |
| `AUTH_SECRET` | Auth.js 密钥，可用 `openssl rand -hex 32` 生成 |
| `AUTH_URL` | 应用地址，如 `http://localhost:3000` |
| `FEISHU_APP_ID` | 飞书自建应用 App ID |
| `FEISHU_APP_SECRET` | 飞书自建应用 App Secret |
| `FEISHU_WEBHOOK_URL` | 应用机器人在通知群的 Webhook 地址 |
| `FEISHU_WEBHOOK_SECRET` | 可选，Webhook 签名校验密钥 |
| `NEXT_PUBLIC_APP_URL` | 前端可访问的系统地址（飞书卡片按钮跳转用） |

## 飞书应用配置

1. 在[飞书开放平台](https://open.feishu.cn/)创建**企业自建应用**
2. 开启能力：**网页应用**（OAuth）+ **机器人**（群消息）
3. **安全设置** → **重定向 URL** 添加（须与下方完全一致，多一个斜杠也会 20029）：

   ```
   http://localhost:3000/api/auth/callback/feishu
   ```

   也可在登录页 `/login` 底部查看当前系统使用的地址。

4. 权限管理：开通 **`contact:user.base:readonly`**（获取用户基本信息，用于登录）
5. 将应用机器人拉入采购通知群
6. 获取该机器人的 Webhook 地址，填入 `FEISHU_WEBHOOK_URL`

## 角色配置（审批必做）

登录只解决「谁能进系统」；**审批按钮**取决于 `UserRole` 表里的角色分配。

### 推荐：超级管理员可视化管理

1. 自己先用飞书登录一次
2. 在 [`prisma/seed.ts`](../prisma/seed.ts) 填入自己的 `openId` 为 `SUPER_ADMIN`，执行 `npm run db:seed`
3. 登录后访问 **`/admin` 权限管理**：
   - 点击 **「同步飞书通讯录」** 将企业全员录入系统（无需对方先登录）
   - **车组组长配置**：为每个车组指定组长与报销员
   - **技术组组长配置**：为每个技术组指定组长

用户也可通过飞书登录自动写入/更新 `User` 表；分配角色前需先完成通讯录同步或让对方登录一次。

### 飞书通讯录权限（同步全员）

在应用 **权限管理** 中开通并由企业管理员授权（应用身份、全部成员）：

| 权限 | scope |
|------|--------|
| 获取用户基本信息 | `contact:user.base:readonly` |
| 获取部门基础信息 | `contact:department.base:readonly` |
| 获取通讯录部门组织架构信息 | `contact:department.organize:readonly` |

同步使用 `tenant_access_token` 调用通讯录 API，将 `open_id`、姓名、头像写入 `User` 表。

### 角色说明

| 角色 | 范围 | 权限 |
|------|------|------|
| SUPER_ADMIN | 全局 | 访问 `/admin`，管理所有角色 |
| TEAM_ADMIN | 指定车组 | 管理审核阶段，车组组长通过 |
| TECH_GROUP_ADMIN | 指定技术组 | 管理审核阶段，技术组组长通过 |
| TEACHER | 全局 | 「老师审核」阶段通过 |
| FINANCE | 指定车组 | 上传报销截图 |
| PROJECT_MANAGER | 全局 | 项管：进度汇总、项目异常介入、任务/里程碑验收 |

同一人可拥有多个角色（如同时担任「英雄」管理员与「工程」报销员）。

### 导航栏没有「权限管理」？

常见原因：

1. **`db:seed` 未执行**：`seed.ts` 里写了 SUPER_ADMIN 不等于已写入数据库，需运行 `npm run db:seed`
2. **openId 不一致**：`UserRole.openId` 必须与 `User` 表中你登录账号的 openId 完全一致
3. **旧数据残留**：若曾配置过 `TECH` 或 `ou_xxx_placeholder`，schema 升级后会导致角色表异常，执行：
   ```bash
   npm run db:fix-roles
   ```
4. **会话未刷新**：修改角色后退出重新飞书登录一次

### 手动 seed（可选）

```typescript
const seedRoles = [
  { openId: "ou_xxx", role: UserRoleType.SUPER_ADMIN },
  { openId: "ou_yyy", role: UserRoleType.TEACHER },
  { openId: "ou_zzz", role: UserRoleType.TEAM_ADMIN, team: "英雄" },
  { openId: "ou_aaa", role: UserRoleType.TECH_GROUP_ADMIN, techGroup: "机械" },
  { openId: "ou_bbb", role: UserRoleType.FINANCE, team: "英雄" },
];
```

### 完整审批与报销流程

**审批：**

1. **申请人** → `/apply` 提交
2. **管理审核**（状态「管理审核」）：车组组长、技术组组长**均需通过**（分别私信通知），全部通过后进入老师审核
3. **TEACHER** → 「指导老师通过」
4. **采购人** → 上传发票 + Word 清单（状态「待上传凭证」）
5. **报销员** → 上传报销截图（状态「待报销截图」）
6. **采购人** → 「确认报销」（状态「待确认」）→ 完成

**状态一览：**

```
草稿 → 管理审核 → 老师审核 → 待上传凭证 → 待报销截图 → 待确认 → 已完成
```

---

## 飞书通知

### 群 Webhook（可选）

在 `.env` 填写 `FEISHU_WEBHOOK_URL` 后，状态变更时会向**群**推送卡片。未配置则跳过群通知。

### 审批人私信（已实现）

开通权限 **`im:message:send_as_bot`** 后，系统会在状态变更时向对应角色的**所有** `UserRole` 用户私发卡片：

| 订单状态 | 私信通知 |
|----------|----------|
| 管理审核 | 车组组长 + 技术组组长（分别发送） |
| 老师审核 | TEACHER |
| 待上传凭证 / 待确认 | 采购发起人 |
| 待报销截图 | FINANCE（对应车组） |

前提：

1. 审批人已在 `UserRole` 表中配置正确的 `open_id`
2. 审批人至少登录过本系统一次（与机器人建立会话）
3. `.env` 中 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 有效

群 Webhook 与私信**独立**：只配 App 凭证也可发私信；Webhook 仅影响群消息。

## 功能测试流程

1. **登录**：访问 `/login`，飞书授权后跳转 `/orders`
2. **申请**：`/apply` 填写车组、技术组，添加明细，点击「提交申请」
3. **通知**：提交后通知群应收到飞书交互卡片（需配置 Webhook）
4. **管理审核**：车组组长、技术组组长分别点击「通过」
5. **老师审批**：TEACHER 点击「指导老师通过」
6. **采购人上传**：多张发票（每张 ≤20MB）+ Word 清单
7. **报销员**：在详情页或弹窗中查看发票与清单后，上传报销截图
8. **采购人确认**：点击「确认报销」
9. **定时汇总**：`npm run cron`（每天 09:00）

## 上传文件与附件

### 存储位置

上传文件保存在项目目录下：

```
public/uploads/<订单ID>/<文件名>
```

例如：`public/uploads/a1b2c3.../invoice-1-1712345678-abc.pdf`

- 通过浏览器访问：`http://localhost:3000/uploads/<订单ID>/<文件名>`
- 服务器上直接查看：进入项目根目录，打开 `public/uploads/` 文件夹
- 生产环境备份时请一并备份 `public/uploads/` 与 SQLite 数据库

### 限制

| 项目 | 限制 |
|------|------|
| 单文件大小 | 20MB |
| 发票数量 | 最多 20 张（可多选） |
| 清单 | 1 份（.doc / .docx / .pdf） |
| 报销截图 | 1 份 |

Server Actions 总上传上限 100MB（多张发票合计）。

### 谁能查看附件

订单详情页「**流程附件**」按步骤展示：

| 步骤 | 内容 | 可查看 |
|------|------|--------|
| 采购人上传 | 发票、Word 清单 | 采购人、对应车组报销员、超级管理员 |
| 报销员上传 | 报销截图 | 同上 |

报销员在「上传截图」弹窗内也会显示发票与清单链接。飞书私信会提示前往详情页查看附件。

修改 `next.config.ts` 中 `serverActions.bodySizeLimit` 可调整总上传上限（需重启 dev server）。

## 局域网调试

本机 IP 变化时可在 `.env` 设置 `LAN_HOST=你的IP`，或 `ALLOWED_DEV_ORIGINS=ip1,ip2` 追加多个主机。

### 1. 启动

```bash
npm run dev
```

默认监听 `0.0.0.0:3000`，局域网内其他设备可访问 `http://<本机IP>:3000`（如 `http://10.7.165.65:3000`）。

仅本机调试可用 `npm run dev:local`（只绑定 localhost）。

### 2. 修改 `.env`

从手机或其他电脑访问时，需把地址改成局域网 IP（飞书 OAuth 回调必须与访问地址一致）：

```env
AUTH_URL="http://10.7.165.65:3000"
NEXT_PUBLIC_APP_URL="http://10.7.165.65:3000"
```

### 3. 飞书后台

在应用「安全设置 → 重定向 URL」中**追加**（不要删 localhost，方便本机继续用）：

```
http://10.7.165.65:3000/api/auth/callback/feishu
```

### 4. 重启 dev server

修改 `next.config.ts` 或 `.env` 后需重启 `npm run dev`。

---

## 生产部署

### 能否用 GitHub Pages？

**不能。** GitHub Pages 只托管静态 HTML/JS，本项目需要：

- Node.js 运行时（Server Actions、API Routes）
- SQLite 数据库文件持久化
- 服务端飞书 OAuth 与文件上传
- 独立 cron 进程

因此必须部署到**能跑 Node 的服务器**或 PaaS，不能直接用 `github.io`。

### 可选方案

| 方案 | 适用场景 | 说明 |
|------|----------|------|
| **学校/实验室内网服务器** | 长期、仅校内使用 | `npm run build && npm start`，PM2 保活 + cron；飞书回调填内网域名或 IP |
| **Vercel / Railway / Fly.io** | 需要公网访问 | 需把 SQLite 换成 PostgreSQL 等托管数据库；cron 用平台定时任务或单独 worker |
| **内网穿透（ngrok / frp / Tailscale）** | 临时给外网或手机测 | 获得公网 URL 后写入飞书重定向与 `AUTH_URL` |
| **自有 VPS** | 完全自控 | 同内网服务器，可绑域名 + HTTPS（飞书生产环境建议 HTTPS） |

### 本机构建运行

```bash
npm run build
npm start
```

生产环境 `.env` 示例：

```env
AUTH_URL="https://your-domain.example.com"
NEXT_PUBLIC_APP_URL="https://your-domain.example.com"
```

飞书重定向 URL：

```
https://your-domain.example.com/api/auth/callback/feishu
```

主应用与 cron 为**独立进程**，cron 不应在 Serverless 环境内运行：

```bash
pm2 start npm --name procurement-cron -- run cron
```

---

## 进度管理模块

首页 **「进度管理」** 或导航 `/progress`，与采购报销共用登录与飞书应用。

### 功能概览

| 路径 | 功能 |
|------|------|
| `/progress` | 进度首页、进行中的项目列表 |
| `/progress/projects/new` | 新建项目（含验收里程碑） |
| `/progress/projects/[id]` | 项目详情、里程碑、挂载任务 |
| `/progress/tasks/[id]` | 任务详情、交付、周报、验收 |
| `/progress/kanban` | 任务看板（待办/进行中/待验收/已完成） |
| `/progress/archive` | 已归档项目与任务 |

### 项目与任务流程

**项目状态**（须逐步推进，不可跳跃）：

草稿 → 进行中 → 正常 / 异常 → 负责人介入 → 结果理想 / 不理想 → 归档

**任务状态**（须逐步推进）：

待办 → 进行中 → 待验收 → 已完成 → 归档

- 执行人：开始任务、提交交付（飞书文档 + 可选视频）、填写周报
- 组长 / 项管：验收任务与里程碑；审批前请在飞书中打开文档核对内容
- 里程碑须按顺序逐一提交与验收，全部通过后项目方可进入「结果理想」并归档

### 定时提醒（`npm run cron`）

| 时间 | 内容 |
|------|------|
| 每日 09:00 | 采购日报 + 任务逾期警报 + 当日截止提醒 |
| 每周一 09:00 | 活跃任务周报填写提醒（私信负责人） |

### 进度相关飞书权限（除通讯录、私信外）

| 权限 | 用途 |
|------|------|
| `im:message:send_as_bot` | 任务指派、逾期、周报等私信 |
