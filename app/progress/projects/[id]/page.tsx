import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Pencil, Plus } from "lucide-react";
import { ProjectActionsClient } from "@/components/project-management/project-actions-client";
import { ProjectAvatar } from "@/components/project-management/project-avatar";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toProjectManagementServiceError } from "@/lib/project-management/application/errors";
import { getProjectDetail } from "@/lib/project-management/queries/project-queries";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { getProgressActorOrRedirect } from "../../_auth";

const statusLabels = { DRAFT: "草稿", PENDING_APPROVAL: "立项审批中", ACTIVE: "进行中", COMPLETED: "已结束" } as const;
const taskLabels = { DRAFT: "草稿", ACTIVE: "进行中", COMPLETED: "已完成", FAILED: "失败", CANCELLED: "已取消", TIMEOUT: "超时", ARCHIVED: "已归档" } as const;
const requestLabels = { PENDING: "待审批", APPROVED: "已通过", REJECTED: "已驳回", CANCELLED: "已取消" } as const;

type SearchParams = Record<string, string | string[] | undefined>;

export default async function ProjectDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams?: Promise<SearchParams> }) {
  const actor = await getProgressActorOrRedirect();
  const { id } = await params;
  const query = (await searchParams) ?? {};
  const project = await getProjectDetail({
    actor,
    projectId: id,
    pagination: {
      taskCursor: first(query.taskCursor) || undefined,
      requestCursor: first(query.requestCursor) || undefined,
      auditCursor: first(query.auditCursor) || undefined,
    },
  }).catch((error) => { if (toProjectManagementServiceError(error).code === "NOT_FOUND") notFound(); throw error; });
  const owners = project.members.filter((member) => member.role === "OWNER");
  const participants = project.members.filter((member) => member.role === "PARTICIPANT");
  return <>
    <PageCommandBar title={project.name} description={`Project · ${statusLabels[project.status]}`} actions={<div className="flex flex-wrap gap-2"><Link href={routes.progress.projects} className={cn(buttonVariants({ variant: "outline" }))}><ArrowLeft />返回列表</Link>{(project.permissions.canEdit || project.permissions.canResubmit) && <Link href={routes.progress.projectEdit(project.id)} className={cn(buttonVariants())}><Pencil />{project.status === "DRAFT" ? "修改并重新提交" : "编辑"}</Link>}</div>} />
    <div className="mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-5 px-4 py-6 sm:px-6">
      <Card><CardHeader className="grid-cols-[auto_1fr_auto] items-start gap-4"><ProjectAvatar name={project.name} avatarPath={project.avatarPath} className="size-16" /><div className="min-w-0"><CardTitle className="break-words text-2xl">{project.name}</CardTitle><p className="mt-2 text-sm text-muted-foreground">第 {project.establishmentRound} 轮 · {format(project.submittedAt)} 提交</p></div><Badge variant="secondary">{statusLabels[project.status]}</Badge></CardHeader><CardContent><ProjectActionsClient projectId={project.id} lockVersion={project.lockVersion} requestId={project.pendingRequestId} canReview={project.permissions.canReview} canComplete={project.permissions.canComplete} canDelete={project.permissions.canDelete} hasNoTasks={project.taskTotalCount === 0} blockingTaskCount={project.taskTotalCount - project.completedTaskTotalCount} blockingTasks={project.blockingTasks.map((task) => ({ id: task.id, title: task.title, statusLabel: taskLabels[task.status] }))} /></CardContent></Card>
      <Card><CardHeader><CardTitle>Project 内容</CardTitle></CardHeader><CardContent><p className="whitespace-pre-wrap break-words leading-7">{project.description}</p></CardContent></Card>
      <Card><CardHeader><CardTitle>负责人和参与人员</CardTitle></CardHeader><CardContent className="space-y-4"><MemberGroup title="负责人" members={owners} /><MemberGroup title="参与人员" members={participants} /></CardContent></Card>
      <Card id="establishment"><CardHeader><CardTitle>立项申请</CardTitle></CardHeader><CardContent className="space-y-3">{project.requests.map((request) => <div key={request.id} className="rounded-lg border p-3"><div className="flex flex-wrap justify-between gap-2"><strong>第 {request.round} 轮 · {requestLabels[request.status]}</strong><span className="text-sm text-muted-foreground">{format(request.submittedAt)}</span></div><p className="mt-2 text-sm">提交人：{request.submittedByName}{request.reviewerName ? ` · 审批人：${request.reviewerName}` : ""}</p>{request.reviewComment && <p className="mt-2 whitespace-pre-wrap break-words rounded bg-muted p-2 text-sm">{request.reviewComment}</p>}</div>)}{project.requestNextCursor && <PageLink href={detailPageHref(project.id, query, "requestCursor", project.requestNextCursor)}>更早的立项申请</PageLink>}</CardContent></Card>
      <Card><CardHeader className="grid-cols-[1fr_auto]"><div><CardTitle>Task</CardTitle><p className="mt-1 text-sm text-muted-foreground">{project.completedTaskTotalCount}/{project.taskTotalCount} 已完成</p></div>{project.status === "ACTIVE" && <Link href={`${routes.progress.taskNew}?projectId=${project.id}`} className={cn(buttonVariants({ size: "sm" }))}><Plus />新建 Task</Link>}</CardHeader><CardContent>{project.tasks.length ? <div className="space-y-3"><div className="divide-y rounded-lg border">{project.tasks.map((task) => <Link key={task.id} href={routes.progress.taskDetail(task.id)} className="flex min-w-0 items-center justify-between gap-3 p-3 hover:bg-muted/50"><span className="min-w-0 break-words font-medium">{task.title}</span><Badge variant="secondary">{taskLabels[task.status]}</Badge></Link>)}</div>{project.taskNextCursor && <PageLink href={detailPageHref(project.id, query, "taskCursor", project.taskNextCursor)}>下一页 Task</PageLink>}</div> : <p className="text-muted-foreground">尚未关联 Task</p>}</CardContent></Card>
      <Card><CardHeader><CardTitle>最近审计记录</CardTitle></CardHeader><CardContent>{project.auditEvents.length ? <div className="space-y-3">{project.auditEvents.map((event) => <div key={event.id} className="flex flex-wrap justify-between gap-2 border-b pb-3 text-sm"><span className="break-all">{event.action} · {event.actorName}</span><span className="text-muted-foreground">{format(event.createdAt)}</span></div>)}{project.auditNextCursor && <PageLink href={detailPageHref(project.id, query, "auditCursor", project.auditNextCursor)}>更早的审计记录</PageLink>}</div> : <p className="text-muted-foreground">暂无审计记录</p>}</CardContent></Card>
    </div>
  </>;
}
function MemberGroup({ title, members }: { title: string; members: Array<{ personId: string; displayName: string; status: string }> }) { return <div><h3 className="mb-2 text-sm font-medium text-muted-foreground">{title}</h3><div className="flex flex-wrap gap-2">{members.length ? members.map((member) => <Badge key={member.personId} variant="outline" className="max-w-full whitespace-normal break-words">{member.displayName}{member.status === "INACTIVE" ? "（已停用）" : ""}</Badge>) : <span className="text-sm text-muted-foreground">无</span>}</div></div>; }
function format(value: string | null) { return value ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Shanghai" }).format(new Date(value)) : "未设置"; }
function first(value: string | string[] | undefined) { return Array.isArray(value) ? value[0] ?? "" : value ?? ""; }
function detailPageHref(projectId: string, params: SearchParams, key: "taskCursor" | "requestCursor" | "auditCursor", cursor: string) {
  const search = new URLSearchParams();
  for (const cursorKey of ["taskCursor", "requestCursor", "auditCursor"] as const) {
    const value = cursorKey === key ? cursor : first(params[cursorKey]);
    if (value) search.set(cursorKey, value);
  }
  return `${routes.progress.projectDetail(projectId)}?${search.toString()}`;
}
function PageLink({ href, children }: { href: string; children: React.ReactNode }) { return <div className="flex justify-end"><Link href={href} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>{children}</Link></div>; }
