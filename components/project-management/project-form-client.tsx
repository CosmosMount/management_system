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
  async function submit() {
    setError(""); setFieldErrors({});
    let nextAvatarPath = avatarPath;
    if (avatarFile) {
      const data = new FormData(); data.set("avatar", avatarFile);
      const upload = await uploadProjectAvatar(data);
      if (!upload.ok) { setError(upload.message); return; }
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
      setError(result.error.message); setFieldErrors(nextFieldErrors);
      requestAnimationFrame(() => {
        const targetId = Object.keys(nextFieldErrors).map((key) => ({ name: "project-name", description: "project-description", avatarPath: "project-avatar", members: "project-members", requestedTaskIds: "project-tasks" })[key as "name" | "description" | "avatarPath" | "members" | "requestedTaskIds"]).find(Boolean);
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
        <div className="space-y-2"><Label htmlFor="project-avatar" className="inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2"><ImagePlus className="size-4" />上传头像</Label><input id="project-avatar" type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(event) => setAvatarFile(event.target.files?.[0] ?? null)} /><Button type="button" variant="ghost" onClick={() => { setAvatarFile(null); setAvatarPath(null); }}><RotateCcw />恢复默认</Button><p className="text-xs text-muted-foreground">PNG、JPG 或 WebP，不超过 2 MiB</p></div>
      </CardContent></Card>
      <Card><CardHeader><CardTitle>基本信息</CardTitle></CardHeader><CardContent className="space-y-4">
        <div className="space-y-2"><Label htmlFor="project-name">Project 名称</Label><Input id="project-name" value={name} maxLength={200} aria-invalid={Boolean(fieldErrors.name)} onChange={(event) => setName(event.target.value)} />{fieldErrors.name?.map((message) => <p key={message} className="text-sm text-destructive">{message}</p>)}</div>
        <div className="space-y-2"><Label htmlFor="project-description">Project 内容</Label><Textarea id="project-description" value={description} maxLength={8000} rows={8} aria-invalid={Boolean(fieldErrors.description)} onChange={(event) => setDescription(event.target.value)} />{fieldErrors.description?.map((message) => <p key={message} className="text-sm text-destructive">{message}</p>)}</div>
      </CardContent></Card>
      <Card id="project-members" tabIndex={-1}><CardHeader><CardTitle>成员</CardTitle></CardHeader><CardContent className="space-y-4">
        <TaskMemberRolePicker members={members} people={people} scope={{ purpose: "VISIBLE" }} editable protectedOwnerId={protectedOwnerId} onChange={setMembers} onPersonResolved={(person) => setPeople((current) => current.some((item) => item.id === person.id) ? current : [...current, person])} />
        {fieldErrors.members?.map((message) => <p key={message} className="text-sm text-destructive">{message}</p>)}
      </CardContent></Card>
      {mode !== "active" && <Card id="project-tasks" tabIndex={-1}><CardHeader><CardTitle>纳入已有 Task（可选）</CardTitle></CardHeader><CardContent className="space-y-3"><p className="text-sm text-muted-foreground">Task 会在立项通过后统一加入；审批前不会改变归属。</p><TaskMultiSelect value={taskIds} onValueChange={setTaskIds} projectCandidates maxSelected={50} showSelectedList placeholder="搜索可加入的 Task" ariaLabel="搜索可加入的 Task" />{fieldErrors.requestedTaskIds?.map((message) => <p key={message} className="text-sm text-destructive">{message}</p>)}</CardContent></Card>}
      {error && <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>}
      <div className="flex justify-end"><Button type="button" size="lg" disabled={pending} onClick={() => startTransition(submit)}>{pending ? "正在保存…" : buttonLabel}</Button></div>
    </div>
  </div>;
}
