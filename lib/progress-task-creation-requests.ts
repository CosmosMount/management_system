import type { Importance, TaskCategory, Urgency } from "@prisma/client";
import { normalizeTaskTechGroups } from "@/lib/progress-task-tech-groups";

export type TaskCreationDraft = {
  title: string;
  goal: string;
  stageId: string | null;
  stageName: string;
  category: TaskCategory;
  taskTechGroups: string[];
  urgency: Urgency;
  importance: Importance;
  assigneeOpenIds: string[];
  assigneeNames: string[];
  metrics: string;
  dueAt: string;
  needsOfflineConfirmation: boolean;
  needsWeeklyReport: boolean;
  acceptanceChecklistItems: Array<{ content: string }>;
};

export function parseTaskCreationDraft(payload: string): TaskCreationDraft | null {
  try {
    const parsed = JSON.parse(payload) as Partial<TaskCreationDraft>;
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.title || !Array.isArray(parsed.assigneeOpenIds)) return null;
    return {
      title: String(parsed.title),
      goal: typeof parsed.goal === "string" ? parsed.goal : "",
      stageId: typeof parsed.stageId === "string" ? parsed.stageId : null,
      stageName: typeof parsed.stageName === "string" ? parsed.stageName : "无阶段",
      category: (parsed.category as TaskCategory) ?? "RND",
      taskTechGroups: Array.isArray(parsed.taskTechGroups)
        ? normalizeTaskTechGroups(parsed.taskTechGroups.map(String))
        : [],
      urgency: parsed.urgency as Urgency,
      importance: parsed.importance as Importance,
      assigneeOpenIds: parsed.assigneeOpenIds.map(String),
      assigneeNames: Array.isArray(parsed.assigneeNames)
        ? parsed.assigneeNames.map(String)
        : [],
      metrics: typeof parsed.metrics === "string" ? parsed.metrics : "",
      dueAt: typeof parsed.dueAt === "string" ? parsed.dueAt : "",
      needsOfflineConfirmation: !!parsed.needsOfflineConfirmation,
      needsWeeklyReport: !!parsed.needsWeeklyReport,
      acceptanceChecklistItems: Array.isArray(parsed.acceptanceChecklistItems)
        ? parsed.acceptanceChecklistItems
            .map((item) => ({
              content:
                typeof item?.content === "string" ? item.content.trim() : "",
            }))
            .filter((item) => item.content)
        : [],
    };
  } catch {
    return null;
  }
}

export function formatTaskCreationDraftSummary(
  draft: TaskCreationDraft | null,
): string {
  if (!draft) return "任务申请内容无法解析";
  const assignees =
    draft.assigneeNames.length > 0
      ? draft.assigneeNames.join("、")
      : draft.assigneeOpenIds.join("、");
  const taskTechGroups =
    draft.taskTechGroups.length > 0 ? draft.taskTechGroups.join("、") : "未选技术组";
  return `${draft.title} · ${draft.stageName} · ${taskTechGroups} · ${assignees}`;
}
