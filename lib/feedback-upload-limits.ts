export const MAX_FEEDBACK_IMAGE_COUNT = 9;
export const MAX_FEEDBACK_IMAGE_SIZE = 20 * 1024 * 1024;
export const MAX_FEEDBACK_IMAGE_TOTAL_SIZE = 50 * 1024 * 1024;
export const FEEDBACK_IMAGE_SIZE_LABEL = "20MB";
export const FEEDBACK_IMAGE_TOTAL_SIZE_LABEL = "50MB";

export const FEEDBACK_IMAGE_ALLOWED_TYPES = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
] as const;

export const FEEDBACK_IMAGE_ACCEPT = FEEDBACK_IMAGE_ALLOWED_TYPES.join(",");
