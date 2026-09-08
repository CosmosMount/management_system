"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  createComment,
  createRisk,
  deleteComment,
  getActivityVersion,
  loadCommentPage,
  loadRecentActivityPage,
  loadRiskPage,
  resolveRisk,
} from "@/app/actions/project-management/collaboration";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field-error";
import {
  fieldErrorsFullyHandled,
  firstFieldErrorMessage,
} from "@/lib/project-management/field-errors";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime } from "@/lib/project-management/labels";
import type {
  CollaborationCapabilities,
  CommentItemDto,
  CommentPageDto,
  RecentActivityItemDto,
  RecentActivityPageDto,
  RiskItemDto,
  RiskPageDto,
} from "@/lib/project-management/queries/collaboration-queries";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

type TargetType = "PROJECT" | "TASK";
type RiskSource = "DIRECT" | "TASKS";
type Notice = { kind: "success" | "error" | "info"; message: string } | null;

export type CollaborationInitialData = {
  targetType: TargetType;
  targetId: string;
  capabilities: CollaborationCapabilities;
  directActiveRisks: RiskPageDto;
  directResolvedRisks: RiskPageDto;
  taskActiveRisks?: RiskPageDto;
  taskResolvedRisks?: RiskPageDto;
  comments: CommentPageDto;
  activity: RecentActivityPageDto;
  activityVersion: string;
};

export function CollaborationLeftSidebar({ data }: { data: CollaborationInitialData }) {
  return (
    <div className="min-w-0 space-y-4">
      <RiskPanel data={data} />
      <CommentPanel data={data} />
    </div>
  );
}

export function CollaborationRightSidebar({ data }: { data: CollaborationInitialData }) {
  return (
    <div className="min-w-0">
      <RecentActivityPanel data={data} />
      <ActivityVersionPoller
        targetType={data.targetType}
        targetId={data.targetId}
        initialToken={data.activityVersion}
      />
    </div>
  );
}

export function CreateRiskCard({
  targetType,
  targetId,
  canCreate,
}: {
  targetType: TargetType;
  targetId: string;
  canCreate: boolean;
}) {
  const router = useRouter();
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [contentError, setContentError] = useState("");
  if (!canCreate) return null;
  const trimmed = content.trim();
  return (
    <section className="min-w-0 rounded-xl border border-border bg-card p-4 sm:p-5">
      <h2 className="font-semibold">提出{targetType === "PROJECT" ? "项目" : "任务"}风险</h2>
      <label className="mt-3 block text-sm font-medium" htmlFor={`${targetType}-${targetId}-risk`}>
        风险内容
      </label>
      <Textarea
        id={`${targetType}-${targetId}-risk`}
        className="mt-2 min-h-28"
        value={content}
        maxLength={2_000}
        disabled={busy}
        aria-invalid={Boolean(contentError)}
        aria-describedby={contentError ? `${targetType}-${targetId}-risk-error` : undefined}
        onChange={(event) => { setContent(event.target.value); if (event.target.value.trim()) setContentError(""); }}
        placeholder="说明当前风险、影响和需要关注的问题"
      />
      <FieldError id={`${targetType}-${targetId}-risk-error`} messages={contentError} className="mt-1.5" />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{content.length}/2000</span>
        <Button
          type="button"
          disabled={busy}
          onClick={async () => {
            if (busy) return;
            if (!trimmed) {
              setContentError("请填写风险内容");
              requestAnimationFrame(() => document.getElementById(`${targetType}-${targetId}-risk`)?.focus());
              return;
            }
            setBusy(true);
            setNotice({ kind: "info", message: "正在提出风险…" });
            const result = await createRisk({ targetType, targetId, content }).catch(() => null);
            if (!result) {
              setNotice({ kind: "error", message: "网络或服务暂时不可用，请稍后重试。" });
            } else if (!result.ok) {
              const fieldMessage = firstFieldErrorMessage(
                result.error.fieldErrors,
                "content",
              );
              if (fieldMessage) {
                setContentError(fieldMessage);
                requestAnimationFrame(() =>
                  document.getElementById(`${targetType}-${targetId}-risk`)?.focus(),
                );
                setNotice(
                  fieldErrorsFullyHandled(result.error.fieldErrors, ["content"])
                    ? null
                    : { kind: "error", message: result.error.message },
                );
              } else setNotice({ kind: "error", message: result.error.message });
            } else {
              setContent("");
              setNotice({ kind: "success", message: "风险已提出。" });
              toast.success("风险已提出");
              router.refresh();
            }
            setBusy(false);
          }}
        >
          {busy ? "提交中…" : "提出风险"}
        </Button>
      </div>
      <InlineNotice notice={notice} />
    </section>
  );
}

export function RiskPanel({ data }: { data: CollaborationInitialData }) {
  return (
    <section id="risks" className="min-w-0 scroll-mt-20 rounded-xl border border-border bg-card p-4">
      <h2 className="font-semibold">{data.targetType === "PROJECT" ? "项目" : "任务"}风险</h2>
      <div className="mt-3 space-y-5">
        <RiskGroup
          key={`direct:${pageKey(data.directActiveRisks)}:${pageKey(data.directResolvedRisks)}`}
          heading={data.targetType === "PROJECT" ? "项目自身风险" : "风险记录"}
          targetType={data.targetType}
          targetId={data.targetId}
          source="DIRECT"
          initialActive={data.directActiveRisks}
          initialResolved={data.directResolvedRisks}
        />
        {data.targetType === "PROJECT" && data.taskActiveRisks && data.taskResolvedRisks && (
          <RiskGroup
            key={`tasks:${pageKey(data.taskActiveRisks)}:${pageKey(data.taskResolvedRisks)}`}
            heading="当前所属任务风险"
            targetType="PROJECT"
            targetId={data.targetId}
            source="TASKS"
            initialActive={data.taskActiveRisks}
            initialResolved={data.taskResolvedRisks}
          />
        )}
      </div>
    </section>
  );
}

function RiskGroup({
  heading,
  targetType,
  targetId,
  source,
  initialActive,
  initialResolved,
}: {
  heading: string;
  targetType: TargetType;
  targetId: string;
  source: RiskSource;
  initialActive: RiskPageDto;
  initialResolved: RiskPageDto;
}) {
  const router = useRouter();
  const [active, setActive] = useState(initialActive);
  const [resolved, setResolved] = useState(initialResolved);
  const [showResolved, setShowResolved] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [resolving, setResolving] = useState<RiskItemDto | null>(null);
  const [resolveNote, setResolveNote] = useState("");
  const [resolveError, setResolveError] = useState("");
  const loadMore = async (status: "ACTIVE" | "RESOLVED") => {
    const page = status === "ACTIVE" ? active : resolved;
    if (!page.nextCursor || busyKey) return;
    setBusyKey(status);
    const result = await loadRiskPage({
      targetType,
      targetId,
      source,
      status,
      cursor: page.nextCursor,
      limit: 20,
    }).catch(() => null);
    if (
      result?.ok === false &&
      result.error.code === "VALIDATION_ERROR" &&
      result.error.message === "风险分页游标无效"
    ) {
      const recovered = await loadRiskPage({
        targetType,
        targetId,
        source,
        status,
        cursor: null,
        limit: 20,
      }).catch(() => null);
      if (recovered?.ok) {
        if (status === "ACTIVE") setActive(recovered.data);
        else setResolved(recovered.data);
        setNotice({ kind: "info", message: "风险列表已变化，已重新加载。" });
      } else {
        setNotice({
          kind: "error",
          message:
            recovered?.ok === false
              ? recovered.error.message
              : "风险加载失败，请重试。",
        });
      }
      setBusyKey(null);
      return;
    }
    if (!result || !result.ok) {
      setNotice({ kind: "error", message: result?.error.message ?? "风险加载失败，请重试。" });
    } else {
      const next = mergeRiskPage(page, result.data);
      if (status === "ACTIVE") setActive(next);
      else setResolved(next);
      setNotice(null);
    }
    setBusyKey(null);
  };

  return (
    <div className="min-w-0 border-t border-border pt-4 first:border-t-0 first:pt-0">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <h3 className="min-w-0 break-words text-sm font-medium">{heading}</h3>
        <Badge variant={active.totalCount > 0 ? "destructive" : "secondary"}>
          {active.totalCount} 条未解决
        </Badge>
      </div>
      <div className="mt-3 space-y-3">
        {active.items.length === 0 ? (
          <EmptyBox text={resolved.totalCount > 0 ? "当前无未解决风险" : "从未记录风险"} />
        ) : (
          active.items.map((risk) => (
            <RiskItem key={risk.id} risk={risk} onResolve={() => { setResolving(risk); setResolveNote(""); setResolveError(""); setNotice(null); }} />
          ))
        )}
        {active.nextCursor && (
          <Button type="button" variant="outline" size="sm" className="w-full" disabled={busyKey !== null} onClick={() => void loadMore("ACTIVE")}>
            {busyKey === "ACTIVE" ? "加载中…" : "加载更多未解决风险"}
          </Button>
        )}
      </div>

      <div className="mt-4 border-t border-border pt-3">
        <Button type="button" variant="ghost" size="sm" className="w-full justify-between" onClick={() => setShowResolved((value) => !value)}>
          <span>已解决历史</span><span>{resolved.totalCount} 条</span>
        </Button>
        {showResolved && (
          <div className="mt-3 space-y-3">
            {resolved.items.length === 0 ? <EmptyBox text="暂无已解决风险" /> : resolved.items.map((risk) => <RiskItem key={risk.id} risk={risk} />)}
            {resolved.nextCursor && (
              <Button type="button" variant="outline" size="sm" className="w-full" disabled={busyKey !== null} onClick={() => void loadMore("RESOLVED")}>
                {busyKey === "RESOLVED" ? "加载中…" : "加载更多已解决风险"}
              </Button>
            )}
          </div>
        )}
      </div>
      <InlineNotice notice={notice} />

      <Dialog open={Boolean(resolving)} onOpenChange={(open) => { if (!open && busyKey !== "resolve") setResolving(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>解决风险</DialogTitle>
            <DialogDescription className="whitespace-pre-wrap break-words">
              {resolving ? `${resolving.target.name}：${resolving.content}` : "填写解决说明。"}
            </DialogDescription>
          </DialogHeader>
          <label className="text-sm font-medium" htmlFor={`resolve-${resolving?.id ?? "risk"}`}>解决说明</label>
          <Input id={`resolve-${resolving?.id ?? "risk"}`} value={resolveNote} maxLength={500} disabled={busyKey === "resolve"} aria-invalid={Boolean(resolveError)} aria-describedby={resolveError ? `resolve-${resolving?.id ?? "risk"}-error` : undefined} onChange={(event) => { const value = event.target.value.replace(/[\r\n]/g, ""); setResolveNote(value); if (value.trim()) setResolveError(""); }} />
          <FieldError id={`resolve-${resolving?.id ?? "risk"}-error`} messages={resolveError} />
          <div className="text-right text-xs text-muted-foreground">{resolveNote.length}/500</div>
          <InlineNotice notice={notice} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={busyKey === "resolve"} onClick={() => setResolving(null)}>取消</Button>
            <Button
              type="button"
              disabled={busyKey === "resolve"}
              onClick={async () => {
                if (!resolving || busyKey) return;
                if (!resolveNote.trim()) {
                  setResolveError("请填写解决说明");
                  requestAnimationFrame(() => document.getElementById(`resolve-${resolving.id}`)?.focus());
                  return;
                }
                setBusyKey("resolve");
                const result = await resolveRisk({ riskId: resolving.id, resolveNote }).catch(() => null);
                if (!result || !result.ok) {
                  const fieldMessage = result?.ok === false
                    ? firstFieldErrorMessage(result.error.fieldErrors, "resolveNote")
                    : undefined;
                  if (fieldMessage) {
                    setResolveError(fieldMessage);
                    requestAnimationFrame(() =>
                      document.getElementById(`resolve-${resolving.id}`)?.focus(),
                    );
                    setNotice(
                      result?.ok === false && fieldErrorsFullyHandled(result.error.fieldErrors, ["resolveNote"])
                        ? null
                        : { kind: "error", message: result?.ok === false ? result.error.message : "风险解决失败，请重试。" },
                    );
                  }
                  else setNotice({ kind: "error", message: result?.ok === false ? result.error.message : "风险解决失败，请重试。" });
                } else {
                  setActive((page) => ({ ...page, items: page.items.filter((item) => item.id !== resolving.id), totalCount: Math.max(0, page.totalCount - 1) }));
                  setResolving(null);
                  setNotice({ kind: "success", message: "风险已解决。" });
                  toast.success("风险已解决");
                  router.refresh();
                }
                setBusyKey(null);
              }}
            >
              {busyKey === "resolve" ? "提交中…" : "确认解决"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RiskItem({ risk, onResolve }: { risk: RiskItemDto; onResolve?: () => void }) {
  return (
    <article className={cn("min-w-0 rounded-lg border p-3", risk.status === "ACTIVE" ? "border-amber-300 bg-amber-50/60" : "border-border bg-muted/30")}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        {risk.target.type === "TASK" ? (
          <Link className="min-w-0 break-words text-xs font-medium text-primary hover:underline" href={routes.progress.taskDetail(risk.target.id)}>{risk.target.name}</Link>
        ) : <span className="min-w-0 break-words text-xs font-medium">{risk.target.name}</span>}
        <Badge variant={risk.status === "ACTIVE" ? "destructive" : "secondary"}>{risk.status === "ACTIVE" ? "未解决" : "已解决"}</Badge>
      </div>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">{risk.content}</p>
      <p className="mt-2 break-words text-xs text-muted-foreground">{risk.createdByName} · {formatDateTime(risk.createdAt)}</p>
      {risk.status === "RESOLVED" && (
        <div className="mt-2 rounded-md bg-emerald-50 p-2 text-xs text-emerald-900">
          <p className="whitespace-pre-wrap break-words">{risk.resolveNote}</p>
          <p className="mt-1">{risk.resolvedByName} · {formatDateTime(risk.resolvedAt)}</p>
        </div>
      )}
      {risk.canResolve && onResolve && <Button type="button" variant="outline" size="sm" className="mt-3 w-full" onClick={onResolve}>解决风险</Button>}
    </article>
  );
}

export function CommentPanel({ data }: { data: CollaborationInitialData }) {
  const router = useRouter();
  const [page, setPage] = useState(data.comments);
  const serverPageKey = commentPageKey(data.comments);
  const [lastServerPageKey, setLastServerPageKey] = useState(serverPageKey);
  if (lastServerPageKey !== serverPageKey) {
    setLastServerPageKey(serverPageKey);
    setPage(data.comments);
  }
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [contentError, setContentError] = useState("");
  const submit = async () => {
    if (busy) return;
    if (!content.trim()) {
      setContentError("请输入评论内容");
      requestAnimationFrame(() => document.getElementById(`${data.targetType}-${data.targetId}-comment`)?.focus());
      return;
    }
    setBusy(true);
    setNotice({ kind: "info", message: "正在发布评论…" });
    const result = await createComment({ targetType: data.targetType, targetId: data.targetId, content }).catch(() => null);
    if (!result || !result.ok) {
      const fieldMessage = result?.ok === false
        ? firstFieldErrorMessage(result.error.fieldErrors, "content")
        : undefined;
      if (fieldMessage) {
        setContentError(fieldMessage);
        requestAnimationFrame(() =>
          document.getElementById(`${data.targetType}-${data.targetId}-comment`)?.focus(),
        );
        setNotice(
          result?.ok === false && fieldErrorsFullyHandled(result.error.fieldErrors, ["content"])
            ? null
            : { kind: "error", message: result?.ok === false ? result.error.message : "评论发布失败，请重试。" },
        );
      }
      else setNotice({ kind: "error", message: result?.ok === false ? result.error.message : "评论发布失败，请重试。" });
    } else {
      setContent("");
      setNotice({ kind: "success", message: "评论已发布。" });
      toast.success("评论已发布");
      router.refresh();
    }
    setBusy(false);
  };
  const remove = async (comment: CommentItemDto) => {
    if (busy || !window.confirm(`确认删除 ${comment.authorName} 的评论“${preview(comment.content)}”吗？`)) return;
    setBusy(true);
    const result = await deleteComment({ commentId: comment.id }).catch(() => null);
    if (!result || !result.ok) {
      setNotice({ kind: "error", message: result?.error.message ?? "评论删除失败，请重试。" });
    } else {
      setPage((current) => ({ ...current, items: current.items.filter((item) => item.id !== comment.id), totalCount: Math.max(0, current.totalCount - 1) }));
      setNotice({ kind: "success", message: "评论已删除。" });
      toast.success("评论已删除");
      router.refresh();
    }
    setBusy(false);
  };
  return (
    <section className="min-w-0 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-2"><h2 className="font-semibold">{data.targetType === "PROJECT" ? "项目" : "任务"}评论</h2><Badge variant="secondary">{page.totalCount}</Badge></div>
      <label className="mt-3 block text-sm font-medium" htmlFor={`${data.targetType}-${data.targetId}-comment`}>发表评论</label>
      <Textarea id={`${data.targetType}-${data.targetId}-comment`} className="mt-2 min-h-24" value={content} maxLength={1_000} disabled={busy || !data.capabilities.canCreateComment} aria-invalid={Boolean(contentError)} aria-describedby={contentError ? `${data.targetType}-${data.targetId}-comment-error` : undefined} onChange={(event) => { setContent(event.target.value); if (event.target.value.trim()) setContentError(""); }} placeholder="输入评论内容" />
      <FieldError id={`${data.targetType}-${data.targetId}-comment-error`} messages={contentError} className="mt-1.5" />
      <div className="mt-2 flex items-center justify-between gap-2"><span className="text-xs text-muted-foreground">{content.length}/1000</span><Button type="button" size="sm" disabled={busy || !data.capabilities.canCreateComment} onClick={() => void submit()}>{busy ? "处理中…" : "发布评论"}</Button></div>
      <InlineNotice notice={notice} />
      <div className="mt-4 space-y-3 border-t border-border pt-4">
        {page.items.length === 0 ? <EmptyBox text="暂无评论" /> : page.items.map((comment) => (
          <article key={comment.id} className="min-w-0 rounded-lg border border-border p-3">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2"><p className="min-w-0 break-words text-sm font-medium">{comment.authorName}{comment.authorInactive ? "（已停用）" : ""}</p>{comment.canDelete && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void remove(comment)}>删除</Button>}</div>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">{comment.content}</p>
            <p className="mt-2 text-xs text-muted-foreground">{formatDateTime(comment.createdAt)}</p>
          </article>
        ))}
        {page.nextCursor && <Button type="button" variant="outline" size="sm" className="w-full" disabled={busy} onClick={async () => {
          setBusy(true);
          const result = await loadCommentPage({ targetType: data.targetType, targetId: data.targetId, cursor: page.nextCursor, limit: 20 }).catch(() => null);
          if (!result || !result.ok) setNotice({ kind: "error", message: result?.error.message ?? "评论加载失败，请重试。" });
          else setPage((current) => mergeCommentPage(current, result.data));
          setBusy(false);
        }}>{busy ? "加载中…" : "加载更多评论"}</Button>}
      </div>
    </section>
  );
}

const projectFilters = [
  ["ALL", "全部"], ["PROJECT", "项目"], ["TASK", "任务"], ["RISK", "风险"], ["COMMENT", "评论"], ["REVIEW", "审批"],
] as const;
const taskFilters = [
  ["ALL", "全部"], ["TASK", "任务"], ["PLAN_NODE", "计划节点"], ["RISK", "风险"], ["COMMENT", "评论"], ["REVIEW", "审批"],
] as const;

export function RecentActivityPanel({ data }: { data: CollaborationInitialData }) {
  const filters = data.targetType === "PROJECT" ? projectFilters : taskFilters;
  const [category, setCategory] = useState<(typeof filters)[number][0]>("ALL");
  const [page, setPage] = useState(data.activity);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const versionRef = useRef(data.activityVersion);
  const requestRef = useRef(0);

  const reload = useCallback(async (nextCategory: string) => {
    const request = ++requestRef.current;
    setBusy(true);
    const result = await loadRecentActivityPage({ targetType: data.targetType, targetId: data.targetId, category: nextCategory, cursor: null, limit: 20 }).catch(() => null);
    if (request !== requestRef.current) return;
    if (!result || !result.ok) setNotice({ kind: "error", message: result?.error.message ?? "近期动态加载失败，请重试。" });
    else { setPage(result.data); setNotice(null); }
    setBusy(false);
  }, [data.targetId, data.targetType]);

  useEffect(() => {
    if (versionRef.current === data.activityVersion) return;
    versionRef.current = data.activityVersion;
    void reload(category);
  }, [category, data.activityVersion, reload]);

  useEffect(() => {
    const listener = () => void reload(category);
    window.addEventListener("pm-activity-version", listener);
    return () => window.removeEventListener("pm-activity-version", listener);
  }, [category, reload]);

  return (
    <section className="min-w-0 rounded-xl border border-border bg-card p-4">
      <h2 className="font-semibold">近期动态</h2>
      <div className="mt-3 flex flex-wrap gap-1" aria-label="近期动态筛选">
        {filters.map(([value, label]) => <Button key={value} type="button" size="sm" variant={category === value ? "default" : "ghost"} disabled={busy} onClick={() => { setCategory(value); void reload(value); }}>{label}</Button>)}
      </div>
      <InlineNotice notice={notice} />
      <div className="mt-4 space-y-3">
        {busy && page.items.length === 0 ? <EmptyBox text="正在加载近期动态…" /> : page.items.length === 0 ? <EmptyBox text="暂无近期动态" /> : page.items.map((item) => <ActivityItem key={item.id} item={item} />)}
        {page.nextCursor && <Button type="button" variant="outline" size="sm" className="w-full" disabled={busy} onClick={async () => {
          const request = ++requestRef.current;
          setBusy(true);
          const result = await loadRecentActivityPage({ targetType: data.targetType, targetId: data.targetId, category, cursor: page.nextCursor, limit: 20 }).catch(() => null);
          if (request !== requestRef.current) return;
          if (!result || !result.ok) setNotice({ kind: "error", message: result?.error.message ?? "近期动态加载失败，请重试。" });
          else setPage((current) => mergeActivityPage(current, result.data));
          setBusy(false);
        }}>{busy ? "加载中…" : "加载更早动态"}</Button>}
      </div>
    </section>
  );
}

function ActivityItem({ item }: { item: RecentActivityItemDto }) {
  const body = <><div className="flex min-w-0 flex-wrap items-center gap-2"><Badge variant="outline">{activityCategoryLabel(item.category)}</Badge><span className="min-w-0 break-words text-sm font-medium">{item.title}</span></div><p className="mt-2 break-words text-xs text-muted-foreground">{item.actorName} · {item.targetName} · {formatDateTime(item.createdAt)}</p><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">{item.summary}</p></>;
  return item.linkPath ? <Link href={item.linkPath} className="block min-w-0 rounded-lg border border-border p-3 hover:bg-muted/40">{body}</Link> : <article className="min-w-0 rounded-lg border border-border p-3">{body}</article>;
}

export function ActivityVersionPoller({ targetType, targetId, initialToken }: { targetType: TargetType; targetId: string; initialToken: string }) {
  const router = useRouter();
  const tokenRef = useRef(initialToken);
  const requestRef = useRef(0);
  const runningRef = useRef(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => { tokenRef.current = initialToken; }, [initialToken]);
  useEffect(() => {
    let disposed = false;
    const check = async () => {
      if (disposed || document.visibilityState !== "visible" || runningRef.current) return;
      runningRef.current = true;
      const request = ++requestRef.current;
      const result = await getActivityVersion({ targetType, targetId }).catch(() => null);
      const currentAndVisible =
        !disposed &&
        request === requestRef.current &&
        document.visibilityState === "visible";
      if (currentAndVisible) setFailed(!result?.ok);
      if (currentAndVisible && result?.ok && result.data.token !== tokenRef.current) {
        tokenRef.current = result.data.token;
        window.dispatchEvent(new Event("pm-activity-version"));
        router.refresh();
      }
      runningRef.current = false;
    };
    const timer = window.setInterval(() => void check(), 5_000);
    const visibility = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", visibility);
    return () => { disposed = true; requestRef.current += 1; window.clearInterval(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [router, targetId, targetType]);
  return failed ? <p className="mt-2 break-words text-xs text-muted-foreground" role="status">自动更新暂时不可用，系统将在下一周期重试。</p> : null;
}

function InlineNotice({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return <p className={cn("mt-3 break-words rounded-md px-3 py-2 text-sm", notice.kind === "error" && "bg-destructive/10 text-destructive", notice.kind === "success" && "bg-emerald-50 text-emerald-800", notice.kind === "info" && "bg-muted text-muted-foreground")} role={notice.kind === "error" ? "alert" : "status"}>{notice.message}</p>;
}

function EmptyBox({ text }: { text: string }) { return <div className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">{text}</div>; }
function pageKey(page: RiskPageDto) { return `${page.totalCount}:${page.nextCursor ?? ""}:${page.items.map((item) => `${item.id}:${item.status}`).join(",")}`; }
export function commentPageKey(page: CommentPageDto) { return `${page.totalCount}:${page.nextCursor ?? ""}:${page.items.map((item) => item.id).join(",")}`; }
function mergeRiskPage(current: RiskPageDto, next: RiskPageDto): RiskPageDto { const byId = new Map(current.items.map((item) => [item.id, item])); for (const item of next.items) byId.set(item.id, item); return { items: [...byId.values()], totalCount: next.totalCount, nextCursor: next.nextCursor }; }
function mergeCommentPage(current: CommentPageDto, next: CommentPageDto): CommentPageDto { const byId = new Map(current.items.map((item) => [item.id, item])); for (const item of next.items) byId.set(item.id, item); return { items: [...byId.values()], totalCount: next.totalCount, nextCursor: next.nextCursor }; }
function mergeActivityPage(current: RecentActivityPageDto, next: RecentActivityPageDto): RecentActivityPageDto { const byId = new Map(current.items.map((item) => [item.id, item])); for (const item of next.items) byId.set(item.id, item); return { items: [...byId.values()], nextCursor: next.nextCursor }; }
function preview(value: string) { return value.length <= 80 ? value : `${value.slice(0, 80)}…`; }
function activityCategoryLabel(value: RecentActivityItemDto["category"]) { return ({ PROJECT: "项目", TASK: "任务", PLAN_NODE: "计划节点", RISK: "风险", COMMENT: "评论", REVIEW: "审批" } as const)[value]; }
