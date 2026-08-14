import {
  absoluteDateTimeSchema,
  idSchema,
} from "@/lib/project-management/validations/lifecycle";
import { TEAM_OPTIONS, TECH_GROUP_OPTIONS } from "@/lib/constants";
import {
  standaloneTimeCanvasScopeKindValues,
  taskScopedTimeCanvasScopeKind,
  taskTimeCanvasGrouping,
  timeCanvasGroupByValues,
  taskStatusValues,
  workSegmentStatusValues,
  workSegmentTypeValues,
} from "@/lib/project-management/types/contract-values";
import { addStructuredProjectManagementIssue } from "@/lib/project-management/validations/issues";
import { z } from "zod";

export const MAX_TIME_CANVAS_RANGE_DAYS = 366;
export const DEFAULT_PEOPLE_PAGE_LIMIT = 25;
export const MAX_PEOPLE_PAGE_LIMIT = 50;
export const MAX_TIME_CANVAS_VISIBLE_SEGMENTS = 5_000;
export const MAX_TIME_CANVAS_ANCHOR_NODES = 5_000;

// Producers count serialized Full Segment and Busy objects after authorization
// classification, then reject instead of truncating the response.
export const timeCanvasVisibleSegmentCountSchema = z
  .number({ message: "可见 Segment 数量不正确" })
  .int("可见 Segment 数量不正确")
  .min(0, "可见 Segment 数量不正确")
  .superRefine((visibleSegmentCount, ctx) => {
    if (visibleSegmentCount > MAX_TIME_CANVAS_VISIBLE_SEGMENTS) {
      addStructuredProjectManagementIssue({
        ctx,
        code: "QUERY_LIMIT_EXCEEDED",
        message: "授权过滤后的返回时间对象不能超过 5000 条，禁止静默截断",
      });
    }
  });

const MAX_TIME_CANVAS_RANGE_MS =
  MAX_TIME_CANVAS_RANGE_DAYS * 24 * 60 * 60 * 1_000;

const optionCursorSchema = z
  .string({ message: "分页游标格式不正确" })
  .trim()
  .min(1, "分页游标格式不正确")
  .max(500, "分页游标格式不正确")
  .optional();

const querySchema = z
  .string({ message: "搜索内容格式不正确" })
  .trim()
  .max(200, "搜索内容过长")
  .optional();

function idListSchema(label: string) {
  return z
    .array(idSchema, { message: `${label}列表格式不正确` })
    .optional()
    .default([])
    .superRefine((ids, ctx) => {
      if (new Set(ids).size !== ids.length) {
        ctx.addIssue({ code: "custom", message: `${label}不能重复选择` });
      }
    });
}

const peoplePageLimitSchema = z
  .number({ message: "人员分页数量不正确" })
  .int("人员分页数量不正确")
  .min(1, "人员分页数量不正确")
  .optional()
  .default(DEFAULT_PEOPLE_PAGE_LIMIT)
  .superRefine((limit, ctx) => {
    if (limit > MAX_PEOPLE_PAGE_LIMIT) {
      addStructuredProjectManagementIssue({
        ctx,
        code: "QUERY_LIMIT_EXCEEDED",
        message: "人员分页数量不能超过 50",
      });
    }
  });

const optionPageLimitSchema = z
  .number({ message: "分页数量不正确" })
  .int("分页数量不正确")
  .min(1, "分页数量不正确")
  .optional()
  .default(25)
  .superRefine((limit, ctx) => {
    if (limit > 50) {
      addStructuredProjectManagementIssue({
        ctx,
        code: "QUERY_LIMIT_EXCEEDED",
        message: "分页数量不能超过 50",
      });
    }
  });

export const timeCanvasScopeSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal(taskScopedTimeCanvasScopeKind), taskId: idSchema })
    .strict(),
  z.object({ kind: z.enum(standaloneTimeCanvasScopeKindValues) }).strict(),
]);

const timeCanvasRangeFields = {
  rangeStart: absoluteDateTimeSchema("请选择带时区的有效范围开始时间"),
  rangeEnd: absoluteDateTimeSchema("请选择带时区的有效范围结束时间"),
} as const;

function validateHalfOpenRange(
  input: { rangeStart: Date; rangeEnd: Date },
  ctx: z.RefinementCtx,
) {
  if (
    !(input.rangeStart instanceof Date) ||
    !(input.rangeEnd instanceof Date)
  ) {
    return;
  }
  if (input.rangeEnd <= input.rangeStart) {
    ctx.addIssue({
      code: "custom",
      path: ["rangeEnd"],
      message: "范围结束时间必须晚于开始时间，区间采用 [start, end)",
    });
    return;
  }
  if (input.rangeEnd.getTime() - input.rangeStart.getTime() > MAX_TIME_CANVAS_RANGE_MS) {
    addStructuredProjectManagementIssue({
      ctx,
      code: "QUERY_LIMIT_EXCEEDED",
      path: ["rangeEnd"],
      message: "时间范围不能超过 366 天",
    });
  }
}

export const getTimeCanvasDataInputSchema = z
  .object({
    scope: timeCanvasScopeSchema,
    ...timeCanvasRangeFields,
    personIds: idListSchema("Person"),
    taskIds: idListSchema("Task"),
    types: z.array(z.enum(workSegmentTypeValues)).optional().default([]),
    statuses: z.array(z.enum(workSegmentStatusValues)).optional().default([]),
    groupBy: z.enum(timeCanvasGroupByValues),
    includeTaskAnchors: z.boolean().optional().default(true),
    includeActual: z.boolean().optional().default(true),
    emptyPersonIdsMeansNone: z.boolean().optional().default(false),
    includeBusyBlocks: z.boolean().optional().default(false),
  })
  .strict()
  .superRefine((input, ctx) => {
    validateHalfOpenRange(input, ctx);
    if (input.groupBy === taskTimeCanvasGrouping && input.includeBusyBlocks) {
      ctx.addIssue({
        code: "custom",
        path: ["includeBusyBlocks"],
        message: "Busy 只允许在按人员分组的画布中返回",
      });
    }
  });

export const getMyTimelinePageInputSchema = z
  .object({
    showAll: z.boolean().optional().default(false),
  })
  .strict();

const adaptiveBlockCommonFields = {
  rowPageKey: z.string().trim().min(1).max(100),
  preferredCenter: absoluteDateTimeSchema("时间画布中心格式不正确"),
  blockStart: absoluteDateTimeSchema("时间数据块开始格式不正确"),
  blockEnd: absoluteDateTimeSchema("时间数据块结束格式不正确"),
} as const;

export const getAdaptiveTimeCanvasBlockInputSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("MY_TIMELINE"),
      ...adaptiveBlockCommonFields,
      showAll: z.boolean().optional().default(false),
    }).strict(),
    z.object({
      kind: z.literal("TASK"),
      ...adaptiveBlockCommonFields,
      taskId: idSchema,
    }).strict(),
    z.object({
      kind: z.literal("PROJECT"),
      ...adaptiveBlockCommonFields,
      projectId: idSchema,
    }).strict(),
    z.object({
      kind: z.literal("RESOURCE_PLAN"),
      ...adaptiveBlockCommonFields,
      all: z.boolean(),
      projectIds: idListSchema("Project"),
      taskIds: idListSchema("Task"),
      personIds: idListSchema("Person"),
      pinnedTaskIds: z.array(idSchema).max(1).optional().default([]),
      pinnedPersonIds: z.array(idSchema).max(1).optional().default([]),
    }).strict(),
  ])
  .superRefine((input, ctx) => {
    validateHalfOpenRange(
      { rangeStart: input.blockStart, rangeEnd: input.blockEnd },
      ctx,
    );
  });

const searchPeopleCommonFields = {
  query: querySchema,
  cursor: optionCursorSchema,
  limit: peoplePageLimitSchema,
} as const;

export const peopleOptionScopeSchema = z.discriminatedUnion("purpose", [
  z.object({ purpose: z.literal("VISIBLE") }).strict(),
  z
    .object({
      purpose: z.literal("TASK_CREATE"),
      team: z.enum(TEAM_OPTIONS, { message: "请选择有效车组" }),
      techGroup: z.enum(TECH_GROUP_OPTIONS, { message: "请选择有效技术组" }),
    })
    .strict(),
  z
    .object({
      purpose: z.literal("TASK_MEMBERS"),
      taskId: idSchema,
    })
    .strict(),
  z
    .object({
      purpose: z.literal("TASK_SEGMENT_CREATE"),
      taskId: idSchema,
    })
    .strict(),
]);

export const searchPeopleInputSchema = z.discriminatedUnion("purpose", [
  // Visibility and ACTIVE status are server-enforced and not caller-selectable.
  z
    .object({
      purpose: z.literal("VISIBLE"),
      ...searchPeopleCommonFields,
    })
    .strict(),
  z
    .object({
      purpose: z.literal("TASK_CREATE"),
      team: z.enum(TEAM_OPTIONS, { message: "请选择有效车组" }),
      techGroup: z.enum(TECH_GROUP_OPTIONS, { message: "请选择有效技术组" }),
      ...searchPeopleCommonFields,
    })
    .strict(),
  z
    .object({
      purpose: z.literal("TASK_MEMBERS"),
      taskId: idSchema,
      ...searchPeopleCommonFields,
    })
    .strict(),
  z
    .object({
      purpose: z.literal("TASK_SEGMENT_CREATE"),
      taskId: idSchema,
      ...searchPeopleCommonFields,
    })
    .strict(),
]);

export const searchTaskOptionsInputSchema = z
  .object({
    query: querySchema,
    statuses: z.array(z.enum(taskStatusValues)).optional().default([]),
    mine: z.boolean().optional().default(false),
    projectCandidates: z.boolean().optional().default(false),
    cursor: optionCursorSchema,
    limit: optionPageLimitSchema,
  })
  .strict();

export const resolvePeopleOptionsByIdsInputSchema = z
  .object({
    scope: peopleOptionScopeSchema,
    ids: idListSchema("Person"),
  })
  .strict();

export const resolveTaskOptionsByIdsInputSchema = z
  .object({ ids: idListSchema("Task"), projectCandidates: z.boolean().optional().default(false) })
  .strict();

export type GetTimeCanvasDataInput = z.infer<
  typeof getTimeCanvasDataInputSchema
>;
export type GetMyTimelinePageInput = z.infer<
  typeof getMyTimelinePageInputSchema
>;
export type GetAdaptiveTimeCanvasBlockInput = z.infer<
  typeof getAdaptiveTimeCanvasBlockInputSchema
>;
export type SearchPeopleInput = z.infer<typeof searchPeopleInputSchema>;
export type PeopleOptionScope = z.infer<typeof peopleOptionScopeSchema>;
export type SearchTaskOptionsInput = z.infer<
  typeof searchTaskOptionsInputSchema
>;
