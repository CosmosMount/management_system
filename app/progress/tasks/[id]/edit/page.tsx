import { randomUUID } from "node:crypto";
import { notFound, redirect } from "next/navigation";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import {
  TaskComposerClient,
} from "@/components/project-management/task-composer-client";
import {
  TASK_COMPOSER_START_ID,
  type TaskComposerSeed,
} from "@/lib/project-management/composer-contract";
import { toProjectManagementServiceError } from "@/lib/project-management/application/errors";
import { isoToShanghaiDateTimeLocal } from "@/lib/project-management/date-time";
import {
  getActorPersonOption,
  resolvePeopleOptionsByIds,
  resolveTaskOptionsByIds,
  searchPeople,
  searchTaskOptions,
} from "@/lib/project-management/queries/option-queries";
import {
  getTaskWorkspace,
  type TaskWorkspace,
} from "@/lib/project-management/queries/task-queries";
import { routes } from "@/lib/routes";
import { listActiveProjectOptions } from "@/lib/project-management/queries/project-queries";
import { getProgressActorOrRedirect } from "../../../_auth";
import { listGlobalTimeMarkers } from "@/lib/project-management/global-time-markers";

export default async function ProgressTaskEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await getProgressActorOrRedirect();
  const { id } = await params;
  const workspace = await getTaskWorkspace({ actor, taskId: id }).catch(
    (error) => {
      const mapped = toProjectManagementServiceError(error);
      if (mapped.code === "NOT_FOUND") notFound();
      throw error;
    },
  );
  if (!workspace.permissions.canUpdateMetadata) notFound();
  if (workspace.task.status !== "DRAFT") {
    redirect(routes.progress.taskDetail(id));
  }

  const memberIds = workspace.members.map((member) => member.personId);
  const relatedTaskIds = workspace.task.relatedTaskId
    ? [workspace.task.relatedTaskId]
    : [];
  const [
    actorPerson,
    peoplePage,
    currentPeople,
    taskPage,
    currentRelatedTasks,
    projectOptions,
    globalMarkers,
  ] = await Promise.all([
    getActorPersonOption(actor),
    workspace.permissions.canManageMembers
      ? searchPeople({
          actor,
          input: { purpose: "TASK_MEMBERS", taskId: id, limit: 50 },
        })
      : Promise.resolve({
          items: [],
          nextCursor: null,
          hasMoreByQuery: false,
        }),
    resolveVisiblePeople(actor, memberIds),
    searchTaskOptions({ actor, input: { limit: 50 } }),
    resolveTaskOptionsByIds({ actor, input: { ids: relatedTaskIds } }),
    listActiveProjectOptions(workspace.task.projectId),
    listGlobalTimeMarkers(),
  ]);
  const people = mergeById(
    currentPeople,
    peoplePage.items,
    [actorPerson],
  );
  const tasks = mergeById(
    currentRelatedTasks,
    taskPage.items.filter((task) => task.id !== id),
  );
  const seed = editSeed(workspace);
  const deploymentEnvironment =
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    process.env.NODE_ENV ||
    "unknown";

  return (
    <>
      <PageCommandBar
        title="编辑 Task"
        description="统一调整草稿的基本信息、成员和完整计划；保存后返回 Task 工作台。"
      />
      <TaskComposerClient
        accountId={actor.accountId}
        deploymentEnvironment={deploymentEnvironment}
        initialSeed={seed}
        initialPeople={people}
        initialTasks={tasks}
        initialProjects={projectOptions}
        initialGlobalMarkers={globalMarkers}
        mode={{
          kind: "EDIT_DRAFT",
          taskId: workspace.task.id,
          planVersionId: workspace.currentPlan.id,
          expectedLockVersion: workspace.task.lockVersion,
          existingNodeIds: workspace.currentPlan.nodes.map(
            (entry) => entry.nodeId,
          ),
          canManageMembers: workspace.permissions.canManageMembers,
        }}
      />
    </>
  );
}

function editSeed(workspace: TaskWorkspace): TaskComposerSeed {
  const plannedStartAt = isoToShanghaiDateTimeLocal(
    workspace.currentPlan.plannedStartAt ?? workspace.task.createdAt,
  );
  const milestones = workspace.currentPlan.nodes.flatMap((entry) =>
    entry.milestone
      ? [
          {
            id: entry.nodeId,
            goal: entry.milestone.goal,
            completionCriteria: entry.milestone.completionCriteria,
            expectedCompletedAt: isoToShanghaiDateTimeLocal(
              entry.milestone.expectedCompletedAt,
            ),
            reviewRequirements: entry.milestone.reviewRequirements,
            businessDescription: entry.businessDescription,
          },
        ]
      : [],
  );
  const terminationEntry = workspace.currentPlan.nodes.find(
    (entry) => entry.termination,
  );
  const terminationId =
    terminationEntry?.nodeId ?? `draft-termination-${randomUUID()}`;

  return {
    draftId: randomUUID(),
    title: workspace.task.title,
    description: workspace.task.description,
    team: workspace.task.team,
    techGroup: workspace.task.techGroup,
    priority: workspace.task.priority,
    relatedTaskId: workspace.task.relatedTaskId,
    projectId: workspace.task.projectId,
    members: workspace.members.flatMap((member) =>
      member.role === "OWNER" || member.role === "PARTICIPANT"
        ? [{ personId: member.personId, role: member.role }]
        : [],
    ),
    plannedStartAt,
    milestones,
    termination: {
      id: terminationId,
      name: terminationEntry?.termination?.name ?? "Terminal",
      plannedAt: terminationEntry?.termination
        ? isoToShanghaiDateTimeLocal(terminationEntry.termination.plannedAt)
        : addDaysLocal(plannedStartAt, 1),
      plannedOutcomeCriteria:
        terminationEntry?.termination?.plannedOutcomeCriteria ?? "",
      businessDescription: terminationEntry?.businessDescription ?? "",
    },
    selectedEntityId: TASK_COMPOSER_START_ID,
  };
}

function mergeById<T extends { id: string }>(...groups: T[][]) {
  const merged = new Map<string, T>();
  for (const group of groups) {
    for (const entry of group) {
      if (!merged.has(entry.id)) merged.set(entry.id, entry);
    }
  }
  return [...merged.values()];
}

async function resolveVisiblePeople(
  actor: Awaited<ReturnType<typeof getProgressActorOrRedirect>>,
  personIds: string[],
) {
  const ids = [...new Set(personIds)];
  const people = [];
  for (let offset = 0; offset < ids.length; offset += 50) {
    people.push(
      ...(await resolvePeopleOptionsByIds({
        actor,
        input: {
          scope: { purpose: "VISIBLE" },
          ids: ids.slice(offset, offset + 50),
        },
      })),
    );
  }
  return people;
}

function addDaysLocal(value: string, days: number) {
  const parsed = new Date(`${value}:00+08:00`);
  return isoToShanghaiDateTimeLocal(
    new Date(parsed.getTime() + days * 24 * 60 * 60 * 1_000),
  );
}
