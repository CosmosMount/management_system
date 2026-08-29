// @playwright-project node-db
import { expect, test } from "@playwright/test";
import {
  buildClosedProcurementCardKitCard,
  buildProcurementCardKitCard,
  procurementTeacherApprovalResult,
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

test("首次上传采购凭证的卡片不会误写为重新上传", () => {
  const card = buildProcurementCardKitCard({
    id: "procurement-card-copy",
    orderNo: "CG-COPY-001",
    initiatorName: "测试采购人",
    totalPrice: 100,
    status: "PENDING_APPLICANT_DOCS",
    team: "英雄",
    techGroup: "电控",
    items: [],
  });
  const rendered = JSON.stringify(card);
  expect(rendered).toContain("请上传发票、实物照片");
  expect(rendered).not.toContain("请重新上传发票、实物照片");
});

test("老师审核通过后的卡片处理结果明确由申请人上传凭证", () => {
  const resultMessage = procurementTeacherApprovalResult("CG-COPY-002");
  const card = buildClosedProcurementCardKitCard(
    {
      id: "procurement-card-result-copy",
      orderNo: "CG-COPY-002",
      initiatorName: "测试采购人",
      totalPrice: 100,
      status: "PENDING_APPLICANT_DOCS",
      team: "英雄",
      techGroup: "电控",
      items: [],
    },
    resultMessage,
  );
  const rendered = JSON.stringify(card);
  expect(rendered).toContain(
    "老师审核已通过，订单「CG-COPY-002」已进入待申请人上传凭证环节",
  );
  expect(rendered).not.toContain("订单 CG-COPY-002 待上传凭证");
});
