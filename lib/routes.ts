/** 应用内路由路径 */
export const routes = {
  admin: {
    root: "/admin",
    system: "/admin/system",
    roles: "/admin/roles",
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
    tasks: "/progress/tasks",
    taskDetail: (id: string) => `/progress/tasks/${id}`,
    resources: "/progress/resources",
    conflicts: "/progress/resources/conflicts",
    notifications: "/progress/notifications",
  },
} as const;
