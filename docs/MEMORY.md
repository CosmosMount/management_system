# 开发记忆

## 技术决策

- **Prisma 7** 要求 `PrismaClient` 传入 driver adapter；SQLite 使用 `@prisma/adapter-better-sqlite3`，数据库路径在 `lib/prisma.ts` 中解析。
- **Auth.js middleware** 不能 import 含 Prisma 的 `lib/auth.ts`；拆分为 `auth.config.ts`（edge）+ `auth-edge.ts`（middleware）+ `auth.ts`（含 signIn upsert）。
- **权限工具** 拆分为 `permissions-client.ts`（纯函数，客户端可用）与 `permissions.ts`（含 `getUserRole` 数据库查询）。
- **shadcn v4** 基于 Base UI；`DialogTrigger` 使用 `render` prop 而非 `asChild`；Toast 组件已改为 `sonner`。
- **飞书 Webhook 签名**：`HmacSHA256("", timestamp + "\n" + secret)` 后 Base64 编码。

## 目录结构（2026-06-22）

- 应用代码在仓库**根目录**（原 `procurement/` 已移出）
- 文档集中在 **`docs/`** 目录

## 已知限制

- 首版无驳回流程，状态只能向前流转。
- 文件存储在 `public/uploads/`，无访问鉴权，适用于本地可信环境。
- `UserRole` 需手动 seed，首次登录不会自动分配角色。
