"use client";

import type { FormEventHandler } from "react";
import { useState } from "react";
import { ImageIcon, MessageSquare, Send } from "lucide-react";
import type { FeedbackStatus } from "@prisma/client";
import { ImagePreview } from "@/components/image-preview";
import {
  FeedbackImageInput,
  handleFeedbackPaste,
} from "@/components/feedback/feedback-images";
import type {
  FeedbackAttachmentView,
  FeedbackImageFiles,
  FeedbackView,
} from "@/components/feedback/feedback-types";
import {
  feedbackStatusBadgeVariant,
  formatFeedbackTime,
} from "@/components/feedback/feedback-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { feedbackStatusLabels } from "@/lib/feedback-labels";
import { cn } from "@/lib/utils";

const statusOptions: FeedbackStatus[] = ["OPEN", "IN_PROGRESS", "CLOSED"];

export function FeedbackConversation({
  feedback,
  avatarByOpenId,
  currentUserOpenId,
  isSuperAdmin,
  canReply,
  replyPending,
  statusPending,
  replyImages,
  setReplyImages,
  onReply,
  onStatus,
}: {
  feedback?: FeedbackView;
  avatarByOpenId: Record<string, string | null>;
  currentUserOpenId: string;
  isSuperAdmin: boolean;
  canReply: boolean;
  replyPending: boolean;
  statusPending: boolean;
  replyImages: FeedbackImageFiles["files"];
  setReplyImages: FeedbackImageFiles["setFiles"];
  onReply: FormEventHandler<HTMLFormElement>;
  onStatus: (status: FeedbackStatus) => void;
}) {
  return (
    <Card className="flex min-h-[32rem] min-w-0 flex-col overflow-hidden lg:h-full lg:min-h-0">
      {feedback ? (
        <>
          <CardHeader className="shrink-0 border-b">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle>反馈详情</CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">
                  提交人：{feedback.submitterName} · 创建于{" "}
                  {formatFeedbackTime(feedback.createdAt)}
                </p>
              </div>
              <Badge variant={feedbackStatusBadgeVariant(feedback.status)}>
                {feedbackStatusLabels[feedback.status]}
              </Badge>
            </div>
            {isSuperAdmin && (
              <div className="flex flex-wrap gap-2 pt-2">
                {statusOptions.map((status) => (
                  <Button
                    key={status}
                    type="button"
                    size="sm"
                    variant={feedback.status === status ? "default" : "outline"}
                    disabled={statusPending}
                    onClick={() => onStatus(status)}
                  >
                    {feedbackStatusLabels[status]}
                  </Button>
                ))}
              </div>
            )}
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col gap-5">
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
              {feedback.messages.map((message) => {
                const mine = message.authorOpenId === currentUserOpenId;
                return (
                  <div
                    key={message.id}
                    className={cn("flex gap-3", mine && "flex-row-reverse text-right")}
                  >
                    <FeedbackAvatar
                      openId={message.authorOpenId}
                      name={message.authorName}
                      avatarByOpenId={avatarByOpenId}
                    />
                    <div
                      className={cn(
                        "min-w-0 max-w-[min(42rem,85%)] rounded-lg border bg-background p-3 text-left",
                        mine && "bg-primary/5",
                      )}
                    >
                      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">{message.authorName}</span>
                        <span>{formatFeedbackTime(message.createdAt)}</span>
                      </div>
                      {message.body && (
                        <p className="whitespace-pre-wrap break-words text-sm leading-6">
                          {message.body}
                        </p>
                      )}
                      {message.attachments.length > 0 && (
                        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                          {message.attachments.map((attachment) => (
                            <FeedbackAttachment key={attachment.id} attachment={attachment} />
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {canReply ? (
              <form onSubmit={onReply} className="shrink-0 space-y-3 border-t pt-4">
                <input type="hidden" name="feedbackId" value={feedback.id} />
                <Textarea
                  name="body"
                  placeholder="继续补充情况，或回复处理结果"
                  rows={3}
                  disabled={replyPending}
                  className="max-h-24 resize-none overflow-y-auto"
                  onPaste={(event) => handleFeedbackPaste(event, {
                    files: replyImages,
                    setFiles: setReplyImages,
                  })}
                />
                <FeedbackImageInput
                  files={replyImages}
                  setFiles={setReplyImages}
                  disabled={replyPending}
                  compact
                />
                <div className="flex justify-end">
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
        <CardContent className="flex min-h-[32rem] flex-1 flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
          <MessageSquare className="h-8 w-8" />
          选择一条反馈查看详情
        </CardContent>
      )}
    </Card>
  );
}

function FeedbackAvatar({
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
      <img src={avatar} alt={name} className="h-8 w-8 shrink-0 rounded-full object-cover" />
    );
  }
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
      {initial}
    </span>
  );
}

function FeedbackAttachment({ attachment }: { attachment: FeedbackAttachmentView }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="flex aspect-square min-w-0 items-center justify-center overflow-hidden rounded-md border bg-muted">
        <span className="flex h-full w-full flex-col items-center justify-center gap-2 p-2 text-center text-xs text-muted-foreground">
          <ImageIcon className="h-5 w-5" />
          <span className="line-clamp-2 break-all">{attachment.fileName}</span>
        </span>
      </div>
    );
  }
  return (
    <ImagePreview
      src={attachment.path}
      alt={attachment.fileName}
      wrapperClassName="flex aspect-square min-w-0 items-center justify-center overflow-hidden rounded-md border bg-muted"
      className="h-full w-full object-cover"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={attachment.path}
        alt={attachment.fileName}
        loading="lazy"
        onError={() => setFailed(true)}
        className="h-full w-full object-cover"
      />
    </ImagePreview>
  );
}
