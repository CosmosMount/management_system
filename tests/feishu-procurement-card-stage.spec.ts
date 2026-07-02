import { expect, test } from "@playwright/test";
import {
  supportsProcurementCardApproval,
  supportsProcurementCardConfirm,
} from "../lib/feishu-procurement-card";

test("可审批阶段由订单状态决定按钮是否展示", () => {
  expect(supportsProcurementCardApproval("MANAGEMENT_REVIEW")).toBe(true);
  expect(supportsProcurementCardApproval("TEACHER_REVIEW")).toBe(true);
  expect(supportsProcurementCardApproval("PENDING_APPLICANT_DOCS")).toBe(false);
  expect(supportsProcurementCardConfirm("PENDING_APPLICANT_CONFIRM")).toBe(true);
  expect(supportsProcurementCardConfirm("COMPLETED")).toBe(false);
});
