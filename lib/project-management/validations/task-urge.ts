import { z } from "zod";

export const TASK_URGE_COOLDOWN_MS = 5 * 60 * 1000;
export const TASK_URGE_DEFAULT_MESSAGE = "请关注该任务的当前进展，并及时跟进。";

export const urgeTaskInputSchema = z.object({
  taskId: z.string().uuid("任务标识无效"),
  message: z.string().trim().max(500, "催促信息最多 500 字").default(""),
  requestId: z.string().uuid("请求标识无效，请重新打开弹窗"),
}).strict();
