import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ProjectManagementActor } from "@/lib/project-management/identity";

export const actionInboxStreams = [
  "SEGMENT_CONFIRMATION",
  "TASK_NEXT_NODE",
  "MILESTONE_REVIEW",
  "REVISION_REVIEW",
  "PROJECT_ESTABLISHMENT",
  "TERMINATION_REVIEW",
] as const;

export type ActionInboxStream = (typeof actionInboxStreams)[number];

const cursorPositionSchema = z
  .object({
    relevantAt: z.string().datetime({ offset: true }),
    id: z.string().uuid(),
  })
  .strict();

const cursorCoreSchema = z
  .object({
    v: z.literal(1),
    kind: z.literal("ACTION_INBOX"),
    accountId: z.string().uuid(),
    personId: z.string().uuid(),
    generatedAt: z.string().datetime({ offset: true }),
    positions: z
      .object({
        SEGMENT_CONFIRMATION: cursorPositionSchema.optional(),
        TASK_NEXT_NODE: cursorPositionSchema.optional(),
        MILESTONE_REVIEW: cursorPositionSchema.optional(),
        REVISION_REVIEW: cursorPositionSchema.optional(),
        PROJECT_ESTABLISHMENT: cursorPositionSchema.optional(),
        TERMINATION_REVIEW: cursorPositionSchema.optional(),
      })
      .strict(),
  })
  .strict();

const cursorEnvelopeSchema = z
  .object({
    core: cursorCoreSchema,
    signature: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  })
  .strict();

export type ActionInboxCursorPosition = z.infer<typeof cursorPositionSchema>;
export type ActionInboxCursorPositions = z.infer<
  typeof cursorCoreSchema
>["positions"];

export type ActionInboxCursor = z.infer<typeof cursorCoreSchema>;

export function encodeActionInboxCursor(
  actor: ProjectManagementActor,
  generatedAt: Date,
  positions: ActionInboxCursorPositions,
): string {
  const core = {
    v: 1,
    kind: "ACTION_INBOX",
    accountId: actor.accountId,
    personId: actor.personId,
    generatedAt: generatedAt.toISOString(),
    positions,
  } satisfies ActionInboxCursor;
  return Buffer.from(
    JSON.stringify({ core, signature: sign(core) }),
  ).toString("base64url");
}

export function decodeActionInboxCursor(
  value: string,
  actor: ProjectManagementActor,
): ActionInboxCursor | null {
  const secret = cursorSigningSecret();
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    const parsed = cursorEnvelopeSchema.safeParse(decoded);
    if (!parsed.success) return null;
    if (
      parsed.data.core.accountId !== actor.accountId ||
      parsed.data.core.personId !== actor.personId ||
      !hasValidSignature(parsed.data.core, parsed.data.signature, secret)
    ) {
      return null;
    }
    return parsed.data.core;
  } catch {
    return null;
  }
}

function sign(core: ActionInboxCursor, secret = cursorSigningSecret()) {
  return createHmac("sha256", secret)
    .update("action-inbox-cursor:v1\n")
    .update(JSON.stringify(core))
    .digest("base64url")
    .slice(0, 22);
}

function hasValidSignature(
  core: ActionInboxCursor,
  signature: string,
  secret: string,
) {
  const actual = Buffer.from(signature, "base64url");
  const expected = Buffer.from(sign(core, secret), "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function cursorSigningSecret() {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error(
      "Action Inbox 分页游标签名密钥未配置：请设置 AUTH_SECRET 或 NEXTAUTH_SECRET",
    );
  }
  return secret;
}
