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
    if (!name.trim()) localFieldErrors.name = ["请输入 Project 名称"];
    if (!description.trim()) localFieldErrors.description = ["请输入 Project 内容"];
    if (members.every((member) => member.role !== "OWNER")) {
      localFieldErrors.members = ["至少需要一名 Project 负责人"];
    }
    if (Object.keys(localFieldErrors).length > 0) {
      setFieldErrors((current) => ({ ...current, ...localFieldErrors }));
      requestAnimationFrame(() => {
        const targetId = localFieldErrors.name
          ? "project-name"
          : localFieldErrors.description
            ? "project-description"
            : "project-members";
        document.getElementById(targetId)?.focus();
      });
      return;
    }
    let nextAvatarPath = avatarPath;
    if (avatarFile) {
      const data = new FormData(); data.set("avatar", avatarFile);
      const upload = await uploadProjectAvatar(data);
      if (!upload.ok) {
        setFieldErrors({ avatarPath: [upload.message] });
        requestAnimationFrame(() => document.getElementById("project-avatar")?.focus());
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
        if (targetId) document.getElementById(targetId)?.focus();
      });
      return;
    }
    router.push(routes.progress.projectDetail(result.data.projectId)); router.refresh();
  }
  const buttonLabel = mode === "create" ? "提交立项" : mode === "draft" ? "修改并重新提交" : "保存修改";
  return <div className="mx-auto w-full min-w-0 max-w-4xl px-4 py-6 sm:px-6">
    <div className="space-y-5">
      <Card><CardHeader><CardTitle>Project 头像</CardTitle></CardHeader><CardContent className="flex flex-wrap items-center gap-4">
        <ProjectAvatar name={name || "Project"} avatarPath={avatarPreview ?? avatarPath} className="size-20" />
        <div className="space-y-2"><Label htmlFor="project-avatar" className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 ${fieldErrors.avatarPath ? "border-destructive ring-3 ring-destructive/20" : ""}`}><ImagePlus className="size-4" />上传头像</Label><input id="project-avatar" type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" aria-invalid={Boolean(fieldErrors.avatarPath)} aria-describedby={fieldErrors.avatarPath ? "project-avatar-error" : undefined} onChange={(event) => { setAvatarFile(event.target.files?.[0] ?? null); clearFieldError("avatarPath"); }} /><Button type="button" variant="ghost" onClick={() => { setAvatarFile(null); setAvatarPath(null); clearFieldError("avatarPath"); }}><RotateCcw />恢复默认</Button><p className="text-xs text-muted-foreground">PNG、JPG 或 WebP，不超过 2 MiB</p><FieldError id="project-avatar-error" messages={fieldErrors.avatarPath} /></div>
      </CardContent></Card>
      <Card><CardHeader><CardTitle>基本信息</CardTitle></CardHeader><CardContent className="space-y-4">
        <div className="space-y-2"><Label htmlFor="project-name">Project 名称</Label><Input id="project-name" value={name} maxLength={200} aria-invalid={Boolean(fieldErrors.name)} aria-describedby={fieldErrors.name ? "project-name-error" : undefined} onChange={(event) => { setName(event.target.value); if (event.target.value.trim()) clearFieldError("name"); }} /><FieldError id="project-name-error" messages={fieldErrors.name} /></div>
        <div className="space-y-2"><Label htmlFor="project-description">Project 内容</Label><Textarea id="project-description" value={description} maxLength={8000} rows={8} aria-invalid={Boolean(fieldErrors.description)} aria-describedby={fieldErrors.description ? "project-description-error" : undefined} onChange={(event) => { setDescription(event.target.value); if (event.target.value.trim()) clearFieldError("description"); }} /><FieldError id="project-description-error" messages={fieldErrors.description} /></div>
      </CardContent></Card>
      <Card id="project-members" tabIndex={-1}><CardHeader><CardTitle>成员</CardTitle></CardHeader><CardContent className="space-y-4">
        <TaskMemberRolePicker members={members} people={people} scope={{ purpose: "VISIBLE" }} editable protectedOwnerId={protectedOwnerId} error={fieldErrors.members} onChange={(nextMembers) => { setMembers(nextMembers); if (nextMembers.some((member) => member.role === "OWNER")) clearFieldError("members"); }} onPersonResolved={(person) => setPeople((current) => current.some((item) => item.id === person.id) ? current : [...current, person])} />
      </CardContent></Card>
      {mode !== "active" && <Card id="project-tasks" tabIndex={-1}><CardHeader><CardTitle>纳入已有 Task（可选）</CardTitle></CardHeader><CardContent className="space-y-3"><p className="text-sm text-muted-foreground">Task 会在立项通过后统一加入；审批前不会改变归属。</p><TaskMultiSelect value={taskIds} onValueChange={(nextTaskIds) => { setTaskIds(nextTaskIds); clearFieldError("requestedTaskIds"); }} projectCandidates maxSelected={50} showSelectedList placeholder="搜索可加入的 Task" ariaLabel="搜索可加入的 Task" invalid={Boolean(fieldErrors.requestedTaskIds)} ariaDescribedBy={fieldErrors.requestedTaskIds ? "project-tasks-error" : undefined} /><FieldError id="project-tasks-error" messages={fieldErrors.requestedTaskIds} /></CardContent></Card>}
      {error && <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>}
      <div className="flex justify-end"><Button type="button" size="lg" disabled={pending} onClick={() => startTransition(submit)}>{pending ? "正在保存…" : buttonLabel}</Button></div>
    </div>
  </div>;
}
