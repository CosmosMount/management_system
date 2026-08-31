import { createHash } from "node:crypto";

export const FEISHU_PROVIDER = "FEISHU";
export const DEFAULT_TENANT_ID = "default";

export function normalizeOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function stableIdentityHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
