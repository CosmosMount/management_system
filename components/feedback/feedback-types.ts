import type { FeedbackStatus } from "@prisma/client";

export type FeedbackAttachmentView = {
  id: string;
  path: string;
  fileName: string;
  mimeType: string;
  size: number;
  sortOrder: number;
};

export type FeedbackMessageView = {
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

export type FeedbackFilter = "ACTIVE" | FeedbackStatus | "ALL";

export type FeedbackImageFile = {
  id: string;
  file: File;
  previewUrl: string;
};

export type FeedbackImageFiles = {
  files: FeedbackImageFile[];
  setFiles: (files: FeedbackImageFile[]) => void;
};
