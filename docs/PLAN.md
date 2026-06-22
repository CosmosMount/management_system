# 采购报销系统 — 项目规划

## 概述

基于 Next.js + Prisma + SQLite 的本地单体全栈应用（仓库根目录）。支持采购申请、动态明细、多级审批流转，以及飞书 OAuth 登录与 Webhook 卡片通知。

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
                    ↘ 飞书 Webhook（卡片通知）
定时脚本 cron.ts → Prisma → 飞书 Webhook（每日汇总）
```

飞书 OAuth 与 Webhook **共用同一自建应用**（`FEISHU_APP_ID` / `FEISHU_APP_SECRET` + 应用机器人 Webhook）。

## 数据模型

| 模型 | 说明 |
|------|------|
| `User` | 飞书用户（openId, name, avatar） |
| `UserRole` | openId → TECH / TEACHER / FINANCE |
| `PurchaseOrder` | 采购主单（单号、车组、技术组、总价、状态、凭证路径） |
| `PurchaseItem` | 明细（名称、规格、数量、单价） |

## 状态机

```
DRAFT → TECH_REVIEW → TEACHER_REVIEW → PENDING_REIMBURSE → REIMBURSING → COMPLETED
```

| 状态 | 操作角色 |
|------|----------|
| TECH_REVIEW | TECH 通过 |
| TEACHER_REVIEW | TEACHER 通过 |
| PENDING_REIMBURSE | FINANCE 接单 |
| REIMBURSING | FINANCE 上传凭证并完成 |

## 主要路由

| 路径 | 功能 |
|------|------|
| `/login` | 飞书登录 |
| `/apply` | 采购申请表单（动态明细） |
| `/orders` | 订单列表与审批 |
| `/orders/[id]` | 订单详情（飞书卡片跳转目标） |

## 环境变量

见根目录 [`.env.example`](../.env.example)。
