import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  assertAuthorized,
  authorize,
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
  type PersonOptionPage,
  type PersonOptionDto,
} from "@/lib/project-management/types/time-canvas";
import {
  resolvePeopleOptionsByIdsInputSchema,
  searchPeopleInputSchema,
  type PeopleOptionScope,
  type SearchPeopleInput,
} from "@/lib/project-management/validations/time-canvas";
import { rankFuzzyMatches } from "@/lib/search/fuzzy-score";
import {
  normalizeSearchText,
  searchTerms,
} from "@/lib/search/normalize-search-text";
import {
  cursorFilter,
  FUZZY_CANDIDATE_LIMIT,
  mergeRowsById,
  nextOptionCursor,
  QUERY_RESULT_LIMIT,
  validateOptionCursor,
} from "@/lib/project-management/queries/option-query-support";

export {
  listMyTaskOptions,
  resolveTaskOptionsByIds,
  searchTaskOptions,
} from "@/lib/project-management/queries/task-option-queries";

const peopleSearchTaskAuthorizationSelect = {
  id: true,
  team: true,
  techGroup: true,
  status: true,
  priority: true,
  createdByAccountId: true,
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

type PersonOptionRow = Prisma.PersonGetPayload<{
  select: typeof personOptionSelect;
}>;

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
    createdByAccountId: task.createdByAccountId,
    members: task.members,
  };
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

function comparePeopleRows(left: PersonOptionRow, right: PersonOptionRow) {
  return (
    left.displayName.localeCompare(right.displayName, "zh-CN") ||
    left.id.localeCompare(right.id)
  );
}
