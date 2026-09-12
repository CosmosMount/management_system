import { z } from "zod";
import { absoluteDateTimeSchema, idSchema } from "@/lib/project-management/validations/lifecycle";
import { MAX_TIME_CANVAS_RANGE_DAYS } from "@/lib/project-management/validations/time-canvas";

const rangeFields = {
  rangeStart: absoluteDateTimeSchema("请选择有效的工作开始时间"),
  rangeEnd: absoluteDateTimeSchema("请选择有效的工作结束时间"),
};
const personIds = z.array(idSchema).min(1, "请至少选择一位参与人").max(50, "参与人不能超过 50 位")
  .refine((values) => new Set(values).size === values.length, "参与人不能重复");

const displayIds = (label: string) => z.array(idSchema)
  .max(50, `展示${label}不能超过 50 个`)
  .transform((ids) => [...new Set(ids)].sort());

export const meetingTimelineDisplaySchema = z.object({
  projectIds: displayIds("项目"),
  taskIds: displayIds("任务"),
}).strict();

export type MeetingTimelineDisplay = z.infer<typeof meetingTimelineDisplaySchema>;

function validateRange(value: { rangeStart: Date; rangeEnd: Date }, context: z.RefinementCtx) {
  if (!(value.rangeStart instanceof Date) || !(value.rangeEnd instanceof Date)) return;
  if (value.rangeEnd <= value.rangeStart) {
    context.addIssue({ code: "custom", path: ["rangeEnd"], message: "工作结束时间必须晚于开始时间" });
  } else if (value.rangeEnd.getTime() - value.rangeStart.getTime() > MAX_TIME_CANVAS_RANGE_DAYS * 86_400_000) {
    context.addIssue({ code: "custom", path: ["rangeEnd"], message: "工作时间范围不能超过 366 天" });
  }
}

export const meetingFieldsSchema = z.object({
  topic: z.string().trim().min(1, "请输入会议主题").max(200, "会议主题不能超过 200 字"),
  personIds,
  ...rangeFields,
  minutes: z.string().max(50_000, "会议纪要不能超过 50000 字").default(""),
  timelineDisplay: meetingTimelineDisplaySchema.optional(),
}).strict().superRefine(validateRange);

export const updateMeetingSchema = meetingFieldsSchema.safeExtend({
  meetingId: idSchema,
  expectedVersion: z.number().int().nonnegative(),
});

export const createMeetingSchema = meetingFieldsSchema.safeExtend({ requestId: idSchema });

export const meetingIdSchema = z.object({ meetingId: idSchema }).strict();
export const meetingPeopleFilterSchema = z.object({
  query: z.string().trim().max(200).default(""),
  cursor: idSchema.optional(),
  ids: z.array(idSchema).max(50).optional(),
}).strict();
export const meetingListCursorSchema = z.object({
  version: z.literal(1),
  id: idSchema,
  at: z.string().datetime({ offset: true }),
  asOf: z.string().datetime({ offset: true }),
  filterKey: z.string().max(2048),
}).strict();

export function parseMeetingListCursor(value: string) {
  try {
    const parsed = meetingListCursorSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const listMeetingsSchema = z.object({
  query: z.string().trim().max(200, "搜索内容不能超过 200 字").default(""),
  personId: idSchema.optional(),
  dateFrom: z.string().date("请选择有效的开始日期").optional(),
  dateTo: z.string().date("请选择有效的结束日期").optional(),
  period: z.enum(["all", "7", "30", "90", "custom"]).default("all"),
  projectId: z.union([idSchema, z.literal("none")]).optional(),
  taskId: z.union([idSchema, z.literal("none")]).optional(),
  mine: z.boolean().default(false),
  sort: z.enum(["createdAt", "updatedAt", "rangeStart"]).default("createdAt"),
  cursor: z.string().max(4096).refine((value) => idSchema.safeParse(value).success || parseMeetingListCursor(value) !== null, "分页参数不正确，请重新筛选").optional(),
}).strict().superRefine((value, context) => {
  if (value.period !== "custom" && (value.dateFrom || value.dateTo)) {
    context.addIssue({ code: "custom", path: ["period"], message: "填写日期时请选择自定义工作区间" });
  }
  if (value.period === "custom" && !value.dateFrom && !value.dateTo) {
    context.addIssue({ code: "custom", path: ["dateFrom"], message: "请至少选择一个日期" });
  }
  if (value.dateFrom && value.dateTo && value.dateFrom > value.dateTo) {
    context.addIssue({ code: "custom", path: ["dateTo"], message: "结束日期不能早于开始日期" });
  }
});

export const meetingTimelineSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("SAVED"), meetingId: idSchema, ...rangeFields }).strict(),
  z.object({ kind: z.literal("PREVIEW"), personIds, timelineDisplay: meetingTimelineDisplaySchema.optional(), ...rangeFields }).strict(),
]).superRefine(validateRange);

export type MeetingFields = z.input<typeof meetingFieldsSchema>;
export type MeetingTimelineInput = z.input<typeof meetingTimelineSchema>;
