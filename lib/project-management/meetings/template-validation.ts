import { z } from "zod";
import { idSchema } from "@/lib/project-management/validations/lifecycle";
import { meetingContentSchema } from "./validation";

export const meetingTemplateFieldsSchema = meetingContentSchema.extend({
  name: z.string().trim().min(1, "请输入模板名称").max(100, "模板名称不能超过 100 字"),
  description: z.string().trim().max(500, "模板说明不能超过 500 字").default(""),
});
export const createMeetingTemplateSchema = meetingTemplateFieldsSchema.extend({ requestId: idSchema });
export const meetingTemplateIdSchema = z.object({ templateId: idSchema }).strict();
export const deleteMeetingTemplateSchema = meetingTemplateIdSchema.extend({ expectedVersion: z.number().int().nonnegative() });
export const updateMeetingTemplateSchema = meetingTemplateFieldsSchema.extend(deleteMeetingTemplateSchema.shape);
export const listMeetingTemplatesSchema = z.object({
  cursor: z.object({ id: idSchema, updatedAt: z.string().datetime({ offset: true }) }).strict().optional(),
}).strict();

export type MeetingContent = {
  topic: string;
  personIds: string[];
  minutes: string;
  timelineDisplay: { projectIds: string[]; taskIds: string[] };
};

export function copyMeetingTemplateContent(template: MeetingContent): MeetingContent {
  return {
    topic: template.topic,
    minutes: template.minutes,
    personIds: [...template.personIds],
    timelineDisplay: {
      projectIds: [...template.timelineDisplay.projectIds],
      taskIds: [...template.timelineDisplay.taskIds],
    },
  };
}
