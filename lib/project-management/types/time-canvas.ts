import {
  personTimeCanvasGrouping,
  standaloneTimeCanvasScopeKindValues,
  taskScopedTimeCanvasScopeKind,
  taskTimeCanvasGrouping,
  taskNodeStatusValues,
  taskNodeTypeValues,
  taskPriorityValues,
  taskStatusValues,
} from "@/lib/project-management/types/contract-values";
import { z } from "zod";

const dtoIdSchema = z.string().uuid();
const dtoAbsoluteDateTimeSchema = z.string().datetime({ offset: true });
export const currentNodeDeadlineDtoSchema = z.object({
  nodeId: dtoIdSchema,
  nodeType: z.enum(["MILESTONE", "TERMINATION"]),
  dueAt: dtoAbsoluteDateTimeSchema,
}).strict();
const taskStatusSchema = z.enum(taskStatusValues);
const taskPrioritySchema = z.enum(taskPriorityValues);
const taskNodeTypeSchema = z.enum(taskNodeTypeValues);
const taskNodeStatusSchema = z.enum(taskNodeStatusValues);
const pageCursorSchema = z.string().trim().min(1).max(500).nullable();

export const globalTimeMarkerDtoSchema = z
  .object({
    id: dtoIdSchema,
    name: z.string().trim().min(1).max(100),
    markedAt: dtoAbsoluteDateTimeSchema,
    updatedAt: dtoAbsoluteDateTimeSchema,
    versionToken: dtoAbsoluteDateTimeSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.versionToken !== value.updatedAt) {
      ctx.addIssue({
        code: "custom",
        path: ["versionToken"],
        message: "关键时间点版本令牌必须等于 updatedAt",
      });
    }
  });

export type GlobalTimeMarkerDto = z.infer<typeof globalTimeMarkerDtoSchema>;

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
    canSubmitTerminationReview: z.boolean(),
  })
  .strict();

export type NodeCapabilitiesDto = z.infer<typeof nodeCapabilitiesDtoSchema>;

export const segmentPermissionsDtoSchema = z
  .object({
    canViewDetails: z.boolean(),
    canEdit: z.boolean(),
    canMove: z.boolean(),
    canResize: z.boolean(),
    canSoftDelete: z.boolean(),
  })
  .strict();

export type SegmentPermissionsDto = z.infer<
  typeof segmentPermissionsDtoSchema
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

const timeCanvasProjectDtoSchema = z.object({
  id: dtoIdSchema,
  name: z.string().trim().min(1),
}).strict();

export const taskTimeCanvasRowDtoSchema = z
  .object({
    kind: z.literal(taskTimeCanvasGrouping),
    project: timeCanvasProjectDtoSchema.nullish(),
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
    currentNodeDeadline: currentNodeDeadlineDtoSchema.nullable(),
    id: dtoIdSchema,
    title: z.string().trim().min(1),
    project: timeCanvasProjectDtoSchema.nullish(),
    status: taskStatusSchema,
    priority: taskPrioritySchema,
    createdAt: dtoAbsoluteDateTimeSchema,
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

export const timeSegmentDtoSchema = z
  .object({
    kind: z.literal("SEGMENT"),
    visibility: z.literal("FULL"),
    id: dtoIdSchema,
    personId: dtoIdSchema,
    type: z.literal("WORK"),
    startAt: dtoAbsoluteDateTimeSchema,
    endAt: dtoAbsoluteDateTimeSchema,
    content: z.string(),
    taskId: dtoIdSchema.nullable(),
    taskTitle: z.string().trim().min(1).nullable(),
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

export const busyBlockDtoSchema = z
  .object({
    kind: z.literal("BUSY"),
    visibility: z.literal("BUSY_ONLY"),
    personId: dtoIdSchema,
    startAt: dtoAbsoluteDateTimeSchema,
    endAt: dtoAbsoluteDateTimeSchema,
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
] as const;

export type BusyBlockDto = z.infer<typeof busyBlockDtoSchema>;

export const personAccountBindingValues = ["UNBOUND", "BOUND"] as const;

export const personOptionDtoSchema = z
  .object({
    id: dtoIdSchema,
    displayName: z.string().trim().min(1),
    avatar: z.string().nullable(),
    status: z.enum(["ACTIVE", "INACTIVE"]),
    accountBinding: z.enum(personAccountBindingValues),
  })
  .strict();

export type PersonOptionDto = z.infer<typeof personOptionDtoSchema>;

export const personOptionPageSchema = z
  .object({
    items: z.array(personOptionDtoSchema),
    nextCursor: pageCursorSchema,
    hasMoreByQuery: z.boolean().optional().default(false),
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

const activeTerminationOptionDtoSchema = z
  .object({
    nodeId: dtoIdSchema,
    name: z.string(),
    plannedAt: dtoAbsoluteDateTimeSchema,
  })
  .strict();

export const taskOptionDtoSchema = z
  .object({
    currentNodeDeadline: currentNodeDeadlineDtoSchema.nullable(),
    id: dtoIdSchema,
    title: z.string().trim().min(1),
    status: taskStatusSchema,
    priority: taskPrioritySchema,
    team: z.string(),
    techGroup: z.string(),
    activeMilestone: activeMilestoneOptionDtoSchema.nullable(),
    activeTermination: activeTerminationOptionDtoSchema.nullable(),
    currentPlanVersionNo: z.number().int().positive(),
    permission: taskOptionPermissionDtoSchema,
  })
  .strict();

export const taskOptionPageSchema = z
  .object({
    items: z.array(taskOptionDtoSchema),
    nextCursor: pageCursorSchema,
    hasMoreByQuery: z.boolean().optional().default(false),
  })
  .strict();

export type TaskOptionPage = z.infer<typeof taskOptionPageSchema>;

const timeCanvasDataCommonFields = {
  scope: timeCanvasScopeDtoSchema,
  timezone: z.string().trim().min(1),
  range: timeCanvasRangeDtoSchema,
  rowPageKey: z.string().trim().min(1).max(100).default("legacy"),
  anchors: z.array(timeCanvasTaskAnchorDtoSchema),
  globalMarkers: z.array(globalTimeMarkerDtoSchema).max(200).default([]),
  generatedAt: dtoAbsoluteDateTimeSchema,
} as const;

const personGroupedTimeCanvasDataDtoSchema = z
  .object({
    ...timeCanvasDataCommonFields,
    groupBy: z.literal(personTimeCanvasGrouping),
    rows: z.array(personTimeCanvasRowDtoSchema),
    /** Complete authorized page; Full plus Busy objects share the 5,000 limit. */
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
          message: "同一画布不能重复返回相同 kind 和 id 的行",
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
          message: "同一画布不能重复返回相同 Task anchor",
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

    const globalMarkerIds = new Set<string>();
    value.globalMarkers.forEach((marker, index) => {
      if (globalMarkerIds.has(marker.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["globalMarkers", index, "id"],
          message: "同一画布不能重复返回相同关键时间点",
        });
      }
      globalMarkerIds.add(marker.id);
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
            message: "按人员分组时对象必须属于当前 Person 行集合",
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
          message: "按 Task 分组时对象必须属于当前 Task 行集合",
        });
      }
    });
    value.anchors.forEach((anchor, index) => {
      if (!currentTaskIds.has(anchor.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["anchors", index, "id"],
          message: "按 Task 分组时 anchor 必须属于当前 Task 行集合",
        });
      }
    });
  });

export type TimeCanvasDataDto = z.infer<typeof timeCanvasDataDtoSchema>;
