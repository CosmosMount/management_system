"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { appOriginFromHeaders } from "@/lib/app-origin";
import { exportMeetingMinutes } from "@/lib/project-management/meetings/export";
import { getCurrentProjectManagementActor } from "@/lib/project-management/identity";
import { runProjectManagementAction } from "@/lib/project-management/application/action-result";
import { createMeeting, updateMeeting } from "@/lib/project-management/meetings/service";
import { getMeetingTimeline } from "@/lib/project-management/meetings/timeline";
import { drainNotificationOutboxSoon } from "@/lib/notification-delivery";
import { listMeetingMissingPeople, urgeMeetingWorkSegments } from "@/lib/project-management/application/meeting-urge-service";
import { routes } from "@/lib/routes";

export async function exportMeetingMinutesAction(input: unknown) {
  return runProjectManagementAction({ event: "pm.meeting.export", action: "exportMeetingMinutes", callback: async (context) => {
    const actor = await getCurrentProjectManagementActor();
    context.setActorAccountId(actor.accountId);
    return exportMeetingMinutes(actor, input, appOriginFromHeaders(await headers()));
  } });
}

export async function createMeetingAction(input: unknown) {
  return runProjectManagementAction({ event: "pm.meeting.create", action: "createMeeting", callback: async (context) => {
    const actor = await getCurrentProjectManagementActor();
    context.setActorAccountId(actor.accountId);
    const meeting = await createMeeting(actor, input);
    revalidatePath(routes.progress.meetings);
    return meeting;
  } });
}

export async function updateMeetingAction(input: unknown) {
  return runProjectManagementAction({ event: "pm.meeting.update", action: "updateMeeting", callback: async (context) => {
    const actor = await getCurrentProjectManagementActor();
    context.setActorAccountId(actor.accountId);
    const meeting = await updateMeeting(actor, input);
    revalidatePath(routes.progress.meetings);
    revalidatePath(routes.progress.meetingDetail(meeting.id));
    return meeting;
  } });
}

export async function getMeetingTimelineAction(input: unknown) {
  return runProjectManagementAction({ event: "pm.meeting.timeline", action: "getMeetingTimeline", callback: async (context) => {
    const actor = await getCurrentProjectManagementActor();
    context.setActorAccountId(actor.accountId);
    return getMeetingTimeline(actor, input);
  } });
}

export async function listMeetingMissingPeopleAction(input: unknown) {
  return runProjectManagementAction({ event: "pm.meeting.missing_people", action: "listMeetingMissingPeople", callback: async (context) => {
    const actor = await getCurrentProjectManagementActor();
    context.setActorAccountId(actor.accountId);
    return listMeetingMissingPeople(actor, input);
  } });
}

export async function urgeMeetingWorkSegmentsAction(input: unknown) {
  return runProjectManagementAction({ event: "pm.meeting.work_segment_reminder", action: "urgeMeetingWorkSegments", callback: async (context) => {
    const actor = await getCurrentProjectManagementActor();
    context.setActorAccountId(actor.accountId);
    const result = await urgeMeetingWorkSegments(actor, input);
    drainNotificationOutboxSoon();
    return result;
  } });
}
