"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy } from "lucide-react";
import { completeProject, deleteProject, reviewProjectEstablishment } from "@/app/actions/project-management/projects";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { routes } from "@/lib/routes";

export function ProjectActionsClient({ projectId, lockVersion, requestId, canReview, canComplete, canDelete, blockingTasks, blockingTaskCount, hasNoTasks }: { projectId: string; lockVersion: number; requestId: string | null; canReview: boolean; canComplete: boolean; canDelete: boolean; blockingTasks: Array<{ id: string; title: string; statusLabel: string }>; blockingTaskCount: number; hasNoTasks: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dialog, setDialog] = useState<"complete" | "delete" | null>(null);
  function run(operation: () => Promise<{ ok: boolean; error?: { message: string } }>, deleted = false) {
    setError("");
    setNotice("");
    startTransition(async () => {
      const result = await operation();
      if (!result.ok) { setError(result.error?.message ?? "操作失败"); return; }
      setDialog(null);
      if (deleted) router.push(routes.progress.projects); else router.refresh();
    });
  }
  async function copyProjectLink() {
    setError("");
    setNotice("");
    try {
      await navigator.clipboard.writeText(window.location.href);
      setNotice("Project 链接已复制。");
    } catch {
      setError("浏览器拒绝复制，请手动复制地址栏链接。");
    }
  }
  return <div className="min-w-0 space-y-3">
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" disabled={pending} onClick={() => void copyProjectLink()}><Copy />复制链接</Button>
      {canReview && requestId && <><Button disabled={pending} onClick={() => run(() => reviewProjectEstablishment({ projectId, requestId, expectedLockVersion: lockVersion, decision: "APPROVE", comment }))}>通过立项</Button><Button variant="destructive" disabled={pending || !comment.trim()} onClick={() => { if (window.confirm("确认驳回该立项申请？")) run(() => reviewProjectEstablishment({ projectId, requestId, expectedLockVersion: lockVersion, decision: "REJECT", comment })); }}>驳回</Button></>}
      {canComplete && <Button disabled={pending} onClick={() => setDialog("complete")}>结束 Project</Button>}
      {canDelete && <Button variant="destructive" disabled={pending} onClick={() => setDialog("delete")}>删除 Project</Button>}
    </div>
    {canReview && <Textarea value={comment} onChange={(event) => setComment(event.target.value)} maxLength={2000} placeholder="审批意见（驳回时必填）" aria-label="立项审批意见" />}
    {notice && <p role="status" className="text-sm text-emerald-700">{notice}</p>}
    {error && <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
    <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open && !pending) setDialog(null); }}><DialogContent><DialogHeader><DialogTitle>{dialog === "delete" ? "删除 Project" : "结束 Project"}</DialogTitle><DialogDescription>{dialog === "delete" ? "Project 会删除，Task 不会删除，只会变为无所属 Project。此操作不会删除 Task 的成员、计划或历史。" : hasNoTasks ? "当前没有关联 Task。确认结束后 Project 资料和成员将变为只读。" : blockingTaskCount > 0 ? `仍有 ${blockingTaskCount} 个 Task 未完成，暂时不能结束 Project。` : "确认结束 Project？结束后 Project 资料、成员和 Task 归属将变为只读。"}</DialogDescription></DialogHeader>
      {dialog === "complete" && blockingTasks.length > 0 && <div className="max-h-52 divide-y overflow-y-auto rounded-lg border">{blockingTasks.map((task) => <a key={task.id} href={routes.progress.taskDetail(task.id)} className="flex min-w-0 items-center justify-between gap-3 p-3 hover:bg-muted"><span className="min-w-0 break-words">{task.title}</span><span className="shrink-0 text-xs text-muted-foreground">{task.statusLabel}</span></a>)}</div>}
      <DialogFooter><Button type="button" variant="outline" disabled={pending} onClick={() => setDialog(null)}>取消</Button>{dialog === "delete" ? <Button type="button" variant="destructive" disabled={pending} onClick={() => run(() => deleteProject({ projectId, expectedLockVersion: lockVersion }), true)}>确认删除</Button> : <Button type="button" disabled={pending || blockingTaskCount > 0} onClick={() => run(() => completeProject({ projectId, expectedLockVersion: lockVersion }))}>确认结束</Button>}</DialogFooter>
    </DialogContent></Dialog>
  </div>;
}
