import { z } from "zod";
import {
  MAX_GLOBAL_TIME_MARKER_MS,
  MIN_GLOBAL_TIME_MARKER_MS,
} from "@/lib/project-management/time-canvas/time-math";

export const MAX_GLOBAL_TIME_MARKERS = 200;
export const MAX_GLOBAL_TIME_MARKER_NAME_LENGTH = 100;

const absoluteDateTimeSchema = z
  .string({ message: "关键时间点格式不正确" })
  .datetime({ offset: true, message: "关键时间点格式不正确" });

const markedAtSchema = absoluteDateTimeSchema.refine((value) => {
  const timeMs = Date.parse(value);
  return timeMs >= MIN_GLOBAL_TIME_MARKER_MS && timeMs <= MAX_GLOBAL_TIME_MARKER_MS;
}, "关键时间点必须在公元 1 年至 9999 年的可显示范围内");

export const globalTimeMarkerSnapshotItemSchema = z
  .object({
    id: z.string().uuid("关键时间点 ID 不正确"),
    name: z
      .string({ message: "请输入关键时间点名称" })
      .trim()
      .min(1, "请输入关键时间点名称")
      .max(
        MAX_GLOBAL_TIME_MARKER_NAME_LENGTH,
        `关键时间点名称不能超过 ${MAX_GLOBAL_TIME_MARKER_NAME_LENGTH} 个字符`,
      ),
    markedAt: markedAtSchema,
    updatedAt: absoluteDateTimeSchema.optional(),
    versionToken: absoluteDateTimeSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.updatedAt && value.updatedAt !== value.versionToken) {
      ctx.addIssue({
        code: "custom",
        path: ["versionToken"],
        message: "关键时间点版本令牌必须等于 updatedAt",
      });
    }
  });

export const saveGlobalTimeMarkersInputSchema = z
  .object({
    expectedCollectionVersion: z
      .string({ message: "关键时间点集合版本不正确" })
      .regex(/^[a-f0-9]{64}$/, "关键时间点集合版本不正确"),
    markers: z
      .array(globalTimeMarkerSnapshotItemSchema)
      .max(
        MAX_GLOBAL_TIME_MARKERS,
        `关键时间点不能超过 ${MAX_GLOBAL_TIME_MARKERS} 个`,
      ),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    value.markers.forEach((marker, index) => {
      if (ids.has(marker.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["markers", index, "id"],
          message: "同一个关键时间点不能重复提交",
        });
      }
      ids.add(marker.id);
    });
  });

export type SaveGlobalTimeMarkersInput = z.infer<
  typeof saveGlobalTimeMarkersInputSchema
>;
