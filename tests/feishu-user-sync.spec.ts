import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  mergeFeishuContactUsers,
  type FeishuContactUser,
} from "../lib/feishu-contact";
import {
  FeishuContactSyncConfirmationRequiredError,
  reconcileFeishuContactUsers,
  reconcileFeishuContactUsersTx,
} from "../lib/feishu-user-sync";
import { prisma } from "../lib/prisma";
import {
  connectDatabaseClient,
  databaseBackendPid,
  waitForDirectBlockers,
} from "./helpers/database-barrier";
import { resolveFeishuIdentityForUserTx } from "../lib/project-management/identity";

test.describe.configure({ mode: "serial" });

test("同一成员跨部门去重时保留任一离职标记", () => {
  expect(
    mergeFeishuContactUsers([
      {
        openId: "ou_multi_department",
        unionId: null,
        name: "多部门成员",
        avatar: null,
        isActive: true,
      },
      {
        openId: "ou_multi_department",
        unionId: "on_multi_department",
        name: "多部门成员",
        avatar: "https://example.invalid/avatar.png",
        isActive: false,
      },
    ]),
  ).toEqual([
    {
      openId: "ou_multi_department",
      unionId: "on_multi_department",
      name: "多部门成员",
      avatar: "https://example.invalid/avatar.png",
      isActive: false,
    },
  ]);
});

test("全量通讯录同步停用已离职成员并恢复重新在职成员", async () => {
  const rollback = new Error("rollback feishu contact sync fixture");
  let assertionsCompleted = false;

  await expect(
    prisma.$transaction(async (tx) => {
      const suffix = randomUUID();
      const departedOpenId = `ou_departed_${suffix}`;
      const returningOpenId = `ou_returning_${suffix}`;
      const departed = await tx.account.create({
        data: {
          identities: {
            create: {
              provider: "FEISHU",
              tenantId: "default",
              providerSubject: `open:${departedOpenId}`,
              openId: departedOpenId,
            },
          },
          person: {
            create: { displayName: "已离职同步成员", status: "ACTIVE" },
          },
          reimbursementUser: {
            create: { openId: departedOpenId, name: "已离职同步成员" },
          },
          reimbursementRoles: {
            create: {
              openId: departedOpenId,
              role: "TEAM_ADMIN",
              team: "英雄",
              techGroup: "",
            },
          },
        },
        include: { person: true },
      });
      const returning = await tx.account.create({
        data: {
          identities: {
            create: {
              provider: "FEISHU",
              tenantId: "default",
              providerSubject: `open:${returningOpenId}`,
              openId: returningOpenId,
            },
          },
          person: {
            create: { displayName: "重新在职同步成员", status: "INACTIVE" },
          },
          reimbursementUser: {
            create: { openId: returningOpenId, name: "重新在职同步成员" },
          },
        },
        include: { person: true },
      });

      await resolveFeishuIdentityForUserTx(tx, {
        openId: returningOpenId,
        name: "重新在职同步成员",
      });
      await expect(
        tx.person.findUnique({
          where: { id: returning.person!.id },
          select: { status: true },
        }),
      ).resolves.toEqual({ status: "INACTIVE" });

      const activeIdentities = await tx.accountIdentity.findMany({
        where: {
          provider: "FEISHU",
          tenantId: "default",
          openId: { not: null },
          account: { person: { is: { status: "ACTIVE" } } },
        },
        select: {
          openId: true,
          unionId: true,
          account: {
            select: {
              person: { select: { displayName: true, avatar: true } },
            },
          },
        },
      });
      const contacts = activeIdentities.flatMap((identity) => {
        if (
          !identity.openId?.trim() ||
          !identity.account.person ||
          identity.openId === departedOpenId
        ) {
          return [];
        }
        return [
          {
            openId: identity.openId,
            unionId: identity.unionId,
            name: identity.account.person.displayName,
            avatar: identity.account.person.avatar,
            isActive: true,
          } satisfies FeishuContactUser,
        ];
      });
      contacts.push({
        openId: returningOpenId,
        unionId: null,
        name: "重新在职同步成员",
        avatar: null,
        isActive: true,
      });

      const result = await reconcileFeishuContactUsersTx(tx, contacts);

      await expect(
        tx.person.findUnique({
          where: { id: departed.person!.id },
          select: { status: true },
        }),
      ).resolves.toEqual({ status: "INACTIVE" });
      await expect(
        tx.person.findUnique({
          where: { id: returning.person!.id },
          select: { status: true },
        }),
      ).resolves.toEqual({ status: "ACTIVE" });
      await expect(
        tx.user.findUnique({
          where: { accountId: departed.id },
          select: { id: true },
        }),
      ).resolves.not.toBeNull();
      await expect(
        tx.userRole.findFirst({
          where: { accountId: departed.id, revokedAt: null },
          select: { role: true },
        }),
      ).resolves.toEqual({ role: "TEAM_ADMIN" });
      expect(result.deactivated).toBeGreaterThanOrEqual(1);
      expect(result.reactivated).toBe(1);
      await expect(
        tx.domainAuditEvent.count({
          where: {
            entityType: "Person",
            entityId: { in: [departed.person!.id, returning.person!.id] },
            action: {
              in: [
                "person.feishu_contact_deactivated",
                "person.feishu_contact_reactivated",
              ],
            },
          },
        }),
      ).resolves.toBe(2);

      assertionsCompleted = true;
      throw rollback;
    }),
  ).rejects.toThrow(rollback.message);

  expect(assertionsCompleted).toBe(true);
});

test("含新成员的高比例停用可跨事务二次确认并记录审计", async () => {
  const suffix = randomUUID();
  const confirmerOpenId = `ou_sync_confirmer_${suffix}`;
  const confirmer = await prisma.account.create({
    data: {
      identities: {
        create: {
          provider: "FEISHU",
          tenantId: "default",
          providerSubject: `open:${confirmerOpenId}`,
          openId: confirmerOpenId,
        },
      },
      person: {
        create: { displayName: "同步高比例停用确认人", status: "ACTIVE" },
      },
      reimbursementUser: {
        create: { openId: confirmerOpenId, name: "同步高比例停用确认人" },
      },
      systemRoles: {
        create: { role: "SUPER_ADMINISTRATOR", team: "", techGroup: "" },
      },
    },
  });
  const revokedConfirmer = await prisma.account.create({
    data: {
      person: {
        create: { displayName: "已撤权同步确认人", status: "ACTIVE" },
      },
      systemRoles: {
        create: {
          role: "SUPER_ADMINISTRATOR",
          team: "",
          techGroup: "",
          revokedAt: new Date(),
        },
      },
    },
  });
  const existingIdentities = await prisma.accountIdentity.findMany({
    where: {
      provider: "FEISHU",
      tenantId: "default",
      openId: { not: null },
      account: { person: { is: { status: "ACTIVE" } } },
    },
    select: {
      openId: true,
      unionId: true,
      accountId: true,
      account: {
        select: {
          person: { select: { displayName: true, avatar: true } },
        },
      },
    },
  });
  const confirmedByAccountId = confirmer.id;
  const retainedContacts = existingIdentities.flatMap((identity) => {
    const openId = identity.openId?.trim();
    return openId && identity.account.person
      ? [{
          openId,
          unionId: identity.unionId,
          name: identity.account.person.displayName,
          avatar: identity.account.person.avatar,
          isActive: true,
        } satisfies FeishuContactUser]
      : [];
  });
  const departureCount = Math.max(
    10,
    Math.ceil(existingIdentities.length * 0.5) + 1,
  );
  const newMembers = Array.from({ length: departureCount }, (_, index) => ({
    openId: `ou_sync_new_member_${suffix}_${index}`,
    unionId: `on_sync_new_member_${suffix}_${index}`,
    name: `同步新增成员 ${index}`,
    avatar: null,
    isActive: true,
  } satisfies FeishuContactUser));
  retainedContacts.push(...newMembers);
  const departingPersonIds: string[] = [];
  const fixtureOpenIds = [
    confirmerOpenId,
    ...newMembers.map((member) => member.openId),
  ];
  try {
    for (let index = 0; index < departureCount; index++) {
      const openId = `ou_sync_bulk_departed_${suffix}_${index}`;
      fixtureOpenIds.push(openId);
      const account = await prisma.account.create({
        data: {
          identities: {
            create: {
              provider: "FEISHU",
              tenantId: "default",
              providerSubject: `open:${openId}`,
              openId,
            },
          },
          person: {
            create: {
              displayName: `批量离职成员 ${index}`,
              status: "ACTIVE",
            },
          },
          reimbursementUser: {
            create: { openId, name: `批量离职成员 ${index}` },
          },
        },
        include: { person: true },
      });
      departingPersonIds.push(account.person!.id);
    }

    let confirmation: FeishuContactSyncConfirmationRequiredError | undefined;
    try {
      await reconcileFeishuContactUsers(retainedContacts);
    } catch (error) {
      if (error instanceof FeishuContactSyncConfirmationRequiredError) {
        confirmation = error;
      } else {
        throw error;
      }
    }
    expect(confirmation).toBeDefined();
    expect(confirmation!.deactivateCount).toBe(departureCount);
    expect(confirmation!.confirmationToken).toMatch(/^[0-9a-f]{64}$/);
    await expect(
      prisma.accountIdentity.count({
        where: { unionId: { in: newMembers.map((member) => member.unionId!) } },
      }),
    ).resolves.toBe(0);

    await expect(
      reconcileFeishuContactUsers(retainedContacts, {
        snapshotDropConfirmationToken: confirmation!.confirmationToken,
        confirmedByAccountId: revokedConfirmer.id,
      }),
    ).rejects.toThrow("确认操作人已失去超级管理员权限，请重新发起同步");
    await expect(
      prisma.person.count({
        where: { id: { in: departingPersonIds }, status: "INACTIVE" },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.domainAuditEvent.count({
        where: {
          action: "person.feishu_contact_snapshot_drop_confirmed",
          entityId: confirmation!.confirmationToken,
        },
      }),
    ).resolves.toBe(0);

    const result = await reconcileFeishuContactUsers(retainedContacts, {
      snapshotDropConfirmationToken: confirmation!.confirmationToken,
      confirmedByAccountId,
    });
    expect(result.created).toBeGreaterThanOrEqual(newMembers.length);
    expect(result.deactivated).toBe(departureCount);
    await expect(
      prisma.person.count({
        where: {
          id: { in: departingPersonIds },
          status: "INACTIVE",
        },
      }),
    ).resolves.toBe(departureCount);
    await expect(
      prisma.accountIdentity.count({
        where: { unionId: { in: newMembers.map((member) => member.unionId!) } },
      }),
    ).resolves.toBe(newMembers.length);
    await expect(
      prisma.domainAuditEvent.count({
        where: {
          action: "person.feishu_contact_snapshot_drop_confirmed",
          entityType: "FeishuContactSync",
          entityId: confirmation!.confirmationToken,
          actorAccountId: confirmedByAccountId,
        },
      }),
    ).resolves.toBe(1);
  } finally {
    const fixtureAccounts = await prisma.account.findMany({
      where: {
        identities: {
          some: { openId: { in: fixtureOpenIds } },
        },
      },
      select: { id: true },
    });
    const fixtureAccountIds = [...new Set([
      ...fixtureAccounts.map((account) => account.id),
      confirmer.id,
      revokedConfirmer.id,
    ])];
    await prisma.systemRoleAssignment.deleteMany({
      where: { accountId: { in: fixtureAccountIds } },
    });
    await prisma.user.deleteMany({
      where: { accountId: { in: fixtureAccountIds } },
    });
    await prisma.accountIdentity.deleteMany({
      where: { accountId: { in: fixtureAccountIds } },
    });
    await prisma.person.deleteMany({
      where: { accountId: { in: fixtureAccountIds } },
    });
    // The append-only audit trigger prevents deleting the confirming account
    // because its audit foreign key would otherwise be rewritten to null.
    const deletableFixtureAccountIds = fixtureAccountIds.filter(
      (accountId) => accountId !== confirmer.id,
    );
    await prisma.account.deleteMany({
      where: { id: { in: deletableFixtureAccountIds } },
    });
  }
});

test("手动同步等待管理员集合锁后复核操作人权限且拒绝部分写入", async () => {
  const suffix = randomUUID();
  const requesterOpenId = `ou_sync_requester_${suffix}`;
  const returningOpenId = `ou_sync_returning_${suffix}`;
  const newOpenId = `ou_sync_pending_new_${suffix}`;
  const requester = await prisma.account.create({
    data: {
      identities: {
        create: {
          provider: "FEISHU",
          tenantId: "default",
          providerSubject: `open:${requesterOpenId}`,
          openId: requesterOpenId,
        },
      },
      person: {
        create: { displayName: "并发同步操作人", status: "ACTIVE" },
      },
      reimbursementUser: {
        create: { openId: requesterOpenId, name: "并发同步操作人" },
      },
      systemRoles: {
        create: { role: "SUPER_ADMINISTRATOR", team: "", techGroup: "" },
      },
    },
    include: { person: true, systemRoles: true },
  });
  const returning = await prisma.account.create({
    data: {
      identities: {
        create: {
          provider: "FEISHU",
          tenantId: "default",
          providerSubject: `open:${returningOpenId}`,
          openId: returningOpenId,
        },
      },
      person: {
        create: { displayName: "等待返岗同步成员", status: "INACTIVE" },
      },
      reimbursementUser: {
        create: { openId: returningOpenId, name: "等待返岗同步成员" },
      },
    },
    include: { person: true },
  });
  const activeIdentities = await prisma.accountIdentity.findMany({
    where: {
      provider: "FEISHU",
      tenantId: "default",
      openId: { not: null },
      account: { person: { is: { status: "ACTIVE" } } },
    },
    select: {
      openId: true,
      unionId: true,
      account: {
        select: {
          person: { select: { displayName: true, avatar: true } },
        },
      },
    },
  });
  const contacts = activeIdentities.flatMap((identity) => {
    const openId = identity.openId?.trim();
    return openId && identity.account.person
      ? [{
          openId,
          unionId: identity.unionId,
          name: identity.account.person.displayName,
          avatar: identity.account.person.avatar,
          isActive: true,
        } satisfies FeishuContactUser]
      : [];
  });
  contacts.push(
    {
      openId: returningOpenId,
      unionId: null,
      name: "等待返岗同步成员",
      avatar: null,
      isActive: true,
    },
    {
      openId: newOpenId,
      unionId: null,
      name: "等待创建同步成员",
      avatar: null,
      isActive: true,
    },
  );

  const assignment = requester.systemRoles[0]!;
  const auditCountBefore = await prisma.domainAuditEvent.count({
    where: {
      entityId: { in: [requester.person!.id, returning.person!.id] },
    },
  });
  let locker: Awaited<ReturnType<typeof connectDatabaseClient>> | undefined;
  let observer: Awaited<ReturnType<typeof connectDatabaseClient>> | undefined;
  let lockerCommitted = false;
  let syncOutcome:
    | Promise<
        | { status: "fulfilled"; value: unknown }
        | { status: "rejected"; reason: unknown }
      >
    | undefined;
  try {
    locker = await connectDatabaseClient("feishu-sync-admin-locker");
    observer = await connectDatabaseClient("feishu-sync-admin-observer");
    await locker.query("BEGIN");
    const lockerPid = await databaseBackendPid(locker);
    await locker.query("SELECT pg_advisory_xact_lock($1)", [2_026_080_301]);

    syncOutcome = reconcileFeishuContactUsers(contacts, {
      requestedByAccountId: requester.id,
    }).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    await waitForDirectBlockers(observer, lockerPid, 1);

    await locker.query(
      `UPDATE "SystemRoleAssignment"
       SET "revokedAt" = NOW()
       WHERE "id" = $1`,
      [assignment.id],
    );
    await locker.query("COMMIT");
    lockerCommitted = true;

    const outcome = await syncOutcome;
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") {
      throw new Error("同步未在操作人撤权后失败");
    }
    expect(outcome.reason).toBeInstanceOf(Error);
    expect((outcome.reason as Error).message).toBe(
      "同步操作人已失去超级管理员权限，请重新发起同步",
    );
    await expect(
      prisma.accountIdentity.count({ where: { openId: newOpenId } }),
    ).resolves.toBe(0);
    await expect(
      prisma.person.findUniqueOrThrow({
        where: { id: returning.person!.id },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "INACTIVE" });
    await expect(
      prisma.domainAuditEvent.count({
        where: {
          entityId: { in: [requester.person!.id, returning.person!.id] },
        },
      }),
    ).resolves.toBe(auditCountBefore);
  } finally {
    if (locker && !lockerCommitted) {
      await locker.query("ROLLBACK").catch(() => undefined);
    }
    if (syncOutcome) await syncOutcome;
    await Promise.allSettled([
      ...(locker ? [locker.end()] : []),
      ...(observer ? [observer.end()] : []),
    ]);
    const accidentallyCreatedAccounts = await prisma.accountIdentity.findMany({
      where: { openId: newOpenId },
      select: { accountId: true },
    });
    const fixtureAccountIds = [...new Set([
      requester.id,
      returning.id,
      ...accidentallyCreatedAccounts.map((identity) => identity.accountId),
    ])];
    await prisma.systemRoleAssignment.deleteMany({
      where: { accountId: { in: fixtureAccountIds } },
    });
    await prisma.user.deleteMany({
      where: { accountId: { in: fixtureAccountIds } },
    });
    await prisma.accountIdentity.deleteMany({
      where: { accountId: { in: fixtureAccountIds } },
    });
    await prisma.person.deleteMany({
      where: { accountId: { in: fixtureAccountIds } },
    });
    await prisma.account.deleteMany({
      where: { id: { in: fixtureAccountIds } },
    });
  }
});

test("全量同步身份冲突回滚后写入脱敏审计", async () => {
  const suffix = randomUUID();
  const openId = `ou_sync_conflict_${suffix}`;
  const unionId = `on_sync_conflict_${suffix}`;
  const accountA = await prisma.account.create({ data: {} });
  const accountB = await prisma.account.create({ data: {} });
  await prisma.accountIdentity.createMany({
    data: [
      {
        accountId: accountA.id,
        provider: "FEISHU",
        tenantId: "default",
        providerSubject: unionId,
        unionId,
      },
      {
        accountId: accountB.id,
        provider: "FEISHU",
        tenantId: "default",
        providerSubject: `open:${openId}`,
        openId,
      },
    ],
  });

  try {
    await expect(
      reconcileFeishuContactUsers([
        {
          openId,
          unionId,
          name: "同步冲突用户",
          avatar: null,
          isActive: true,
        },
      ]),
    ).rejects.toThrow("飞书身份已关联多个项目管理账号");

    const audit = await prisma.domainAuditEvent.findFirstOrThrow({
      where: {
        action: "pm.identity.conflict",
        entityType: "AccountIdentity",
      },
      orderBy: { createdAt: "desc" },
    });
    expect(JSON.stringify(audit.after)).toContain("ADMIN_REVIEW_REQUIRED");
    expect(JSON.stringify(audit.before)).not.toContain(openId);
    expect(JSON.stringify(audit.before)).not.toContain(unionId);
    await expect(
      prisma.person.count({
        where: { accountId: { in: [accountA.id, accountB.id] } },
      }),
    ).resolves.toBe(0);
  } finally {
    await prisma.accountIdentity.deleteMany({
      where: { accountId: { in: [accountA.id, accountB.id] } },
    });
    await prisma.account.deleteMany({
      where: { id: { in: [accountA.id, accountB.id] } },
    });
  }
});
