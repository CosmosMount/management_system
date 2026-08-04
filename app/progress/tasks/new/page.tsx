import { randomUUID } from "node:crypto";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import {
  TASK_COMPOSER_START_ID,
  TaskComposerClient,
  type TaskComposerSeed,
} from "@/components/project-management/task-composer-client";
import { TEAM_OPTIONS, TECH_GROUP_OPTIONS } from "@/lib/constants";
import {
  isoToShanghaiDateTimeLocal,
} from "@/lib/project-management/date-time";
import {
  getActorPersonOption,
  listTagOptions,
  resolvePeopleOptionsByIds,
  searchPeople,
  searchTaskOptions,
} from "@/lib/project-management/queries/option-queries";
import {
  getTaskWorkspace,
  type TaskWorkspace,
} from "@/lib/project-management/queries/task-queries";
import type { PersonOptionDto } from "@/lib/project-management/types/time-canvas";
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

  const [actorPerson, peoplePage, templatePeople, taskPage, tagPage] = await Promise.all([
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
    resolveTemplatePeople(actor, initialScope, template),
    searchTaskOptions({ actor, input: { limit: 50 } }),
    listTagOptions({ actor, input: { limit: 50 } }),
  ]);
  const people = mergePersonOptions(
    peoplePage.items,
    [actorPerson, ...templatePeople],
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
        description="在一个工作台内编排元数据、成员、Milestone 与 Terminal；创建后再安排人员投入。"
      />
      <TaskComposerClient
        accountId={actor.accountId}
        deploymentEnvironment={deploymentEnvironment}
        initialSeed={seed}
        initialPeople={people}
        initialTasks={tasks}
        initialTags={tagPage.items}
        actorPersonId={actor.personId}
      />
    </>
  );
}

function chooseInitialScope(
  actor: Awaited<ReturnType<typeof getProgressActorOrRedirect>>,
  template: TaskWorkspace | null,
) {
  void actor;
  const templateTeam = template?.task.team;
  const templateTechGroup = template?.task.techGroup;
  return {
    team: TEAM_OPTIONS.includes(templateTeam as (typeof TEAM_OPTIONS)[number])
      ? templateTeam!
      : TEAM_OPTIONS[0],
    techGroup: TECH_GROUP_OPTIONS.includes(
      templateTechGroup as (typeof TECH_GROUP_OPTIONS)[number],
    )
      ? templateTechGroup!
      : TECH_GROUP_OPTIONS[0],
  };
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
  const shanghaiToday = isoToShanghaiDateTimeLocal(now).slice(0, 10);
  const defaultStartLocal = validDateParam(start)
    ? `${start}T09:00`
    : addDaysLocal(`${shanghaiToday}T09:00`, 1);
  const templateMilestones = template?.currentPlan.nodes
    .filter((entry) => entry.type === "MILESTONE" && entry.milestone)
    .map((entry) => ({
      id: `draft-node-${randomUUID()}`,
      goal: entry.milestone?.goal ?? "",
      completionCriteria: entry.milestone?.completionCriteria ?? "",
      expectedCompletedAt: isoToShanghaiDateTimeLocal(
        entry.milestone?.expectedCompletedAt ?? `${defaultStartLocal}:00+08:00`,
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
  const milestones = templateMilestones ?? [];
  const owner = people.find((person) => person.id === actorPersonId) ?? people[0];
  const templateMembers = normalizeTemplateMembers(
    template?.members ?? [],
    actorPersonId,
  );

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
      templateMembers.length > 0
        ? templateMembers
        : owner
          ? [{ personId: owner.id, role: "OWNER" }]
          : [],
    plannedStartAt,
    milestones,
    termination: {
      id: `draft-termination-${randomUUID()}`,
      name: templateTermination?.termination?.name ?? "Terminal",
      plannedAt: templateTermination?.termination
        ? isoToShanghaiDateTimeLocal(templateTermination.termination.plannedAt)
        : addDaysLocal(plannedStartAt, 14),
      plannedOutcomeCriteria:
        templateTermination?.termination?.plannedOutcomeCriteria ?? "",
      businessDescription: templateTermination?.businessDescription ?? "",
    },
    selectedEntityId: TASK_COMPOSER_START_ID,
  };
}

function normalizeTemplateMembers(
  members: TaskWorkspace["members"],
  creatorPersonId: string,
): Array<{ personId: string; role: "OWNER" | "PARTICIPANT" }> {
  const normalized = new Map<string, "OWNER" | "PARTICIPANT">();
  for (const member of members) {
    const role =
      member.role === "OWNER"
        ? "OWNER"
        : member.role === "PARTICIPANT" ||
            member.role === "LEAD" ||
            member.role === "MEMBER"
          ? "PARTICIPANT"
          : null;
    if (!role) continue;
    if (normalized.get(member.personId) === "OWNER") continue;
    normalized.set(member.personId, role);
  }
  normalized.set(creatorPersonId, "OWNER");
  return [...normalized].map(([personId, role]) => ({ personId, role }));
}

async function resolveTemplatePeople(
  actor: Awaited<ReturnType<typeof getProgressActorOrRedirect>>,
  scope: { team: string; techGroup: string },
  template: TaskWorkspace | null,
): Promise<PersonOptionDto[]> {
  const ids = [...new Set(template?.members.map((member) => member.personId) ?? [])];
  const resolved: PersonOptionDto[] = [];
  for (let offset = 0; offset < ids.length; offset += 50) {
    resolved.push(
      ...(await resolvePeopleOptionsByIds({
        actor,
        input: {
          scope: {
            purpose: "TASK_CREATE",
            team: scope.team,
            techGroup: scope.techGroup,
          },
          ids: ids.slice(offset, offset + 50),
        },
      })),
    );
  }
  return resolved;
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
    team: workspace.task.team,
    techGroup: workspace.task.techGroup,
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
