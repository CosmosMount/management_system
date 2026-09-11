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
| `PLAYWRIGHT_DATABASE_URL` | 可选的 `npm run test:e2e` 本机 PostgreSQL 凭据/authority 模板；显式配置时优先，否则 runner 只复用 `DATABASE_URL` 的本机 authority/凭据并忽略其路径。POSIX-only 官方 runner 每次生成随机 target/shadow 和独立 marker，先拥有独立 server 进程组并确认 3003 readiness，再启动另一独立 Playwright CLI 组；两组均证明静默后才按两个精确名称清理。marker 用于防止错误 run/cross-run 和仅凭公开 token 的删除，不是同 UID 或已拥有工作树写权限进程之间的认证边界；调用方不配置 Playwright shadow |
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
3. 登录后先访问 **`/admin/system` 系统同步**，点击 **「同步飞书通讯录」** 将企业全员录入系统（无需对方先登录）。同步按在职通讯录全量快照核对：缺席或被飞书标记为离职的成员会停用，重新出现在在职快照时恢复。
4. 访问 **`/admin/accounts` 账号与权限**：
   - 在「车组职责配置」中按车组直接添加或移除报销车组组长和报销员
   - 在「技术组职责配置」中按技术组直接添加或移除报销技术组组长和指导老师，并维护指导老师审批邮箱
   - 在「用户与角色」中搜索统一账号，分配超级管理员、项目管理员或四类报销角色；账号列表支持筛选、分页、就地移除角色和查看角色历史/安全审计
   - 当前成员列表、职责矩阵和账号选择器只展示在职人员；离职人员的历史账号、角色、订单和审计仍保留
5. 访问 **`/admin/time-markers` 关键时间点**，可新增、编辑、软删除全局时间点，也可直接在带日期网格的时间线上拖动日期；所有草稿通过「保存全部」一次原子生效。保存期间时间线会锁定，并发版本冲突会保留当前草稿供管理员对照最新集合，未保存时离开页面会二次确认。

项目系统角色不再提供车组/技术组组长。授予超级管理员以及撤销全局项目角色需要二次确认；服务端仍会阻止自撤销或移除最后一名可用全局管理员。

项目模块不再提供账号级启用/禁用开关。停用 `Person` 对应账号仍可读取既有订单、Task、投入和审计历史，但项目与采购的所有新写入都会由服务端拒绝；停用人员也不能被新增选择或成为新业务通知收件人。

用户也可通过飞书登录自动写入/更新 `User` 表；分配角色前需先完成通讯录同步或让对方登录一次。停用人员即使仍能登录读取历史，也不能创建 Project/Task 或执行其他项目与采购业务写入。

### 飞书通讯录权限（同步全员）

在应用 **权限管理** 中开通并由企业管理员授权（应用身份、全部成员）：

| 权限 | scope |
|------|--------|
| 获取用户基本信息 | `contact:user.base:readonly` |
| 获取部门基础信息 | `contact:department.base:readonly` |
| 获取通讯录部门组织架构信息 | `contact:department.organize:readonly` |

同步使用 `tenant_access_token` 调用通讯录 API，将 `open_id`、姓名、头像写入统一账号及 `User`。同步前会确认应用授权范围包含根部门并严格完成部门/人员分页；已有飞书账号不少于 10 个且单次拟停用超过 30% 时默认阻断，超级管理员必须先确认飞书授权范围完整，再在二次确认对话框继续，同步会写入确认审计。确认令牌绑定稳定的飞书身份快照和待停用账号集合，快照变化后必须重新确认；每次手动同步都会在真正写库前、持有同步与管理员集合锁后复核发起人仍是在职超级管理员；提交高比例停用确认时还会复核确认人，拉取期间被停用或撤权后必须重新发起。离职成员不会物理删除，以保留订单、Task、投入与审计历史；其 `Person` 会标记为 `INACTIVE`，不再参与写权限、角色权限、人员选择或通知收件人解析。普通登录不会自动恢复该状态，只有后续在职通讯录快照会恢复；若快照会停用最后一名有效全局管理员，同步同样会整批回滚。

### 角色说明

| 角色 | 范围 | 权限 |
|------|------|------|
| 统一超级管理员 | 全局 | 报销和项目最高权限；访问 `/admin/accounts` |
| 项目管理员 | 项目全局 | 与统一超级管理员相同的项目业务权限、审批权和项目审计；不能管理账号 |
| Task 负责人 | 单个 Task | 管理成员、Task 状态、计划、Revision、验收证据、结束申请和该 Task 全部投入；可有多名 |
| Task 参与人 | 单个 Task | 编辑 Task 与计划、提交 Revision/验收证据/结束申请，并管理自己的关联投入 |
| TEAM_ADMIN | 指定车组 | 管理审核阶段，车组组长通过 |
| TECH_GROUP_ADMIN | 指定技术组 | 管理审核阶段，技术组组长通过 |
| TEACHER | 全局 | 「老师审核」阶段通过 |
| FINANCE | 指定车组 | 上传报销截图 |

所有已登录统一账号都可查看全部未删除 Project、Task、计划、成员、验收、审计和完整 投入记录；只有 `Person.status=ACTIVE` 的在职账号可提交 Project 立项和创建任意合法车组/技术组的 Task。Project 是 Task 上方的文件夹与立项对象，不包含 Stage；只有统一超级管理员或项目管理员能审批立项。Project Owner 可修改、结束和删除 Project，但不会继承任何 Task 写权限。

Revision 是用户选择时间的计划变化标记，不形成阶段，也不能关联 投入记录。创建 Revision 时固定沿用 Current Plan 的 Start，自动保留全部已完成 Milestone 和已生效 Revision，并用调用方提供的后续 Milestone 与 Terminal 重建未完成部分。创建即进入 `PENDING_APPROVAL`，不再存在草稿或单独提交动作；等待审批时，Task 详情会在 Current Plan 下自动加入只读的“Revision 修改后”候选 Plan，供提交人和审批人直接比较。驳回或取消后候选行消失；批准后该候选成为新的 Current Plan。若候选关联或基线异常，页面只展示修改前计划并禁用批准，但仍允许驳回或由有权限的人取消。该能力复用现有计划版本数据，不需要新增数据库字段。驳回后可修改并直接重新送审，取消后释放该 Task 的唯一候选名额，批准后才进入 Current Plan 和正式时间轴。

同一 Task 同时最多只能有一条待审批：未撤出的 `PENDING` Milestone Review、`PENDING_APPROVAL` Revision 与 `PENDING` Termination Review 互斥。Milestone 或 Terminal 提交后，在审批通过、驳回、要求修订或撤出前不能用新的请求键重复提交；相同请求键按原结果幂等重放，重新提交必须使用新请求键。任一待审批存在时，新的 Milestone、Revision 或 Terminal 申请都会被阻止；审批离开待处理状态后释放名额。Terminal 由 OWNER、PARTICIPANT 或全局管理员提交结束结果、原因和总结，只有统一超级管理员或项目管理员批准后才真正结束 Task。

存在 Task 数据时，系统要求至少保留一名具有 default tenant 有效飞书 openId 的全局管理员；账号后台会拒绝撤销最后一名可用审批人的角色，数据库永久门禁也会拦截绕过应用层的账号删除、角色和身份写入。空库创建首个 Task 时同样检查该不变量。提交 Milestone 验收、Terminal 结束申请或创建/重新送审 Revision 时会在同一事务中再次校验，失败时整事务回滚，不会留下无人处理或无法通知的待审批记录。

项目 `GROUP_LEADER` 已退役；旧角色行会在部署时归档为只读领域审计并从运行时表删除，账号记录仍可查看。活跃旧系统角色或旧 Task 成员角色会阻断迁移，必须先显式撤销或结束，不能静默映射权限。采购报销的 `TEAM_ADMIN`、`TECH_GROUP_ADMIN` 等独立角色、组长称谓和审批流程不受影响。Work Segment 不再保存独立工作职责、Task Node 或完成比例；投入只可关联 Task，历史非空完成比例同样归档到领域审计。

### 导航栏没有「权限管理」？

常见原因：

1. **首位超管未初始化**：执行 `npm run db:seed -- --super-admin-open-id=<飞书 openId>`。
2. **账号尚未建立**：先让该用户登录或执行通讯录同步。
3. **旧数据未通过迁移预检**：升级前先运行 `npm run accounts:preflight`，处理报告中的身份、重复角色或范围冲突。

统一账号历史升级仍按 `npm run accounts:preflight` → `npm run db:deploy` → `npm run accounts:validate` 执行。Task 全员可见改造部署前还必须先运行只读 `npm run pm:task-access-preflight`；若报告零负责人 Task 或孤立的 Task 关联投入，迁移会阻断，必须先人工修复，不能猜测负责人。受控 `npm run db:deploy` 会把不可逆 Task migration 与 Prisma history 记录放入同一 PostgreSQL 事务；不得绕过它直接运行 `prisma migrate deploy`。迁移链还会在不可逆 Task DDL 之前按固定顺序锁定相关表、复检具有有效飞书身份的全局管理员，并安装覆盖账号删除、全局角色、飞书身份和首条 Task 创建的永久串行延迟约束，避免遗漏人工预检、部署中断或旧实例并发写入时留下半升级 schema。该自动门禁不替代发布前报告核对。

`20260814120000_retire_project_management_legacy_history` 是向前迁移：部署前需确认没有仍有效的旧项目系统角色或旧 Task 成员角色。迁移会把已撤销/结束角色及非空投入完成比例写入 append-only `DomainAuditEvent`，随后收窄角色枚举并删除 `WorkSegment.completionPercent`；整个过程不得创建或修改站内通知、outbox 或收件人记录。

### 完整审批与报销流程

进入 `/procurement` 会直接打开采购看板。桌面端通过左侧栏、移动端通过导航抽屉在「采购看板、待办与最近、新建申请、订单列表」之间切换；订单详情和编辑页归属“订单列表”。采购各面板顶部统一使用与项目管理一致的上下文命令栏，不显示返回按钮，状态和业务操作集中在命令栏右侧。独立“工坊加工费”录入入口已下线，旧 `/procurement/workshop-fee` 返回 404；普通采购申请仍可选择“加工费”种类，既有工坊加工费历史订单仍保留并可按原权限查看。停用账号仍可从“订单列表”读取自己的历史订单，但侧栏不显示新建申请，直达写入页面会进入只读或无权访问状态。

预算池 Excel 只需填写项目、兵种组、预算和周期（仍兼容旧“车组”表头），不再填写技术方向。预算、已用金额与阈值告警均按兵种组汇总；同组项目会列在该兵种组后，不拆成多栏。

**审批：**

1. **申请人** → `/procurement/new` 提交
2. **管理审核**（状态「管理审核」）：车组组长、技术组组长**均需通过**（分别私信通知），全部通过后进入老师审核
3. **TEACHER** → 「指导老师通过」
4. **采购人** → 上传发票，并为每行明细上传实物照片；系统自动生成 Word 验收清单（状态「待申请人上传凭证」）。**车组组长、技术组组长、采购人**需事先在「个人设置」上传电子签名图片。
5. **报销员** → 上传报销截图（状态「待报销员处理」）
6. **采购人** → 「确认报销」（状态「待申请人确认」）→ 完成

**状态一览：**

```
草稿 → 管理审核 → 老师审核 → 待申请人上传凭证 → 待报销员处理 → 待申请人确认 → 已完成
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
| 待申请人上传凭证 / 待申请人确认 | 采购发起人 |
| 待报销员处理 | 报销员（对应车组） |

前提：

1. 审批人已在 `UserRole` 表中配置正确的 `open_id`
2. 审批人至少登录过本系统一次，或已通过通讯录同步写入 `User.unionId`
3. `.env` 中通知机器人和审批机器人凭证有效；未单独配置时至少 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 有效

群 Webhook 与私信**独立**：只配 App 凭证也可发私信；Webhook 仅影响群消息。

## 功能测试流程

1. **登录**：访问 `/login`，飞书授权后进入 `/procurement/dashboard`
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

### 界面第一阶段：导航与展示规范

项目管理导航按“工作空间 / 团队排期 / 消息中心”分组：工作空间包含工作台、项目、任务、待办与审批；团队排期包含资源计划、人员时间线；消息中心保留通知及未读数量。人员时间线仍为单人只读视图，资源计划仍沿用原有投入权限；分组不增加角色或扩大权限，原 `/progress` 路由和通知链接继续有效。

页面顶部统一显示中文入口、面包屑、标题和操作区域。超长页面标题默认最多两行，可通过“展开完整标题”查看和收起；这只约束顶部标题，不改变详情正文和业务记录。项目、任务、计划修订、里程碑等操作与表单使用中文展示名称，保存的业务名称、枚举和历史记录不批量改写。

通知列表仍位于 `/progress/notifications`，低频偏好设置移至同一路由的 `?view=settings` 视图。通过页面内“通知列表 / 通知设置”链接切换时保留通知类型、未读筛选及分页位置；刷新和浏览器返回可恢复视图。设置界面继续说明强制事件不受普通关闭偏好影响，停用人员只能查看设置。第一阶段仅统一导航；当前桌面布局见下一节，审批状态机与画布业务语义不变。

完整重构范围和后续分期见[项目管理 UI 重构计划](docs/plans/2026-09-08-project-management-ui-refactor-plan.md)。

### 当前业务与详情结构

进度模块统一展示当前节点的到期提示：红色“已逾期”、黄色“即将到期”（未来 72 小时内，包含边界）、绿色“距到期超过 3 天”（超过 72 小时）。按截止时刻判断，时间使用上海时区展示；仅进行中任务的当前生效计划参与提示，优先当前里程碑，没有当前里程碑时使用当前结束节点。草稿、终态、后续未激活节点、历史和待审批候选计划不预警；当前节点等待验收时仍显示到期情况，不代表当前查看者拥有审批权限。

工作台不常驻展示到期图例，鼠标悬浮“参与任务”标题旁的“到期规则”自动展示说明，移出入口和说明区域后收起；手机可点击切换，键盘聚焦后可按 Enter 切换、Escape 收起。任务行保留彩色状态和截止时间，画布图例保持不变。

提示覆盖工作台、任务列表与详情、项目任务概览、个人日程、人员时间线、资源计划、相关待办和任务选择器。页面可见时每分钟更新，恢复可见或重新聚焦时立即更新，不为颜色变化轮询数据库。工作台对全部参与任务按“逾期、临期、距到期超过 3 天、无有效到期目标”排序后预览前 6 项，同类按截止时间、名称和 ID 排序；其他列表分页、待办优先级和通知规则保持不变。画布的到期文字和底色独立于节点图标、完成状态及修订计划配色。

工作台 `/progress` 默认展示我的待办与参与任务预览：顶部四项指标在桌面横排、手机两列排列，存在紧急待办时突出提醒；“我的待办”汇总任务推进与审批事项，参与任务使用列表展示名称、状态、当前节点和截止时间，保留按风险排序的前 6 项预览。完整个人日程独立在 `?view=schedule`；“管理概览”位于 `/progress?view=management`，所有已登录账号可主动进入，但不因此获得操作权限。概览显示可读、未删除对象的全量进行中项目/任务数、未解决风险记录数及当前账号的紧急待办；终态对象的遗留风险仍可查看，风险每页 12 条。项目与任务列表提供单一搜索、范围、状态工具栏（任务另有优先级）、重置入口和长内容展开，原默认“我参与 + 进行中”不变。

旧 Project/Stage 工作流已清理；当前重新提供轻量 Project 文件夹和立项流程，不恢复 Stage、周报或旧审批角色。`/progress/projects` 提供默认“只看我参与 + 进行中”的列表、创建、详情、编辑、审批、驳回重提、结束和软删除。Project 与 Task 详情只保留一个主标题，成员和长说明按需展开。Project 与 Task 工作台均采用同页布局：上方完整时间线与人员投入，下方桌面三栏（左侧风险与讨论、中间主体操作、右侧近期动态）；窄屏依次展示时间线、主体操作、风险讨论和近期动态。Task 默认选中当前节点，节点导航与审批详情同页联动；Project 的任务列表与时间线同页联动。旧 `section` 链接仍可打开完整工作台，不再控制分区显隐；保留 `focus`、`center`、缩放参数、风险与节点详情锚点以及刷新、前后退定位。当前节点到期警示继续在任务摘要、节点详情/导航、Project 任务列表及对应时间线节点显示：已逾期为红色，距截止不超过 72 小时为琥珀色，超过 72 小时为绿色，并配文字与图标；非进行中任务或无有效截止时间不显示警示。Project 主体详情把 Task 按七种状态分组，各组可独立折叠并可整组或逐条选择计划轨道；默认只展开并显示进行中 Task，折叠不改变已经选择的轨道，选择只存在于当前页面且不影响人员投入。Task 主体包含待处理 Revision、选中节点详情及风险录入，Project 主体包含任务列表及风险录入；审批门禁及全局反馈在时间线上方持续可见。等待审批的 Revision 会自动在 Current Plan 后加入只读、琥珀色的修改后候选 Plan；其后才是用户勾选的历史 Plan 与人员投入。Task 节点导航中的每条已生效 Revision 可独立勾选“显示修订前计划”，按需加入对应基础 Plan 的只读历史行；可同时比较多条，取消勾选只隐藏该行。对比内容跨越三年展示上限时，可用“最早内容 / 最新内容”在本地切换展示窗口，不会为对比端点请求人员投入。右侧近期动态继续把 `DomainAuditEvent` 格式化为可筛选的中文活动记录。Project 风险明确分为自身风险和当前所属 Task 风险；Project 评论不混入 Task 评论。立项申请与完整审计历史继续持久化；详情不恢复历史卡片，只在立项审批中展示当前轮的提交人、提交时间和申请加入的 Task。一个 Task 最多属于一个 ACTIVE Project；Task 加入时会把有效 Task 成员补为 Project Participant，但 Project 身份不授予 Task 权限。

风险只绑定一个 Project 或 Task，同一对象允许多条未解决风险。只有 ACTIVE 对象可提出风险，成员或全局管理员可以解决 ACTIVE/终态对象的遗留风险；所有已登录用户都可在未删除对象发表评论，只有两类全局管理员可以软删除评论。风险提出/解决和评论发布会原子写入审计、站内通知及非 mandatory 的项目管理 outbox，评论删除只写审计。风险、评论和动态均使用每页 20 条的稳定服务端分页；详情页每 5 秒检查轻量审计版本 token，页面隐藏时暂停。

- 所有已登录并成功解析到统一 `Account/Person` 的账号可查看全部未删除 Task、计划/审批/审计历史和全员完整 Segment；只有 `Person.status=ACTIVE` 的账号可创建 Task 或执行其他业务写入，可见性扩大不扩大写权限。
- Task 成员只分“负责人”和“参与人”，支持多负责人，同一 Person 只能有一个有效角色。草稿可暂不设置成员或负责人，创建者不会自动成为负责人，但可在草稿阶段继续编辑、管理成员、激活或删除自己创建的 Task；激活前必须至少设置一名有效负责人，激活后不再保留创建者特权。
- 参与人可编辑 Task/计划、提交验收并创建自己的 Revision，并管理自己的关联投入；负责人另可管理成员、Task 状态、任意未生效 Revision 和该 Task 全部投入；全局管理员拥有全部项目写权限。
- ACTIVE Project 只在没有未删除的草稿或进行中 Task 时允许结束；空 Project 和仅包含已完成、失败结束、已取消、已超时或已归档 Task 的 Project 均可结束。Project 详情的 Task 完成进度为严格 `COMPLETED` 数量除以“未删除 Task 总数减去 `CANCELLED` 数量”；原始 Task 总数仍用于空 Project 与结束门禁判断。
- Revision 是可选择时间的非分段标记，创建即待审批，没有 Draft/Submit；驳回后修改即重新送审。每个 Task 只允许一条 Milestone/Revision/Termination 待审批，待审批期间不能再次提交其他审批申请。Milestone 与 Terminal 均允许 OWNER、PARTICIPANT 或全局管理员提交，三类申请只由统一超级管理员或项目管理员决定，并允许管理员自审；界面不再提供流程策略、Reviewer 或自审开关。
- `/progress` 是“我的工作”统一驾驶舱，默认展示行动待办、最多 6 条参与任务预览和折叠通知，完整任务从列表访问，时间画布和参与计划在 `?view=schedule` 查看。行动待办预览前 8 项，默认前 4 项、其余可展开；投入只通过时间线详情维护，没有到期确认队列。
- `/progress/kanban` 是全员可访问的只读人员工作看板。默认选择当前用户，也可通过异步人员选择器切换任一在职人员；画布展示该人员的完整投入、有效参与的进行中 Task Current Plan 和全局关键时间点，不展示或代办其指标、待办、审批和通知。选择使用 `people=<personId>`，并与 `center`、`scale` 一同保存在 URL 中；切换人员保留当前时间视口。
- `/progress/approvals` 展示完整的待办与审批全局优先队列，按“紧急 → 高 → 中 → 低”、相关时间和稳定 ID 排序，每次加载 50 项。队列包含本人待确认投入、本人有效参与的 ACTIVE Task 当前节点，以及全局管理员可处理的 Milestone 验收、Revision、Project 立项和 Terminal 结束审批；“任务结束申请”不再作为一条行动待办。当前节点优先使用 Task 的 `activeMilestoneNodeId`，进入结束阶段后使用 Current Plan 中的 ACTIVE Terminal；相同 Milestone/Terminal 已有待处理审批时隐藏当前节点，待审批 Revision 不隐藏。逾期当前节点为“紧急”，其余为“中”。
- `/progress/tasks/new` 提供新建 Composer；尚未激活的 Task 通过工作台右上角“编辑 Task”进入 `/progress/tasks/[id]/edit`，使用同一 Composer 一次保存基本信息、关联 Task、成员和完整计划。Participant 可编辑内容与计划，但成员区只读；保存成功后返回工作台。
- `/progress/tasks` 与 `/progress/tasks/[id]` 提供 Task 列表和 Task 工作台。人员投入时间线位于工作台 Tab 上方，并在“计划与资源”“概览”“修订与历史”“验收”“审计”之间切换时保持显示和交互状态。DRAFT 工作台的“概览”和“计划与资源”均为只读展示；草稿创建者、Task Owner 或全局管理员可软删除未激活草稿，已激活及终态 Task 不提供该入口。ACTIVE 的既有元数据和成员可在同一事务编辑。发起 Revision 进入 `/progress/tasks/[id]/revisions/new`，被驳回候选通过 `/progress/tasks/[id]/revisions/[revisionId]/edit` 修改；两者与 Task 创建/草稿编辑共用 Composer 的 TimeCanvas、节点表、Inspector、撤销/重做、校验和本地恢复，保存后直接返回“修订与历史”。可编辑 Composer 的桌面 TimeCanvas 支持 Shift 点击、空白框选和鼠标整组移动可编辑节点；选中组只存在于当前页面，不写入本地草稿或服务端，Revision 的 Start、已完成 Milestone 和已生效 Revision 等只读承接节点不会加入选中组。桌面多选状态栏还提供按整数天批量前移/后移，操作时需明确选择“当前及后续”或“仅已选节点”；前者包含当前焦点以及时间不早于它的全部可编辑节点，后者只处理显式选中组，移动端不提供该入口。整组拖动和批量移动都按一次原子修改进入撤销/重做，失败时所有节点保持原值。工作台 Revision Tab 只保留历史、审批、取消和 Diff，不再内联编辑候选计划。
- DRAFT Task 只能在计划开始时间已到达后激活；校验使用事务内的服务端时间，不追溯检查已经激活或结束的历史 Task。
- `/progress/resources` 统一为“资源计划”。默认显示全部可见人员和草稿/进行中 Task，也可按 Project、Task、人员多选，并用七个复选框筛选草稿、进行中及五种终态 Task；允许全部取消。Task 集合为“直接选择与所选 Project 下 Task 的并集”和状态选择的交集，Task 搜索建议使用同一状态条件；人员集合再并入符合状态的 Task 成员和所选 Project 成员。状态只决定 Task 计划轨道及由 Task 推导的人员：直接选择或经 Project 进入画布的人员仍展示全部可见投入，包括属于已被筛除 Task 的投入。画布一次装配完整 Task 与人员集合，混排只读 Current Plan 轨道与可交互人员投入；范围由内容自动扩展两个上海日历月并按最多 180 天分块读取。未保存的虚线创建草稿可在桌面横移、调整两端或拖到当前可创建的 Person 行，移动端继续使用表单；快速创建的“内容”默认为空，需由创建人明确填写。
- `/progress` 的个人画布同时展示本人投入、全部有效参与 Task，以及用户自己创建且仍为 DRAFT 的 Task；默认只列进行中 Task，用户切换显示草稿后可看到自己的零成员草稿，也可切换全部终态。Task 表与 Current Plan 轨道来自同一全量装配。画布按全部计划和本人可见投入自动计算范围，在内容两侧增加两个上海日历月，并以不超过 180 天的数据块读取。Task 工作台展示全部有效成员及这些成员的全部投入；Project 详情展示 Project/所属 Task 全部有效成员的全部投入，计划轨道则只包含用户在状态分组中勾选的本 Project Task。真实 Task 计划轨道和按 Task 分组行的左侧标题可直接进入对应 Task 详情；存在未保存的投入创建内容时，离开前继续要求确认，取消后保留原草稿。Composer 草稿、人员及 Revision 对比行保持非链接文本。投入悬浮信息包含所属 Task，未关联 Task 时显示“独立投入”。所有完整和紧凑画布默认使用周尺度，只有 URL 或调用方明确指定时才采用月/季/年；工具栏保留“今天”和独立底部滚动条。投入新增或更新时间范围后会重新计算和预加载目标数据块；软删除记录不显示也不扩大范围。旧记录按原默认可见集合迁移，完整原数据、来源和变更历史保存在只读归档。Task 详情沿用既有投入权限，Project 详情中的投入只读。
- 超级管理员配置的关键时间点会出现在个人、资源计划、Task/Project 详情和桌面 Composer 的统一 TimeCanvas 中，即使当前业务行为空也会保留显示。业务画布不为其增加独立行，只在对应日期显示名称和贯穿内容区的细竖线；精确时间保留在悬浮提示和无障碍文本中。密集时间点聚合为可点击计数，打开后可查看并选择具体时间点。它们进入可导航范围，但可视窗口最多三年且不会覆盖业务内容的默认初始中心，也不会产生提醒、站内通知或飞书消息。
- 投入统一为“人员 + 起止时间 + 工作内容 + 可选任务关联”。允许过去、当前、未来及重叠时间，单条最长 31 天、内容最多 2,000 字；没有计划/实际、状态、优先级、输出或确认。保留单条新增、编辑、软删除和桌面拖动/边界调整，移动端通过表单维护；不再提供批量、拆分、合并或确认流程。权限与任务关联限制不变，操作只记录审计，不产生投入通知。
- `/progress/approvals` 汇总当前任务节点、Milestone Review、Revision、项目立项与 Termination，不再包含投入确认。Tag 分类能力已整体退役，`/progress/tags` 返回 404。
- Task 工作台的当前 Milestone 验收审批会展示提交人、提交时间及本轮 TEXT/LINK 证据；历史 FILE 或不安全链接以不可查看状态呈现，不生成可点击地址。
- `/progress/notifications` 提供站内通知中心和分类飞书偏好；站内通知始终保留，强制事件不受普通关闭偏好影响。
- 当前项目管理正式路由只保留 `/progress`、`/progress/kanban`、`/progress/projects/*`、`/progress/tasks/*`、`/progress/resources`、`/progress/approvals` 与 `/progress/notifications`；`/progress/task/:id`、`/progress/my-timeline` 和 `/admin/roles` 均返回 404。
- Task mutation 公共入口只保留 Draft 整包 `updateTaskDraft` 与 Active 整包 `updateActiveTask`。时间视图 URL 使用 `focus`、`center`、`scale` 以及 `projects`/`tasks`/`people` 等复数选择；资源计划另用 `taskStatuses` 保存 Task 状态多选，缺失时表示默认草稿/进行中，空值表示不显示任何 Task 计划。`timelineDate`、`timelineFocus`、单值 `personId`/`taskId`、`start`/`end` 和 `zoom` 会被忽略并从规范 URL 移除。
- Composer 只恢复当前 v4 草稿；v1/v2/v3 不读取、不转换也不导出。过渡 tombstone 仅删除旧 key 与 IndexedDB 正文，首次生产发布满 30 天后应删除 tombstone 模块及调用点。
- 飞书登录和通讯录同步先解析统一 `Account/AccountIdentity/Person`，再关联并更新采购 `User`。通讯录全量同步会把缺席或离职人员标记为 `INACTIVE` 并保留历史关联；只有重新进入在职快照才恢复，普通身份解析不会覆盖停用状态。账号级项目访问禁用机制已移除，停用人员仍可读取历史，但不能执行项目或采购写入、取得管理员能力、作为新增成员或收到新业务通知。
- 人员与 Task 选择统一使用异步模糊选择器，支持 NFKC、拼音首字母、顺序匹配和已选项安全恢复；搜索建议继续按最多 50 条分页，资源计划中的 Task/人员已选集合不设 50 项上限。Task 列表与账号后台使用相同的有界排序规则。
- 当前项目管理行为以 [`docs/TECH.md`](docs/TECH.md)、[`docs/TESTING.md`](docs/TESTING.md)、ADR、Prisma schema 和实现为准；历史实施计划及截图已归档移除，避免与现行规范冲突。
- `npm run pm:release-rehearsal` 仅用于本机隔离 `_test`/`_snapshot` 数据库；必须显式设置 `PM_RELEASE_REHEARSAL_CONFIRM=LOCAL_ISOLATED_REHEARSAL` 和 `NOTIFICATION_DELIVERY_DISABLED=true`。它不会执行生产维护窗口，生产发布仍需另行授权与 BO/TL/QA/DBA 签字。
- 项目管理飞书通知只允许写入 `channel=project-management` 的 notification outbox；adapter 已构造普通交互卡并经统一私信传输层投递。Project 立项、Milestone 验收、Revision 和 Terminal 待审批事件使用审批机器人用途，其他项目管理事件使用通知机器人。
- 资源冲突和投入比例能力已完整下线：`/progress/resources/conflicts` 返回 404，Segment 允许时间重叠，系统不再检测、提示、阻止或通知冲突，也没有替代容量模型。

现行成员、可见性和审批决策见 [Task 全员可见、双成员角色与全局管理员审批 ADR](docs/adr/2026-08-03-task-global-visibility-participants-admin-approval.md)，Revision 节点与送审状态机见 [Revision 时间标记 ADR](docs/adr/2026-08-04-revision-time-marker.md)。已有数据的受控发布顺序为：

```bash
npm run pm:task-access-preflight

# 进入维护窗口后停止应用写入和通知 worker，再执行迁移
NOTIFICATION_DELIVERY_DISABLED=true npm run db:deploy

npm run accounts:validate
```

`20260805120000_single_task_pending_approval` 会统一撤出当前待处理的 Task Milestone/Revision 审批：保留审批、证据和已发送消息历史，取消 Revision 候选计划，冻结尚可投递的对应 outbox/recipient，将相关未读站内审批通知标记为已读，并写 `source=MIGRATION` 审计。迁移末尾会断言全库 Task 待审批数为零；失败则整次回滚。采购、报销、投入确认和关联复核完全不受影响。迁移成功并完成验证后才能恢复应用写入和通知 worker。

### 统一投入记录迁移

`20260907120000_unify_work_segments` 必须在应用停写、通知 worker 暂停的维护窗口部署。备份完整数据库后执行 `npm run db:deploy`，再部署匹配的新应用。旧投入、来源和变更原样保留在 `LegacyWorkSegment`、`LegacyWorkSegmentSource`、`LegacyWorkSegmentChange`；只读触发器禁止写入，Prisma `@@ignore` 保留迁移管理但不生成日常 Client API。归档解除对日常人员、账号和任务的外键依赖，以免业务删除改写历史。

新表仅回填原默认可见记录，保留 ID、人员、时间、内容、任务及创建/修改信息，不按内容或时间去重。已确认/取消的旧计划、软删除记录、输出字段和来源链仅归档，领域审计和已发送消息不删除。迁移取消旧投入确认的待发 outbox/recipient，并将相关未读站内通知标记已读，其他消息不受影响。

恢复服务前核对数量、原定位链接、编辑权限和通知队列。旧应用不能连接新结构；回退必须同时恢复匹配应用与数据库，恢复写入后不得用旧备份直接覆盖新增记录。
