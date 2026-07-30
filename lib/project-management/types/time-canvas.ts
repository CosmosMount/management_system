import {
  resourceConflictKindValues,
  resourceConflictSeverityValues,
  resourceConflictStatusValues,
  personTimeCanvasGrouping,
  standaloneTimeCanvasScopeKindValues,
  taskScopedTimeCanvasScopeKind,
  taskTimeCanvasGrouping,
  taskNodeStatusValues,
  taskNodeTypeValues,
  taskPriorityValues,
  taskStatusValues,
  workSegmentRoleValues,
  workSegmentStatusValues,
  workSegmentTypeValues,
} from "@/lib/project-management/types/contract-values";
import { z } from "zod";

const dtoIdSchema = z.string().uuid();
const dtoAbsoluteDateTimeSchema = z.string().datetime({ offset: true });
const conflictKindSchema = z.enum(resourceConflictKindValues);
const conflictSeveritySchema = z.enum(resourceConflictSeverityValues);
const conflictStatusSchema = z.enum(resourceConflictStatusValues);
const taskStatusSchema = z.enum(taskStatusValues);
const taskPrioritySchema = z.enum(taskPriorityValues);
const taskNodeTypeSchema = z.enum(taskNodeTypeValues);
const taskNodeStatusSchema = z.enum(taskNodeStatusValues);
const pageCursorSchema = z.string().trim().min(1).max(500).nullable();

export const timeCanvasScopeDtoSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal(taskScopedTimeCanvasScopeKind),
      taskId: dtoIdSchema,
    })
    .strict(),
  z.object({ kind: z.enum(standaloneTimeCanvasScopeKindValues) }).strict(),
]);

export type TimeCanvasScopeDto = z.infer<typeof timeCanvasScopeDtoSchema>;

export const timeCanvasRangeDtoSchema = z
  .object({
    startAt: dtoAbsoluteDateTimeSchema,
    endAt: dtoAbsoluteDateTimeSchema,
  })
  .strict()
  .superRefine((range, ctx) => {
    if (new Date(range.endAt) <= new Date(range.startAt)) {
      ctx.addIssue({
        code: "custom",
        path: ["endAt"],
        message: "Canvas 区间必须采用非空半开区间 [start, end)",
      });
    }
  });

export type TimeCanvasRangeDto = z.infer<typeof timeCanvasRangeDtoSchema>;

const taskCapabilitiesDtoSchema = z
  .object({
    canView: z.boolean(),
    canUpdateMetadata: z.boolean(),
    canManageMembers: z.boolean(),
    canManageTags: z.boolean(),
    canActivate: z.boolean(),
    canArchive: z.boolean(),
    canCreateRevision: z.boolean(),
  })
  .strict();

export type TaskCapabilitiesDto = z.infer<typeof taskCapabilitiesDtoSchema>;

const nodeCapabilitiesDtoSchema = z
  .object({
    canView: z.boolean(),
    canEditDraft: z.boolean(),
    canCreateSegment: z.boolean(),
    canSubmitReview: z.boolean(),
    canReview: z.boolean(),
    canConfirmTermination: z.boolean(),
  })
  .strict();

export type NodeCapabilitiesDto = z.infer<typeof nodeCapabilitiesDtoSchema>;

export const segmentPermissionsDtoSchema = z
  .object({
    canViewDetails: z.boolean(),
    canEdit: z.boolean(),
    canMove: z.boolean(),
    canResize: z.boolean(),
    canSplit: z.boolean(),
    canMerge: z.boolean(),
    canCancel: z.boolean(),
    canConfirm: z.boolean(),
    canRelink: z.boolean(),
    canSoftDelete: z.boolean(),
  })
  .strict();

export type SegmentPermissionsDto = z.infer<
  typeof segmentPermissionsDtoSchema
>;

const conflictCapabilitiesDtoSchema = z
  .object({
    canAcknowledge: z.boolean(),
    canResolve: z.boolean(),
    canIgnore: z.boolean(),
    canPreviewSuggestion: z.boolean(),
    canApplySuggestion: z.boolean(),
  })
  .strict();

export type ConflictCapabilitiesDto = z.infer<
  typeof conflictCapabilitiesDtoSchema
>;

const rowCapabilitiesDtoSchema = z
  .object({
    canCreateSegment: z.boolean(),
  })
  .strict();

const timeCanvasRowFields = {
  id: dtoIdSchema,
  label: z.string().trim().min(1),
  sublabel: z.string().nullable(),
  capabilities: rowCapabilitiesDtoSchema,
} as const;

export const personTimeCanvasRowDtoSchema = z
  .object({
    kind: z.literal(personTimeCanvasGrouping),
    ...timeCanvasRowFields,
  })
  .strict();

export const taskTimeCanvasRowDtoSchema = z
  .object({
    kind: z.literal(taskTimeCanvasGrouping),
    ...timeCanvasRowFields,
  })
  .strict();

export const timeCanvasRowDtoSchema = z.discriminatedUnion("kind", [
  personTimeCanvasRowDtoSchema,
  taskTimeCanvasRowDtoSchema,
]);

export type TimeCanvasRowDto = z.infer<typeof timeCanvasRowDtoSchema>;

export const timeCanvasNodeAnchorDtoSchema = z
  .object({
    id: dtoIdSchema,
    taskId: dtoIdSchema,
    type: taskNodeTypeSchema,
    status: taskNodeStatusSchema,
    sequence: z.number().int().min(0),
    label: z.string().trim().min(1),
    plannedAt: dtoAbsoluteDateTimeSchema.nullable(),
    capabilities: nodeCapabilitiesDtoSchema,
    updatedAt: dtoAbsoluteDateTimeSchema,
    versionToken: dtoAbsoluteDateTimeSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.versionToken !== value.updatedAt) {
      ctx.addIssue({
        code: "custom",
        path: ["versionToken"],
        message: "Node 版本令牌必须等于 updatedAt",
      });
    }
  });

export type TimeCanvasNodeAnchorDto = z.infer<
  typeof timeCanvasNodeAnchorDtoSchema
>;

export const timeCanvasTaskAnchorDtoSchema = z
  .object({
    id: dtoIdSchema,
    title: z.string().trim().min(1),
    status: taskStatusSchema,
    priority: taskPrioritySchema,
    plannedStartAt: dtoAbsoluteDateTimeSchema.nullable(),
    capabilities: taskCapabilitiesDtoSchema,
    nodes: z.array(timeCanvasNodeAnchorDtoSchema),
    updatedAt: dtoAbsoluteDateTimeSchema,
    versionToken: dtoAbsoluteDateTimeSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.versionToken !== value.updatedAt) {
      ctx.addIssue({
        code: "custom",
        path: ["versionToken"],
        message: "Task 版本令牌必须等于 updatedAt",
      });
    }
  });

export type TimeCanvasTaskAnchorDto = z.infer<
  typeof timeCanvasTaskAnchorDtoSchema
>;

const segmentTagDtoSchema = z
  .object({
    id: dtoIdSchema,
    name: z.string(),
    color: z.string(),
  })
  .strict();

export const timeSegmentDtoSchema = z
  .object({
    kind: z.literal("SEGMENT"),
    visibility: z.literal("FULL"),
    id: dtoIdSchema,
    personId: dtoIdSchema,
    type: z.enum(workSegmentTypeValues),
    status: z.enum(workSegmentStatusValues),
    startAt: dtoAbsoluteDateTimeSchema,
    endAt: dtoAbsoluteDateTimeSchema,
    content: z.string(),
    allocation: z.number().gt(0).max(100).nullable(),
    role: z.enum(workSegmentRoleValues),
    customRole: z.string().nullable(),
    priority: taskPrioritySchema,
    expectedOutput: z.string(),
    actualOutput: z.string(),
    completionPercent: z.number().min(0).max(100).nullable(),
    taskId: dtoIdSchema.nullable(),
    nodeId: dtoIdSchema.nullable(),
    associationNeedsReview: z.boolean(),
    conflictIds: z.array(dtoIdSchema),
    tags: z.array(segmentTagDtoSchema),
    permissions: segmentPermissionsDtoSchema,
    updatedAt: dtoAbsoluteDateTimeSchema,
    versionToken: dtoAbsoluteDateTimeSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Date(value.endAt) <= new Date(value.startAt)) {
      ctx.addIssue({
        code: "custom",
        path: ["endAt"],
        message: "Segment 结束时间必须晚于开始时间",
      });
    }
    if (value.versionToken !== value.updatedAt) {
      ctx.addIssue({
        code: "custom",
        path: ["versionToken"],
        message: "Segment 版本令牌必须等于 updatedAt",
      });
    }
  });

export type TimeSegmentDto = z.infer<typeof timeSegmentDtoSchema>;

export const busyConflictSummaryDtoSchema = z
  .object({
    count: z.number().int().min(0),
    severity: conflictSeveritySchema.nullable(),
  })
  .strict();

export const busyBlockDtoSchema = z
  .object({
    kind: z.literal("BUSY"),
    visibility: z.literal("BUSY_ONLY"),
    personId: dtoIdSchema,
    startAt: dtoAbsoluteDateTimeSchema,
    endAt: dtoAbsoluteDateTimeSchema,
    allocation: z.number().gt(0).max(100).nullable(),
    conflictSummary: busyConflictSummaryDtoSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Date(value.endAt) <= new Date(value.startAt)) {
      ctx.addIssue({
        code: "custom",
        path: ["endAt"],
        message: "Busy 结束时间必须晚于开始时间",
      });
    }
  });

export const BUSY_BLOCK_DTO_FIELDS = [
  "kind",
  "visibility",
  "personId",
  "startAt",
  "endAt",
  "allocation",
  "conflictSummary",
] as const;

export type BusyBlockDto = z.infer<typeof busyBlockDtoSchema>;

const hiddenConflictCapabilitiesDtoSchema = z
  .object({
    canAcknowledge: z.literal(false),
    canResolve: z.literal(false),
    canIgnore: z.literal(false),
    canPreviewSuggestion: z.literal(false),
    canApplySuggestion: z.literal(false),
  })
  .strict();

export const hiddenTimeCanvasConflictDtoSchema = z
  .object({
    kind: z.literal("CONFLICT"),
    visibility: z.literal("HIDDEN"),
    severity: conflictSeveritySchema,
    hiddenSegmentCount: z.number().int().min(1),
    capabilities: hiddenConflictCapabilitiesDtoSchema,
  })
  .strict();

export type HiddenTimeCanvasConflictDto = z.infer<
  typeof hiddenTimeCanvasConflictDtoSchema
>;

export const visibleTimeCanvasConflictDtoSchema = z
  .object({
    kind: z.literal("CONFLICT"),
    visibility: z.literal("VISIBLE"),
    id: dtoIdSchema,
    personId: dtoIdSchema,
    conflictKind: conflictKindSchema,
    startAt: dtoAbsoluteDateTimeSchema,
    endAt: dtoAbsoluteDateTimeSchema,
    severity: conflictSeveritySchema,
    status: conflictStatusSchema,
    hiddenSegmentCount: z.number().int().min(0),
    capabilities: conflictCapabilitiesDtoSchema,
    updatedAt: dtoAbsoluteDateTimeSchema,
    versionToken: dtoAbsoluteDateTimeSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Date(value.endAt) <= new Date(value.startAt)) {
      ctx.addIssue({
        code: "custom",
        path: ["endAt"],
        message: "Conflict 结束时间必须晚于开始时间",
      });
    }
    if (value.versionToken !== value.updatedAt) {
      ctx.addIssue({
        code: "custom",
        path: ["versionToken"],
        message: "Conflict 版本令牌必须等于 updatedAt",
      });
    }
  });

export type VisibleTimeCanvasConflictDto = z.infer<
  typeof visibleTimeCanvasConflictDtoSchema
>;

export const timeCanvasConflictDtoSchema = z.union([
  visibleTimeCanvasConflictDtoSchema,
  hiddenTimeCanvasConflictDtoSchema,
]);

export type TimeCanvasConflictDto = z.infer<
  typeof timeCanvasConflictDtoSchema
>;

export const personOptionDtoSchema = z
  .object({
    id: dtoIdSchema,
    displayName: z.string().trim().min(1),
    avatar: z.string().nullable(),
    status: z.literal("ACTIVE"),
  })
  .strict();

export const personOptionPageSchema = z
  .object({
    items: z.array(personOptionDtoSchema),
    nextCursor: pageCursorSchema,
  })
  .strict();

export type PersonOptionPage = z.infer<typeof personOptionPageSchema>;

const taskOptionPermissionDtoSchema = z
  .object({
    canView: z.boolean(),
  })
  .strict();

const activeMilestoneOptionDtoSchema = z
  .object({
    nodeId: dtoIdSchema,
    goal: z.string(),
    expectedCompletedAt: dtoAbsoluteDateTimeSchema,
  })
  .strict();

export const taskOptionDtoSchema = z
  .object({
    id: dtoIdSchema,
    title: z.string().trim().min(1),
    status: taskStatusSchema,
    priority: taskPrioritySchema,
    activeMilestone: activeMilestoneOptionDtoSchema.nullable(),
    permission: taskOptionPermissionDtoSchema,
  })
  .strict();

export const taskOptionPageSchema = z
  .object({
    items: z.array(taskOptionDtoSchema),
    nextCursor: pageCursorSchema,
  })
  .strict();

export type TaskOptionPage = z.infer<typeof taskOptionPageSchema>;

export const tagOptionDtoSchema = z
  .object({
    id: dtoIdSchema,
    name: z.string().trim().min(1),
    color: z.string(),
    isArchived: z.boolean(),
  })
  .strict();

export const tagOptionPageSchema = z
  .object({
    items: z.array(tagOptionDtoSchema),
    nextCursor: pageCursorSchema,
  })
  .strict();

export type TagOptionPage = z.infer<typeof tagOptionPageSchema>;

const timeCanvasDataCommonFields = {
  scope: timeCanvasScopeDtoSchema,
  timezone: z.string().trim().min(1),
  range: timeCanvasRangeDtoSchema,
  anchors: z.array(timeCanvasTaskAnchorDtoSchema),
  conflicts: z.array(timeCanvasConflictDtoSchema),
  nextCursor: pageCursorSchema,
  generatedAt: dtoAbsoluteDateTimeSchema,
} as const;

const personGroupedTimeCanvasDataDtoSchema = z
  .object({
    ...timeCanvasDataCommonFields,
    groupBy: z.literal(personTimeCanvasGrouping),
    rows: z.array(personTimeCanvasRowDtoSchema),
    /** Complete authorized result; producers reject above the visible limit. */
    segments: z.array(z.union([timeSegmentDtoSchema, busyBlockDtoSchema])),
  })
  .strict();

const taskGroupedTimeCanvasDataDtoSchema = z
  .object({
    ...timeCanvasDataCommonFields,
    groupBy: z.literal(taskTimeCanvasGrouping),
    rows: z.array(taskTimeCanvasRowDtoSchema),
    /** Busy blocks cannot be attributed to Task rows without leaking taskId. */
    segments: z.array(timeSegmentDtoSchema),
  })
  .strict();

export const timeCanvasDataDtoSchema = z
  .discriminatedUnion("groupBy", [
    personGroupedTimeCanvasDataDtoSchema,
    taskGroupedTimeCanvasDataDtoSchema,
  ])
  .superRefine((value, ctx) => {
    const rowKeys = new Set<string>();
    value.rows.forEach((row, index) => {
      const key = `${row.kind}:${row.id}`;
      if (rowKeys.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["rows", index, "id"],
          message: "同一画布页不能重复返回相同 kind 和 id 的行",
        });
      }
      rowKeys.add(key);
    });

    const anchorIds = new Set<string>();
    value.anchors.forEach((anchor, anchorIndex) => {
      if (anchorIds.has(anchor.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["anchors", anchorIndex, "id"],
          message: "同一画布页不能重复返回相同 Task anchor",
        });
      }
      anchorIds.add(anchor.id);
      anchor.nodes.forEach((node, nodeIndex) => {
        if (node.taskId !== anchor.id) {
          ctx.addIssue({
            code: "custom",
            path: ["anchors", anchorIndex, "nodes", nodeIndex, "taskId"],
            message: "Node 的 taskId 必须等于父 Task anchor 的 id",
          });
        }
      });
    });

    const responseRangeStart = Date.parse(value.range.startAt);
    const responseRangeEnd = Date.parse(value.range.endAt);
    value.segments.forEach((segment, index) => {
      const segmentStart = Date.parse(segment.startAt);
      const segmentEnd = Date.parse(segment.endAt);
      if (
        !(segmentStart < responseRangeEnd && segmentEnd > responseRangeStart)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["segments", index],
          message: "Segment 或 Busy 必须与响应半开区间相交",
        });
      }
    });

    if (value.groupBy === personTimeCanvasGrouping) {
      const currentPersonIds = new Set(value.rows.map((row) => row.id));
      value.segments.forEach((segment, index) => {
        if (!currentPersonIds.has(segment.personId)) {
          ctx.addIssue({
            code: "custom",
            path: ["segments", index, "personId"],
            message: "按人员分组时对象必须属于当前 Person 行分页",
          });
        }
      });
      value.conflicts.forEach((conflict, index) => {
        if (
          conflict.visibility === "VISIBLE" &&
          !currentPersonIds.has(conflict.personId)
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["conflicts", index, "personId"],
            message: "可见 Conflict 必须属于当前 Person 行分页",
          });
        }
      });
      return;
    }

    const currentTaskIds = new Set(value.rows.map((row) => row.id));
    value.segments.forEach((segment, index) => {
      if (segment.taskId === null || !currentTaskIds.has(segment.taskId)) {
        ctx.addIssue({
          code: "custom",
          path: ["segments", index, "taskId"],
          message: "按 Task 分组时对象必须属于当前 Task 行分页",
        });
      }
    });
    value.anchors.forEach((anchor, index) => {
      if (!currentTaskIds.has(anchor.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["anchors", index, "id"],
          message: "按 Task 分组时 anchor 必须属于当前 Task 行分页",
        });
      }
    });
  });

export type TimeCanvasDataDto = z.infer<typeof timeCanvasDataDtoSchema>;

export const visibleSegmentPlacementConflictDtoSchema = z
  .object({
    kind: z.literal("PLACEMENT_CONFLICT"),
    visibility: z.literal("VISIBLE"),
    reason: conflictKindSchema,
    severity: conflictSeveritySchema,
    range: timeCanvasRangeDtoSchema,
  })
  .strict();

export type VisibleSegmentPlacementConflictDto = z.infer<
  typeof visibleSegmentPlacementConflictDtoSchema
>;

export const hiddenSegmentPlacementConflictDtoSchema = z
  .object({
    kind: z.literal("PLACEMENT_CONFLICT"),
    visibility: z.literal("HIDDEN"),
    blocked: z.literal(true),
  })
  .strict();

export type HiddenSegmentPlacementConflictDto = z.infer<
  typeof hiddenSegmentPlacementConflictDtoSchema
>;

export const segmentPlacementConflictDtoSchema = z.discriminatedUnion(
  "visibility",
  [
    visibleSegmentPlacementConflictDtoSchema,
    hiddenSegmentPlacementConflictDtoSchema,
  ],
);

export type SegmentPlacementConflictDto = z.infer<
  typeof segmentPlacementConflictDtoSchema
>;

export const segmentPlacementPreviewDtoSchema = z
  .object({
    personId: dtoIdSchema,
    range: timeCanvasRangeDtoSchema,
    allocation: z.number().gt(0).max(100).nullable(),
    conflicts: z.array(segmentPlacementConflictDtoSchema),
    generatedAt: dtoAbsoluteDateTimeSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const hiddenConflictIndexes = value.conflicts
      .map((conflict, index) =>
        conflict.visibility === "HIDDEN" ? index : null,
      )
      .filter((index): index is number => index !== null);
    if (hiddenConflictIndexes.length > 1) {
      ctx.addIssue({
        code: "custom",
        path: ["conflicts", hiddenConflictIndexes[1] ?? 0],
        message: "隐藏 placement 命中必须聚合为单一通用 indicator",
      });
    }
  });

export type SegmentPlacementPreviewDto = z.infer<
  typeof segmentPlacementPreviewDtoSchema
>;
