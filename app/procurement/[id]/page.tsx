import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { AppHeader } from "@/components/app-header";
import { LiveAutoRefresh } from "@/components/live-auto-refresh";
import { OrderActions } from "@/components/order-actions";
import { OrderDraftActions } from "@/components/order-draft-actions";
import { PurchaseOrderDeleteByAdminButton } from "@/components/admin-delete-actions";
import { OrderAttachmentsCard } from "@/components/order-attachments";
import { OrderPageFocus } from "@/components/order-page-focus";
import { OrderReimbursementActions } from "@/components/order-reimbursement-actions";
import { ProcurementNotifyApproverButton } from "@/components/procurement-notify-approver-button";
import { OrderRejectionNotice } from "@/components/procurement/order-rejection-notice";
import { OrdersBackHeader } from "@/components/procurement/procurement-back-link";
import { ProcurementPageLayout } from "@/components/procurement/procurement-page-layout";
import { PageShell } from "@/components/page-shell";
import { Badge } from "@/components/ui/badge";
import {
  CheckCircle2,
  CircleDashed,
  Info,
  ListOrdered,
} from "lucide-react";
import { PurchaseItemReferenceCell } from "@/components/purchase-item-reference-cell";
import { formatPurchaseItemKind } from "@/lib/purchase-item-kind";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { prisma } from "@/lib/prisma";
import { getCurrentUserLiveVersion } from "@/lib/live-version-current";
import { groupOrderAttachments } from "@/lib/order-attachments";
import {
  canViewReimbursementAttachments,
  canWithdrawProcurementOrder,
  canNotifyProcurementApprover,
  getUserRoles,
  isSuperAdmin,
  statusLabels,
} from "@/lib/permissions";
import { canViewProcurementOrder } from "@/lib/procurement-visibility";
import { resolveProcurementHandlerNames } from "@/lib/procurement-order-handlers";
import { userHasSignature } from "@/lib/user-signature";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ focus?: string; from?: string }>;
};

export default async function OrderDetailPage({ params, searchParams }: Props) {
  const { id } = await params;
  const liveVersion = await getCurrentUserLiveVersion("procurement-order", id);
  const { focus, from } = await searchParams;
  const session = await auth();
  const userRoles = session?.user?.openId
    ? await getUserRoles(session.user.openId)
    : [];
  const admin = session?.user?.openId
    ? await isSuperAdmin(session.user.openId)
    : false;
  const hasSignature = session?.user?.openId
    ? await userHasSignature(session.user.openId)
    : false;

  const order = await prisma.purchaseOrder.findUnique({
    where: { id },
    include: {
      items: true,
      initiator: { select: { openId: true } },
    },
  });

  if (!order) {
    notFound();
  }

  if (
    !canViewProcurementOrder(
      order.status,
      session?.user?.openId,
      order.initiator.openId,
      admin,
    )
  ) {
    notFound();
  }

  const orderScope = { team: order.team, techGroup: order.techGroup };
  const managementState = {
    teamApproved: order.teamApproved,
    techGroupApproved: order.techGroupApproved,
  };
  const attachments = groupOrderAttachments(order);
  const canViewAttachments = canViewReimbursementAttachments(
    order.status,
    userRoles,
    orderScope,
    session?.user?.openId,
    order.initiator.openId,
  );

  const canWithdrawForEdit = canWithdrawProcurementOrder(
    order.status,
    session?.user?.openId,
    order.initiator.openId,
  );
  const canNotifyApprover = canNotifyProcurementApprover(
    order.status,
    session?.user?.openId,
    order.initiator.openId,
  );
  const currentHandler = canNotifyApprover
    ? (
        await resolveProcurementHandlerNames([
          {
            id: order.id,
            status: order.status,
            team: order.team,
            techGroup: order.techGroup,
            initiatorName: order.initiatorName,
            teamApproved: order.teamApproved,
            techGroupApproved: order.techGroupApproved,
          },
        ])
      ).get(order.id)
    : undefined;

  return (
    <>
      <AppHeader />
      <LiveAutoRefresh
        scope="procurement-order"
        resourceId={order.id}
        initialVersion={liveVersion}
        intervalMs={5000}
      />
      <OrderPageFocus focus={focus ?? null} fromNotify={from === "notify"} />
      <PageShell>
        <ProcurementPageLayout className="max-w-4xl space-y-3">
          <div className="space-y-2">
            <div className="flex items-start justify-between gap-4">
              <OrdersBackHeader
                className="mb-0 min-w-0 flex-1"
                title={`订单 ${order.orderNo}`}
                description={`${order.initiatorName} · ${order.team} / ${order.techGroup}`}
              />
              <div
                id="approval"
                className="flex flex-wrap items-center justify-end gap-2 scroll-mt-20"
              >
              <Badge variant={order.status === "REJECTED" ? "destructive" : "default"}>
                {statusLabels[order.status]}
              </Badge>
              {order.isWorkshopFee && (
                <Badge variant="secondary">工坊加工费</Badge>
              )}
              {!order.isWorkshopFee && (
                <>
                  <OrderActions
                    orderId={order.id}
                    status={order.status}
                    order={orderScope}
                    userRoles={userRoles}
                    managementState={managementState}
                    hasSignature={hasSignature}
                  />
                  <OrderDraftActions
                    orderId={order.id}
                    status={order.status}
                    userOpenId={session?.user?.openId}
                    initiatorOpenId={order.initiator.openId}
                    hasSignature={hasSignature}
                  />
                  {canNotifyApprover ? (
                    <ProcurementNotifyApproverButton
                      orderId={order.id}
                      currentHandler={currentHandler}
                    />
                  ) : null}
                  <OrderReimbursementActions
                    orderId={order.id}
                    items={order.items.map((item) => ({
                      id: item.id,
                      name: item.name,
                      spec: item.spec,
                      quantity: item.quantity,
                      unitPrice: item.unitPrice,
                    }))}
                    status={order.status}
                    orderScope={orderScope}
                    userRoles={userRoles}
                    userOpenId={session?.user?.openId}
                    initiatorOpenId={order.initiator.openId}
                    attachments={attachments}
                    canViewAttachments={canViewAttachments}
                    rejectionReason={order.rejectionReason}
                    orderStatus={order.status}
                    rejectedByName={order.rejectedByName}
                    rejectedAt={order.rejectedAt}
                  />
                </>
              )}
            <PurchaseOrderDeleteByAdminButton
              orderId={order.id}
              isSuperAdmin={admin}
            />
            </div>
            </div>
            {order.rejectionReason ? (
              <OrderRejectionNotice
                reason={order.rejectionReason}
                status={order.status}
                rejectedByName={order.rejectedByName}
                rejectedAt={order.rejectedAt}
              />
            ) : null}
            {canWithdrawForEdit ? (
              <p className="text-sm text-muted-foreground">
                老师审核通过前，你可点击「修改清单」编辑采购明细并重新提交，已进行的审批将清零。
              </p>
            ) : null}
          </div>

        {order.status === "MANAGEMENT_REVIEW" && (
          <Card className="gap-0 py-0">
            <CardContent className="flex flex-wrap gap-4 py-3 text-sm">
              <span className="inline-flex items-center gap-1.5">
                {order.teamApproved ? (
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                ) : (
                  <CircleDashed className="h-4 w-4 text-muted-foreground" />
                )}
                车组组长：{order.teamApproved ? "已通过" : "待审核"}
              </span>
              <span className="inline-flex items-center gap-1.5">
                {order.techGroupApproved ? (
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                ) : (
                  <CircleDashed className="h-4 w-4 text-muted-foreground" />
                )}
                技术组组长：{order.techGroupApproved ? "已通过" : "待审核"}
              </span>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Info className="h-4 w-4 text-primary" />
              基本信息
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 sm:grid-cols-2">
            <p>
              <span className="text-muted-foreground">发起人：</span>
              {order.initiatorName}
            </p>
            <p>
              <span className="text-muted-foreground">车组：</span>
              {order.team}
            </p>
            <p>
              <span className="text-muted-foreground">技术组：</span>
              {order.techGroup}
            </p>
            <p>
              <span className="text-muted-foreground">总价：</span>¥
              {order.totalPrice.toFixed(2)}
            </p>
            <p>
              <span className="text-muted-foreground">创建时间：</span>
              {order.createdAt.toLocaleString("zh-CN")}
            </p>
            <p>
              <span className="text-muted-foreground">更新时间：</span>
              {order.updatedAt.toLocaleString("zh-CN")}
            </p>
          </CardContent>
        </Card>

        <OrderAttachmentsCard order={order} canView={canViewAttachments} />

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <ListOrdered className="h-4 w-4 text-primary" />
              采购明细
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>物品名称</TableHead>
                  <TableHead>规格</TableHead>
                  <TableHead>种类</TableHead>
                  <TableHead>加工商</TableHead>
                  <TableHead>链接/图片</TableHead>
                  <TableHead>数量</TableHead>
                  <TableHead>单价</TableHead>
                  <TableHead>小计</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {order.items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>{item.name}</TableCell>
                    <TableCell>{item.spec}</TableCell>
                    <TableCell>
                      {formatPurchaseItemKind(item.itemKind)}
                    </TableCell>
                    <TableCell>{item.processingVendor || "—"}</TableCell>
                    <TableCell>
                      <PurchaseItemReferenceCell
                        itemKind={item.itemKind}
                        purchaseLink={item.purchaseLink}
                        referenceImagePath={item.referenceImagePath}
                      />
                    </TableCell>
                    <TableCell>{item.quantity}</TableCell>
                    <TableCell>¥{item.unitPrice.toFixed(2)}</TableCell>
                    <TableCell>
                      ¥{(item.quantity * item.unitPrice).toFixed(2)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        </ProcurementPageLayout>
      </PageShell>
    </>
  );
}
