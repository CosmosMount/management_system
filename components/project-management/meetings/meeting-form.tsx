"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createMeetingAction, updateMeetingAction } from "@/app/actions/project-management/meetings";
import { UserMultiSelect } from "@/components/project-management/user-picker";
import { ProjectMultiSelect } from "@/components/project-management/project-picker";
import { TaskMultiSelect } from "@/components/project-management/task-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { FieldError } from "@/components/ui/field-error";
import { isoToShanghaiDateTimeLocal, shanghaiDateTimeLocalToIso } from "@/lib/project-management/date-time";
import { meetingFieldsSchema, meetingTimelineSchema, type MeetingTimelineInput } from "@/lib/project-management/meetings/validation";
import type { MeetingDto } from "@/lib/project-management/meetings/service";
import { routes } from "@/lib/routes";
import { MeetingTimeline } from "./meeting-timeline";

export function MeetingForm({ meeting }: { meeting?: MeetingDto }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const requestId = useRef<string | null>(null);
  const saved = useRef(false);
  const [pending, startTransition] = useTransition();
  const [topic, setTopic] = useState(meeting?.topic ?? "");
  const [personIds, setPersonIds] = useState(meeting?.participants.map((person) => person.id) ?? []);
  const defaultRangeEnd = new Date();
  const defaultRangeStart = new Date(defaultRangeEnd.getTime() - 7 * 24 * 60 * 60 * 1000);
  const [rangeStart, setRangeStart] = useState(meeting ? isoToShanghaiDateTimeLocal(meeting.rangeStart) : isoToShanghaiDateTimeLocal(defaultRangeStart.toISOString()));
  const [rangeEnd, setRangeEnd] = useState(meeting ? isoToShanghaiDateTimeLocal(meeting.rangeEnd) : isoToShanghaiDateTimeLocal(defaultRangeEnd.toISOString()));
  const [minutes, setMinutes] = useState(meeting?.minutes ?? "");
  const [projectIds, setProjectIds] = useState(meeting?.timelineDisplay.projectIds ?? []);
  const [taskIds, setTaskIds] = useState(meeting?.timelineDisplay.taskIds ?? []);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [preview, setPreview] = useState<MeetingTimelineInput | null>(null);
  const dirty = topic !== (meeting?.topic ?? "") || minutes !== (meeting?.minutes ?? "") ||
    JSON.stringify(projectIds) !== JSON.stringify(meeting?.timelineDisplay.projectIds ?? []) ||
    JSON.stringify(taskIds) !== JSON.stringify(meeting?.timelineDisplay.taskIds ?? []) ||
    rangeStart !== (meeting ? isoToShanghaiDateTimeLocal(meeting.rangeStart) : "") ||
    rangeEnd !== (meeting ? isoToShanghaiDateTimeLocal(meeting.rangeEnd) : "") ||
    JSON.stringify(personIds) !== JSON.stringify(meeting?.participants.map((person) => person.id) ?? []);
  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) { if (dirty && !saved.current) event.preventDefault(); }
    function interceptLink(event: MouseEvent) {
      if (!dirty || saved.current || event.defaultPrevented || event.button !== 0) return;
      const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (target && !window.confirm("会议内容尚未保存，确定离开吗？")) { event.preventDefault(); event.stopPropagation(); }
    }
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", interceptLink, true);
    return () => { window.removeEventListener("beforeunload", beforeUnload); document.removeEventListener("click", interceptLink, true); };
  }, [dirty]);

  function showErrors(errors: Record<string, string[]>) {
    setFieldErrors(errors);
    requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
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
    <p className="text-sm text-muted-foreground">保存后所有登录用户立即可见。参与人不是访问名单；工作时间范围不是会议召开时间。</p>
    <fieldset disabled={pending} className="min-w-0 space-y-5">
      <div className="space-y-2"><Label htmlFor="meeting-topic">会议主题</Label><Input id="meeting-topic" value={topic} maxLength={200} required aria-invalid={Boolean(fieldErrors.topic)} aria-describedby="meeting-topic-error" onChange={(event) => setTopic(event.target.value)} /><FieldError id="meeting-topic-error" messages={fieldErrors.topic} /></div>
      <div className="space-y-2"><Label htmlFor="meeting-people">参与人</Label><UserMultiSelect inputId="meeting-people" ariaLabel="会议参与人" scope={{ purpose: "VISIBLE" }} value={personIds} onValueChange={(ids) => { setPersonIds(ids); setPreview(null); }} initialOptions={meeting?.participants} maxSelected={50} invalid={Boolean(fieldErrors.personIds)} ariaDescribedBy="meeting-people-error" /><FieldError id="meeting-people-error" messages={fieldErrors.personIds} /></div>
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <div className="min-w-0 space-y-2"><Label htmlFor="meeting-range-start">工作开始时间（北京时间）</Label><Input id="meeting-range-start" className="min-w-0 max-w-full" type="datetime-local" value={rangeStart} required aria-invalid={Boolean(fieldErrors.rangeStart)} aria-describedby="meeting-start-error" onChange={(event) => { setRangeStart(event.target.value); setPreview(null); }} /><FieldError id="meeting-start-error" messages={fieldErrors.rangeStart} /></div>
        <div className="min-w-0 space-y-2"><Label htmlFor="meeting-range-end">工作结束时间（北京时间）</Label><Input id="meeting-range-end" className="min-w-0 max-w-full" type="datetime-local" value={rangeEnd} required aria-invalid={Boolean(fieldErrors.rangeEnd)} aria-describedby="meeting-end-error" onChange={(event) => { setRangeEnd(event.target.value); setPreview(null); }} /><FieldError id="meeting-end-error" messages={fieldErrors.rangeEnd} /></div>
      </div>
      <div className="space-y-2"><Label htmlFor="meeting-projects">展示项目</Label><ProjectMultiSelect inputId="meeting-projects" ariaLabel="展示项目" disabled={pending} value={projectIds} onValueChange={(ids) => { setProjectIds(ids); setPreview(null); }} invalid={Boolean(fieldErrors["timelineDisplay.projectIds"] || fieldErrors.timelineDisplay)} ariaDescribedBy="meeting-projects-error" /><FieldError id="meeting-projects-error" messages={fieldErrors["timelineDisplay.projectIds"] ?? fieldErrors.timelineDisplay} /></div>
      <div className="space-y-2"><Label htmlFor="meeting-tasks">展示任务</Label><TaskMultiSelect inputId="meeting-tasks" ariaLabel="展示任务" disabled={pending} mine={false} value={taskIds} onValueChange={(ids) => { setTaskIds(ids); setPreview(null); }} invalid={Boolean(fieldErrors["timelineDisplay.taskIds"])} ariaDescribedBy="meeting-tasks-error" /><FieldError id="meeting-tasks-error" messages={fieldErrors["timelineDisplay.taskIds"]} /></div>
      <p className="text-sm text-muted-foreground">可选，仅用于展示时间线，不改变项目、任务或会议参与人。项目内的任务、计划和工作记录随原数据更新。</p>
      <Button type="button" variant="outline" onClick={showPreview}>预览工作时间线</Button>
      {preview && <MeetingTimeline source={preview} />}
      <div className="space-y-2"><Label htmlFor="meeting-minutes">会议纪要</Label><Textarea id="meeting-minutes" className="min-h-56" value={minutes} maxLength={50_000} aria-invalid={Boolean(fieldErrors.minutes)} aria-describedby="meeting-minutes-error" placeholder="记录讨论内容、结论和后续事项，可稍后补充" onChange={(event) => setMinutes(event.target.value)} /><FieldError id="meeting-minutes-error" messages={fieldErrors.minutes} /></div>
    </fieldset>
    {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
    <Button type="submit" disabled={pending}>{pending ? "正在保存…" : meeting ? "保存修改" : "创建会议记录"}</Button>
  </form>;
}
