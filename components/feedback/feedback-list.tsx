"use client";

import { ImageIcon, MessageSquare, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  FeedbackFilter,
  FeedbackMessageView,
  FeedbackView,
} from "@/components/feedback/feedback-types";
import { feedbackStatusLabels } from "@/lib/feedback-labels";
import { cn } from "@/lib/utils";

export const feedbackFilterOptions: Array<{
  value: FeedbackFilter;
  label: string;
}> = [
  { value: "ACTIVE", label: "活动" },
  { value: "OPEN", label: feedbackStatusLabels.OPEN },
  { value: "IN_PROGRESS", label: feedbackStatusLabels.IN_PROGRESS },
  { value: "CLOSED", label: feedbackStatusLabels.CLOSED },
  { value: "ALL", label: "全部" },
];

export function FeedbackList({
  feedbacks,
  selectedFeedbackId,
  statusFilter,
  isSuperAdmin,
  onNew,
  onFilterChange,
  onSelect,
}: {
  feedbacks: FeedbackView[];
  selectedFeedbackId?: string;
  statusFilter: FeedbackFilter;
  isSuperAdmin: boolean;
  onNew: () => void;
  onFilterChange: (filter: FeedbackFilter) => void;
  onSelect: (feedbackId: string) => void;
}) {
  return (
    <Card className="flex min-h-[32rem] min-w-0 flex-col overflow-hidden lg:h-full lg:min-h-0">
      <CardHeader className="shrink-0 border-b">
        <div className="flex items-center justify-between gap-3">
          <CardTitle>{isSuperAdmin ? "反馈清单" : "我的反馈"}</CardTitle>
          <Button size="sm" onClick={onNew}>
            <Plus className="h-4 w-4" />
            新反馈
          </Button>
        </div>
        <div className="flex flex-wrap gap-2 pt-2">
          {feedbackFilterOptions.map((option) => (
            <Button
              key={option.value}
              type="button"
              size="sm"
              variant={statusFilter === option.value ? "default" : "outline"}
              onClick={() => onFilterChange(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 overflow-y-auto p-0 [scrollbar-gutter:stable]">
        {feedbacks.length === 0 ? (
          <div className="flex min-h-[20rem] flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
            <MessageSquare className="h-8 w-8" />
            暂无反馈
          </div>
        ) : (
          <div className="divide-y">
            {feedbacks.map((feedback) => {
              const last = lastMessage(feedback);
              const attachmentCount = countAttachments(feedback);
              return (
                <button
                  key={feedback.id}
                  type="button"
                  className={cn(
                    "block w-full px-4 py-3 text-left transition-colors hover:bg-muted/60",
                    selectedFeedbackId === feedback.id && "bg-muted",
                  )}
                  onClick={() => onSelect(feedback.id)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium">
                        {messagePreview(feedback)}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {isSuperAdmin ? `${feedback.submitterName} · ` : ""}
                        {last ? `${last.authorName} 更新 · ` : ""}
                        {formatFeedbackTime(feedback.lastMessageAt)}
                      </p>
                    </div>
                    <Badge variant={feedbackStatusBadgeVariant(feedback.status)}>
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
  );
}

export function formatFeedbackTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function feedbackStatusBadgeVariant(status: FeedbackView["status"]) {
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
