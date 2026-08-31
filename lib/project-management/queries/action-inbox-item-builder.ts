import { routes } from "@/lib/routes";
import {
  authorize,
  type AuthorizationTaskResource,
} from "@/lib/project-management/authorization";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { terminationOutcomeLabel } from "@/lib/project-management/notifications/user-facing-copy";
import type { ActionInboxStream } from "@/lib/project-management/queries/action-inbox-cursor";
import type { ActionInboxSources } from "@/lib/project-management/queries/action-inbox-query-loader";
import type {
  ActionInboxItem,
  ActionInboxPage,
  ActionInboxSeverity,
  StreamItem,
} from "@/lib/project-management/queries/action-inbox-types";

export function buildActionInboxCandidates({
  actor,
  generatedAt,
  take,
  sources,
}: {
  actor: ProjectManagementActor;
  generatedAt: Date;
  take: number;
  sources: ActionInboxSources;
}) {
  const {
    confirmationSegments,
    nextMilestones,
    nextTerminations,
    reviews,
    revisions,
    terminationReviews,
    projectRequests,
  } = sources;
  const candidates: StreamItem[] = [];
  for (const segment of confirmationSegments) {
    const task = segment.task;
    const resource = task
      ? ({ type: "task", ...task } satisfies AuthorizationTaskResource)
      : null;
    const canManage = authorize({
      actor,
      action:
        segment.personId === actor.personId
          ? "segment.manage_self"
          : "segment.manage_others",
      resource: { type: "segment", personId: segment.personId, task: resource },
    }).allowed;
    if (!canManage) continue;
    candidates.push(
      streamItem("SEGMENT_CONFIRMATION", segment.id, segment.endAt, {
        id: `segment-confirm:${segment.id}`,
        kind: "SEGMENT_CONFIRMATION",
        title: segment.content,
        summary: "计划投入已到期，请确认完整、部分或未执行。",
        ...(task
          ? taskContext(task)
          : {
              projectId: null,
              projectName: null,
              taskId: null,
              taskTitle: null,
            }),
        nodeId: null,
        nodeType: null,
        nodeStatus: null,
        relevantAt: segment.endAt.toISOString(),
        timeLabel: "投入结束",
        severity: segment.endAt < generatedAt ? "HIGH" : "MEDIUM",
        href: `/progress?focus=${segment.id}`,
        actionLabel: "确认投入",
      }),
    );
  }

  const nextNodeCandidates: StreamItem[] = [];
  for (const node of nextMilestones) {
    if (!node.milestone) continue;
    nextNodeCandidates.push(
      streamItem(
        "TASK_NEXT_NODE",
        node.id,
        node.milestone.expectedCompletedAt,
        {
          id: `task-next-node:${node.id}`,
          kind: "TASK_NEXT_NODE",
          title: node.milestone.goal,
          summary: `完成标准：${node.milestone.completionCriteria}`,
          ...taskContext(node.task),
          nodeId: node.id,
          nodeType: "MILESTONE",
          nodeStatus: node.status,
          relevantAt: node.milestone.expectedCompletedAt.toISOString(),
          timeLabel: "计划完成",
          severity:
            node.milestone.expectedCompletedAt < generatedAt
              ? "CRITICAL"
              : "MEDIUM",
          href: `${routes.progress.taskDetail(node.task.id)}?focus=${node.id}`,
          actionLabel: "查看节点",
        },
      ),
    );
  }
  for (const node of nextTerminations) {
    if (!node.termination) continue;
    const nodeName = terminalName(node.termination.name);
    nextNodeCandidates.push(
      streamItem("TASK_NEXT_NODE", node.id, node.termination.plannedAt, {
        id: `task-next-node:${node.id}`,
        kind: "TASK_NEXT_NODE",
        title: nodeName,
        summary: `计划结束标准：${node.termination.plannedOutcomeCriteria}`,
        ...taskContext(node.task),
        nodeId: node.id,
        nodeType: "TERMINATION",
        nodeStatus: node.status,
        relevantAt: node.termination.plannedAt.toISOString(),
        timeLabel: "计划结束",
        severity:
          node.termination.plannedAt < generatedAt ? "CRITICAL" : "MEDIUM",
        href: `${routes.progress.taskDetail(node.task.id)}?focus=${node.id}`,
        actionLabel: "查看节点",
      }),
    );
  }
  nextNodeCandidates.sort(compareStreamItems);
  candidates.push(...nextNodeCandidates.slice(0, take));

  for (const review of reviews) {
    const task = review.milestoneNode.node.task;
    if (
      !authorize({
        actor,
        action: "milestone.review",
        resource: { type: "task", ...task },
      }).allowed
    ) {
      continue;
    }
    candidates.push(
      streamItem(
        "MILESTONE_REVIEW",
        review.id,
        review.milestoneNode.expectedCompletedAt,
        {
          id: `review:${review.id}`,
          kind: "MILESTONE_REVIEW",
          title: review.milestoneNode.goal,
          summary: "里程碑已提交验收，请给出审核决定。",
          ...taskContext(task),
          nodeId: review.milestoneNode.node.id,
          nodeType: "MILESTONE",
          nodeStatus: review.milestoneNode.node.status,
          relevantAt: review.milestoneNode.expectedCompletedAt.toISOString(),
          timeLabel: "计划完成",
          severity:
            review.milestoneNode.expectedCompletedAt < generatedAt
              ? "CRITICAL"
              : "HIGH",
          href: routes.progress.taskReviews(task.id),
          actionLabel: "审批验收",
        },
      ),
    );
  }
  for (const revision of revisions) {
    const task = revision.node.task;
    if (
      !authorize({
        actor,
        action: "revision.review",
        resource: { type: "task", ...task },
      }).allowed
    ) {
      continue;
    }
    candidates.push(
      streamItem("REVISION_REVIEW", revision.id, revision.revisionAt, {
        id: `revision:${revision.id}`,
        kind: "REVISION_REVIEW",
        title: task.title,
        summary: revision.reason || "任务计划修订等待审核。",
        ...taskContext(task),
        nodeId: revision.node.id,
        nodeType: "REVISION",
        nodeStatus: revision.node.status,
        relevantAt: revision.revisionAt.toISOString(),
        timeLabel: "修订时间",
        severity: "HIGH",
        href: routes.progress.taskRevisions(task.id),
        actionLabel: "审核修订",
      }),
    );
  }
  for (const review of terminationReviews) {
    const task = review.terminationNode.node.task;
    if (
      !authorize({
        actor,
        action: "termination.review",
        resource: { type: "task", ...task },
      }).allowed
    ) {
      continue;
    }
    const nodeName = terminalName(review.terminationNode.name);
    candidates.push(
      streamItem(
        "TERMINATION_REVIEW",
        review.id,
        review.terminationNode.plannedAt,
        {
          id: `termination-review:${review.id}`,
          kind: "TERMINATION_REVIEW",
          title: task.title,
          summary: `${nodeName}申请${terminationOutcomeLabel(review.outcome)}，等待审批${review.reason ? `：${review.reason}` : ""}`,
          ...taskContext(task),
          nodeId: review.terminationNode.node.id,
          nodeType: "TERMINATION",
          nodeStatus: review.terminationNode.node.status,
          relevantAt: review.terminationNode.plannedAt.toISOString(),
          timeLabel: "计划结束",
          severity:
            review.terminationNode.plannedAt < generatedAt
              ? "CRITICAL"
              : "HIGH",
          href: `${routes.progress.taskDetail(task.id)}?focus=${review.terminationNode.node.id}`,
          actionLabel: "审批结束",
        },
      ),
    );
  }
  for (const request of projectRequests) {
    candidates.push(
      streamItem("PROJECT_ESTABLISHMENT", request.id, request.submittedAt, {
        id: `project-establishment:${request.id}`,
        kind: "PROJECT_ESTABLISHMENT",
        title: request.project.name,
        summary: `第 ${request.round} 轮项目立项申请等待审批。`,
        projectId: request.project.id,
        projectName: request.project.name,
        taskId: null,
        taskTitle: null,
        nodeId: null,
        nodeType: null,
        nodeStatus: null,
        relevantAt: request.submittedAt.toISOString(),
        timeLabel: "提交时间",
        severity: "HIGH",
        href: `${routes.progress.projectDetail(request.project.id)}#establishment`,
        actionLabel: "审批立项",
      }),
    );
  }
  return candidates;
}

function streamItem(
  stream: ActionInboxStream,
  rawId: string,
  relevantAt: Date,
  item: ActionInboxItem,
): StreamItem {
  return { stream, rawId, relevantAt, item };
}

function taskContext(task: {
  id: string;
  title: string;
  project: { id: string; name: string } | null;
}) {
  return {
    projectId: task.project?.id ?? null,
    projectName: task.project?.name ?? null,
    taskId: task.id,
    taskTitle: task.title,
  };
}

function terminalName(name: string) {
  return name === "Terminal" ? "结束节点" : name;
}

const severityRank: Record<ActionInboxSeverity, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

export function compareStreamItems(
  left: StreamItem,
  right: StreamItem,
) {
  return (
    severityRank[left.item.severity] - severityRank[right.item.severity] ||
    left.relevantAt.getTime() - right.relevantAt.getTime() ||
    left.item.id.localeCompare(right.item.id)
  );
}

export function emptyActionInboxPage(now: Date): ActionInboxPage {
  return {
    items: [],
    totalCount: 0,
    criticalCount: 0,
    nextCursor: null,
    generatedAt: now.toISOString(),
  };
}
