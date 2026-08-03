/** 应用内路由路径 */
export const routes = {
  admin: {
    root: "/admin",
    system: "/admin/system",
    accounts: "/admin/accounts",
    roles: "/admin/accounts",
    budgetPools: "/admin/budget-pools",
  },
  procurement: {
    root: "/procurement",
    new: "/procurement/new",
    list: "/procurement/list",
    dashboard: "/procurement/dashboard",
    workshopFee: "/procurement/workshop-fee",
    detail: (id: string) => `/procurement/${id}`,
    edit: (id: string) => `/procurement/${id}/edit`,
  },
  progress: {
    root: "/progress",
    myTimeline: "/progress/my-timeline",
    tasks: "/progress/tasks",
    taskNew: "/progress/tasks/new",
    taskDetail: (id: string) => `/progress/tasks/${id}`,
    resources: "/progress/resources",
    approvals: "/progress/approvals",
    notifications: "/progress/notifications",
    tags: "/progress/tags",
  },
} as const;
