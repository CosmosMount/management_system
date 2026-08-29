// @playwright-project node-db
import { expect, test } from "@playwright/test";
import { prisma } from "../lib/prisma";

test.describe("Termination Review migration", () => {
  test("creates the review enum, table, relations, indexes, and safety constraints", async () => {
    const enumValues = await prisma.$queryRaw<Array<{ enumlabel: string }>>`
      SELECT value.enumlabel
      FROM pg_type type
      JOIN pg_enum value ON value.enumtypid = type.oid
      WHERE type.typname = 'TerminationReviewResult'
      ORDER BY value.enumsortorder
    `;
    expect(enumValues.map((row) => row.enumlabel)).toEqual([
      "PENDING",
      "APPROVED",
      "REJECTED",
      "REVISION_REQUIRED",
    ]);

    const columns = await prisma.$queryRaw<
      Array<{
        column_name: string;
        is_nullable: string;
        column_default: string | null;
      }>
    >`
      SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'TerminationReview'
      ORDER BY ordinal_position
    `;
    expect(columns.map((column) => column.column_name)).toEqual([
      "id",
      "terminationNodeId",
      "outcome",
      "reason",
      "summary",
      "result",
      "submittedByAccountId",
      "reviewerAccountId",
      "reviewedAt",
      "comment",
      "idempotencyKey",
      "createdAt",
    ]);
    expect(
      columns.find((column) => column.column_name === "result"),
    ).toMatchObject({
      is_nullable: "NO",
      column_default: "'PENDING'::\"TerminationReviewResult\"",
    });

    const constraints = await prisma.$queryRaw<
      Array<{ conname: string; definition: string }>
    >`
      SELECT table_constraint.conname, pg_get_constraintdef(table_constraint.oid) AS definition
      FROM pg_constraint table_constraint
      JOIN pg_class relation ON relation.oid = table_constraint.conrelid
      WHERE relation.relname = 'TerminationReview'
      ORDER BY table_constraint.conname
    `;
    expect(constraints.map((constraint) => constraint.conname)).toEqual(
      expect.arrayContaining([
        "TerminationReview_idempotency_not_blank_check",
        "TerminationReview_non_success_reason_required_check",
        "TerminationReview_rejection_comment_required_check",
        "TerminationReview_review_state_check",
        "TerminationReview_terminationNodeId_fkey",
        "TerminationReview_submittedByAccountId_fkey",
        "TerminationReview_reviewerAccountId_fkey",
      ]),
    );

    const indexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'TerminationReview'
      ORDER BY indexname
    `;
    expect(indexes.map((index) => index.indexname)).toEqual(
      expect.arrayContaining([
        "TerminationReview_terminationNodeId_idempotencyKey_key",
        "TerminationReview_terminationNodeId_createdAt_idx",
        "TerminationReview_pending_terminationNode_key",
        "TerminationReview_result_idx",
      ]),
    );
  });
});
