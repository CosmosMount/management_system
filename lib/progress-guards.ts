import type { ProjectStatus } from "@prisma/client";

export function assertProjectActive(status: ProjectStatus): void {
  if (status === "COMPLETED") {
    throw new Error("项目已完成，不能继续操作");
  }
  if (status === "CANCELED") {
    throw new Error("项目已取消，不能继续操作");
  }
}
