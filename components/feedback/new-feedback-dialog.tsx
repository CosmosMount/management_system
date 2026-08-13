"use client";

import type { FormEventHandler } from "react";
import {
  FeedbackImageInput,
  handleFeedbackPaste,
} from "@/components/feedback/feedback-images";
import type { FeedbackImageFiles } from "@/components/feedback/feedback-types";
import { Button } from "@/components/ui/button";
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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto [scrollbar-gutter:stable] sm:max-w-lg">
        <form onSubmit={onSubmit} className="space-y-4">
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
            disabled={pending}
            onPaste={(event) => handleFeedbackPaste(event, {
              files: images,
              setFiles: setImages,
            })}
          />
          <FeedbackImageInput files={images} setFiles={setImages} disabled={pending} />
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
