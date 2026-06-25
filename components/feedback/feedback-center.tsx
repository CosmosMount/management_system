"use client";

import type { ChangeEvent, ClipboardEvent, FormEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ImageIcon, MessageSquare, Plus, Send, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import type { FeedbackStatus } from "@prisma/client";
import {
  createFeedback,
  replyFeedback,
  updateFeedbackStatus,
} from "@/app/actions/feedback";
import { ImagePreview } from "@/components/image-preview";
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
import {
  FEEDBACK_IMAGE_ACCEPT,
  FEEDBACK_IMAGE_ALLOWED_TYPES,
  MAX_FEEDBACK_IMAGE_COUNT,
  MAX_FEEDBACK_IMAGE_SIZE,
} from "@/lib/feedback-upload-limits";
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
type FeedbackFilter = "ACTIVE" | FeedbackStatus | "ALL";
const filterOptions: Array<{ value: FeedbackFilter; label: string }> = [
  { value: "ACTIVE", label: "活动" },
  { value: "OPEN", label: feedbackStatusLabels.OPEN },
  { value: "IN_PROGRESS", label: feedbackStatusLabels.IN_PROGRESS },
  { value: "CLOSED", label: feedbackStatusLabels.CLOSED },
  { value: "ALL", label: "全部" },
];
const feedbackImageTypeSet = new Set<string>(FEEDBACK_IMAGE_ALLOWED_TYPES);

type FeedbackImageFiles = {
  files: FeedbackImageFile[];
  setFiles: (files: FeedbackImageFile[]) => void;
};

type FeedbackImageFile = {
  id: string;
  file: File;
  previewUrl: string;
};

function hasClipboardImage(event: ClipboardEvent): boolean {
  return Array.from(event.clipboardData.items).some((item) => {
    if (item.kind !== "file") return false;
    return item.type.startsWith("image/");
  });
}

function clipboardImageFiles(event: ClipboardEvent): File[] {
  return Array.from(event.clipboardData.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => !!file && file.type.startsWith("image/"));
}

function acceptedFeedbackImages(files: File[], showErrors = true): File[] {
  const accepted: File[] = [];
  for (const file of files) {
    if (!feedbackImageTypeSet.has(file.type)) {
      if (showErrors) toast.error("反馈图片仅支持 PNG/JPG/WebP");
      continue;
    }
    if (file.size > MAX_FEEDBACK_IMAGE_SIZE) {
      if (showErrors) toast.error("单张反馈图片不能超过 100MB");
      continue;
    }
    accepted.push(file);
  }
  return accepted;
}

function addAcceptedFeedbackImages(
  currentFiles: FeedbackImageFile[],
  accepted: File[],
  setFiles: (files: FeedbackImageFile[]) => void,
) {
  if (accepted.length === 0) return;

  const remaining = MAX_FEEDBACK_IMAGE_COUNT - currentFiles.length;
  if (remaining <= 0) {
    toast.error(`最多上传 ${MAX_FEEDBACK_IMAGE_COUNT} 张图片`);
    return;
  }

  if (accepted.length > remaining) {
    toast.error(`最多上传 ${MAX_FEEDBACK_IMAGE_COUNT} 张图片`);
  }

  setFiles([
    ...currentFiles,
    ...accepted.slice(0, remaining).map(createFeedbackImageFile),
  ]);
}

function addFeedbackImages(
  currentFiles: FeedbackImageFile[],
  nextFiles: File[],
  setFiles: (files: FeedbackImageFile[]) => void,
) {
  addAcceptedFeedbackImages(
    currentFiles,
    acceptedFeedbackImages(nextFiles),
    setFiles,
  );
}

function handleFeedbackPaste(
  event: ClipboardEvent,
  { files, setFiles }: FeedbackImageFiles,
) {
  if (!hasClipboardImage(event)) return;
  const images = clipboardImageFiles(event);
  const accepted = acceptedFeedbackImages(images, false);
  if (accepted.length === 0) {
    if (!event.clipboardData.getData("text/plain")) {
      acceptedFeedbackImages(images);
    }
    return;
  }

  event.preventDefault();
  addAcceptedFeedbackImages(files, accepted, setFiles);
}

function buildFeedbackFormData(
  form: HTMLFormElement,
  imageFiles: FeedbackImageFile[],
): FormData {
  const formData = new FormData(form);
  formData.delete("images");
  for (const image of imageFiles) {
    formData.append("images", image.file, image.file.name);
  }
  return formData;
}

function createFeedbackImageFile(file: File): FeedbackImageFile {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${file.name}-${file.size}-${file.lastModified}-${Date.now()}`;
  return {
    id,
    file,
    previewUrl: URL.createObjectURL(file),
  };
}

function revokeFeedbackImages(images: FeedbackImageFile[]) {
  for (const image of images) {
    URL.revokeObjectURL(image.previewUrl);
  }
}

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

function pushSelectedFeedbackUrl(feedbackId: string) {
  const params = new URLSearchParams(window.location.search);
  params.delete("new");
  params.set("selected", feedbackId);
  const query = params.toString();
  window.history.pushState(null, "", query ? `/feedback?${query}` : "/feedback");
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

function AttachmentPreview({
  attachment,
}: {
  attachment: FeedbackAttachmentView;
}) {
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

function FeedbackImageInput({
  files,
  setFiles,
  disabled,
  compact = false,
}: FeedbackImageFiles & {
  disabled: boolean;
  compact?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (files.length === 0 && inputRef.current) {
      inputRef.current.value = "";
    }
  }, [files.length]);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    addFeedbackImages(files, Array.from(event.target.files ?? []), setFiles);
    event.target.value = "";
  }

  function removeFile(index: number) {
    const removed = files[index];
    if (removed) {
      URL.revokeObjectURL(removed.previewUrl);
    }
    setFiles(files.filter((_, fileIndex) => fileIndex !== index));
  }

  return (
    <div className="space-y-2">
      {files.length > 0 && (
        <div
          className={cn(
            compact
              ? "flex gap-2 overflow-x-auto pb-1 [scrollbar-gutter:stable]"
              : "grid grid-cols-3 gap-2 sm:grid-cols-4",
          )}
        >
          {files.map((file, index) => (
            <FeedbackImagePreview
              key={file.id}
              image={file}
              compact={compact}
              disabled={disabled}
              onRemove={() => removeFile(index)}
            />
          ))}
        </div>
      )}
      <Input
        ref={inputRef}
        type="file"
        accept={FEEDBACK_IMAGE_ACCEPT}
        multiple
        disabled={disabled}
        className={cn(compact ? "max-w-full" : "max-w-md")}
        onChange={handleFileChange}
      />
      <p className="text-xs text-muted-foreground">
        支持 PNG/JPG/WebP，可选择文件或在输入框中粘贴截图；最多{" "}
        {MAX_FEEDBACK_IMAGE_COUNT} 张，每张不超过 100MB。
      </p>
    </div>
  );
}

function FeedbackImagePreview({
  image,
  compact,
  disabled,
  onRemove,
}: {
  image: FeedbackImageFile;
  compact: boolean;
  disabled: boolean;
  onRemove: () => void;
}) {
  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-md border bg-muted",
        compact ? "h-16 w-16 shrink-0" : "aspect-square",
      )}
    >
      <ImagePreview
        src={image.previewUrl}
        alt={image.file.name}
        wrapperClassName="block h-full w-full"
        className="h-full w-full object-cover"
      />
      <Button
        type="button"
        size="icon-xs"
        variant="destructive"
        className="absolute right-1 top-1"
        disabled={disabled}
        aria-label={`移除 ${image.file.name}`}
        onClick={onRemove}
      >
        <X className="h-3 w-3" />
      </Button>
    </div>
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
  const selectedFromUrl = searchParams.get("selected");
  const selectedFromUrlFeedback = selectedFromUrl
    ? feedbacks.find((feedback) => feedback.id === selectedFromUrl)
    : undefined;
  const [newOpenState, setNewOpenState] = useState(false);
  const [statusFilter, setStatusFilter] = useState<FeedbackFilter>(
    selectedFromUrlFeedback
      ? selectedFromUrlFeedback.status === "CLOSED"
        ? "CLOSED"
        : "ACTIVE"
      : "ACTIVE",
  );
  const [hasManualFilter, setHasManualFilter] = useState(false);
  const [selectedId, setSelectedId] = useState(
    selectedFromUrl ?? feedbacks[0]?.id ?? "",
  );
  const [createPending, setCreatePending] = useState(false);
  const [replyPending, setReplyPending] = useState(false);
  const [statusPending, setStatusPending] = useState(false);
  const [createImages, setCreateImages] = useState<FeedbackImageFile[]>([]);
  const [replyImageState, setReplyImageState] = useState<{
    feedbackId: string;
    files: FeedbackImageFile[];
  }>({ feedbackId: "", files: [] });
  const createImagesRef = useRef<FeedbackImageFile[]>([]);
  const replyImagesRef = useRef<FeedbackImageFile[]>([]);
  const newOpen = newOpenState || newFromUrl;

  useEffect(() => {
    createImagesRef.current = createImages;
  }, [createImages]);

  useEffect(() => {
    replyImagesRef.current = replyImageState.files;
  }, [replyImageState.files]);

  useEffect(() => {
    return () => {
      revokeFeedbackImages(createImagesRef.current);
      revokeFeedbackImages(replyImagesRef.current);
    };
  }, []);

  const urlStatusFilter =
    selectedFromUrlFeedback && selectedFromUrl
      ? selectedFromUrlFeedback.status === "CLOSED"
        ? "CLOSED"
        : "ACTIVE"
      : undefined;
  const effectiveStatusFilter =
    !hasManualFilter && urlStatusFilter ? urlStatusFilter : statusFilter;
  const effectiveSelectedId = selectedFromUrlFeedback?.id ?? selectedId;

  const filteredFeedbacks = useMemo(() => {
    if (effectiveStatusFilter === "ALL") return feedbacks;
    if (effectiveStatusFilter === "ACTIVE") {
      return feedbacks.filter((feedback) => feedback.status !== "CLOSED");
    }
    return feedbacks.filter(
      (feedback) => feedback.status === effectiveStatusFilter,
    );
  }, [effectiveStatusFilter, feedbacks]);

  const selectedFeedback =
    filteredFeedbacks.find((feedback) => feedback.id === effectiveSelectedId) ??
    filteredFeedbacks[0];
  const canReply =
    !!selectedFeedback &&
    (isSuperAdmin || selectedFeedback.status !== "CLOSED");
  const replyImages =
    selectedFeedback?.id === replyImageState.feedbackId
      ? replyImageState.files
      : [];

  function clearCreateImages() {
    revokeFeedbackImages(createImages);
    setCreateImages([]);
  }

  function setReplyImages(files: FeedbackImageFile[]) {
    setReplyImageState({ feedbackId: selectedFeedback?.id ?? "", files });
  }

  function clearReplyImages() {
    revokeFeedbackImages(replyImageState.files);
    setReplyImageState({ feedbackId: "", files: [] });
  }

  function handleFilterChange(filter: FeedbackFilter) {
    clearReplyImages();
    setHasManualFilter(true);
    setStatusFilter(filter);
    router.replace("/feedback", { scroll: false });
  }

  function handleNewOpenChange(open: boolean) {
    setNewOpenState(open);
    if (!open) {
      clearCreateImages();
    }
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
      const result = await createFeedback(
        buildFeedbackFormData(form, createImages),
      );
      toast.success("反馈已提交");
      form.reset();
      clearCreateImages();
      setNewOpenState(false);
      setHasManualFilter(false);
      setStatusFilter("ACTIVE");
      setSelectedId(result.id);
      router.push(`/feedback?selected=${result.id}`, { scroll: false });
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
      await replyFeedback(buildFeedbackFormData(form, replyImages));
      toast.success("回复已发送");
      form.reset();
      clearReplyImages();
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
    <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto [scrollbar-gutter:stable] lg:h-full lg:grid-cols-[22rem_minmax(0,1fr)] lg:overflow-hidden">
      <Card className="flex min-h-[32rem] min-w-0 flex-col overflow-hidden lg:h-full lg:min-h-0">
        <CardHeader className="shrink-0 border-b">
          <div className="flex items-center justify-between gap-3">
            <CardTitle>{isSuperAdmin ? "反馈清单" : "我的反馈"}</CardTitle>
            <Button size="sm" onClick={() => setNewOpenState(true)}>
              <Plus className="h-4 w-4" />
              新反馈
            </Button>
          </div>
          <div className="flex flex-wrap gap-2 pt-2">
            {filterOptions.map((option) => (
              <Button
                key={option.value}
                type="button"
                size="sm"
                variant={
                  effectiveStatusFilter === option.value ? "default" : "outline"
                }
                onClick={() => handleFilterChange(option.value)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 overflow-y-auto p-0 [scrollbar-gutter:stable]">
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
                      if (feedback.id !== selectedFeedback?.id) {
                        clearReplyImages();
                      }
                      setSelectedId(feedback.id);
                      pushSelectedFeedbackUrl(feedback.id);
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

      <Card className="flex min-h-[32rem] min-w-0 flex-col overflow-hidden lg:h-full lg:min-h-0">
        {selectedFeedback ? (
          <>
            <CardHeader className="shrink-0 border-b">
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

            <CardContent className="flex min-h-0 flex-1 flex-col gap-5">
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
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
                          "min-w-0 max-w-[min(42rem,85%)] rounded-lg border bg-background p-3 text-left",
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
                              <AttachmentPreview
                                key={attachment.id}
                                attachment={attachment}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {canReply ? (
                <form
                  onSubmit={handleReply}
                  className="shrink-0 space-y-3 border-t pt-4"
                >
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
                    className="max-h-24 resize-none overflow-y-auto"
                    onPaste={(event) =>
                      handleFeedbackPaste(event, {
                        files: replyImages,
                        setFiles: setReplyImages,
                      })
                    }
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

      <Dialog open={newOpen} onOpenChange={handleNewOpenChange}>
        <DialogContent className="max-h-[90vh] overflow-y-auto [scrollbar-gutter:stable] sm:max-w-lg">
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
              onPaste={(event) =>
                handleFeedbackPaste(event, {
                  files: createImages,
                  setFiles: setCreateImages,
                })
              }
            />
            <FeedbackImageInput
              files={createImages}
              setFiles={setCreateImages}
              disabled={createPending}
            />
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
