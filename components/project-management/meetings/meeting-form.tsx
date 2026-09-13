"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createMeetingAction, updateMeetingAction } from "@/app/actions/project-management/meetings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldError } from "@/components/ui/field-error";
import { isoToShanghaiDateTimeLocal, shanghaiDateTimeLocalToIso } from "@/lib/project-management/date-time";
import { meetingFieldsSchema, meetingTimelineSchema, type MeetingTimelineInput } from "@/lib/project-management/meetings/validation";
import type { MeetingDto } from "@/lib/project-management/meetings/service";
import { routes } from "@/lib/routes";
import { MeetingTimeline } from "./meeting-timeline";
import { MeetingContentFields } from "./meeting-content-fields";
import { MeetingTemplatePicker } from "./meeting-template-picker";
import { useMeetingUnsavedChanges } from "./use-meeting-unsaved-changes";
import { useMeetingFieldErrors } from "./use-meeting-field-errors";
import { copyMeetingTemplateContent, type MeetingContent } from "@/lib/project-management/meetings/template-validation";
import type { MeetingTemplateSelection } from "@/lib/project-management/meetings/template-service";

export function MeetingForm({ meeting, initialTemplate, templateError = "" }: { meeting?: MeetingDto; initialTemplate?: MeetingTemplateSelection; templateError?: string }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const requestId = useRef<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [content, setContent] = useState<MeetingContent>(() => meeting ? {
    topic: meeting.topic, personIds: meeting.participants.map((person) => person.id), minutes: meeting.minutes, timelineDisplay: meeting.timelineDisplay,
  } : initialTemplate ? copyMeetingTemplateContent(initialTemplate.template) : { topic: "", personIds: [], minutes: "", timelineDisplay: { projectIds: [], taskIds: [] } });
  const { topic, personIds, minutes, timelineDisplay: { projectIds, taskIds } } = content;
  const [participants, setParticipants] = useState(meeting?.participants ?? initialTemplate?.template.participants);
  const [templateName, setTemplateName] = useState(initialTemplate?.template.name ?? "");
  const defaultRangeEnd = new Date();
  const defaultRangeStart = new Date(defaultRangeEnd.getTime() - 7 * 24 * 60 * 60 * 1000);
  const [rangeStart, setRangeStart] = useState(meeting ? isoToShanghaiDateTimeLocal(meeting.rangeStart) : isoToShanghaiDateTimeLocal(defaultRangeStart.toISOString()));
  const [rangeEnd, setRangeEnd] = useState(meeting ? isoToShanghaiDateTimeLocal(meeting.rangeEnd) : isoToShanghaiDateTimeLocal(defaultRangeEnd.toISOString()));
  const [initialRange] = useState({ rangeStart, rangeEnd });
  const [error, setError] = useState(templateError);
  const { fieldErrors, setFieldErrors, showErrors } = useMeetingFieldErrors(formRef, pending, initialTemplate?.fieldErrors);
  const [preview, setPreview] = useState<MeetingTimelineInput | null>(null);
  const dirty = topic !== (meeting?.topic ?? "") || minutes !== (meeting?.minutes ?? "") ||
    JSON.stringify(projectIds) !== JSON.stringify(meeting?.timelineDisplay.projectIds ?? []) ||
    JSON.stringify(taskIds) !== JSON.stringify(meeting?.timelineDisplay.taskIds ?? []) ||
    rangeStart !== initialRange.rangeStart || rangeEnd !== initialRange.rangeEnd ||
    JSON.stringify(personIds) !== JSON.stringify(meeting?.participants.map((person) => person.id) ?? []);
  const saved = useMeetingUnsavedChanges(dirty, "会议内容尚未保存，确定离开吗？");

  function applyTemplate(selection: MeetingTemplateSelection) {
    if ((topic || minutes || personIds.length || projectIds.length || taskIds.length) && !window.confirm("使用模板将覆盖当前所有非时间内容（包括空值），工作时间保持不变。确定替换吗？")) return;
    setContent(copyMeetingTemplateContent(selection.template));
    setParticipants(selection.template.participants);
    setTemplateName(selection.template.name);
    setError("");
    setPreview(null);
    showErrors(selection.fieldErrors);
  }

  const fields = { topic, personIds, minutes, timelineDisplay: { projectIds, taskIds }, rangeStart: shanghaiDateTimeLocalToIso(rangeStart), rangeEnd: shanghaiDateTimeLocalToIso(rangeEnd) };
  function showPreview() {
    const input = { kind: "PREVIEW" as const, personIds, timelineDisplay: fields.timelineDisplay, rangeStart: fields.rangeStart, rangeEnd: fields.rangeEnd };
    const parsed = meetingTimelineSchema.safeParse(input);
    if (!parsed.success) { showErrors(parsed.error.flatten().fieldErrors); return; }
    setFieldErrors({});
    setPreview(input);
  }

  function submit() {
    setError("");
    const parsed = meetingFieldsSchema.safeParse(fields);
    if (!parsed.success) { showErrors(parsed.error.flatten().fieldErrors); return; }
    setFieldErrors({});
    requestId.current ??= crypto.randomUUID();
    startTransition(async () => {
      try {
        const result = meeting
          ? await updateMeetingAction({ ...fields, meetingId: meeting.id, expectedVersion: meeting.version })
          : await createMeetingAction({ ...fields, requestId: requestId.current });
        if (!result.ok) { setError(result.error.message); showErrors(result.error.fieldErrors ?? {}); return; }
        saved.current = true;
        router.push(`${routes.progress.meetingDetail(result.data.id)}?saved=1`);
        router.refresh();
      } catch { setError("保存结果暂时无法确认，请检查网络后重试；重复提交不会创建第二条会议"); }
    });
  }

  return <form ref={formRef} className="min-w-0 space-y-5" noValidate onSubmit={(event) => { event.preventDefault(); if (!pending) submit(); }}>
    {!meeting && <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border bg-primary/5 p-3">
      <div className="min-w-0 text-sm [overflow-wrap:anywhere]">{templateName ? <><p className="font-medium">已填充模板：{templateName}</p><p className="text-muted-foreground">可自由修改，与原模板互不影响；工作时间未改变。</p></> : <p>使用模板预填会议信息，或直接填写创建。</p>}</div>
      <div className="flex flex-wrap gap-2"><MeetingTemplatePicker disabled={pending} onSelect={applyTemplate} label={templateName ? "更换模板" : "使用模板"} />{templateName && <Button type="button" variant="ghost" disabled={pending} onClick={() => setTemplateName("")}>关闭模板提示</Button>}</div>
    </div>}
    <p className="text-sm text-muted-foreground">保存后所有登录用户立即可见。参与人不是访问名单；工作时间范围不是会议召开时间。</p>
    <fieldset disabled={pending} className="min-w-0 space-y-5">
      <MeetingContentFields value={content} onChange={(next) => { setContent(next); setPreview(null); }} participants={participants} disabled={pending} errors={fieldErrors} afterPeople={
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <div className="min-w-0 space-y-2"><Label htmlFor="meeting-range-start">工作开始时间（北京时间）</Label><Input id="meeting-range-start" className="min-w-0 max-w-full" type="datetime-local" value={rangeStart} required aria-invalid={Boolean(fieldErrors.rangeStart)} aria-describedby="meeting-start-error" onChange={(event) => { setRangeStart(event.target.value); setPreview(null); }} /><FieldError id="meeting-start-error" messages={fieldErrors.rangeStart} /></div>
        <div className="min-w-0 space-y-2"><Label htmlFor="meeting-range-end">工作结束时间（北京时间）</Label><Input id="meeting-range-end" className="min-w-0 max-w-full" type="datetime-local" value={rangeEnd} required aria-invalid={Boolean(fieldErrors.rangeEnd)} aria-describedby="meeting-end-error" onChange={(event) => { setRangeEnd(event.target.value); setPreview(null); }} /><FieldError id="meeting-end-error" messages={fieldErrors.rangeEnd} /></div>
      </div>} beforeMinutes={<>
      <Button type="button" variant="outline" onClick={showPreview}>预览工作时间线</Button>
      {preview && <MeetingTimeline source={preview} />}
      </>} />
    </fieldset>
    {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
    <Button type="submit" disabled={pending}>{pending ? "正在保存…" : meeting ? "保存修改" : "创建会议记录"}</Button>
  </form>;
}
