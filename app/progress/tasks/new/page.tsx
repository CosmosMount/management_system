import { randomUUID } from "node:crypto";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import {
  TaskComposerClient,
  type TaskComposerSeed,
} from "@/components/project-management/task-composer-client";
import { TEAM_OPTIONS, TECH_GROUP_OPTIONS } from "@/lib/constants";
import {
  authorize,
  isSystemAdministrator,
} from "@/lib/project-management/authorization";
import {
  isoToShanghaiDateTimeLocal,
} from "@/lib/project-management/date-time";
import {
  getActorPersonOption,
  listTagOptions,
  searchPeople,
  searchTaskOptions,
} from "@/lib/project-management/queries/option-queries";
import {
  getTaskWorkspace,
  type TaskWorkspace,
} from "@/lib/project-management/queries/task-queries";
import { getProgressActorOrRedirect } from "../../_auth";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function ProgressTaskNewPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const actor = await getProgressActorOrRedirect();
  const params = (await searchParams) ?? {};
  const templateTaskId = firstParam(params.templateTaskId);
  const relatedTaskId = firstParam(params.relatedTaskId);
  const start = firstParam(params.start);
  const template = templateTaskId
    ? await getTaskWorkspace({ actor, taskId: templateTaskId }).catch(() => null)
    : null;
  const requestedRelated = relatedTaskId
    ? await getTaskWorkspace({ actor, taskId: relatedTaskId }).catch(() => null)
    : null;

  const initialScope = chooseInitialScope(actor, template);
  if (!initialScope) {
    return (
      <>
        <PageCommandBar
          title="新建 Task"
          description="当前账号没有可创建 Task 的组织范围。"
        />
        <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6">
          <div className="rounded-xl border border-border bg-card p-6 text-sm leading-6 text-muted-foreground">
            创建 Task 需要 System Administrator 或对应车组/技术组的 Team
            Administrator 权限。请联系管理员配置后重试。
          </div>
        </div>
      </>
    );
  }

  const [actorPerson, peoplePage, taskPage, tagPage] = await Promise.all([
    getActorPersonOption(actor),
    searchPeople({
      actor,
      input: {
        purpose: "TASK_CREATE",
        team: initialScope.team,
        techGroup: initialScope.techGroup,
        limit: 50,
      },
    }),
    searchTaskOptions({ actor, input: { limit: 50 } }),
    listTagOptions({ actor, input: { limit: 50 } }),
  ]);
  const people = mergeTemplatePeople(
    mergePersonOptions(peoplePage.items, [actorPerson]),
    template,
  );
  const tasks = mergeRelatedTasks(taskPage.items, template, requestedRelated);
  const seed = createSeed({
    actorPersonId: actor.personId,
    initialScope,
    people,
    template,
    requestedRelated,
    start,
  });
  const deploymentEnvironment =
    process.env.NEXT_PUBLIC_APP_URL?.trim() || process.env.NODE_ENV || "unknown";

  return (
    <>
      <PageCommandBar
        title="新建 Task"
        description="在一个工作台内编排元数据、成员、Milestone 与 Termination；创建后再安排人员投入。"
      />
      <TaskComposerClient
        accountId={actor.accountId}
        deploymentEnvironment={deploymentEnvironment}
        initialSeed={seed}
        initialPeople={people}
        initialTasks={tasks}
        initialTags={tagPage.items}
        isSystemAdministrator={isSystemAdministrator(actor)}
        createScopes={actor.systemRoles
          .filter((role) => role.role === "TEAM_ADMINISTRATOR")
          .map((role) => ({ team: role.team, techGroup: role.techGroup }))}
      />
    </>
  );
}

function chooseInitialScope(
  actor: Awaited<ReturnType<typeof getProgressActorOrRedirect>>,
  template: TaskWorkspace | null,
) {
  const candidates = [
    template
      ? { team: template.task.team, techGroup: template.task.techGroup }
      : null,
    ...actor.systemRoles
      .filter((role) => role.role === "TEAM_ADMINISTRATOR")
      .map((role) => ({
        team: TEAM_OPTIONS.includes(role.team as (typeof TEAM_OPTIONS)[number])
          ? role.team
          : TEAM_OPTIONS[0],
        techGroup: TECH_GROUP_OPTIONS.includes(
          role.techGroup as (typeof TECH_GROUP_OPTIONS)[number],
        )
          ? role.techGroup
          : TECH_GROUP_OPTIONS[0],
      })),
    { team: TEAM_OPTIONS[0], techGroup: TECH_GROUP_OPTIONS[0] },
  ].filter(
    (scope): scope is { team: string; techGroup: string } => scope !== null,
  );
  return (
    candidates.find((scope) =>
      authorize({
        actor,
        action: "task.create",
        resource: { type: "system", ...scope },
      }).allowed,
    ) ?? null
  );
}

function createSeed({
  actorPersonId,
  initialScope,
  people,
  template,
  requestedRelated,
  start,
}: {
  actorPersonId: string;
  initialScope: { team: string; techGroup: string };
  people: Array<{ id: string; displayName: string }>;
  template: TaskWorkspace | null;
  requestedRelated: TaskWorkspace | null;
  start: string;
}): TaskComposerSeed {
  const now = new Date();
  const defaultStart = new Date(now.getTime() + 24 * 60 * 60 * 1_000);
  defaultStart.setUTCHours(1, 0, 0, 0);
  const defaultStartLocal = validDateParam(start)
    ? `${start}T09:00`
    : isoToShanghaiDateTimeLocal(defaultStart);
  const templateMilestones = template?.currentPlan.nodes
    .filter((entry) => entry.type === "MILESTONE" && entry.milestone)
    .map((entry) => ({
      id: `draft-node-${randomUUID()}`,
      goal: entry.milestone?.goal ?? "",
      completionCriteria: entry.milestone?.completionCriteria ?? "",
      expectedCompletedAt: isoToShanghaiDateTimeLocal(
        entry.milestone?.expectedCompletedAt ?? defaultStart.toISOString(),
      ),
      reviewRequirements: entry.milestone?.reviewRequirements ?? "",
      businessDescription: entry.businessDescription,
    }));
  const templateTermination = template?.currentPlan.nodes.find(
    (entry) => entry.type === "TERMINATION" && entry.termination,
  );
  const plannedStartAt = start
    ? defaultStartLocal
    : template?.currentPlan.plannedStartAt
      ? isoToShanghaiDateTimeLocal(template.currentPlan.plannedStartAt)
      : defaultStartLocal;
  const firstMilestoneAt = addDaysLocal(plannedStartAt, 7);
  const milestones =
    templateMilestones && templateMilestones.length > 0
      ? templateMilestones
      : [
          {
            id: `draft-node-${randomUUID()}`,
            goal: "",
            completionCriteria: "",
            expectedCompletedAt: firstMilestoneAt,
            reviewRequirements: "",
            businessDescription: "",
          },
        ];
  const owner = people.find((person) => person.id === actorPersonId) ?? people[0];
  const templateMembers = template?.members.map((member) => ({
    personId: member.personId,
    role: member.role,
  }));

  return {
    draftId: randomUUID(),
    title: template ? `${template.task.title}（副本）` : "",
    description: template?.task.description ?? "",
    team: initialScope.team,
    techGroup: initialScope.techGroup,
    priority: template?.task.priority ?? "MEDIUM",
    tagIds: template?.tags.map((tag) => tag.id) ?? [],
    relatedTaskId:
      requestedRelated?.task.id ?? template?.task.relatedTaskId ?? null,
    members:
      templateMembers && templateMembers.length > 0
        ? templateMembers
        : owner
          ? [{ personId: owner.id, role: "OWNER" }]
          : [],
    revisionApprovalMode:
      template?.task.revisionApprovalMode === "DIRECT_BY_OWNER"
        ? "DIRECT_BY_OWNER"
        : "REVIEW_REQUIRED",
    allowSelfReview: false,
    plannedStartAt,
    milestones,
    termination: {
      id: `draft-termination-${randomUUID()}`,
      plannedAt: templateTermination?.termination
        ? isoToShanghaiDateTimeLocal(templateTermination.termination.plannedAt)
        : addDaysLocal(milestones.at(-1)?.expectedCompletedAt ?? firstMilestoneAt, 7),
      plannedOutcomeCriteria:
        templateTermination?.termination?.plannedOutcomeCriteria ?? "",
      businessDescription: templateTermination?.businessDescription ?? "",
    },
    selectedEntityId: milestones[0]?.id ?? null,
  };
}

function mergeTemplatePeople<T extends { id: string }>(
  people: T[],
  template: TaskWorkspace | null,
) {
  const merged: Array<T | {
    id: string;
    displayName: string;
    avatar: null;
    status: "ACTIVE";
    accountAvailability: "ACTIVE";
  }> = [...people];
  for (const member of template?.members ?? []) {
    if (merged.some((person) => person.id === member.personId)) continue;
    merged.push({
      id: member.personId,
      displayName: member.displayName,
      avatar: null,
      status: "ACTIVE",
      accountAvailability: "ACTIVE",
    });
  }
  return merged;
}

function mergePersonOptions<T extends { id: string }>(people: T[], required: T[]) {
  const merged = [...people];
  for (const person of required) {
    if (!merged.some((item) => item.id === person.id)) merged.push(person);
  }
  return merged;
}

function mergeRelatedTasks<T extends { id: string }>(
  tasks: T[],
  template: TaskWorkspace | null,
  requestedRelated: TaskWorkspace | null,
) {
  const merged: Array<T | ReturnType<typeof workspaceTaskOption>> = [...tasks];
  for (const workspace of [template, requestedRelated]) {
    if (!workspace || merged.some((task) => task.id === workspace.task.id)) continue;
    merged.push(workspaceTaskOption(workspace));
  }
  return merged;
}

function workspaceTaskOption(workspace: TaskWorkspace) {
  const active = workspace.currentPlan.nodes.find(
    (entry) => entry.nodeId === workspace.task.activeMilestoneNodeId,
  );
  return {
    id: workspace.task.id,
    title: workspace.task.title,
    status: workspace.task.status,
    priority: workspace.task.priority,
    activeMilestone: active?.milestone
      ? {
          nodeId: active.nodeId,
          goal: active.milestone.goal,
          expectedCompletedAt: active.milestone.expectedCompletedAt,
        }
      : null,
    permission: { canView: true },
  };
}

function addDaysLocal(value: string, days: number) {
  const parsed = new Date(`${value}:00+08:00`);
  return isoToShanghaiDateTimeLocal(
    new Date(parsed.getTime() + days * 24 * 60 * 60 * 1_000),
  );
}

function validDateParam(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(new Date(`${value}T00:00:00+08:00`).getTime());
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}
