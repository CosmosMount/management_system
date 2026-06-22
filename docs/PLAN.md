# pnx management — 项目规划



## 概述



基于 Next.js + Prisma + SQLite 的本地单体全栈应用。包含 **采购报销** 与 **进度管理** 两大板块，共用飞书 OAuth、角色体系与通知基础设施。



## 技术栈



- Next.js 16（App Router, TypeScript）

- Prisma 7 + SQLite（`@prisma/adapter-better-sqlite3`）

- Tailwind CSS 4 + shadcn/ui

- React Hook Form + Zod

- Auth.js v5（飞书 OAuth）

- node-cron（独立定时进程）



## 架构



```

用户 → Next.js 页面 → Server Actions → Prisma/SQLite

                    ↘ 飞书 Webhook / 私信（卡片通知）

定时脚本 cron.ts → Prisma → 采购日报 + 进度逾期/周报提醒

```



## 采购报销



### 数据模型



| 模型 | 说明 |

|------|------|

| `PurchaseOrder` | 采购主单 |

| `PurchaseItem` | 明细（含购买链接） |



### 状态机



`DRAFT` → `MANAGEMENT_REVIEW` → `TEACHER_REVIEW` → `PENDING_APPLICANT_DOCS` → `PENDING_FINANCE_REVIEW` → `PENDING_APPLICANT_CONFIRM` → `COMPLETED`



### 路由



| 路径 | 功能 |

|------|------|

| `/apply` | 采购申请 |

| `/orders` | 订单列表 |

| `/dashboard` | 采购汇总看板 |



## 进度管理



### 数据模型



| 模型 | 说明 |

|------|------|

| `Project` | 项目（车组、技术组、宏观状态） |

| `ProjectMilestone` | 验收里程碑（飞书文档） |

| `Task` | 任务（负责人、指标、截止、类别） |

| `TaskSubmission` | 交付 / 里程碑提交 |

| `WeeklyReport` | 周报 |

| `ApprovalRecord` | 验收记录 |

| `ProgressActivityLog` | 操作留痕 |



### 状态流转



`lib/progress-flow.ts`：定义项目与任务允许的状态迁移，服务端 `updateProjectStatus` / `updateTask` 强制校验，UI 仅展示下一步操作按钮。



### 角色



`PROJECT_MANAGER`（项管）为全局角色，与 `TEAM_ADMIN`、`TECH_GROUP_ADMIN` 共同参与验收与异常介入。



### 路由



| 路径 | 功能 |

|------|------|

| `/progress` | 进度首页 |

| `/progress/projects/new` | 新建项目 |

| `/progress/projects/[id]` | 项目详情 |

| `/progress/tasks/[id]` | 任务详情 |

| `/progress/kanban` | 任务看板 |

| `/progress/archive` | 归档检索 |



## 环境变量



见根目录 [`.env.example`](../.env.example)。


