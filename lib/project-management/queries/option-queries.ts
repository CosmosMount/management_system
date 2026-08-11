import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  assertAuthorized,
  authorize,
  isSystemAdministrator,
  taskReadableWhere,
  type AuthorizationTaskResource,
} from "@/lib/project-management/authorization";
import { isTaskCreatableForSegment } from "@/lib/project-management/domain/task-segment-policy";
import {
  notFoundError,
  validationError,
} from "@/lib/project-management/application/errors";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import {
  personOptionPageSchema,
  personOptionDtoSchema,
  tagOptionPageSchema,
  taskOptionPageSchema,
  type PersonOptionPage,
  type PersonOptionDto,
  type TagOptionPage,
  type TaskOptionPage,
} from "@/lib/project-management/types/time-canvas";
import {
  listTagOptionsInputSchema,
  resolvePeopleOptionsByIdsInputSchema,
  resolveTaskOptionsByIdsInputSchema,
  searchPeopleInputSchema,
  searchTaskOptionsInputSchema,
  type PeopleOptionScope,
  type SearchPeopleInput,
} from "@/lib/project-management/validations/time-canvas";
import { rankFuzzyMatches } from "@/lib/search/fuzzy-score";
import {
  normalizeSearchText,
  searchTerms,
} from "@/lib/search/normalize-search-text";

type OptionCursorKind = "people" | "tasks" | "tags";

type OptionCursor = {
  v: 1;
  kind: OptionCursorKind;
  filter: string;
  id: string;
};

const peopleSearchTaskAuthorizationSelect = {
  id: true,
  team: true,
  techGroup: true,
  status: true,
  priority: true,
  members: {
    where: { removedAt: null },
    select: { personId: true, role: true, removedAt: true },
  },
} satisfies Prisma.TaskSelect;

type PeopleSearchTask = Prisma.TaskGetPayload<{
  select: typeof peopleSearchTaskAuthorizationSelect;
}>;

const personOptionSelect = {
  id: true,
  displayName: true,
  avatar: true,
  status: true,
  account: { select: { id: true } },
} satisfies Prisma.PersonSelect;

const taskOptionSelect = {
  id: true,
  title: true,
  description: true,
  status: true,
  priority: true,
  team: true,
  techGroup: true,
  activeMilestoneNode: {
    select: {
      id: true,
      milestone: {
        select: { goal: true, expectedCompletedAt: true },
      },
    },
  },
  currentPlanVersion: {
    select: {
      versionNo: true,
      nodes: {
        where: {
          node: { type: "TERMINATION", status: "ACTIVE", deletedAt: null },
        },
        take: 1,
        select: {
          node: {
            select: {
              id: true,
              termination: { select: { name: true, plannedAt: true } },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.TaskSelect;

type PersonOptionRow = Prisma.PersonGetPayload<{
  select: typeof personOptionSelect;
}>;
type TaskOptionRow = Prisma.TaskGetPayload<{
  select: typeof taskOptionSelect;
}>;

const FUZZY_CANDIDATE_LIMIT = 501;
const QUERY_RESULT_LIMIT = 50;

export async function getActorPersonOption(
  actor: ProjectManagementActor,
): Promise<PersonOptionDto> {
  const person = await prisma.person.findFirstOrThrow({
    where: { id: actor.personId, accountId: actor.accountId },
    select: {
      id: true,
      displayName: true,
      avatar: true,
      status: true,
      account: { select: { id: true } },
    },
  });
  return personOptionDtoSchema.parse({
    id: person.id,
    displayName: person.displayName,
    avatar: person.avatar,
    status: person.status,
    accountBinding: person.account ? "BOUND" : "UNBOUND",
  });
}

export async function searchPeople({
  actor,
  input,
}: {
  actor: ProjectManagementActor;
  input: unknown;
}): Promise<PersonOptionPage> {
  const parsed = searchPeopleInputSchema.parse(input);
  const visibility = await peopleVisibilityForPurpose(actor, parsed);
  const query = normalizeSearchText(parsed.query ?? "");
  const baseWhere: Prisma.PersonWhereInput = {
    AND: [{ status: "ACTIVE" }, visibility],
  };
  if (query) {
    if (parsed.cursor) {
      throw validationError("非空人员搜索不支持分页游标，请继续输入关键词", {
        cursor: ["非空人员搜索不支持分页游标，请继续输入关键词"],
      });
    }
    const directRows = await prisma.person.findMany({
      where: {
        AND: [
          baseWhere,
          ...searchTerms(query).map((term) => ({
            displayName: { contains: term, mode: "insensitive" as const },
          })),
        ],
      },
      select: personOptionSelect,
      orderBy: [{ displayName: "asc" }, { id: "asc" }],
      take: FUZZY_CANDIDATE_LIMIT,
    });
    const fallbackRows =
      directRows.length < QUERY_RESULT_LIMIT
        ? await prisma.person.findMany({
            where: baseWhere,
            select: personOptionSelect,
            orderBy: [{ displayName: "asc" }, { id: "asc" }],
            take: FUZZY_CANDIDATE_LIMIT,
          })
        : [];
    const ranked = rankFuzzyMatches(
      mergeRowsById(directRows, fallbackRows),
      query,
      (person) => [{ text: person.displayName, weight: 2, pinyin: true }],
      comparePeopleRows,
    );
    const resultLimit = Math.min(parsed.limit, QUERY_RESULT_LIMIT);
    return personOptionPageSchema.parse({
      items: ranked.slice(0, resultLimit).map(({ item }) => personOption(item)),
      nextCursor: null,
      hasMoreByQuery:
        ranked.length > resultLimit ||
        directRows.length === FUZZY_CANDIDATE_LIMIT ||
        fallbackRows.length === FUZZY_CANDIDATE_LIMIT,
    });
  }
  const where: Prisma.PersonWhereInput = {
    AND: [{ status: "ACTIVE" }, visibility],
  };
  const filter = cursorFilter({
    query,
    context: peopleCursorContext(parsed),
  });
  const cursorId = await validateOptionCursor({
    cursor: parsed.cursor,
    kind: "people",
    filter,
    exists: (id) =>
      prisma.person.findFirst({ where: { AND: [{ id }, where] }, select: { id: true } }),
  });
  const rows = await prisma.person.findMany({
    where,
    select: personOptionSelect,
    orderBy: [{ displayName: "asc" }, { id: "asc" }],
    take: parsed.limit + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
  });
  const items = rows.slice(0, parsed.limit).map(personOption);
  return personOptionPageSchema.parse({
    items,
    nextCursor:
      rows.length > parsed.limit
        ? nextOptionCursor("people", filter, items.at(-1)?.id)
        : null,
    hasMoreByQuery: false,
  });
}

async function peopleVisibilityForPurpose(
  actor: ProjectManagementActor,
  input: SearchPeopleInput | PeopleOptionScope,
): Promise<Prisma.PersonWhereInput> {
  if (input.purpose === "VISIBLE") return {};
  if (input.purpose === "TASK_CREATE") {
    assertAuthorized({
      actor,
      action: "task.create",
      resource: {
        type: "task",
        team: input.team,
        techGroup: input.techGroup,
      },
    });
    return {};
  }

  const task = await prisma.task.findFirst({
    where: {
      AND: [{ id: input.taskId }, taskReadableWhere(actor)],
    },
    select: peopleSearchTaskAuthorizationSelect,
  });
  if (!task) throw notFoundError();
  if (input.purpose === "TASK_SEGMENT_CREATE") {
    if (!isTaskCreatableForSegment(task.status)) {
      return { id: { in: [] } };
    }
    const resource = peopleSearchTaskResource(task);
    const permittedPersonIds = task.members.flatMap((member) => {
      const action = member.personId === actor.personId
        ? "segment.manage_self"
        : "segment.manage_others";
      return authorize({
        actor,
        action,
        resource: {
          type: "segment",
          personId: member.personId,
          task: resource,
        },
      }).allowed
        ? [member.personId]
        : [];
    });
    return { id: { in: permittedPersonIds } };
  }
  assertAuthorized({
    actor,
    action: "task.manage_members",
    resource: peopleSearchTaskResource(task),
  });
  return {};
}

function peopleCursorContext(input: SearchPeopleInput) {
  if (input.purpose === "VISIBLE") return { purpose: input.purpose };
  if (input.purpose === "TASK_CREATE") {
    return {
      purpose: input.purpose,
      scope: { team: input.team, techGroup: input.techGroup },
    };
  }
  return { purpose: input.purpose, taskId: input.taskId };
}

function peopleSearchTaskResource(
  task: PeopleSearchTask,
): AuthorizationTaskResource {
  return {
    type: "task",
    id: task.id,
    team: task.team,
    techGroup: task.techGroup,
    status: task.status,
    priority: task.priority,
    members: task.members,
  };
}

export async function searchTaskOptions({
  actor,
  input,
}: {
  actor: ProjectManagementActor;
  input: unknown;
}): Promise<TaskOptionPage> {
  const parsed = searchTaskOptionsInputSchema.parse(input);
  const query = normalizeSearchText(parsed.query ?? "");
  const statuses = [...parsed.statuses].sort();
  const tagIds = [...parsed.tagIds].sort();
  const baseWhere: Prisma.TaskWhereInput = {
    AND: [
      taskReadableWhere(actor),
      statuses.length > 0 ? { status: { in: statuses } } : {},
      tagIds.length > 0
        ? { tags: { some: { tagId: { in: tagIds } } } }
        : {},
      parsed.mine
        ? {
            members: {
              some: { personId: actor.personId, removedAt: null },
            },
          }
        : {},
      parsed.projectCandidates ? projectEstablishmentTaskCandidateWhere(actor) : {},
    ],
  };
  if (query) {
    if (parsed.cursor) {
      throw validationError("非空 Task 搜索不支持分页游标，请继续输入关键词", {
        cursor: ["非空 Task 搜索不支持分页游标，请继续输入关键词"],
      });
    }
    const directRows = await prisma.task.findMany({
      where: {
        AND: [
          baseWhere,
          ...searchTerms(query).map((term) => ({
            OR: [
              { title: { contains: term, mode: "insensitive" as const } },
              { description: { contains: term, mode: "insensitive" as const } },
            ],
          })),
        ],
      },
      select: taskOptionSelect,
      orderBy: [{ title: "asc" }, { id: "asc" }],
      take: FUZZY_CANDIDATE_LIMIT,
    });
    const fallbackRows =
      directRows.length < QUERY_RESULT_LIMIT
        ? await prisma.task.findMany({
            where: baseWhere,
            select: taskOptionSelect,
            orderBy: [{ title: "asc" }, { id: "asc" }],
            take: FUZZY_CANDIDATE_LIMIT,
          })
        : [];
    const ranked = rankFuzzyMatches(
      mergeRowsById(directRows, fallbackRows),
      query,
      (task) => [
        { text: task.title, weight: 2, pinyin: true },
        { text: task.description, weight: 1 },
      ],
      compareTaskRows,
    );
    const resultLimit = Math.min(parsed.limit, QUERY_RESULT_LIMIT);
    return taskOptionPageSchema.parse({
      items: ranked.slice(0, resultLimit).map(({ item }) => taskOption(item)),
      nextCursor: null,
      hasMoreByQuery:
        ranked.length > resultLimit ||
        directRows.length === FUZZY_CANDIDATE_LIMIT ||
        fallbackRows.length === FUZZY_CANDIDATE_LIMIT,
    });
  }
  const where = baseWhere;
  const filter = cursorFilter({ query, statuses, tagIds, mine: parsed.mine, projectCandidates: parsed.projectCandidates });
  const cursorId = await validateOptionCursor({
    cursor: parsed.cursor,
    kind: "tasks",
    filter,
    exists: (id) =>
      prisma.task.findFirst({ where: { AND: [{ id }, where] }, select: { id: true } }),
  });
  const rows = await prisma.task.findMany({
    where,
    select: taskOptionSelect,
    orderBy: [{ title: "asc" }, { id: "asc" }],
    take: parsed.limit + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
  });
  const items = rows.slice(0, parsed.limit).map(taskOption);
  return taskOptionPageSchema.parse({
    items,
    nextCursor:
      rows.length > parsed.limit
        ? nextOptionCursor("tasks", filter, items.at(-1)?.id)
        : null,
    hasMoreByQuery: false,
  });
}

export async function resolvePeopleOptionsByIds({
  actor,
  input,
}: {
  actor: ProjectManagementActor;
  input: unknown;
}): Promise<PersonOptionDto[]> {
  const parsed = resolvePeopleOptionsByIdsInputSchema.parse(input);
  const visibility = await peopleVisibilityForPurpose(actor, parsed.scope);
  if (parsed.ids.length === 0) return [];
  const rows = await prisma.person.findMany({
    where: {
      AND: [
        { id: { in: parsed.ids } },
        visibility,
        parsed.scope.purpose === "TASK_SEGMENT_CREATE"
          ? { status: "ACTIVE" }
          : {},
      ],
    },
    select: personOptionSelect,
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return parsed.ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [personOptionDtoSchema.parse(personOption(row))] : [];
  });
}

export async function resolveTaskOptionsByIds({
  actor,
  input,
}: {
  actor: ProjectManagementActor;
  input: unknown;
}): Promise<TaskOptionPage["items"]> {
  const parsed = resolveTaskOptionsByIdsInputSchema.parse(input);
  if (parsed.ids.length === 0) return [];
  const rows = await prisma.task.findMany({
    where: { AND: [{ id: { in: parsed.ids } }, taskReadableWhere(actor), parsed.projectCandidates ? projectEstablishmentTaskCandidateWhere(actor) : {}] },
    select: taskOptionSelect,
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return parsed.ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [taskOption(row)] : [];
  });
}

function projectEstablishmentTaskCandidateWhere(actor: ProjectManagementActor): Prisma.TaskWhereInput {
  return {
    projectId: null,
    ...(isSystemAdministrator(actor) ? {} : { members: { some: { personId: actor.personId, role: { in: ["OWNER", "PARTICIPANT"] }, removedAt: null } } }),
  };
}

export async function listTagOptions({
  actor,
  input,
}: {
  actor: ProjectManagementActor;
  input: unknown;
}): Promise<TagOptionPage> {
  const parsed = listTagOptionsInputSchema.parse(input);
  const query = parsed.query?.trim() ?? "";
  const visibility: Prisma.TagWhereInput = parsed.includeArchived
    ? isSystemAdministrator(actor)
      ? {}
      : {
          OR: [
            { archivedAt: null },
            {
              archivedAt: { not: null },
              createdByAccountId: actor.accountId,
            },
          ],
        }
    : { archivedAt: null };
  const where: Prisma.TagWhereInput = {
    AND: [
      visibility,
      query ? { name: { contains: query, mode: "insensitive" } } : {},
    ],
  };
  const filter = cursorFilter({ query, includeArchived: parsed.includeArchived });
  const cursorId = await validateOptionCursor({
    cursor: parsed.cursor,
    kind: "tags",
    filter,
    exists: (id) =>
      prisma.tag.findFirst({ where: { AND: [{ id }, where] }, select: { id: true } }),
  });
  const rows = await prisma.tag.findMany({
    where,
    select: { id: true, name: true, color: true, archivedAt: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: parsed.limit + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
  });
  const items = rows.slice(0, parsed.limit).map((tag) => ({
    id: tag.id,
    name: tag.name,
    color: tag.color,
    isArchived: tag.archivedAt !== null,
  }));
  return tagOptionPageSchema.parse({
    items,
    nextCursor:
      rows.length > parsed.limit
        ? nextOptionCursor("tags", filter, items.at(-1)?.id)
        : null,
  });
}

function personOption(person: PersonOptionRow) {
  return {
    id: person.id,
    displayName: person.displayName,
    avatar: person.avatar,
    status: person.status,
    accountBinding:
      person.account === null ? ("UNBOUND" as const) : ("BOUND" as const),
  };
}

function taskOption(task: TaskOptionRow) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    team: task.team,
    techGroup: task.techGroup,
    activeMilestone:
      task.activeMilestoneNode?.milestone
        ? {
            nodeId: task.activeMilestoneNode.id,
            goal: task.activeMilestoneNode.milestone.goal,
            expectedCompletedAt:
              task.activeMilestoneNode.milestone.expectedCompletedAt.toISOString(),
          }
        : null,
    activeTermination: task.currentPlanVersion.nodes[0]?.node.termination
      ? {
          nodeId: task.currentPlanVersion.nodes[0].node.id,
          name: task.currentPlanVersion.nodes[0].node.termination.name,
          plannedAt:
            task.currentPlanVersion.nodes[0].node.termination.plannedAt.toISOString(),
        }
      : null,
    currentPlanVersionNo: task.currentPlanVersion.versionNo,
    permission: { canView: true },
  };
}

function mergeRowsById<T extends { id: string }>(...groups: readonly T[][]): T[] {
  const rows = new Map<string, T>();
  for (const group of groups) {
    for (const row of group) rows.set(row.id, row);
  }
  return [...rows.values()];
}

function comparePeopleRows(left: PersonOptionRow, right: PersonOptionRow) {
  return (
    left.displayName.localeCompare(right.displayName, "zh-CN") ||
    left.id.localeCompare(right.id)
  );
}

function compareTaskRows(left: TaskOptionRow, right: TaskOptionRow) {
  const activeOrder =
    Number(right.status === "ACTIVE") - Number(left.status === "ACTIVE");
  return (
    activeOrder ||
    left.title.localeCompare(right.title, "zh-CN") ||
    left.id.localeCompare(right.id)
  );
}

function cursorFilter(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("base64url")
    .slice(0, 22);
}

function nextOptionCursor(
  kind: OptionCursorKind,
  filter: string,
  id: string | undefined,
): string | null {
  if (!id) return null;
  return Buffer.from(
    JSON.stringify({ v: 1, kind, filter, id } satisfies OptionCursor),
  ).toString("base64url");
}

async function validateOptionCursor({
  cursor,
  kind,
  filter,
  exists,
}: {
  cursor: string | undefined;
  kind: OptionCursorKind;
  filter: string;
  exists: (id: string) => Promise<{ id: string } | null>;
}): Promise<string | null> {
  if (!cursor) return null;
  const decoded = decodeOptionCursor(cursor);
  if (
    !decoded ||
    decoded.kind !== kind ||
    decoded.filter !== filter ||
    !(await exists(decoded.id))
  ) {
    throw validationError("分页游标无效或已不再匹配当前查询", {
      cursor: ["分页游标无效或已不再匹配当前查询"],
    });
  }
  return decoded.id;
}

function decodeOptionCursor(cursor: string): OptionCursor | null {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      record.v !== 1 ||
      (record.kind !== "people" &&
        record.kind !== "tasks" &&
        record.kind !== "tags") ||
      typeof record.filter !== "string" ||
      typeof record.id !== "string" ||
      !UUID_PATTERN.test(record.id)
    ) {
      return null;
    }
    return record as OptionCursor;
  } catch {
    return null;
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
