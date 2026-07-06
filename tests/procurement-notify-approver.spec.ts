import { expect, test } from "@playwright/test";
import type { UserRoleRecord } from "../lib/permissions-client";
import { canNotifyProcurementApprover } from "../lib/permissions-client";

const noRoles: UserRoleRecord[] = [];

test("采购人或超级管理员可在待审批环节催促当前审批人", () => {
  expect(
    canNotifyProcurementApprover(
      "MANAGEMENT_REVIEW",
      "initiator-open-id",
      "initiator-open-id",
      noRoles,
    ),
  ).toBe(true);
  expect(
    canNotifyProcurementApprover(
      "TEACHER_REVIEW",
      "initiator-open-id",
      "initiator-open-id",
      noRoles,
    ),
  ).toBe(true);
  expect(
    canNotifyProcurementApprover(
      "PENDING_FINANCE_REVIEW",
      "initiator-open-id",
      "initiator-open-id",
      noRoles,
    ),
  ).toBe(true);
  expect(
    canNotifyProcurementApprover(
      "MANAGEMENT_REVIEW",
      "admin-open-id",
      "initiator-open-id",
      [{ role: "SUPER_ADMIN", team: "", techGroup: "" }],
    ),
  ).toBe(true);
  expect(
    canNotifyProcurementApprover(
      "PENDING_APPLICANT_DOCS",
      "initiator-open-id",
      "initiator-open-id",
      noRoles,
    ),
  ).toBe(false);
  expect(
    canNotifyProcurementApprover(
      "MANAGEMENT_REVIEW",
      "other-open-id",
      "initiator-open-id",
      noRoles,
    ),
  ).toBe(false);
});
