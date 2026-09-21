"use client";

import type { FormEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { FeedbackStatus } from "@prisma/client";
import {
  createFeedback,
  replyFeedback,
  updateFeedbackStatus,
} from "@/app/actions/feedback";
import { FeedbackConversation } from "@/components/feedback/feedback-conversation";
import {
  buildFeedbackFormData,
  revokeFeedbackImages,
} from "@/components/feedback/feedback-images";
import { FeedbackList } from "@/components/feedback/feedback-list";
import { NewFeedbackDialog } from "@/components/feedback/new-feedback-dialog";
import type {
  FeedbackFilter,
  FeedbackImageFile,
  FeedbackView,
} from "@/components/feedback/feedback-types";
import { toast } from "sonner";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type { FeedbackView } from "@/components/feedback/feedback-types";

type Props = {
  feedbacks: FeedbackView[];
  avatarByOpenId: Record<string, string | null>;
  currentUserOpenId: string;
  isSuperAdmin: boolean;
};

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
  const [replyImageState, setReplyImageState] = useState<
    Record<string, FeedbackImageFile[]>
  >({});
  const [replyBodies, setReplyBodies] = useState<Record<string, string>>({});
  const createImagesRef = useRef<FeedbackImageFile[]>([]);
  const replyImagesRef = useRef<FeedbackImageFile[]>([]);
  const newOpen = newOpenState || newFromUrl;

  useEffect(() => {
    createImagesRef.current = createImages;
  }, [createImages]);

  useEffect(() => {
    replyImagesRef.current = Object.values(replyImageState).flat();
  }, [replyImageState]);

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
  const replyImages = selectedFeedback
    ? replyImageState[selectedFeedback.id] ?? []
    : [];
  const mobileConversationOpen = Boolean(selectedFromUrlFeedback);

  function clearCreateImages() {
    revokeFeedbackImages(createImages);
    setCreateImages([]);
  }

  function setReplyImages(files: FeedbackImageFile[]) {
    if (!selectedFeedback) return;
    setReplyImageState((current) => ({ ...current, [selectedFeedback.id]: files }));
  }

  function clearReplyImages(feedbackId: string) {
    revokeFeedbackImages(replyImageState[feedbackId] ?? []);
    setReplyImageState((current) => ({ ...current, [feedbackId]: [] }));
  }

  function handleFilterChange(filter: FeedbackFilter) {
    setHasManualFilter(true);
    setStatusFilter(filter);
    router.replace("/feedback", { scroll: false });
  }

  function handleNewOpenChange(open: boolean) {
    setNewOpenState(open);
    if (!open) clearCreateImages();
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
      const result = await createFeedback(buildFeedbackFormData(form, createImages));
      toast.success("反馈已提交");
      form.reset();
      clearCreateImages();
      setNewOpenState(false);
      setHasManualFilter(false);
      setStatusFilter("ACTIVE");
      setSelectedId(result.id);
      router.push(`/feedback?selected=${result.id}`, { scroll: false });
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "提交失败");
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
      clearReplyImages(selectedFeedback.id);
      setReplyBodies((current) => ({ ...current, [selectedFeedback.id]: "" }));
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "发送失败");
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
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "更新失败");
    } finally {
      setStatusPending(false);
    }
  }

  return (
    <div className="grid min-h-0 min-w-0 flex-1 gap-4 overflow-hidden lg:h-full lg:grid-cols-[22rem_minmax(0,1fr)]">
      <div
        data-testid="feedback-list-panel"
        className={cn("min-h-0 min-w-0 lg:block", mobileConversationOpen && "hidden")}
      >
        <FeedbackList
          feedbacks={filteredFeedbacks}
          selectedFeedbackId={selectedFeedback?.id}
          statusFilter={effectiveStatusFilter}
          isSuperAdmin={isSuperAdmin}
          onNew={() => setNewOpenState(true)}
          onFilterChange={handleFilterChange}
          onSelect={(feedbackId) => {
            setSelectedId(feedbackId);
            pushSelectedFeedbackUrl(feedbackId);
            requestAnimationFrame(() => {
              document.getElementById("feedback-conversation-title")?.focus({ preventScroll: true });
            });
          }}
        />
      </div>
      <div
        data-testid="feedback-conversation-panel"
        className={cn("min-h-0 min-w-0 flex-col gap-2 lg:flex", mobileConversationOpen ? "flex" : "hidden")}
      >
        <Button
          type="button"
          variant="outline"
          className="shrink-0 self-start lg:hidden"
          onClick={() => {
            const params = new URLSearchParams(window.location.search);
            params.delete("selected");
            const query = params.toString();
            window.history.pushState(null, "", query ? `/feedback?${query}` : "/feedback");
            if (selectedFeedback) {
              requestAnimationFrame(() => {
                document.querySelector<HTMLButtonElement>(`[data-feedback-id="${CSS.escape(selectedFeedback.id)}"]`)?.focus({ preventScroll: true });
              });
            }
          }}
        >
          <ArrowLeft aria-hidden="true" />返回反馈列表
        </Button>
        <FeedbackConversation
          key={selectedFeedback?.id ?? "none"}
          feedback={selectedFeedback}
          avatarByOpenId={avatarByOpenId}
          currentUserOpenId={currentUserOpenId}
          isSuperAdmin={isSuperAdmin}
          canReply={canReply}
          replyPending={replyPending}
          statusPending={statusPending}
          replyImages={replyImages}
          setReplyImages={setReplyImages}
          replyBody={selectedFeedback ? replyBodies[selectedFeedback.id] ?? "" : ""}
          onReplyBodyChange={(body) => {
            if (selectedFeedback) {
              setReplyBodies((current) => ({ ...current, [selectedFeedback.id]: body }));
            }
          }}
          onReply={handleReply}
          onStatus={handleStatus}
        />
      </div>
      <NewFeedbackDialog
        key={newOpen ? "new-feedback-open" : "new-feedback-closed"}
        open={newOpen}
        pending={createPending}
        images={createImages}
        setImages={setCreateImages}
        onOpenChange={handleNewOpenChange}
        onSubmit={handleCreate}
      />
    </div>
  );
}

function pushSelectedFeedbackUrl(feedbackId: string) {
  const params = new URLSearchParams(window.location.search);
  params.delete("new");
  params.set("selected", feedbackId);
  const query = params.toString();
  window.history.pushState(null, "", query ? `/feedback?${query}` : "/feedback");
}
