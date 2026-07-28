import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  canViewProcurementOrder,
  procurementListWhere,
  procurementSummaryWhere,
} from "@/lib/procurement-visibility";

export type LiveVersionScope =
  | "feedback"
  | "procurement"
  | "procurement-dashboard"
  | "procurement-order"
  | "profile"
  | "admin";

export type LiveVersionContext = {
  scope: LiveVersionScope;
  resourceId?: string;
  userOpenId: string;
  isSuperAdmin: boolean;
  mine?: boolean;
};

type VersionPart = string | number | Date | null | undefined;

function newestDate(...values: Array<Date | null | undefined>): Date | null {
  return values.reduce<Date | null>((latest, value) => {
    if (!value) return latest;
    if (!latest || value.getTime() > latest.getTime()) return value;
    return latest;
  }, null);
}

function encodePart(
  name: string,
  maxValue: VersionPart,
  count: number,
): string {
  const value =
    maxValue instanceof Date ? maxValue.toISOString() : (maxValue ?? "");
  return `${name}:${value}:${count}`;
}

function encodeVersion(parts: string[]): string {
  return parts.join("|");
}

async function userRoleVersion(openId: string): Promise<string> {
  const roles = await prisma.userRole.findMany({
    where: { openId },
    orderBy: [{ role: "asc" }, { team: "asc" }, { techGroup: "asc" }],
    select: { role: true, team: true, techGroup: true },
  });
  return `roles:${JSON.stringify(roles)}`;
}

async function userProfileVersion(openId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { openId },
    select: { name: true, avatar: true, signaturePath: true },
  });
  return `user:${JSON.stringify(user ?? null)}`;
}

async function purchaseOrderUpdatedAtVersion(
  name: string,
  where?: Prisma.PurchaseOrderWhereInput,
): Promise<string> {
  const [aggregate, count] = await Promise.all([
    prisma.purchaseOrder.aggregate({ where, _max: { updatedAt: true } }),
    prisma.purchaseOrder.count({ where }),
  ]);
  return encodePart(name, aggregate._max.updatedAt, count);
}

async function purchaseItemVersion(
  where?: Prisma.PurchaseItemWhereInput,
): Promise<string> {
  const [aggregate, count] = await Promise.all([
    prisma.purchaseItem.aggregate({ where, _max: { updatedAt: true } }),
    prisma.purchaseItem.count({ where }),
  ]);
  return encodePart("items", aggregate._max.updatedAt, count);
}

async function getFeedbackVersion({
  userOpenId,
  isSuperAdmin,
}: Pick<LiveVersionContext, "userOpenId" | "isSuperAdmin">): Promise<string> {
  const feedbackWhere: Prisma.FeedbackWhereInput = isSuperAdmin
    ? {}
    : { submitterOpenId: userOpenId };
  const messageWhere: Prisma.FeedbackMessageWhereInput = isSuperAdmin
    ? {}
    : { feedback: { submitterOpenId: userOpenId } };
  const attachmentWhere: Prisma.FeedbackAttachmentWhereInput = isSuperAdmin
    ? {}
    : { message: { feedback: { submitterOpenId: userOpenId } } };

  const [
    feedbackUpdated,
    feedbackMessageCreated,
    feedbackAttachmentCreated,
    feedbackCount,
    messageCount,
    attachmentCount,
  ] = await Promise.all([
    prisma.feedback.aggregate({
      where: feedbackWhere,
      _max: { updatedAt: true, lastMessageAt: true },
    }),
    prisma.feedbackMessage.aggregate({
      where: messageWhere,
      _max: { createdAt: true },
    }),
    prisma.feedbackAttachment.aggregate({
      where: attachmentWhere,
      _max: { createdAt: true },
    }),
    prisma.feedback.count({ where: feedbackWhere }),
    prisma.feedbackMessage.count({ where: messageWhere }),
    prisma.feedbackAttachment.count({ where: attachmentWhere }),
  ]);

  return encodeVersion([
    encodePart(
      "feedback",
      newestDate(
        feedbackUpdated._max.updatedAt,
        feedbackUpdated._max.lastMessageAt,
      ),
      feedbackCount,
    ),
    encodePart("messages", feedbackMessageCreated._max.createdAt, messageCount),
    encodePart(
      "attachments",
      feedbackAttachmentCreated._max.createdAt,
      attachmentCount,
    ),
  ]);
}

async function getProcurementVersion(userOpenId: string): Promise<string> {
  const orderWhere = procurementListWhere(userOpenId, {
    includeRejected: true,
  });
  return encodeVersion(
    await Promise.all([
      purchaseOrderUpdatedAtVersion("orders", orderWhere),
      purchaseItemVersion({ order: orderWhere }),
    ]),
  );
}

async function getProcurementDashboardVersion(): Promise<string> {
  const orderWhere = procurementSummaryWhere();
  return encodeVersion(
    await Promise.all([
      purchaseOrderUpdatedAtVersion("orders", orderWhere),
      purchaseItemVersion({ order: orderWhere }),
    ]),
  );
}

async function getProcurementOrderVersion({
  orderId,
  userOpenId,
  isSuperAdmin,
}: {
  orderId: string;
  userOpenId: string;
  isSuperAdmin: boolean;
}): Promise<string> {
  const order = await prisma.purchaseOrder.findUnique({
    where: { id: orderId },
    include: {
      initiator: { select: { openId: true } },
      _count: { select: { items: true } },
    },
  });
  if (
    !order ||
    !canViewProcurementOrder(
      order.status,
      userOpenId,
      order.initiator.openId,
      isSuperAdmin,
    )
  ) {
    return `missing:procurement-order:${orderId}`;
  }

  return encodeVersion([
    encodePart("order", order.updatedAt, 1),
    encodePart("statusEntered", order.statusEnteredAt, 1),
    encodePart("rejected", order.rejectedAt, order.rejectionReason ? 1 : 0),
    encodePart("items", "", order._count.items),
  ]);
}

async function getProfileVersion(userOpenId: string): Promise<string> {
  return encodeVersion(
    await Promise.all([
      userProfileVersion(userOpenId),
      purchaseOrderUpdatedAtVersion("orders", {
        initiator: { openId: userOpenId },
      }),
    ]),
  );
}

async function getAdminVersion(): Promise<string> {
  const [users, roles, budgetAggregate, budgetCount] = await Promise.all([
    prisma.user.findMany({
      orderBy: { openId: "asc" },
      select: {
        openId: true,
        name: true,
        email: true,
        avatar: true,
        signaturePath: true,
        createdAt: true,
      },
    }),
    prisma.userRole.findMany({
      orderBy: [
        { openId: "asc" },
        { role: "asc" },
        { team: "asc" },
        { techGroup: "asc" },
      ],
      select: { openId: true, role: true, team: true, techGroup: true },
    }),
    prisma.procurementBudgetPool.aggregate({ _max: { updatedAt: true } }),
    prisma.procurementBudgetPool.count(),
  ]);

  return encodeVersion([
    `users:${JSON.stringify(
      users.map((user) => ({
        ...user,
        createdAt: user.createdAt.toISOString(),
      })),
    )}`,
    `roles:${JSON.stringify(roles)}`,
    encodePart("budgetPools", budgetAggregate._max.updatedAt, budgetCount),
  ]);
}

export async function getLiveVersion(
  context: LiveVersionContext,
): Promise<string> {
  const userVersion = await userRoleVersion(context.userOpenId);
  const withUserVersion = (version: string) =>
    encodeVersion([version, userVersion]);

  if (context.scope === "feedback") {
    return withUserVersion(await getFeedbackVersion(context));
  }
  if (context.scope === "procurement") {
    return withUserVersion(await getProcurementVersion(context.userOpenId));
  }
  if (context.scope === "procurement-dashboard") {
    return withUserVersion(await getProcurementDashboardVersion());
  }
  if (context.scope === "procurement-order") {
    if (!context.resourceId) return "missing:procurement-order";
    return withUserVersion(
      await getProcurementOrderVersion({
        orderId: context.resourceId,
        userOpenId: context.userOpenId,
        isSuperAdmin: context.isSuperAdmin,
      }),
    );
  }
  if (context.scope === "profile") {
    return withUserVersion(await getProfileVersion(context.userOpenId));
  }
  if (context.scope === "admin") {
    if (!context.isSuperAdmin) return withUserVersion("admin:forbidden");
    return withUserVersion(await getAdminVersion());
  }

  return "unknown";
}

export function isLiveVersionScope(value: string): value is LiveVersionScope {
  return [
    "feedback",
    "procurement",
    "procurement-dashboard",
    "procurement-order",
    "profile",
    "admin",
  ].includes(value);
}
