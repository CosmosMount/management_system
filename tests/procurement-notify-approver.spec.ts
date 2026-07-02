import { expect, test } from "@playwright/test";
import { canNotifyProcurementApprover } from "../lib/permissions-client";

test("仅采购人可在待审批环节通知当前审批人", () => {
  expect(
    canNotifyProcurementApprover(
      "MANAGEMENT_REVIEW",
      "initiator-open-id",
      "initiator-open-id",
    ),
  ).toBe(true);
  expect(
    canNotifyProcurementApprover(
      "TEACHER_REVIEW",
      "initiator-open-id",
      "initiator-open-id",
    ),
  ).toBe(true);
  expect(
    canNotifyProcurementApprover(
      "PENDING_FINANCE_REVIEW",
      "initiator-open-id",
      "initiator-open-id",
    ),
  ).toBe(true);
  expect(
    canNotifyProcurementApprover(
      "PENDING_APPLICANT_DOCS",
      "initiator-open-id",
      "initiator-open-id",
    ),
  ).toBe(false);
  expect(
    canNotifyProcurementApprover(
      "MANAGEMENT_REVIEW",
      "other-open-id",
      "initiator-open-id",
    ),
  ).toBe(false);
});
