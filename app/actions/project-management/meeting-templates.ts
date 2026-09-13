"use server";

import { revalidatePath } from "next/cache";
import { getCurrentProjectManagementActor } from "@/lib/project-management/identity";
import { runProjectManagementAction } from "@/lib/project-management/application/action-result";
import { createMeetingTemplate, deleteMeetingTemplate, getMeetingTemplate, listMeetingTemplates, updateMeetingTemplate } from "@/lib/project-management/meetings/template-service";
import { routes } from "@/lib/routes";

export async function listMeetingTemplatesAction(input: unknown) {
  return runProjectManagementAction({ event: "pm.meeting_template.list", action: "listMeetingTemplates", callback: async (context) => {
    const actor = await getCurrentProjectManagementActor();
    context.setActorAccountId(actor.accountId);
    return listMeetingTemplates(actor, input);
  } });
}

export async function getMeetingTemplateAction(input: unknown) {
  return runProjectManagementAction({ event: "pm.meeting_template.get", action: "getMeetingTemplate", callback: async (context) => {
    const actor = await getCurrentProjectManagementActor();
    context.setActorAccountId(actor.accountId);
    return getMeetingTemplate(actor, input);
  } });
}

export async function createMeetingTemplateAction(input: unknown) {
  return runProjectManagementAction({ event: "pm.meeting_template.create", action: "createMeetingTemplate", callback: async (context) => {
    const actor = await getCurrentProjectManagementActor();
    context.setActorAccountId(actor.accountId);
    const result = await createMeetingTemplate(actor, input);
    revalidatePath(routes.progress.meetings);
    return result;
  } });
}

export async function updateMeetingTemplateAction(input: unknown) {
  return runProjectManagementAction({ event: "pm.meeting_template.update", action: "updateMeetingTemplate", callback: async (context) => {
    const actor = await getCurrentProjectManagementActor();
    context.setActorAccountId(actor.accountId);
    const result = await updateMeetingTemplate(actor, input);
    revalidatePath(routes.progress.meetings);
    revalidatePath(routes.progress.meetingTemplateEdit(result.id));
    return result;
  } });
}

export async function deleteMeetingTemplateAction(input: unknown) {
  return runProjectManagementAction({ event: "pm.meeting_template.delete", action: "deleteMeetingTemplate", callback: async (context) => {
    const actor = await getCurrentProjectManagementActor();
    context.setActorAccountId(actor.accountId);
    const result = await deleteMeetingTemplate(actor, input);
    revalidatePath(routes.progress.meetings);
    revalidatePath(routes.progress.meetingTemplateEdit(result.id));
    return result;
  } });
}
