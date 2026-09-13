import { z } from "zod";

export const approvalUrgeInputSchema = z.object({
  kind: z.enum(["MILESTONE_REVIEW", "REVISION", "TERMINATION_REVIEW"]),
  approvalId: z.string().uuid("审批标识无效"),
  recipientAccountIds: z.array(z.string().uuid("审批人标识无效")).min(1, "至少选择一名审批人"),
  requestId: z.string().uuid("请求标识无效，请重新打开弹窗"),
}).strict();
