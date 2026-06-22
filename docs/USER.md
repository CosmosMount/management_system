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

登录只解决「谁能进系统」；**审批按钮**取决于 `UserRole` 表里的 `open_id` 映射。

### 1. 查每个人的 open_id

每人先用飞书登录一次系统，然后：

```bash
npm run db:studio
```

打开 **User** 表，找到对应姓名，复制 **openId** 列（形如 `ou_xxxxxxxx`）。

### 2. 写入角色

**重要：`openId` 必须从 `User` 表复制**（审批人先登录本系统一次），不要手写占位符或从飞书后台其他地方复制，否则会报 `open_id cross app`。

编辑 [`prisma/seed.ts`](../prisma/seed.ts)：

```typescript
const seedRoles = [
  { openId: "ou_xxx", role: UserRoleType.TECH },   // 从 User 表复制
  { openId: "ou_yyy", role: UserRoleType.TEACHER },
  { openId: "ou_zzz", role: UserRoleType.FINANCE },
];
```

执行 `npm run db:studio` 删除 `UserRole` 表中旧的占位符记录（如 `ou_tech_placeholder`）。

```bash
npm run db:seed
```

或在 Prisma Studio 的 **UserRole** 表里手动新增记录。

| 角色 | 权限 |
|------|------|
| TECH | 订单处于「技术组审核」时显示「技术组通过」 |
| TEACHER | 「老师审核」阶段通过 |
| FINANCE | 「报销操作」：上传发票/截图、完成报销 |

同一人只能绑一个角色；无角色用户可提交申请，但看不到审批按钮。

### 3. 完整审批测试流程

1. **申请人**（无角色或任意账号）→ `/apply` 提交
2. **TECH** 账号 → `/orders` 点「技术组通过」
3. **TEACHER** 账号 → 点「指导老师通过」
4. **FINANCE** 账号 → 「报销操作」上传凭证 → 「完成报销」

---

## 飞书通知

### 群 Webhook（可选）

在 `.env` 填写 `FEISHU_WEBHOOK_URL` 后，状态变更时会向**群**推送卡片。未配置则跳过群通知。

### 审批人私信（已实现）

开通权限 **`im:message:send_as_bot`** 后，系统会在状态变更时向对应角色的**所有** `UserRole` 用户私发卡片：

| 订单状态 | 私信通知角色 |
|----------|-------------|
| 技术组审核 | TECH |
| 老师审核 | TEACHER |
| 待报销 / 报销中 | FINANCE |

前提：

1. 审批人已在 `UserRole` 表中配置正确的 `open_id`
2. 审批人至少登录过本系统一次（与机器人建立会话）
3. `.env` 中 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 有效

群 Webhook 与私信**独立**：只配 App 凭证也可发私信；Webhook 仅影响群消息。

## 功能测试流程

1. **登录**：访问 `/login`，飞书授权后跳转 `/orders`
2. **申请**：`/apply` 填写车组、技术组，添加明细，点击「提交申请」
3. **通知**：提交后通知群应收到飞书交互卡片（需配置 Webhook）
4. **技术组审批**：TECH 角色用户在列表或详情页点击「技术组通过」
5. **老师审批**：TEACHER 角色用户点击「指导老师通过」
6. **报销**：FINANCE 角色点击「报销操作」，上传发票与截图，修改总价后「完成报销」
7. **定时汇总**：`npm run cron` 启动定时任务（每天 09:00 推送积压汇总）

### PM2 部署定时任务

```bash
pm2 start npm --name procurement-cron -- run cron
```

## 生产部署

```bash
npm run build
npm start
```

主应用与 cron 为**独立进程**，cron 不应在 Serverless 环境内运行。
