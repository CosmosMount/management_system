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
3. 安全设置 → 重定向 URL：`{AUTH_URL}/api/auth/callback/feishu`
4. 权限管理：开通 `contact:user.base:readonly`（读取用户基本信息）
5. 将应用机器人拉入采购通知群
6. 获取该机器人的 Webhook 地址，填入 `FEISHU_WEBHOOK_URL`

## 角色配置

登录后系统根据 `UserRole` 表判断审批权限。需手动写入飞书用户的 `open_id`：

```bash
# 编辑 prisma/seed.ts 中的 openId 后执行
npm run db:seed
```

或通过 Prisma Studio：`npm run db:studio`

| 角色 | 权限 |
|------|------|
| TECH | 技术组审核 |
| TEACHER | 老师审核 |
| FINANCE | 报销操作（上传发票/截图、完成） |

无角色用户可登录、提交申请，但无法进行审批操作。

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
