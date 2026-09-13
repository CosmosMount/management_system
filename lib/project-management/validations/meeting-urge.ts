import { z } from "zod";

export const meetingUrgeInputSchema = z.object({
  requestId: z.string().uuid("请求标识无效"),
  expectedVersion: z.number().int().nonnegative(),
  meetingId: z.string().uuid("会议标识无效"),
  recipientPersonIds: z.array(z.string().uuid("收件人标识无效")).min(1, "请至少选择一名参会人员").max(50, "收件人不能超过 50 人"),
}).strict();

export const meetingUrgeQuerySchema = z.object({ meetingId: z.string().uuid("会议标识无效") }).strict();
