// @playwright-project node-db
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  resolveAdminAccountOptionRecords,
  searchAdminAccountOptionPage,
} from "../lib/admin-account-options";
import { prisma } from "../lib/prisma";
import {
  resolveAdminAccountOptionsInputSchema,
  searchAdminAccountOptionsInputSchema,
  updateTeacherEmailInputSchema,
} from "../lib/validations/account-management";

test.describe.configure({ mode: "serial" });

test("管理员账号选择和指导老师邮箱输入使用严格边界", async () => {
  expect(
    searchAdminAccountOptionsInputSchema.safeParse({
      purpose: "ALL",
      query: "测试",
      limit: 50,
      unexpected: true,
    }).success,
  ).toBe(false);
  expect(
    resolveAdminAccountOptionsInputSchema.safeParse({
      purpose: "REIMBURSEMENT",
      ids: Array.from({ length: 51 }, () => randomUUID()),
    }).success,
  ).toBe(false);
  expect(
    updateTeacherEmailInputSchema.safeParse({ accountId: "", email: "a@b.com" })
      .success,
  ).toBe(false);
  expect(
    updateTeacherEmailInputSchema.safeParse({
      accountId: randomUUID(),
      email: `${"a".repeat(250)}@example.com`,
    }).success,
  ).toBe(false);
  expect(
    updateTeacherEmailInputSchema.safeParse({
      accountId: randomUUID(),
      email: "teacher@example.com",
      unexpected: true,
    }).success,
  ).toBe(false);

  const teacherActionSource = await readFile(
    path.join(process.cwd(), "app/actions/adminTeacherEmail.ts"),
    "utf8",
  );
  expect(teacherActionSource).toContain("updateTeacherEmailInputSchema.parse(input)");
  expect(teacherActionSource).toContain("await requireGlobalSuperAdministrator()");
});

test("账号选择分页、范围、解析顺序、拼音和身份轮换保持稳定 accountId", async () => {
  test.setTimeout(60_000);
  const runId = randomUUID().replaceAll("-", "").slice(0, 12);
  const createdAccountIds: string[] = [];
  try {
    for (let index = 0; index < 55; index += 1) {
      const openId = `ou_admin_options_${runId}_${index}`;
      const reimbursementReady = index < 20;
      const account = await prisma.account.create({
        data: {
          person: {
            create: {
              displayName:
                index === 0
                  ? `张三选择器${runId}`
                  : `账号选择回归${runId}${String(index).padStart(2, "0")}`,
            },
          },
          identities: {
            create: {
              provider: "FEISHU",
              providerSubject: `open:${openId}`,
              openId,
            },
          },
          ...(reimbursementReady
            ? {
                reimbursementUser: {
                  create: {
                    openId,
                    name: `报销账号${runId}${index}`,
                  },
                },
              }
            : {}),
        },
        select: { id: true },
      });
      createdAccountIds.push(account.id);
    }

    const firstPage = await searchAdminAccountOptionPage({
      purpose: "ALL",
      query: "",
      limit: 50,
    });
    expect(firstPage.items).toHaveLength(50);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await searchAdminAccountOptionPage({
      purpose: "ALL",
      query: "",
      cursor: firstPage.nextCursor!,
      limit: 50,
    });
    expect(
      secondPage.items.some((item) =>
        firstPage.items.some((firstItem) => firstItem.id === item.id),
      ),
    ).toBe(false);

    await expect(
      searchAdminAccountOptionPage({
        purpose: "REIMBURSEMENT",
        query: "",
        cursor: firstPage.nextCursor!,
        limit: 50,
      }),
    ).rejects.toThrow("分页参数无效");
    await expect(
      searchAdminAccountOptionPage({
        purpose: "ALL",
        query: "账号",
        cursor: firstPage.nextCursor!,
        limit: 50,
      }),
    ).rejects.toThrow("关键词搜索不支持分页");
    await expect(
      searchAdminAccountOptionPage({
        purpose: "ALL",
        query: "",
        cursor: Buffer.from('{"v":1,"purpose":"ALL","id":"bad"}').toString(
          "base64url",
        ),
        limit: 50,
      }),
    ).rejects.toThrow("分页参数无效");

    const pinyinMatches = await searchAdminAccountOptionPage({
      purpose: "ALL",
      query: "zsxq",
      limit: 50,
    });
    expect(pinyinMatches.items.map((item) => item.id)).toContain(
      createdAccountIds[0],
    );

    const allResolved = await resolveAdminAccountOptionRecords({
      purpose: "ALL",
      ids: [createdAccountIds[25]!, createdAccountIds[0]!],
    });
    expect(allResolved.map((item) => item.id)).toEqual([
      createdAccountIds[25],
      createdAccountIds[0],
    ]);
    const reimbursementResolved = await resolveAdminAccountOptionRecords({
      purpose: "REIMBURSEMENT",
      ids: [createdAccountIds[25]!, createdAccountIds[0]!],
    });
    expect(reimbursementResolved.map((item) => item.id)).toEqual([
      createdAccountIds[0],
    ]);

    const rotatedOpenId = `ou_admin_options_rotated_${runId}`;
    await prisma.$transaction([
      prisma.accountIdentity.updateMany({
        where: { accountId: createdAccountIds[0] },
        data: { openId: rotatedOpenId },
      }),
      prisma.user.update({
        where: { accountId: createdAccountIds[0] },
        data: { openId: rotatedOpenId },
      }),
    ]);
    const rotatedMatches = await searchAdminAccountOptionPage({
      purpose: "ALL",
      query: rotatedOpenId,
      limit: 50,
    });
    expect(rotatedMatches.items[0]).toMatchObject({
      id: createdAccountIds[0],
      openId: rotatedOpenId,
      reimbursementReady: true,
    });
  } finally {
    if (createdAccountIds.length > 0) {
      await prisma.user.deleteMany({
        where: { accountId: { in: createdAccountIds } },
      });
      await prisma.person.deleteMany({
        where: { accountId: { in: createdAccountIds } },
      });
      await prisma.accountIdentity.deleteMany({
        where: { accountId: { in: createdAccountIds } },
      });
      await prisma.account.deleteMany({
        where: { id: { in: createdAccountIds } },
      });
    }
  }
});
