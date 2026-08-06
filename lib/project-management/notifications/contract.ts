import type { FeishuBotKind } from "@/lib/feishu-app-config";
import { z } from "zod";

export const PROJECT_MANAGEMENT_NOTIFICATION_OUTBOX_CHANNEL =
  "project-management";
export const PROJECT_MANAGEMENT_NOTIFICATION_PAYLOAD_VERSION = 1;
const PROJECT_MANAGEMENT_NOTIFICATION_KINDS = [
  "task_assigned",
  "task_activated",
  "milestone_due",
  "milestone_overdue",
  "milestone_review_submitted",
  "milestone_review_result",
  "revision_created",
  "revision_pending_review",
  "revision_result",
  "revision_applied",
  "segment_confirmation_due",
  "task_terminated",
  "account_security",
  "project_establishment_submitted",
  "project_establishment_result",
  "project_member_added",
  "project_task_changed",
  "project_completed",
  "project_deleted",
] as const;

const PROJECT_MANAGEMENT_APPROVAL_REQUEST_KINDS = [
  "milestone_review_submitted",
  "revision_pending_review",
  "project_establishment_submitted",
] as const satisfies readonly (typeof PROJECT_MANAGEMENT_NOTIFICATION_KINDS)[number][];

const approvalRequestKindSet = new Set<string>(
  PROJECT_MANAGEMENT_APPROVAL_REQUEST_KINDS,
);

export const projectManagementNotificationPayloadSchema = z
  .object({
    kind: z.enum(PROJECT_MANAGEMENT_NOTIFICATION_KINDS),
    payloadVersion: z.literal(PROJECT_MANAGEMENT_NOTIFICATION_PAYLOAD_VERSION),
    purpose: z.enum(["notification", "approval_request"]),
    category: z.enum([
      "TASK",
      "MILESTONE",
      "REVIEW",
      "REVISION",
      "WORK_SEGMENT",
      "ACCOUNT_SECURITY",
      "PROJECT",
    ]),
    title: z.string().min(1),
    summary: z.string().default(""),
    actorName: z.string().default("系统"),
    taskId: z.string().nullable().optional(),
    taskTitle: z.string().nullable().optional(),
    projectId: z.string().nullable().optional(),
    projectName: z.string().nullable().optional(),
    entityType: z.string().min(1),
    entityId: z.string().min(1),
    linkPath: z.string().default(""),
    recipientOpenIds: z.array(z.string()).default([]),
    mandatory: z.boolean().default(false),
    appOrigin: z.string().nullable().optional(),
    context: z.record(z.string(), z.unknown()).default({}),
  })
  .superRefine((payload, ctx) => {
    const approvalKind = approvalRequestKindSet.has(payload.kind);
    if (payload.purpose === "approval_request" && !approvalKind) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["purpose"],
        message: "审批机器人只能用于项目管理待审批事件",
      });
    }
    if (payload.purpose !== "approval_request" && approvalKind) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["purpose"],
        message: "项目管理待审批事件必须使用审批机器人用途",
      });
    }
  });

export type ProjectManagementNotificationPayload = z.infer<
  typeof projectManagementNotificationPayloadSchema
>;

export function botKindForPayload(
  payload: Pick<ProjectManagementNotificationPayload, "purpose">,
): FeishuBotKind {
  return payload.purpose === "approval_request" ? "approval" : "notification";
}

export function isProjectManagementApprovalRequestKind(kind: string): boolean {
  return approvalRequestKindSet.has(kind);
}
