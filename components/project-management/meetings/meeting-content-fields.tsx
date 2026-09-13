"use client";

import type { ReactNode } from "react";
import { UserMultiSelect } from "@/components/project-management/user-picker";
import { ProjectMultiSelect } from "@/components/project-management/project-picker";
import { TaskMultiSelect } from "@/components/project-management/task-picker";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { FieldError } from "@/components/ui/field-error";
import type { MeetingDto } from "@/lib/project-management/meetings/service";
import type { MeetingContent } from "@/lib/project-management/meetings/template-validation";

export function MeetingContentFields({ value, onChange, participants, disabled, errors, afterPeople, beforeMinutes }: {
  value: MeetingContent;
  onChange: (value: MeetingContent) => void;
  participants?: MeetingDto["participants"];
  disabled: boolean;
  errors: Record<string, string[]>;
  afterPeople?: ReactNode;
  beforeMinutes?: ReactNode;
}) {
  return <>
    <div className="space-y-2"><Label htmlFor="meeting-topic">会议主题</Label><Input id="meeting-topic" value={value.topic} maxLength={200} required aria-invalid={Boolean(errors.topic)} aria-describedby="meeting-topic-error" onChange={(event) => onChange({ ...value, topic: event.target.value })} /><FieldError id="meeting-topic-error" messages={errors.topic} /></div>
    <div className="space-y-2"><Label htmlFor="meeting-people">参与人</Label><UserMultiSelect inputId="meeting-people" ariaLabel="会议参与人" scope={{ purpose: "VISIBLE" }} value={value.personIds} onValueChange={(personIds) => onChange({ ...value, personIds })} initialOptions={participants} disabled={disabled} maxSelected={50} invalid={Boolean(errors.personIds)} ariaDescribedBy="meeting-people-error" /><FieldError id="meeting-people-error" messages={errors.personIds} /></div>
    {afterPeople}
    <div className="space-y-2"><Label htmlFor="meeting-projects">展示项目</Label><ProjectMultiSelect inputId="meeting-projects" ariaLabel="展示项目" disabled={disabled} value={value.timelineDisplay.projectIds} onValueChange={(projectIds) => onChange({ ...value, timelineDisplay: { ...value.timelineDisplay, projectIds } })} invalid={Boolean(errors["timelineDisplay.projectIds"] || errors.timelineDisplay)} ariaDescribedBy="meeting-projects-error" /><FieldError id="meeting-projects-error" messages={errors["timelineDisplay.projectIds"] ?? errors.timelineDisplay} /></div>
    <div className="space-y-2"><Label htmlFor="meeting-tasks">展示任务</Label><TaskMultiSelect inputId="meeting-tasks" ariaLabel="展示任务" disabled={disabled} mine={false} value={value.timelineDisplay.taskIds} onValueChange={(taskIds) => onChange({ ...value, timelineDisplay: { ...value.timelineDisplay, taskIds } })} invalid={Boolean(errors["timelineDisplay.taskIds"])} ariaDescribedBy="meeting-tasks-error" /><FieldError id="meeting-tasks-error" messages={errors["timelineDisplay.taskIds"]} /></div>
    <p className="text-sm text-muted-foreground">可选，仅用于展示时间线，不改变项目、任务或会议参与人。项目内的任务、计划和工作记录随原数据更新。</p>
    {beforeMinutes}
    <div className="space-y-2"><Label htmlFor="meeting-minutes">会议纪要</Label><Textarea id="meeting-minutes" className="min-h-56" value={value.minutes} maxLength={50_000} aria-invalid={Boolean(errors.minutes)} aria-describedby="meeting-minutes-error" placeholder="记录讨论内容、结论和后续事项，可稍后补充" onChange={(event) => onChange({ ...value, minutes: event.target.value })} /><FieldError id="meeting-minutes-error" messages={errors.minutes} /></div>
  </>;
}
