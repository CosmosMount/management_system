import { expect, test } from "@playwright/test";
import { normalizeEmailAddress } from "../lib/email";
import { buildTeacherReviewEmailContent } from "../lib/procurement-teacher-email";

test("邮箱格式校验", () => {
  expect(normalizeEmailAddress(" Teacher@Example.COM ")).toBe(
    "teacher@example.com",
  );
  expect(normalizeEmailAddress("")).toBe("");
  expect(() => normalizeEmailAddress("invalid-email")).toThrow("邮箱格式不正确");
});

test("老师审核邮件包含审批链接", () => {
  const content = buildTeacherReviewEmailContent(
    {
      id: "order-1",
      orderNo: "PO-20260702-0001",
      initiatorName: "张宇山",
      totalPrice: 128.5,
      status: "TEACHER_REVIEW",
      team: "步兵",
      techGroup: "电控",
    },
    "李老师",
    "https://example.com/procurement/order-1?focus=approval#approval",
  );

  expect(content.subject).toContain("待老师审核");
  expect(content.text).toContain("PO-20260702-0001");
  expect(content.html).toContain("前往系统审批");
  expect(content.html).toContain("https://example.com/procurement/order-1");
});
