/** 应用内路由路径 */
export const routes = {
  admin: {
    root: "/admin",
    system: "/admin/system",
    accounts: "/admin/accounts",
    roles: "/admin/accounts",
    budgetPools: "/admin/budget-pools",
    timeMarkers: "/admin/time-markers",
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
    projects: "/progress/projects",
    projectNew: "/progress/projects/new",
    projectDetail: (id: string) => `/progress/projects/${id}`,
    projectEdit: (id: string) => `/progress/projects/${id}/edit`,
    tasks: "/progress/tasks",
    taskNew: "/progress/tasks/new",
    taskDetail: (id: string) => `/progress/tasks/${id}`,
    taskEdit: (id: string) => `/progress/tasks/${id}/edit`,
    taskRevisionNew: (id: string) => `/progress/tasks/${id}/revisions/new`,
    taskRevisionEdit: (taskId: string, revisionId: string) =>
      `/progress/tasks/${taskId}/revisions/${revisionId}/edit`,
    taskRevisions: (id: string) => `/progress/tasks/${id}?tab=revisions`,
    taskReviews: (id: string) => `/progress/tasks/${id}?tab=reviews`,
    resources: "/progress/resources",
    approvals: "/progress/approvals",
    notifications: "/progress/notifications",
  },
} as const;
