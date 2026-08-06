import { z } from "zod";
import type { BudgetThresholdPayload, OrderCardPayload } from "@/lib/feishu";

export const procurementOrderPayloadSchema = z.object({
  id: z.string().min(1),
  orderNo: z.string().min(1),
  initiatorName: z.string(),
  totalPrice: z.number(),
  status: z.enum([
    "DRAFT",
    "MANAGEMENT_REVIEW",
    "TEACHER_REVIEW",
    "PENDING_APPLICANT_DOCS",
    "PENDING_FINANCE_REVIEW",
    "PENDING_APPLICANT_CONFIRM",
    "COMPLETED",
    "REJECTED",
  ]),
  team: z.string(),
  techGroup: z.string(),
  items: z
    .array(
      z.object({
        name: z.string(),
        quantity: z.number(),
        unitPrice: z.number(),
      }),
    )
    .optional(),
  screenshotPath: z.string().nullable().optional(),
  invoicePaths: z.string().nullable().optional(),
  invoicePath: z.string().nullable().optional(),
  listDocPath: z.string().nullable().optional(),
});

const budgetSchema = z.object({
  description: z.string(),
  team: z.string(),
  techGroup: z.string(),
  period: z.string(),
  budgetAmount: z.number(),
  usedAmount: z.number(),
  usagePercent: z.number(),
  threshold: z.number(),
  recipientOpenIds: z.array(z.string()),
});

const appOriginSchema = z.string().nullable().optional();

export const orderOutboxPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("order"),
    order: procurementOrderPayloadSchema,
    appOrigin: appOriginSchema,
  }),
  z.object({
    kind: z.literal("procurement_rejected"),
    order: procurementOrderPayloadSchema,
    reason: z.string(),
    rejectedByName: z.string(),
    appOrigin: appOriginSchema,
  }),
  z.object({
    kind: z.literal("applicant_resubmit"),
    order: procurementOrderPayloadSchema,
    reason: z.string(),
    financeName: z.string(),
    appOrigin: appOriginSchema,
  }),
  z.object({
    kind: z.literal("procurement_return_draft"),
    order: procurementOrderPayloadSchema,
    reason: z.string(),
    returnedByName: z.string(),
    appOrigin: appOriginSchema,
  }),
  z.object({
    kind: z.literal("budget_threshold"),
    budget: budgetSchema,
    appOrigin: appOriginSchema,
  }),
]);

export const teacherReviewEmailOutboxPayloadSchema = z.object({
  kind: z.literal("teacher_review_email"),
  order: procurementOrderPayloadSchema.extend({
    status: z.literal("TEACHER_REVIEW"),
  }),
  expectedStatusEnteredAt: z.string().datetime(),
  appOrigin: z.string().nullable(),
});

export type OrderOutboxPayload =
  | {
      kind: "order";
      order: OrderCardPayload;
      appOrigin?: string | null;
    }
  | {
      kind: "procurement_rejected";
      order: OrderCardPayload;
      reason: string;
      rejectedByName: string;
      appOrigin?: string | null;
    }
  | {
      kind: "applicant_resubmit";
      order: OrderCardPayload;
      reason: string;
      financeName: string;
      appOrigin?: string | null;
    }
  | {
      kind: "procurement_return_draft";
      order: OrderCardPayload;
      reason: string;
      returnedByName: string;
      appOrigin?: string | null;
    }
  | {
      kind: "budget_threshold";
      budget: BudgetThresholdPayload;
      appOrigin?: string | null;
    };

export type TeacherReviewEmailOutboxPayload = {
  kind: "teacher_review_email";
  order: OrderCardPayload & { status: "TEACHER_REVIEW" };
  expectedStatusEnteredAt: string;
  appOrigin: string | null;
};
