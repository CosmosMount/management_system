/** 应用内路由路径（采购 / 进度模块统一层级：new · list · dashboard） */
export const routes = {
  admin: {
    root: "/admin",
    system: "/admin/system",
    roles: "/admin/roles",
    reminders: "/admin/reminders",
    projectTemplates: "/admin/project-templates",
    acceptance: "/admin/acceptance",
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
    new: "/progress/new",
    list: "/progress/list",
    dashboard: "/progress/dashboard",
    archive: "/progress/archive",
    project: (id: string) => `/progress/${id}`,
    projectStage: (projectId: string, stageId: string) =>
      `/progress/${projectId}?stage=${stageId}`,
    task: (id: string) => `/progress/task/${id}`,
  },
} as const;
