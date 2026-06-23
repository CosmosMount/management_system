"use client";

import type { FormEvent } from "react";
import { useMemo, useState } from "react";
import { ImageIcon, MessageSquare, Plus, Send } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import type { FeedbackStatus } from "@prisma/client";
import {
  createFeedback,
  replyFeedback,
  updateFeedbackStatus,
} from "@/app/actions/feedback";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { feedbackStatusLabels } from "@/lib/feedback-labels";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type FeedbackAttachmentView = {
  id: string;
  path: string;
  fileName: string;
  mimeType: string;
  size: number;
  sortOrder: number;
};

type FeedbackMessageView = {
  id: string;
  authorOpenId: string;
  authorName: string;
  body: string;
  createdAt: string;
  attachments: FeedbackAttachmentView[];
};

export type FeedbackView = {
  id: string;
  submitterOpenId: string;
  submitterName: string;
  status: FeedbackStatus;
  lastMessageAt: string;
  closedAt: string | null;
  createdAt: string;
  messages: FeedbackMessageView[];
};

type Props = {
  feedbacks: FeedbackView[];
  avatarByOpenId: Record<string, string | null>;
  currentUserOpenId: string;
  isSuperAdmin: boolean;
};

const statusOptions: FeedbackStatus[] = ["OPEN", "IN_PROGRESS", "CLOSED"];

function formatTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusBadgeVariant(status: FeedbackStatus) {
  if (status === "CLOSED") return "secondary";
  if (status === "IN_PROGRESS") return "outline";
  return "default";
}

function countAttachments(feedback: FeedbackView): number {
  return feedback.messages.reduce(
    (sum, message) => sum + message.attachments.length,
    0,
  );
}

function firstMessage(feedback: FeedbackView): FeedbackMessageView | undefined {
  return feedback.messages[0];
}

function lastMessage(feedback: FeedbackView): FeedbackMessageView | undefined {
  return feedback.messages.at(-1);
}

function messagePreview(feedback: FeedbackView): string {
  const message = firstMessage(feedback);
  if (!message) return "暂无内容";
  if (message.body.trim()) return message.body.trim();
  const imageCount = message.attachments.length;
  return imageCount > 0 ? `上传了 ${imageCount} 张图片` : "暂无内容";
}

function Avatar({
  openId,
  name,
  avatarByOpenId,
}: {
  openId: string;
  name: string;
  avatarByOpenId: Record<string, string | null>;
}) {
  const avatar = avatarByOpenId[openId];
  const initial = name.trim().slice(0, 1) || "?";

  if (avatar) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={avatar}
        alt={name}
        className="h-8 w-8 shrink-0 rounded-full object-cover"
      />
    );
  }

  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
      {initial}
    </span>
  );
}

export function FeedbackCenter({
  feedbacks,
  avatarByOpenId,
  currentUserOpenId,
  isSuperAdmin,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const newFromUrl = searchParams.get("new") === "1";
  const [newOpenState, setNewOpenState] = useState(false);
  const [statusFilter, setStatusFilter] = useState<FeedbackStatus | "ALL">(
    "ALL",
  );
  const [selectedId, setSelectedId] = useState(
    searchParams.get("selected") ?? feedbacks[0]?.id ?? "",
  );
  const [createPending, setCreatePending] = useState(false);
  const [replyPending, setReplyPending] = useState(false);
  const [statusPending, setStatusPending] = useState(false);
  const newOpen = newOpenState || newFromUrl;

  const filteredFeedbacks = useMemo(() => {
    if (!isSuperAdmin || statusFilter === "ALL") return feedbacks;
    return feedbacks.filter((feedback) => feedback.status === statusFilter);
  }, [feedbacks, isSuperAdmin, statusFilter]);

  const selectedFeedback =
    filteredFeedbacks.find((feedback) => feedback.id === selectedId) ??
    filteredFeedbacks[0];
  const canReply =
    !!selectedFeedback &&
    (isSuperAdmin || selectedFeedback.status !== "CLOSED");

  function handleNewOpenChange(open: boolean) {
    setNewOpenState(open);
    if (!open && newFromUrl) {
      const selected = selectedFeedback?.id;
      router.replace(selected ? `/feedback?selected=${selected}` : "/feedback");
    }
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreatePending(true);
    try {
      const form = event.currentTarget;
      const result = await createFeedback(new FormData(form));
      toast.success("反馈已提交");
      form.reset();
      setNewOpenState(false);
      setSelectedId(result.id);
      router.push(`/feedback?selected=${result.id}`);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "提交失败");
    } finally {
      setCreatePending(false);
    }
  }

  async function handleReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedFeedback) return;
    setReplyPending(true);
    try {
      const form = event.currentTarget;
      await replyFeedback(new FormData(form));
      toast.success("回复已发送");
      form.reset();
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "发送失败");
    } finally {
      setReplyPending(false);
    }
  }

  async function handleStatus(status: FeedbackStatus) {
    if (!selectedFeedback) return;
    const formData = new FormData();
    formData.set("feedbackId", selectedFeedback.id);
    formData.set("status", status);
    setStatusPending(true);
    try {
      await updateFeedbackStatus(formData);
      toast.success("状态已更新");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "更新失败");
    } finally {
      setStatusPending(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
      <Card className="min-h-[32rem]">
        <CardHeader className="border-b">
          <div className="flex items-center justify-between gap-3">
            <CardTitle>{isSuperAdmin ? "反馈清单" : "我的反馈"}</CardTitle>
            <Button size="sm" onClick={() => setNewOpenState(true)}>
              <Plus className="h-4 w-4" />
              新反馈
            </Button>
          </div>
          {isSuperAdmin && (
            <div className="flex flex-wrap gap-2 pt-2">
              <Button
                type="button"
                size="sm"
                variant={statusFilter === "ALL" ? "default" : "outline"}
                onClick={() => setStatusFilter("ALL")}
              >
                全部
              </Button>
              {statusOptions.map((status) => (
                <Button
                  key={status}
                  type="button"
                  size="sm"
                  variant={statusFilter === status ? "default" : "outline"}
                  onClick={() => setStatusFilter(status)}
                >
                  {feedbackStatusLabels[status]}
                </Button>
              ))}
            </div>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {filteredFeedbacks.length === 0 ? (
            <div className="flex min-h-[20rem] flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
              <MessageSquare className="h-8 w-8" />
              暂无反馈
            </div>
          ) : (
            <div className="divide-y">
              {filteredFeedbacks.map((feedback) => {
                const last = lastMessage(feedback);
                const active = selectedFeedback?.id === feedback.id;
                const attachmentCount = countAttachments(feedback);
                return (
                  <button
                    key={feedback.id}
                    type="button"
                    className={cn(
                      "block w-full px-4 py-3 text-left transition-colors hover:bg-muted/60",
                      active && "bg-muted",
                    )}
                    onClick={() => {
                      setSelectedId(feedback.id);
                      router.push(`/feedback?selected=${feedback.id}`);
                    }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-medium">
                          {messagePreview(feedback)}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {isSuperAdmin
                            ? `${feedback.submitterName} · `
                            : ""}
                          {last ? `${last.authorName} 更新 · ` : ""}
                          {formatTime(feedback.lastMessageAt)}
                        </p>
                      </div>
                      <Badge variant={statusBadgeVariant(feedback.status)}>
                        {feedbackStatusLabels[feedback.status]}
                      </Badge>
                    </div>
                    {attachmentCount > 0 && (
                      <div className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <ImageIcon className="h-3.5 w-3.5" />
                        {attachmentCount} 张图片
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="min-h-[32rem]">
        {selectedFeedback ? (
          <>
            <CardHeader className="border-b">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle>反馈详情</CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">
                    提交人：{selectedFeedback.submitterName} · 创建于{" "}
                    {formatTime(selectedFeedback.createdAt)}
                  </p>
                </div>
                <Badge variant={statusBadgeVariant(selectedFeedback.status)}>
                  {feedbackStatusLabels[selectedFeedback.status]}
                </Badge>
              </div>
              {isSuperAdmin && (
                <div className="flex flex-wrap gap-2 pt-2">
                  {statusOptions.map((status) => (
                    <Button
                      key={status}
                      type="button"
                      size="sm"
                      variant={
                        selectedFeedback.status === status
                          ? "default"
                          : "outline"
                      }
                      disabled={statusPending}
                      onClick={() => handleStatus(status)}
                    >
                      {feedbackStatusLabels[status]}
                    </Button>
                  ))}
                </div>
              )}
            </CardHeader>

            <CardContent className="space-y-5">
              <div className="max-h-[34rem] space-y-4 overflow-auto pr-1">
                {selectedFeedback.messages.map((message) => {
                  const mine = message.authorOpenId === currentUserOpenId;
                  return (
                    <div
                      key={message.id}
                      className={cn(
                        "flex gap-3",
                        mine && "flex-row-reverse text-right",
                      )}
                    >
                      <Avatar
                        openId={message.authorOpenId}
                        name={message.authorName}
                        avatarByOpenId={avatarByOpenId}
                      />
                      <div
                        className={cn(
                          "max-w-[min(42rem,85%)] rounded-lg border bg-background p-3 text-left",
                          mine && "bg-primary/5",
                        )}
                      >
                        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">
                            {message.authorName}
                          </span>
                          <span>{formatTime(message.createdAt)}</span>
                        </div>
                        {message.body && (
                          <p className="whitespace-pre-wrap break-words text-sm leading-6">
                            {message.body}
                          </p>
                        )}
                        {message.attachments.length > 0 && (
                          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                            {message.attachments.map((attachment) => (
                              <a
                                key={attachment.id}
                                href={attachment.path}
                                target="_blank"
                                rel="noreferrer"
                                className="block overflow-hidden rounded-md border bg-muted"
                              >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={attachment.path}
                                  alt={attachment.fileName}
                                  className="aspect-square w-full object-cover"
                                />
                              </a>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {canReply ? (
                <form onSubmit={handleReply} className="space-y-3 border-t pt-4">
                  <input
                    type="hidden"
                    name="feedbackId"
                    value={selectedFeedback.id}
                  />
                  <Textarea
                    name="body"
                    placeholder="继续补充情况，或回复处理结果"
                    rows={3}
                    disabled={replyPending}
                  />
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <Input
                      type="file"
                      name="images"
                      accept="image/png,image/jpeg,image/webp"
                      multiple
                      disabled={replyPending}
                      className="max-w-md"
                    />
                    <Button type="submit" disabled={replyPending}>
                      <Send className="h-4 w-4" />
                      发送回复
                    </Button>
                  </div>
                </form>
              ) : (
                <div className="rounded-md border bg-muted/60 px-4 py-3 text-sm text-muted-foreground">
                  该反馈已关闭，如需继续沟通请新建反馈。
                </div>
              )}
            </CardContent>
          </>
        ) : (
          <CardContent className="flex min-h-[32rem] flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
            <MessageSquare className="h-8 w-8" />
            选择一条反馈查看详情
          </CardContent>
        )}
      </Card>

      <Dialog open={newOpen} onOpenChange={handleNewOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <form onSubmit={handleCreate} className="space-y-4">
            <DialogHeader>
              <DialogTitle>提交反馈</DialogTitle>
              <DialogDescription>
                描述遇到的问题或建议，可上传多张截图辅助定位。
              </DialogDescription>
            </DialogHeader>
            <Textarea
              name="body"
              placeholder="请输入反馈内容"
              rows={5}
              required
              disabled={createPending}
            />
            <Input
              type="file"
              name="images"
              accept="image/png,image/jpeg,image/webp"
              multiple
              disabled={createPending}
            />
            <p className="text-xs text-muted-foreground">
              支持 PNG/JPG/WebP，最多 9 张，每张不超过 10MB。
            </p>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={createPending}
                onClick={() => handleNewOpenChange(false)}
              >
                取消
              </Button>
              <Button type="submit" disabled={createPending}>
                提交反馈
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
