"use client";

import { useState, type FormEvent, type FormEventHandler } from "react";
import {
  FeedbackImageInput,
  handleFeedbackPaste,
} from "@/components/feedback/feedback-images";
import type { FeedbackImageFiles } from "@/components/feedback/feedback-types";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field-error";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

export function NewFeedbackDialog({
  open,
  pending,
  images,
  setImages,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  pending: boolean;
  images: FeedbackImageFiles["files"];
  setImages: FeedbackImageFiles["setFiles"];
  onOpenChange: (open: boolean) => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
}) {
  const [bodyError, setBodyError] = useState("");
  const [imageError, setImageError] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    const body = event.currentTarget.elements.namedItem("body") as HTMLTextAreaElement | null;
    if (!body?.value.trim()) {
      event.preventDefault();
      setBodyError("请填写反馈内容");
      requestAnimationFrame(() => body?.focus());
      return;
    }
    onSubmit(event);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto [scrollbar-gutter:stable] sm:max-w-lg">
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <DialogHeader>
            <DialogTitle>提交反馈</DialogTitle>
            <DialogDescription>
              描述遇到的问题或建议，可上传多张截图辅助定位。
            </DialogDescription>
          </DialogHeader>
          <Textarea
            id="new-feedback-body"
            name="body"
            placeholder="请输入反馈内容"
            rows={5}
            required
            maxLength={5_000}
            disabled={pending}
            aria-invalid={Boolean(bodyError)}
            aria-describedby={bodyError ? "new-feedback-body-error" : undefined}
            onChange={(event) => { if (event.target.value.trim()) setBodyError(""); }}
            onPaste={(event) => handleFeedbackPaste(event, {
              files: images,
              setFiles: setImages,
              onError: setImageError,
            })}
          />
          <FieldError id="new-feedback-body-error" messages={bodyError} />
          <FeedbackImageInput files={images} setFiles={setImages} disabled={pending} error={imageError} errorId="new-feedback-images-error" onError={setImageError} />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={pending}>提交反馈</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
