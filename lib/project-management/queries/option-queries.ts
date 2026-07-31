import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  assertAuthorized,
  isSystemAdministrator,
  segmentReadableWhere,
  taskReadableWhere,
  type AuthorizationTaskResource,
} from "@/lib/project-management/authorization";
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
  searchPeopleInputSchema,
  searchTaskOptionsInputSchema,
  type SearchPeopleInput,
} from "@/lib/project-management/validations/time-canvas";

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
  allowSelfReview: true,
  members: {
    where: { removedAt: null },
    select: { personId: true, role: true, removedAt: true },
  },
} satisfies Prisma.TaskSelect;

type PeopleSearchTask = Prisma.TaskGetPayload<{
  select: typeof peopleSearchTaskAuthorizationSelect;
}>;

export async function getActorPersonOption(
  actor: ProjectManagementActor,
): Promise<PersonOptionDto> {
  const person = await prisma.person.findFirstOrThrow({
    where: { id: actor.personId, accountId: actor.accountId, status: "ACTIVE" },
    select: {
      id: true,
      displayName: true,
      avatar: true,
      account: { select: { status: true } },
    },
  });
  return personOptionDtoSchema.parse({
    id: person.id,
    displayName: person.displayName,
    avatar: person.avatar,
    status: "ACTIVE",
    accountAvailability: person.account?.status ?? "UNBOUND",
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
  const query = parsed.query?.trim() ?? "";
  const where: Prisma.PersonWhereInput = {
    AND: [
      { status: "ACTIVE" },
      visibility,
      query
        ? { displayName: { contains: query, mode: "insensitive" } }
        : {},
    ],
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
    select: {
      id: true,
      displayName: true,
      avatar: true,
      status: true,
      account: { select: { status: true } },
    },
    orderBy: [{ displayName: "asc" }, { id: "asc" }],
    take: parsed.limit + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
  });
  const items = rows.slice(0, parsed.limit).map((person) => ({
    id: person.id,
    displayName: person.displayName,
    avatar: person.avatar,
    status: "ACTIVE" as const,
    accountAvailability:
      person.account === null ? "UNBOUND" as const : person.account.status,
  }));
  return personOptionPageSchema.parse({
    items,
    nextCursor:
      rows.length > parsed.limit
        ? nextOptionCursor("people", filter, items.at(-1)?.id)
        : null,
  });
}

async function peopleVisibilityForPurpose(
  actor: ProjectManagementActor,
  input: SearchPeopleInput,
): Promise<Prisma.PersonWhereInput> {
  if (input.purpose === "VISIBLE") return peopleVisibleWhere(actor);
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
    allowSelfReview: task.allowSelfReview,
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
  const query = parsed.query?.trim() ?? "";
  const statuses = [...parsed.statuses].sort();
  const tagIds = [...parsed.tagIds].sort();
  const where: Prisma.TaskWhereInput = {
    AND: [
      taskReadableWhere(actor),
      query
        ? {
            OR: [
              { title: { contains: query, mode: "insensitive" } },
              { description: { contains: query, mode: "insensitive" } },
            ],
          }
        : {},
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
    ],
  };
  const filter = cursorFilter({ query, statuses, tagIds, mine: parsed.mine });
  const cursorId = await validateOptionCursor({
    cursor: parsed.cursor,
    kind: "tasks",
    filter,
    exists: (id) =>
      prisma.task.findFirst({ where: { AND: [{ id }, where] }, select: { id: true } }),
  });
  const rows = await prisma.task.findMany({
    where,
    select: {
      id: true,
      title: true,
      status: true,
      priority: true,
      activeMilestoneNode: {
        select: {
          id: true,
          milestone: {
            select: { goal: true, expectedCompletedAt: true },
          },
        },
      },
    },
    orderBy: [{ title: "asc" }, { id: "asc" }],
    take: parsed.limit + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
  });
  const items = rows.slice(0, parsed.limit).map((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    activeMilestone:
      task.activeMilestoneNode?.milestone
        ? {
            nodeId: task.activeMilestoneNode.id,
            goal: task.activeMilestoneNode.milestone.goal,
            expectedCompletedAt:
              task.activeMilestoneNode.milestone.expectedCompletedAt.toISOString(),
          }
        : null,
    permission: { canView: true },
  }));
  return taskOptionPageSchema.parse({
    items,
    nextCursor:
      rows.length > parsed.limit
        ? nextOptionCursor("tasks", filter, items.at(-1)?.id)
        : null,
  });
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

function peopleVisibleWhere(
  actor: ProjectManagementActor,
): Prisma.PersonWhereInput {
  return {
    OR: [
      { id: actor.personId },
      {
        taskMembers: {
          some: {
            removedAt: null,
            task: taskReadableWhere(actor),
          },
        },
      },
      {
        workSegments: {
          some: segmentReadableWhere(actor),
        },
      },
    ],
  };
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
