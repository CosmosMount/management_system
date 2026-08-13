# pnx management

Next.js 全栈管理系统。采购报销、项目管理与反馈中心共用飞书统一账号。

- 技术文档：[`docs/TECH.md`](docs/TECH.md)
- 消息发送矩阵：[`docs/NOTIFICATIONS.md`](docs/NOTIFICATIONS.md)
- 测试手册：[`docs/TESTING.md`](docs/TESTING.md)
- 工作规范：[`docs/AGENTS.md`](docs/AGENTS.md)

## 快速启动

```bash
cp .env.example .env   # 填写飞书凭证、AUTH_SECRET、POSTGRES_PASSWORD
npm install

# 本地开发只启动 PostgreSQL，应用在宿主机运行
docker compose up -d postgres

npm run db:deploy
npm run dev
```

本轮起不迁移旧 SQLite 数据；首次部署从空 PostgreSQL 库开始，通过 seed 初始化角色和规则。

访问 http://localhost:3000 ，使用飞书登录。

日志默认输出到 stdout/stderr，生产和测试为 JSON line，开发可设置 `LOG_FORMAT=pretty`。常用级别为 `LOG_LEVEL=debug|info|warn|error|silent`；敏感字段会自动脱敏，详细规范见 [`docs/TECH.md`](docs/TECH.md#结构化日志)。

| 服务 | 运行位置 | 端口 |
|------|----------|------|
| PostgreSQL | Docker `postgres` | **5432** |
| Next.js | Docker `app` 或宿主机 `npm run dev` | **3000** |
| cron | Docker `cron` 或宿主机 `npm run cron` | 无 HTTP 端口 |

宿主机本地开发也使用同一个 PostgreSQL：

```bash
docker compose up -d postgres
npm run db:deploy   # schema 有更新时
npm run dev
```

若本机 5432 已被占用，在 `.env` 设置 `POSTGRES_PORT=5433`，并同步修改 `DATABASE_URL` 中的端口。

## Docker 快速部署（推荐）

适合内网服务器一键拉起 Web + 定时任务，数据与附件通过 Docker Volume 持久化。

### 1. 准备配置

```bash
cp .env.example .env
```

编辑 `.env`，至少填写：

- `AUTH_SECRET`
- `FEISHU_APP_ID` / `FEISHU_APP_SECRET`
- `NEXT_PUBLIC_APP_URL` — 后台任务默认生成的系统地址（如 `https://pnx.demonmaster.cn`）
- `APP_ALLOWED_ORIGINS` — 允许访问和登录跳转的完整 origin 列表

双入口访问时不要设置 `AUTH_URL` / `NEXTAUTH_URL`。飞书后台「重定向 URL」需要同时添加域名和内网 IP 对应的回调：

```
https://pnx.demonmaster.cn/api/auth/callback/feishu
http://10.4.150.222:3000/api/auth/callback/feishu
```

`DATABASE_URL` 无需修改，`docker-compose.yml` 会为容器内 app/cron 自动设置 PostgreSQL 连接串。

### 2. 启动

```bash
docker compose up -d --build
```

如果当前用户没有 Docker socket 权限，可在 `.env` 或当前 shell 设置 `SUDO_PASSWORD`，然后使用仓库提供的辅助脚本：

```bash
./scripts/docker-compose-sudo.sh up -d --build
```

`SUDO_PASSWORD` 只用于宿主机 `sudo docker compose ...`，不会传入 app/cron 容器。

- **app**：Next.js 应用，默认映射端口 `3000`（可通过 `.env` 设置 `APP_PORT=8080` 改宿主机端口）
- **postgres**：PostgreSQL 16 数据库
- **cron**：采购日报和通知 outbox 投递等后台任务，与 app 共用 PostgreSQL

首次启动会自动执行 `npm run db:deploy` 应用 PostgreSQL migration。

### 3. 初始化管理员（首次）

先用飞书登录一次或同步通讯录，确认首位管理员已经建立统一账号，再在容器内执行：

```bash
docker compose exec app npm run db:seed -- --super-admin-open-id=<飞书 openId>
```

### 4. 常用命令

```bash
docker compose logs -f app      # 查看应用日志
docker compose logs -f cron     # 查看定时任务日志
docker compose down             # 停止
docker compose up -d --build    # 更新代码后重新构建
```

### 5. 数据备份

| 内容 | Docker Volume |
|------|----------------|
| PostgreSQL 数据 | `postgres-data` → 容器内 `/var/lib/postgresql/data` |
| 上传附件 | `app-uploads` → 容器内 `/app/storage/uploads/` |

```bash
# 备份数据库到当前目录（会提示输入 POSTGRES_PASSWORD）
docker compose exec postgres pg_dump -U "${POSTGRES_USER:-postgres}" "${POSTGRES_DB:-management_system}" > backup-$(date +%F).sql

# 恢复到空库
docker compose exec -T postgres psql -U "${POSTGRES_USER:-postgres}" "${POSTGRES_DB:-management_system}" < backup.sql
```

更完整的 Docker 说明见 [`docs/TECH.md`](docs/TECH.md#docker-部署)。

## 环境变量

| 变量 | 说明 |
|------|------|
| `DATABASE_URL` | PostgreSQL 连接串，如 `postgresql://postgres:<密码>@localhost:5432/management_system` |
| `SHADOW_DATABASE_URL` | Prisma migration diff 使用的 shadow 库，建议库名以 `_shadow` 结尾 |
| `PLAYWRIGHT_DATABASE_URL` | `npm run test:e2e` 的本机 PostgreSQL 凭据/authority 模板。POSIX-only 官方 runner 忽略路径，每次生成随机 target/shadow 和独立 marker，先拥有独立 server 进程组并确认 3003 readiness，再启动另一独立 Playwright CLI 组；两组均证明静默后才按两个精确名称清理。marker 用于防止错误 run/cross-run 和仅凭公开 token 的删除，不是同 UID 或已拥有工作树写权限进程之间的认证边界；调用方不配置 Playwright shadow |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` / `POSTGRES_PORT` | Docker PostgreSQL 用，见 `.env.example` |
| `AUTH_SECRET` | Auth.js 密钥，可用 `openssl rand -hex 32` 生成 |
| `FEISHU_APP_ID` | 飞书 OAuth / 通讯录主应用 App ID，也是消息机器人的兼容默认值 |
| `FEISHU_APP_SECRET` | 飞书 OAuth / 通讯录主应用 App Secret |
| `FEISHU_NOTIFICATION_APP_ID` | 可选，通知机器人 App ID；普通私信通知、状态结果、提醒、反馈使用它发送 |
| `FEISHU_NOTIFICATION_APP_SECRET` | 可选，通知机器人 App Secret；未配置时回退 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` |
| `FEISHU_APPROVAL_APP_ID` | 可选，审批机器人 App ID；只发送审批、验收、确认等待处理消息 |
| `FEISHU_APPROVAL_APP_SECRET` | 可选，审批机器人 App Secret；未配置时回退通知机器人 |
| `FEISHU_DIRECT_MESSAGE_ALLOWED_NAMES` / `FEISHU_DIRECT_MESSAGE_ALLOWED_OPEN_IDS` / `FEISHU_DIRECT_MESSAGE_ALLOWED_UNION_IDS` | 可选，飞书私信收件人临时 allowlist；用于测试或演练防误发，未配置时不限制；同时配置多个身份维度时必须全部匹配。Playwright 启动的应用服务默认只允许 `李棋轩` |
| `NOTIFICATION_DELIVERY_DISABLED` | 通知总禁发闸；本地、测试和 Docker 默认应为 `true`，生产确认配置与收件人范围后才可显式设为 `false` |
| `EMAIL_DELIVERY_ALLOWED_ADDRESSES` | 可选，SMTP 收件邮箱 allowlist，逗号/分号/换行分隔；测试和演练环境建议显式配置，未配置时不限制 |
| `CONFIRM_SEND_FEISHU` | 人工调试脚本真实发送的二次确认；不替代禁发闸或收件人 allowlist |
| `FEISHU_WEBHOOK_URL` | 采购通知群 Webhook（与 `FEISHU_PROCUREMENT_WEBHOOK_URL` 二选一，后者优先） |
| `FEISHU_PROCUREMENT_WEBHOOK_URL` | 采购专用群 Webhook |
| `FEISHU_WEBHOOK_SECRET` | 可选，Webhook 签名校验密钥 |
| `FEISHU_PROCUREMENT_WEBHOOK_SECRET` | 可选，采购 Webhook 签名（未配置时回退 `FEISHU_WEBHOOK_SECRET`） |
| `FEISHU_EVENT_ENCRYPT_KEY` | 可选，事件订阅加密密钥（飞书后台「事件与回调」） |
| `FEISHU_VERIFICATION_TOKEN` | 可选，事件订阅校验 Token |
| `FEISHU_WS_BOT_KIND` | 可选，长连接使用的机器人，`notification` 或 `approval`，默认 `notification` |
| `ENABLE_FEISHU_WS` | 可选，是否安装通知机器人长连接，默认 `false` |
| `ENABLE_FEISHU_APPROVAL_WS` | 可选，是否安装审批机器人长连接，默认 `true` |
| `APPLY_PM_IDENTITY_BACKFILL` | 项目管理 Account/Person 初始化确认开关；未设为 `true` 时 `npm run pm:identity-backfill` 只做 dry-run |
| `NEXT_PUBLIC_APP_URL` | 后台任务默认系统地址（cron 飞书卡片按钮跳转用） |
| `APP_ALLOWED_ORIGINS` | 允许登录跳转和飞书按钮生成的完整 origin 列表 |
| `LAN_HOST` | dev server 局域网访问 IP |
| `ALLOWED_DEV_ORIGINS` | Next dev 允许访问资源的额外 host 列表 |

## 飞书应用配置

1. 在[飞书开放平台](https://open.feishu.cn/)创建**企业自建应用**
2. 开启能力：**网页应用**（OAuth）+ **机器人**（群消息）
3. **安全设置** → **重定向 URL** 添加（须与下方完全一致，多一个斜杠也会 20029）：

   ```
   https://pnx.demonmaster.cn/api/auth/callback/feishu
   http://10.4.150.222:3000/api/auth/callback/feishu
   http://localhost:3000/api/auth/callback/feishu
   ```

   也可在登录页 `/login` 底部查看当前系统使用的地址。

4. 权限管理：开通 **`contact:user.base:readonly`**（获取用户基本信息，用于登录）
5. 配置两个消息机器人：
   - **通知机器人**：发送普通私信通知、状态结果、提醒、反馈等。
   - **审批机器人**：只发送需要处理的审批、验收、确认待办；未单独配置时自动回退通知机器人。
   - 若审批机器人是独立飞书应用，系统会用 `union_id` 发送审批私信；请确保用户登录过系统或执行过通讯录同步，否则审批私信会失败并等待 outbox 重试，不会降级到通知机器人。
6. 将采购群 Webhook 对应的机器人拉入采购通知群；群 Webhook 是独立的群通知入口，不参与 `notification/approval` 私信分流
7. 获取采购机器人的 Webhook，填入 `FEISHU_WEBHOOK_URL` 或 `FEISHU_PROCUREMENT_WEBHOOK_URL`
8. OAuth 登录和通讯录同步继续使用 `FEISHU_APP_ID`；消息发送优先使用 `FEISHU_NOTIFICATION_*`，审批待办优先使用 `FEISHU_APPROVAL_*`

### 事件订阅（长连接，推荐）

若飞书后台「事件与回调」要求配置 Request URL，**不要**填网站首页；本项目使用官方 SDK **长连接**接收事件，无需公网回调地址。

1. 确保 `.env` 已配置 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`，或已配置当前长连接机器人对应的消息应用凭证
2. 启动长连接进程（开发：`npm run feishu:ws`；审批机器人生产环境由 `./service/install.sh` 默认安装 `pnx-management-feishu-approval-ws.service` 并自动启动）。通知机器人长连接需设置 `ENABLE_FEISHU_WS=true` 后再安装；手动运行审批长连接可用 `FEISHU_WS_BOT_KIND=approval npm run feishu:ws`。
3. 日志出现「长连接已建立」后，在飞书开放平台 **事件与回调** → 选择 **使用长连接接收事件/回调**
4. 订阅事件（如 `im.message.receive_v1`）；在 **回调配置** 启用 `card.action.trigger`（采购审批按钮依赖此回调）
5. 若后台启用了加密策略，将 `Encrypt Key` / `Verification Token` 填入 `FEISHU_EVENT_ENCRYPT_KEY`、`FEISHU_VERIFICATION_TOKEN`

在飞书开放平台为应用开通 **`cardkit:card:write`**（卡片写权限），否则私信里的审批回调按钮无法发送。

待确认卡片嵌入报销截图还需审批应用开通 **`im:resource`** 或 **`im:resource:upload`**（上传图片资源）。未开通时会改为卡片内「点击在系统中查看」链接。

审批机器人长连接由 `service/pnx-management-feishu-approval-ws.service` 管理，安装脚本默认安装并启动；通知机器人长连接由 `service/pnx-management-feishu-ws.service` 管理，需显式设置 `ENABLE_FEISHU_WS=true`。不需要审批回调时可设置 `ENABLE_FEISHU_APPROVAL_WS=false`。

采购审批卡片可用 `npm run feishu:card-preview -- <orderId>` 预览。该脚本默认 dry-run；真实发送必须额外设置 `CONFIRM_SEND_FEISHU=true`，且不能设置 `NOTIFICATION_DELIVERY_DISABLED=true`。

## 统一账号与角色配置

飞书 OAuth 是唯一登录方式。`Account + AccountIdentity` 是统一账号，`Person` 承载项目成员资料，`User` 继续承载采购报销资料和订单关系，并且必须通过唯一且非空的 `accountId` 关联统一账号。项目角色与报销角色独立，只有统一超级管理员跨两个业务域生效。飞书 `openId` 发生变化时，系统使用稳定的 `unionId` 找回原账号并原位更新报销用户，不会新建重复用户或丢失角色。

### 推荐：超级管理员可视化管理

1. 自己先用飞书登录一次或同步通讯录。
2. 执行 `npm run db:seed -- --super-admin-open-id=<飞书 openId>` 初始化首位统一超级管理员。
3. 登录后先访问 **`/admin/system` 系统同步**，点击 **「同步飞书通讯录」** 将企业全员录入系统（无需对方先登录）。
4. 访问 **`/admin/accounts` 账号与权限**：
   - 在「车组职责配置」中按车组直接添加或移除报销车组组长和报销员
   - 在「技术组职责配置」中按技术组直接添加或移除报销技术组组长和指导老师，并维护指导老师审批邮箱
   - 在「用户与角色」中搜索统一账号，分配超级管理员、项目管理员或四类报销角色；账号列表支持筛选、分页、就地移除角色和查看角色历史/安全审计

项目系统角色不再提供车组/技术组组长。授予超级管理员以及撤销全局项目角色需要二次确认；服务端仍会阻止自撤销或移除最后一名可用全局管理员。

项目模块不再提供账号级启用/禁用开关。账号通过登录身份解析后，项目可见性和写权限只由系统角色、TaskMember 与既有授权规则决定；停用 `Person` 仍不能被新增选择。

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
| 统一超级管理员 | 全局 | 报销和项目最高权限；访问 `/admin/accounts` |
| 项目管理员 | 项目全局 | 与统一超级管理员相同的项目业务权限、审批权和项目审计；不能管理账号 |
| Task 负责人 | 单个 Task | 管理成员、Task 状态、计划、Revision、验收证据和该 Task 全部投入；可有多名 |
| Task 参与人 | 单个 Task | 编辑 Task 与计划、提交 Revision/验收证据，并管理自己的关联投入 |
| TEAM_ADMIN | 指定车组 | 管理审核阶段，车组组长通过 |
| TECH_GROUP_ADMIN | 指定技术组 | 管理审核阶段，技术组组长通过 |
| TEACHER | 全局 | 「老师审核」阶段通过 |
| FINANCE | 指定车组 | 上传报销截图 |

所有已登录统一账号都可查看全部未删除 Project、Task、计划、成员、验收、审计和完整 Planned/Actual Work Segment，也都可提交 Project 立项和创建任意合法车组/技术组的 Task。Project 是 Task 上方的文件夹与立项对象，不包含 Stage；只有统一超级管理员或项目管理员能审批立项。Project Owner 可修改、结束和删除 Project，但不会继承任何 Task 写权限。

Revision 是用户选择时间的计划变化标记，不形成阶段，也不能关联 Planned/Actual Segment。创建 Revision 时固定沿用 Current Plan 的 Start，自动保留全部已完成 Milestone 和已生效 Revision，并用调用方提供的后续 Milestone 与 Terminal 重建未完成部分。创建即进入 `PENDING_APPROVAL`，不再存在草稿或单独提交动作；驳回后可修改并直接重新送审，取消后释放该 Task 的唯一候选名额，批准后才进入 Current Plan 和正式时间轴。

同一 Task 同时最多只能有一条待审批：未撤出的 `PENDING` Milestone Review 与 `PENDING_APPROVAL` Revision 互斥。Milestone 提交后，在审批通过、驳回、要求修订或撤出前不能用新的请求键重复提交；原 Review 尚未撤出时，相同请求键按原结果幂等重放。撤出后的旧请求键会明确返回冲突，重新提交必须使用新请求键。任一待审批存在时，发起/重新送审 Revision 和确认 Terminal 都会被阻止；被驳回或取消的 Revision 不占用名额。Terminal 仍是直接结束确认，不新增审批记录。

存在 Task 数据时，系统要求至少保留一名具有 default tenant 有效飞书 openId 的全局管理员；账号后台会拒绝撤销最后一名可用审批人的角色，数据库永久门禁也会拦截绕过应用层的账号删除、角色和身份写入。空库创建首个 Task 时同样检查该不变量。提交 Milestone 验收或创建/重新送审 Revision 时会在同一事务中再次校验，失败时整事务回滚，不会留下无人处理或无法通知的待审批记录。

项目 `GROUP_LEADER` 已退役，只保留撤销历史且不能继续授予。采购报销的 `TEAM_ADMIN`、`TECH_GROUP_ADMIN` 等独立角色、组长称谓和审批流程不受影响。Work Segment 不再保存独立工作职责，也不再关联 Task Node；投入只可关联 Task。

### 导航栏没有「权限管理」？

常见原因：

1. **首位超管未初始化**：执行 `npm run db:seed -- --super-admin-open-id=<飞书 openId>`。
2. **账号尚未建立**：先让该用户登录或执行通讯录同步。
3. **旧数据未通过迁移预检**：升级前先运行 `npm run accounts:preflight`，处理报告中的身份、重复角色或范围冲突。

统一账号历史升级仍按 `npm run accounts:preflight` → `npm run db:deploy` → `npm run accounts:validate` 执行。Task 全员可见改造部署前还必须先运行只读 `npm run pm:task-access-preflight`；若报告零负责人 Task 或孤立的 Task 关联投入，迁移会阻断，必须先人工修复，不能猜测负责人。受控 `npm run db:deploy` 会把不可逆 Task migration 与 Prisma history 记录放入同一 PostgreSQL 事务；不得绕过它直接运行 `prisma migrate deploy`。迁移链还会在不可逆 Task DDL 之前按固定顺序锁定相关表、复检具有有效飞书身份的全局管理员，并安装覆盖账号删除、全局角色、飞书身份和首条 Task 创建的永久串行延迟约束，避免遗漏人工预检、部署中断或旧实例并发写入时留下半升级 schema。该自动门禁不替代发布前报告核对。

### 完整审批与报销流程

**审批：**

1. **申请人** → `/procurement/new` 提交
2. **管理审核**（状态「管理审核」）：车组组长、技术组组长**均需通过**（分别私信通知），全部通过后进入老师审核
3. **TEACHER** → 「指导老师通过」
4. **采购人** → 上传发票，并为每行明细上传实物照片；系统自动生成 Word 验收清单（状态「待上传凭证」）。**车组组长、技术组组长、采购人**需事先在「个人设置」上传电子签名图片。
5. **报销员** → 上传报销截图（状态「待报销截图」）
6. **采购人** → 「确认报销」（状态「待确认」）→ 完成

**状态一览：**

```
草稿 → 管理审核 → 老师审核 → 待上传凭证 → 待报销截图 → 待确认 → 已完成
```

---

## 飞书通知

### 群 Webhook（可选）

在 `.env` 填写 `FEISHU_WEBHOOK_URL` 后，状态变更和采购日报会向**群**推送卡片。未配置则跳过群通知。群 Webhook 独立于私信机器人，不受 `botKind` 控制。

### 审批人私信（已实现）

开通权限 **`im:message:send_as_bot`** 后，系统会在状态变更时按 `UserRole.accountId` 找到对应账号的**当前飞书身份**并私发卡片；`UserRole.openId` 只作为历史兼容快照，不参与授权或收件人解析。发送机器人按消息性质区分：

- **审批机器人**：只发待审批、待验收、待确认等需要处理的消息。
- **通知机器人**：发审批结果、普通状态变更、提醒、反馈等其他私信消息。
- 未配置审批机器人时，审批消息自动回退通知机器人。

采购状态事件和反馈先写入 notification outbox，由各自的 channel adapter 校验 payload、计算并去重收件人、构造消息，再交给统一飞书私信传输层。采购催办等保留的直接发送入口也必须使用同一传输层。传输层统一执行机器人选择、`open_id`/`union_id` 解析、禁发开关、allowlist、CardKit 创建与错误脱敏。群 Webhook 仍是独立出口，不混入私信接口。完整规则见 [`docs/NOTIFICATIONS.md`](docs/NOTIFICATIONS.md)。

| 订单状态 | 私信通知 |
|----------|----------|
| 管理审核 | 车组组长 + 技术组组长（分别发送） |
| 老师审核 | TEACHER |
| 待上传凭证 / 待确认 | 采购发起人 |
| 待报销截图 | FINANCE（对应车组） |

前提：

1. 审批人已在 `UserRole` 表中配置正确的 `open_id`
2. 审批人至少登录过本系统一次，或已通过通讯录同步写入 `User.unionId`
3. `.env` 中通知机器人和审批机器人凭证有效；未单独配置时至少 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 有效

群 Webhook 与私信**独立**：只配 App 凭证也可发私信；Webhook 仅影响群消息。

## 功能测试流程

1. **登录**：访问 `/login`，飞书授权后跳转 `/procurement/list`
2. **申请**：`/procurement/new` 填写车组、技术组，添加明细，点击「提交申请」
3. **通知**：提交后通知群应收到飞书交互卡片（需配置 Webhook）
4. **管理审核**：车组组长、技术组组长分别点击「通过」
5. **老师审批**：TEACHER 点击「指导老师通过」
6. **采购人上传**：多张发票（每张 ≤20MB）+ 每行实物照片（自动生成验收清单 Word）
7. **报销员**：在详情页或弹窗中查看发票与清单后，上传报销截图
8. **采购人确认**：点击「确认报销」
9. **定时汇总**：`npm run cron`（每天 09:00）

## 上传文件与附件

### 存储位置

上传文件保存在私有目录下，浏览器仍使用 `/uploads/...` 兼容链接，实际读取由鉴权 route 校验权限后返回：

```
storage/uploads/<订单ID>/<文件名>
```

例如：`storage/uploads/a1b2c3.../invoice-1-1712345678-abc.pdf`

- 通过浏览器访问：`http://localhost:3000/uploads/<订单ID>/<文件名>`
- 服务器上直接查看：进入项目根目录，打开 `storage/uploads/` 文件夹
- 生产环境备份时请一并备份 `storage/uploads/` 与 PostgreSQL 数据库

### 限制

| 项目 | 限制 |
|------|------|
| 单文件大小 | 20MB |
| 发票数量 | 最多 20 张（可多选） |
| 实物照片 | 每行明细 1 张（png/jpg/pdf），用于嵌入验收清单 |
| 验收清单 | 系统按学校模板自动生成 `.docx`，无需手填 |
| 报销截图 | 1 份 |
| 反馈图片 | 单张 20MB，单次合计 50MB |

Server Actions 总上传上限 100MB（采购附件或反馈图片合计）。

### 谁能查看附件

订单详情页「**流程附件**」按步骤展示：

| 步骤 | 内容 | 可查看 |
|------|------|--------|
| 采购人上传 | 发票、自动生成的验收清单 | 采购人、对应车组报销员、超级管理员 |
| 报销员上传 | 报销截图 | 同上 |

报销员在「上传截图」弹窗内也会显示发票与清单链接。飞书私信会提示前往详情页查看附件。

修改 `next.config.ts` 中 `serverActions.bodySizeLimit` 可调整总上传上限（需重启 dev server）。

## 局域网调试

本机 IP 变化时可在 `.env` 设置 `LAN_HOST=你的IP`，或 `ALLOWED_DEV_ORIGINS=ip1,ip2` 追加多个主机。

### 1. 启动

```bash
npm run dev
```

默认监听 `0.0.0.0:3000`，局域网内其他设备可访问 `http://<本机IP>:3000`（如 `http://10.4.150.222:3000`）。

仅本机调试可用 `npm run dev:local`（只绑定 localhost）。

### 2. 修改 `.env`

从手机或其他电脑访问时，保留 `AUTH_URL` / `NEXTAUTH_URL` 未设置，并配置允许的入口：

```env
NEXT_PUBLIC_APP_URL="https://pnx.demonmaster.cn"
LAN_HOST=10.4.150.222
ALLOWED_DEV_ORIGINS=pnx.demonmaster.cn,10.4.150.222,localhost,127.0.0.1
APP_ALLOWED_ORIGINS="https://pnx.demonmaster.cn,http://10.4.150.222:3000,http://localhost:3000,http://127.0.0.1:3000"
```

### 3. 飞书后台

在应用「安全设置 → 重定向 URL」中**追加**：

```
https://pnx.demonmaster.cn/api/auth/callback/feishu
http://10.4.150.222:3000/api/auth/callback/feishu
http://localhost:3000/api/auth/callback/feishu
```

### 4. 重启 dev server

修改 `next.config.ts` 或 `.env` 后需重启 `npm run dev`。

### 5. Nginx Proxy Manager 反代域名

如果通过 Nginx Proxy Manager 将 `https://pnx.demonmaster.cn` 反代到本服务，`Details` 页建议：

- `Scheme`: `http`
- `Forward Hostname / IP`: 实际能访问到 Next 服务的上游地址
- `Forward Port`: 实际上游端口，例如直连本机服务用 `3000`；经 frp 时用 frp 暴露业务的 `remotePort`
- 打开 `Websockets Support`
- 打开 `Block Common Exploits` 可保留
- `Custom Nginx Configuration` 默认留空

Nginx Proxy Manager 打开 `Websockets Support` 后会自动写入 Upgrade 相关代理配置，通常不需要在 `Custom Nginx Configuration` 里重复设置 `proxy_set_header Upgrade` / `Connection`。如果你不是用 Nginx Proxy Manager，而是手写 Nginx/OpenResty 配置，才需要类似下面的 location 配置：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;

    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";

    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Real-IP $remote_addr;

    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

保存后可以验证 WebSocket 是否被正确透传：

```bash
curl -i --http1.1 \
  -H 'Connection: Upgrade' \
  -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  -H 'Sec-WebSocket-Version: 13' \
  'https://pnx.demonmaster.cn/_next/webpack-hmr?id=manual-test'
```

期望看到 `HTTP/1.1 101 Switching Protocols`。如果返回 `404 Not Found`，说明域名反代没有透传 WebSocket，`next dev` 下客户端组件可能无法正常接管页面，表现为搜索框、下拉框、按钮等交互异常。长期使用域名访问时更推荐生产模式：`npm run build` 后用 `next start -H 0.0.0.0` 运行。

---

## 生产部署

### Docker（推荐）

见上文 [Docker 快速部署](#docker-快速部署推荐)，适合内网服务器一键运行。

### 能否用 GitHub Pages？

**不能。** GitHub Pages 只托管静态 HTML/JS，本项目需要：

- Node.js 运行时（Server Actions、API Routes）
- PostgreSQL 数据库持久化
- 服务端飞书 OAuth 与文件上传
- 独立 cron 进程

因此必须部署到**能跑 Node 的服务器**或 PaaS，不能直接用 `github.io`。

### 可选方案

| 方案 | 适用场景 | 说明 |
|------|----------|------|
| **学校/实验室内网服务器** | 长期、仅校内使用 | `npm run build && npm start`，PM2 保活 + cron；飞书回调填内网域名或 IP |
| **Vercel / Railway / Fly.io** | 需要公网访问 | 使用托管 PostgreSQL；cron 用平台定时任务或单独 worker |
| **内网穿透（ngrok / frp / Tailscale）** | 临时给外网或手机测 | 获得公网 URL 后写入飞书重定向与 `APP_ALLOWED_ORIGINS` |
| **自有 VPS** | 完全自控 | 同内网服务器，可绑域名 + HTTPS（飞书生产环境建议 HTTPS） |

### 本机构建运行

```bash
npm run build
npm start
```

生产环境 `.env` 示例：

```env
NEXT_PUBLIC_APP_URL="https://your-domain.example.com"
APP_ALLOWED_ORIGINS="https://your-domain.example.com,http://10.4.150.222:3000"
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

## 项目管理重构状态

旧 Project/Stage 工作流已清理；当前重新提供轻量 Project 文件夹和立项流程，不恢复 Stage、周报或旧审批角色。`/progress/projects` 提供默认“只看我参与 + 进行中”的列表、创建、详情、编辑、审批、驳回重提、结束和软删除。Project 与 Task 详情采用“概览 + 三列工作区”：左侧显示可分页的风险和评论，中间保留 Current Plan/Task 主工作区并提供风险录入，右侧把 `DomainAuditEvent` 格式化为可筛选的中文近期动态。Project 风险明确分为自身风险和当前所属 Task 风险；Project 评论不混入 Task 评论。立项申请与完整审计历史继续持久化，但不再作为详情卡片展示。一个 Task 最多属于一个 ACTIVE Project；Task 加入时会把有效 Task 成员补为 Project Participant，但 Project 身份不授予 Task 权限。

风险只绑定一个 Project 或 Task，同一对象允许多条未解决风险。只有 ACTIVE 对象可提出风险，成员或全局管理员可以解决 ACTIVE/终态对象的遗留风险；所有已登录用户都可在未删除对象发表评论，只有两类全局管理员可以软删除评论。风险提出/解决和评论发布会原子写入审计、站内通知及非 mandatory 的项目管理 outbox，评论删除只写审计。风险、评论和动态均使用每页 20 条的稳定服务端分页；详情页每 5 秒检查轻量审计版本 token，页面隐藏时暂停。

- 所有已登录并成功解析到统一 `Account/Person` 的账号可查看全部未删除 Task、计划/审批/审计历史和全员完整 Segment，并可创建 Task；可见性扩大不扩大写权限。
- Task 成员只分“负责人”和“参与人”。支持多负责人且至少一名，同一 Person 只能有一个有效角色；创建者自动成为负责人。
- 参与人可编辑 Task/计划、提交验收并创建自己的 Revision，并管理自己的关联投入；负责人另可管理成员、Task 状态、任意未生效 Revision 和该 Task 全部投入；全局管理员拥有全部项目写权限。
- Revision 是可选择时间的非分段标记，创建即待审批，没有 Draft/Submit；驳回后修改即重新送审。每个 Task 只允许一条 Milestone/Revision 待审批，待审批期间不能再次提交 Milestone、发起或重新送审 Revision，也不能确认 Terminal。Milestone 与 Revision 只由统一超级管理员或项目管理员决定，允许管理员自审；界面不再提供流程策略、Reviewer 或自审开关。
- `/progress` 是“我的工作”统一驾驶舱，提供指标、完整个人时间画布、行动待办、到期确认队列、与 Plan 轨道同页分页的参与 Task 表和折叠通知。投入待办统一打开同一详情 Dialog 处理；旧 `/progress/my-timeline` 返回 404。
- `/progress/tasks/new` 提供新建 Composer；尚未激活的 Task 通过工作台右上角“编辑 Task”进入 `/progress/tasks/[id]/edit`，使用同一 Composer 一次保存基本信息、关联 Task、成员和完整计划。Participant 可编辑内容与计划，但成员区只读；保存成功后返回工作台。
- `/progress/tasks` 与 `/progress/tasks/[id]` 提供 Task 列表和 Task 工作台。人员投入时间线位于工作台 Tab 上方，并在“计划与资源”“概览”“修订与历史”“验收”“审计”之间切换时保持显示和交互状态。DRAFT 工作台的“概览”和“计划与资源”均为只读展示；Task Owner 或全局管理员可软删除未激活草稿，已激活及终态 Task 不提供该入口。ACTIVE 的既有元数据和成员可在同一事务编辑。发起 Revision 进入 `/progress/tasks/[id]/revisions/new`，被驳回候选通过 `/progress/tasks/[id]/revisions/[revisionId]/edit` 修改；两者与 Task 创建/草稿编辑共用 Composer 的 TimeCanvas、节点表、Inspector、撤销/重做、校验和本地恢复，保存后直接返回“修订与历史”。工作台 Revision Tab 只保留历史、审批、取消和 Diff，不再内联编辑候选计划。
- DRAFT Task 只能在计划开始时间已到达后激活；校验使用事务内的服务端时间，不追溯检查已经激活或结束的历史 Task。
- `/progress/resources` 统一为“资源计划”。默认显示全部可见资源，也可按 Project、Task、人员多选；Task 集合为直接选择与所选 Project 下 Task 的并集，人员集合再并入所选 Project 成员和 Task 成员。画布混排只读 Current Plan 轨道与可交互人员投入，Task/人员分别按 25/50 条分页，焦点对象固定在第一页；范围由内容自动扩展两个上海日历月并按最多 180 天分块读取。未保存的虚线创建草稿可在桌面横移、调整两端或拖到当前可创建的 Person 行，移动端继续使用表单。
- `/progress` 的个人画布同时展示本人投入和有效参与 Task，默认只列进行中 Task，用户可切换显示草稿及全部终态；每页 25 条且 Task 表与 Current Plan 轨道来自同一受约束装配。画布按当前页计划和本人可见投入自动计算范围，在内容两侧增加两个上海日历月，并以不超过 180 天的数据块读取。资源计划、Task 与 Project 详情同样按当前计划和投入自动确定范围。所有完整和紧凑画布默认使用周尺度，只有 URL 或调用方明确指定时才采用月/季/年；工具栏保留“今天”和独立底部滚动条。有效 Planned 新增或更新时间范围后会重新计算和预加载目标数据块；所有画布都排除已确认或已取消 Planned，它们不显示也不扩大范围，但数据库事实、来源与变更历史仍保留。Task 详情沿用既有投入权限，Project 详情中的投入只读。
- `/progress/approvals` 汇总投入确认、Milestone Review、Revision 与 Termination。Tag 分类能力已整体退役，`/progress/tags` 返回 404。
- `/progress/notifications` 提供站内通知中心和分类飞书偏好；站内通知始终保留，强制事件不受普通关闭偏好影响。
- 旧 `/progress/task/:id` 会重定向到 `/progress/tasks/:id`；`/progress/projects/*` 是当前 Project 正式路由，旧 `/progress/kanban` 回到 `/progress`。
- 飞书登录和通讯录同步先解析统一 `Account/AccountIdentity/Person`，再关联并更新采购 `User`。账号级项目访问禁用机制已移除，历史禁用账号恢复项目入口，但仍受系统角色、TaskMember 和数据范围授权约束。
- 人员与 Task 选择统一使用异步模糊选择器，支持 NFKC、拼音首字母、顺序匹配、已选项安全恢复和最多 50 项多选；Task 列表与账号后台使用相同的有界排序规则。
- 当前项目管理行为以 [`docs/TECH.md`](docs/TECH.md)、[`docs/TESTING.md`](docs/TESTING.md)、ADR、Prisma schema 和实现为准；历史实施计划及截图已归档移除，避免与现行规范冲突。
- `npm run pm:release-rehearsal` 仅用于本机隔离 `_test`/`_snapshot` 数据库；必须显式设置 `PM_RELEASE_REHEARSAL_CONFIRM=LOCAL_ISOLATED_REHEARSAL` 和 `NOTIFICATION_DELIVERY_DISABLED=true`。它不会执行生产维护窗口，生产发布仍需另行授权与 BO/TL/QA/DBA 签字。
- 项目管理飞书通知只允许写入 `channel=project-management` 的 notification outbox；adapter 已构造普通交互卡并经统一私信传输层投递。Project 立项、验收和 Revision 待审批事件使用审批机器人用途，其他项目管理事件使用通知机器人。
- 资源冲突和投入比例能力已完整下线：`/progress/resources/conflicts` 返回 404，Segment 允许时间重叠，系统不再检测、提示、阻止或通知冲突，也没有替代容量模型。

现行成员、可见性和审批决策见 [Task 全员可见、双成员角色与全局管理员审批 ADR](docs/adr/2026-08-03-task-global-visibility-participants-admin-approval.md)，Revision 节点与送审状态机见 [Revision 时间标记 ADR](docs/adr/2026-08-04-revision-time-marker.md)。已有数据的受控发布顺序为：

```bash
npm run pm:task-access-preflight

# 进入维护窗口后停止应用写入和通知 worker，再执行迁移
NOTIFICATION_DELIVERY_DISABLED=true npm run db:deploy

npm run accounts:validate
```

`20260805120000_single_task_pending_approval` 会统一撤出当前待处理的 Task Milestone/Revision 审批：保留审批、证据和已发送消息历史，取消 Revision 候选计划，冻结尚可投递的对应 outbox/recipient，将相关未读站内审批通知标记为已读，并写 `source=MIGRATION` 审计。迁移末尾会断言全库 Task 待审批数为零；失败则整次回滚。采购、报销、投入确认和关联复核完全不受影响。迁移成功并完成验证后才能恢复应用写入和通知 worker。
