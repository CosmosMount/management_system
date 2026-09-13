"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createMeetingTemplateAction, updateMeetingTemplateAction } from "@/app/actions/project-management/meeting-templates";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { FieldError } from "@/components/ui/field-error";
import { routes } from "@/lib/routes";
import { copyMeetingTemplateContent, meetingTemplateFieldsSchema, type MeetingContent } from "@/lib/project-management/meetings/template-validation";
import type { MeetingTemplateSelection } from "@/lib/project-management/meetings/template-service";
import { MeetingContentFields } from "./meeting-content-fields";
import { useMeetingUnsavedChanges } from "./use-meeting-unsaved-changes";
import { useMeetingFieldErrors } from "./use-meeting-field-errors";

export function MeetingTemplateForm({ selection }: { selection?: MeetingTemplateSelection }) {
  const template = selection?.template;
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const requestId = useRef<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(template?.name ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [initialContent] = useState<MeetingContent>(() => template ? copyMeetingTemplateContent(template) : { topic: "", personIds: [], minutes: "", timelineDisplay: { projectIds: [], taskIds: [] } });
  const [content, setContent] = useState(initialContent);
  const { fieldErrors, setFieldErrors, showErrors } = useMeetingFieldErrors(formRef, pending, selection?.fieldErrors);
  const [error, setError] = useState("");
  const dirty = name !== (template?.name ?? "") || description !== (template?.description ?? "") || JSON.stringify(content) !== JSON.stringify(initialContent);
  const saved = useMeetingUnsavedChanges(dirty, "模板内容尚未保存，确定离开吗？");
  function submit() {
    const fields = { ...content, name, description };
    setError("");
    const parsed = meetingTemplateFieldsSchema.safeParse(fields);
    if (!parsed.success) { showErrors(parsed.error.flatten().fieldErrors); return; }
    setFieldErrors({});
    requestId.current ??= crypto.randomUUID();
    startTransition(async () => {
      try {
        const result = template
          ? await updateMeetingTemplateAction({ ...fields, templateId: template.id, expectedVersion: template.version })
          : await createMeetingTemplateAction({ ...fields, requestId: requestId.current });
        if (!result.ok) { setError(result.error.message); showErrors(result.error.fieldErrors ?? {}); return; }
        saved.current = true;
        router.push(`${routes.progress.meetings}?templateSaved=1`);
        router.refresh();
      } catch { setError("保存结果暂时无法确认，请检查网络后重试；重复提交不会创建第二条模板"); }
    });
  }
  return <form ref={formRef} noValidate className="min-w-0 space-y-5" onSubmit={(event) => { event.preventDefault(); if (!pending) submit(); }}>
    <p className="text-sm text-muted-foreground">所有全局超级管理员共享此模板。模板不包含时间；修改或删除模板不会影响已填充或已创建的会议。</p>
    <fieldset disabled={pending} className="min-w-0 space-y-5">
      <div className="space-y-2"><Label htmlFor="template-name">模板名称</Label><Input id="template-name" value={name} maxLength={100} required aria-invalid={Boolean(fieldErrors.name)} aria-describedby="template-name-error" onChange={(event) => setName(event.target.value)} /><FieldError id="template-name-error" messages={fieldErrors.name} /></div>
      <div className="space-y-2"><Label htmlFor="template-description">模板说明</Label><Textarea id="template-description" value={description} maxLength={500} aria-invalid={Boolean(fieldErrors.description)} aria-describedby="template-description-error" onChange={(event) => setDescription(event.target.value)} /><FieldError id="template-description-error" messages={fieldErrors.description} /></div>
      <MeetingContentFields value={content} onChange={setContent} participants={template?.participants} disabled={pending} errors={fieldErrors} />
    </fieldset>
    {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
    <Button type="submit" disabled={pending}>{pending ? "正在保存…" : template ? "保存模板修改" : "创建会议模板"}</Button>
  </form>;
}
