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

编辑 [`prisma/seed.ts`](../prisma/seed.ts)，把占位符换成真实 open_id：

```typescript
const seedRoles = [
  { openId: "ou_技术组张三", role: UserRoleType.TECH },
  { openId: "ou_指导老师李四", role: UserRoleType.TEACHER },
  { openId: "ou_报销员王五", role: UserRoleType.FINANCE },
];
```

执行：

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

## 飞书群通知（可选）

在 `.env` 填写 `FEISHU_WEBHOOK_URL` 后，提交申请会向**群**推送卡片。未配置时仅跳过通知，不影响审批。

1. 应用机器人拉入通知群
2. 复制群机器人 Webhook 填入 `.env`
3. 重启 `npm run dev`

---

## 飞书私信（当前未实现，但可行）

| 方式 | 能发给谁 | 现状 |
|------|----------|------|
| **Webhook** | 仅群聊 | 已实现（`lib/feishu.ts`） |
| **应用 Open API** | 指定用户的私聊 | 未实现，需额外开发 |

Webhook **不能**单独给某个用户发私信。若要给审批人私发提醒，需用同一应用的 Open API：

- 权限：`im:message:send_as_bot`
- 接口：`POST /open-apis/im/v1/messages`，`receive_id_type=open_id`
- 用户须已与机器人有过交互（例如登录过本系统）

如需「提交后私信通知技术组审批人」，可后续在 `createOrder` 里按 `UserRole` 查 open_id 并调用发消息 API。

---

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
