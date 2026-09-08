"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ImagePlus, RotateCcw } from "lucide-react";
import { createProject, resubmitProject, updateProject, uploadProjectAvatar } from "@/app/actions/project-management/projects";
import { ProjectAvatar } from "@/components/project-management/project-avatar";
import { TaskMemberRolePicker } from "@/components/project-management/task-member-role-picker";
import { TaskMultiSelect } from "@/components/project-management/task-picker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldError } from "@/components/ui/field-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { routes } from "@/lib/routes";
import type { PersonOptionDto } from "@/lib/project-management/types/time-canvas";

type Member = { personId: string; role: "OWNER" | "PARTICIPANT" };

export function ProjectFormClient({
  mode,
  project,
  protectedOwnerId,
}: {
  mode: "create" | "draft" | "active";
  project?: { id: string; name: string; description: string; avatarPath: string | null; lockVersion: number; members: Member[]; memberOptions: PersonOptionDto[]; requestedTaskIds: string[] };
  protectedOwnerId?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [avatarPath, setAvatarPath] = useState<string | null>(project?.avatarPath ?? null);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [members, setMembers] = useState<Member[]>(project?.members ?? []);
  const [people, setPeople] = useState<PersonOptionDto[]>(project?.memberOptions ?? []);
  const [taskIds, setTaskIds] = useState<string[]>(project?.requestedTaskIds ?? []);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const dirty = name !== (project?.name ?? "") || description !== (project?.description ?? "") || avatarFile !== null || avatarPath !== (project?.avatarPath ?? null) || JSON.stringify(members) !== JSON.stringify(project?.members ?? []) || JSON.stringify(taskIds) !== JSON.stringify(project?.requestedTaskIds ?? []);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => { if (dirty && !pending) event.preventDefault(); };
    const interceptLink = (event: MouseEvent) => {
      if (!dirty || pending || event.defaultPrevented || event.button !== 0) return;
      const anchor = (event.target as Element | null)?.closest("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank" || new URL(anchor.href, window.location.href).origin !== window.location.origin) return;
      if (!window.confirm("表单还有未保存的修改，确认离开？")) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("beforeunload", handler);
    document.addEventListener("click", interceptLink, true);
    return () => { window.removeEventListener("beforeunload", handler); document.removeEventListener("click", interceptLink, true); };
  }, [dirty, pending]);
  const avatarPreview = useMemo(() => avatarFile ? URL.createObjectURL(avatarFile) : null, [avatarFile]);
  useEffect(() => () => { if (avatarPreview) URL.revokeObjectURL(avatarPreview); }, [avatarPreview]);
  function clearFieldError(key: string) {
    setFieldErrors((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }
  async function submit() {
    setError("");
    const localFieldErrors: Record<string, string[]> = {};
    if (!name.trim()) localFieldErrors.name = ["请输入项目名称"];
    if (!description.trim()) localFieldErrors.description = ["请输入项目内容"];
    if (members.every((member) => member.role !== "OWNER")) {
      localFieldErrors.members = ["至少需要一名项目负责人"];
    }
    if (Object.keys(localFieldErrors).length > 0) {
      setFieldErrors((current) => ({ ...current, ...localFieldErrors }));
      requestAnimationFrame(() => {
        const targetId = localFieldErrors.name
          ? "project-name"
          : localFieldErrors.description
            ? "project-description"
            : "project-members";
        revealProjectTarget(targetId);
      });
      return;
    }
    let nextAvatarPath = avatarPath;
    if (avatarFile) {
      const data = new FormData(); data.set("avatar", avatarFile);
      const upload = await uploadProjectAvatar(data);
      if (!upload.ok) {
        setFieldErrors({ avatarPath: [upload.message] });
        requestAnimationFrame(() => revealProjectTarget("project-avatar"));
        return;
      }
      nextAvatarPath = upload.path;
    }
    const common = { name, description, avatarPath: nextAvatarPath, members };
    const result = mode === "create"
      ? await createProject({ ...common, requestedTaskIds: taskIds, idempotencyKey })
      : mode === "draft"
        ? await resubmitProject({ projectId: project!.id, expectedLockVersion: project!.lockVersion, ...common, requestedTaskIds: taskIds, idempotencyKey })
        : await updateProject({ projectId: project!.id, expectedLockVersion: project!.lockVersion, ...common });
    if (!result.ok) {
      const nextFieldErrors = result.error.fieldErrors ?? {};
      const supportedFieldKeys = new Set([
        "name",
        "description",
        "avatarPath",
        "members",
        "requestedTaskIds",
      ]);
      const fieldEntries = Object.entries(nextFieldErrors).filter(([, messages]) =>
        messages.some(Boolean),
      );
      const displayedFieldErrors = Object.fromEntries(
        fieldEntries
          .filter(([key]) => supportedFieldKeys.has(key))
          .map(([key, messages]) => [key, messages.filter(Boolean)]),
      );
      setError(
        fieldEntries.length > 0 && fieldEntries.every(([key]) => supportedFieldKeys.has(key))
          ? ""
          : result.error.message,
      );
      setFieldErrors(displayedFieldErrors);
      requestAnimationFrame(() => {
        const targetId = Object.keys(displayedFieldErrors).map((key) => ({ name: "project-name", description: "project-description", avatarPath: "project-avatar", members: "project-members", requestedTaskIds: "project-tasks" })[key as "name" | "description" | "avatarPath" | "members" | "requestedTaskIds"]).find(Boolean);
        if (targetId) revealProjectTarget(targetId);
      });
      return;
    }
    router.push(routes.progress.projectDetail(result.data.projectId)); router.refresh();
  }
  const buttonLabel = mode === "create" ? "提交立项" : mode === "draft" ? "修改并重新提交" : "保存修改";
  return <div className="mx-auto w-full min-w-0 max-w-5xl px-4 py-6 sm:px-6" data-testid="project-form">
    <nav aria-label="项目表单分区" className="sticky top-14 z-20 mb-4 flex flex-wrap gap-2 rounded-xl border border-border bg-background/95 p-3 backdrop-blur">
      <Button type="button" variant="outline" size="sm" onClick={() => revealProjectTarget("project-form-basics", "start")}>1. 基本资料</Button>
      <Button type="button" variant="outline" size="sm" onClick={() => revealProjectTarget("project-form-members", "start")}>2. 项目成员</Button>
      <Button type="button" variant="outline" size="sm" onClick={() => revealProjectTarget("project-form-review", "start")}>{mode === "active" ? "3. 检查保存" : "3. 检查送审"}</Button>
    </nav>
    <div className="space-y-4">
      <Card id="project-form-basics" tabIndex={-1} className="scroll-mt-36"><CardHeader><CardTitle>1. 基本资料</CardTitle><p className="text-sm text-muted-foreground">先说明项目名称与内容，再配置负责人；头像和已有任务可按需补充。</p></CardHeader><CardContent className="space-y-4">
        <div className="space-y-2"><Label htmlFor="project-name">项目名称</Label><Input id="project-name" value={name} maxLength={200} aria-invalid={Boolean(fieldErrors.name)} aria-describedby={fieldErrors.name ? "project-name-error" : undefined} onChange={(event) => { setName(event.target.value); if (event.target.value.trim()) clearFieldError("name"); }} /><FieldError id="project-name-error" messages={fieldErrors.name} /></div>
        <div className="space-y-2"><Label htmlFor="project-description">项目内容</Label><Textarea id="project-description" value={description} maxLength={8000} rows={4} aria-invalid={Boolean(fieldErrors.description)} aria-describedby={fieldErrors.description ? "project-description-error" : undefined} onChange={(event) => { setDescription(event.target.value); if (event.target.value.trim()) clearFieldError("description"); }} /><FieldError id="project-description-error" messages={fieldErrors.description} /></div>
      </CardContent></Card>
      <Card id="project-form-members" tabIndex={-1} className="scroll-mt-36"><CardHeader><CardTitle>2. 项目成员</CardTitle><p className="text-sm text-muted-foreground">至少保留一名项目负责人；成员规则与原提交流程一致。</p></CardHeader><CardContent className="space-y-4">
        <TaskMemberRolePicker members={members} people={people} focusTargetId="project-members" scope={{ purpose: "VISIBLE" }} editable protectedOwnerId={protectedOwnerId} error={fieldErrors.members} onChange={(nextMembers) => { setMembers(nextMembers); if (nextMembers.some((member) => member.role === "OWNER")) clearFieldError("members"); }} onPersonResolved={(person) => setPeople((current) => current.some((item) => item.id === person.id) ? current : [...current, person])} />
      </CardContent></Card>
      <details className="rounded-xl border border-border bg-card p-4" data-testid="project-form-avatar-options">
        <summary className="cursor-pointer font-medium focus-visible:outline-2 focus-visible:outline-ring">项目头像（可选）<span className="ml-2 text-sm text-muted-foreground">{avatarFile || avatarPath ? "已设置" : "使用默认头像"}{fieldErrors.avatarPath ? " · 需修正" : ""}</span></summary>
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <ProjectAvatar name={name || "项目"} avatarPath={avatarPreview ?? avatarPath} className="size-16" />
          <div className="min-w-0 space-y-2">
            <Label htmlFor="project-avatar">上传头像</Label>
            <div className="flex flex-wrap items-center gap-2">
              <ImagePlus className="size-4" aria-hidden="true" />
              <input id="project-avatar" type="file" accept="image/png,image/jpeg,image/webp" className="min-w-0 max-w-full rounded-md text-sm focus-visible:outline-2 focus-visible:outline-ring" aria-invalid={Boolean(fieldErrors.avatarPath)} aria-describedby={fieldErrors.avatarPath ? "project-avatar-error" : undefined} onChange={(event) => { setAvatarFile(event.target.files?.[0] ?? null); clearFieldError("avatarPath"); }} />
              <Button type="button" variant="ghost" onClick={() => { setAvatarFile(null); setAvatarPath(null); clearFieldError("avatarPath"); }}><RotateCcw aria-hidden="true" />恢复默认</Button>
            </div>
            <p className="text-xs text-muted-foreground">PNG、JPG 或 WebP，不超过 2 MiB</p>
            <FieldError id="project-avatar-error" messages={fieldErrors.avatarPath} />
          </div>
        </div>
      </details>
      {mode !== "active" && <details className="rounded-xl border border-border bg-card p-4" data-testid="project-form-task-options">
        <summary className="cursor-pointer font-medium focus-visible:outline-2 focus-visible:outline-ring">纳入已有任务（可选）<span className="ml-2 text-sm text-muted-foreground">已选 {taskIds.length} 项{fieldErrors.requestedTaskIds ? " · 需修正" : ""}</span></summary>
        <div id="project-tasks" tabIndex={-1} className="mt-4 space-y-3 rounded-md focus-visible:outline-2 focus-visible:outline-ring"><p className="text-sm text-muted-foreground">任务会在立项通过后统一加入；审批前不会改变归属。</p><TaskMultiSelect value={taskIds} onValueChange={(nextTaskIds) => { setTaskIds(nextTaskIds); clearFieldError("requestedTaskIds"); }} projectCandidates maxSelected={50} showSelectedList placeholder="搜索可加入的任务" ariaLabel="搜索可加入的任务" invalid={Boolean(fieldErrors.requestedTaskIds)} ariaDescribedBy={fieldErrors.requestedTaskIds ? "project-tasks-error" : undefined} /><FieldError id="project-tasks-error" messages={fieldErrors.requestedTaskIds} /></div>
      </details>}
      {error && <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>}
      <Card id="project-form-review" tabIndex={-1} className="scroll-mt-36"><CardHeader><CardTitle>{mode === "active" ? "3. 检查与保存" : "3. 检查与送审"}</CardTitle></CardHeader><CardContent className="space-y-4">
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div className="min-w-0"><dt className="text-muted-foreground">项目名称</dt><dd className="mt-1 break-words [overflow-wrap:anywhere]">{name || "尚未填写"}</dd></div>
          <div><dt className="text-muted-foreground">负责人</dt><dd className="mt-1">{members.filter((member) => member.role === "OWNER").length} 人</dd></div>
          <div><dt className="text-muted-foreground">{mode === "active" ? "项目成员" : "申请纳入任务"}</dt><dd className="mt-1">{mode === "active" ? `${members.length} 人` : `${taskIds.length} 项`}</dd></div>
        </dl>
        <p className="text-sm text-muted-foreground">{mode === "active" ? "本次保存项目资料与成员修改，不发起立项审批。" : "提交后进入立项审批，并非立即生效；申请纳入的任务在审批通过后加入。"}若校验未通过，将展开并定位需要修改的字段。</p>
        <div className="flex justify-end"><Button type="button" size="lg" disabled={pending} onClick={() => startTransition(submit)}>{pending ? "正在保存…" : buttonLabel}</Button></div>
      </CardContent></Card>
    </div>
  </div>;
}

function revealProjectTarget(targetId: string, block: ScrollLogicalPosition = "center") {
  const target = document.getElementById(targetId);
  let ancestor: HTMLElement | null = target;
  while (ancestor) {
    if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
    ancestor = ancestor.parentElement;
  }
  target?.scrollIntoView({ block });
  target?.focus({ preventScroll: true });
}
