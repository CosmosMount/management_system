import { expect, test } from "@playwright/test";
import type { UserRoleRecord } from "../lib/permissions-client";
import {
  canNotifyProcurementApprover,
  canSupplementApplicantDocs,
  canUploadApplicantDocs,
} from "../lib/permissions-client";

const noRoles: UserRoleRecord[] = [];
const financeRoles: UserRoleRecord[] = [
  { role: "FINANCE", team: "英雄", techGroup: "" },
];
const scope = { team: "英雄", techGroup: "电控" };

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
      "MANAGEMENT_REVIEW",
      "other-open-id",
      "initiator-open-id",
      noRoles,
    ),
  ).toBe(false);
});

test("待上传凭证环节可由报销员或超级管理员催促采购人", () => {
  expect(
    canNotifyProcurementApprover(
      "PENDING_APPLICANT_DOCS",
      "finance-open-id",
      "initiator-open-id",
      financeRoles,
      scope,
    ),
  ).toBe(true);
  expect(
    canNotifyProcurementApprover(
      "PENDING_APPLICANT_DOCS",
      "admin-open-id",
      "initiator-open-id",
      [{ role: "SUPER_ADMIN", team: "", techGroup: "" }],
      scope,
    ),
  ).toBe(true);
  expect(
    canNotifyProcurementApprover(
      "PENDING_APPLICANT_DOCS",
      "initiator-open-id",
      "initiator-open-id",
      noRoles,
      scope,
    ),
  ).toBe(false);
  expect(
    canNotifyProcurementApprover(
      "PENDING_APPLICANT_DOCS",
      "other-open-id",
      "initiator-open-id",
      noRoles,
      scope,
    ),
  ).toBe(false);
});

test("报销审核或待确认阶段采购人可补充修改凭证", () => {
  expect(
    canUploadApplicantDocs(
      "PENDING_APPLICANT_DOCS",
      "initiator-open-id",
      "initiator-open-id",
    ),
  ).toBe(true);
  expect(
    canUploadApplicantDocs(
      "PENDING_FINANCE_REVIEW",
      "initiator-open-id",
      "initiator-open-id",
    ),
  ).toBe(false);
  expect(
    canSupplementApplicantDocs(
      "PENDING_FINANCE_REVIEW",
      "initiator-open-id",
      "initiator-open-id",
    ),
  ).toBe(true);
  expect(
    canSupplementApplicantDocs(
      "PENDING_APPLICANT_CONFIRM",
      "initiator-open-id",
      "initiator-open-id",
    ),
  ).toBe(true);
  expect(
    canSupplementApplicantDocs(
      "PENDING_FINANCE_REVIEW",
      "other-open-id",
      "initiator-open-id",
    ),
  ).toBe(false);
  expect(
    canSupplementApplicantDocs(
      "COMPLETED",
      "initiator-open-id",
      "initiator-open-id",
    ),
  ).toBe(false);
});
