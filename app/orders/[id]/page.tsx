import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { AppHeader } from "@/components/app-header";
import { OrderActions } from "@/components/order-actions";
import { OrderAttachmentsCard } from "@/components/order-attachments";
import { OrderPageFocus } from "@/components/order-page-focus";
import { OrderReimbursementActions } from "@/components/order-reimbursement-actions";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";
import { Badge } from "@/components/ui/badge";
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
import { groupOrderAttachments } from "@/lib/order-attachments";
import {
  canViewReimbursementAttachments,
  getUserRoles,
  statusLabels,
} from "@/lib/permissions";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ focus?: string; from?: string }>;
};

export default async function OrderDetailPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { focus, from } = await searchParams;
  const session = await auth();
  const userRoles = session?.user?.openId
    ? await getUserRoles(session.user.openId)
    : [];

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

  return (
    <>
      <AppHeader />
      <OrderPageFocus focus={focus ?? null} fromNotify={from === "notify"} />
      <PageShell>
        <main className="mx-auto max-w-4xl flex-1 space-y-6 p-4 py-8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Link
                href="/orders"
                className="text-sm text-muted-foreground hover:text-primary hover:underline"
              >
                ← 返回列表
              </Link>
              <PageTitle subtitle={`订单 ${order.orderNo}`} />
            </div>
            <div
              id="approval"
              className="flex flex-wrap items-center justify-end gap-2 scroll-mt-20"
            >
              <Badge variant={order.status === "REJECTED" ? "destructive" : "default"}>
                {statusLabels[order.status]}
              </Badge>
              <OrderActions
              orderId={order.id}
              status={order.status}
              order={orderScope}
              userRoles={userRoles}
              managementState={managementState}
            />
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
            />
          </div>
        </div>

        {order.rejectionReason && (
          <Card className="border-amber-200 bg-amber-50/80 dark:border-amber-900 dark:bg-amber-950/30">
            <CardContent className="space-y-1 pt-6 text-sm">
              <p className="font-medium text-amber-900 dark:text-amber-100">
                {order.status === "REJECTED" ? "驳回说明" : "退回补充说明"}
              </p>
              <p>{order.rejectionReason}</p>
              {order.rejectedByName && (
                <p className="text-muted-foreground">
                  {order.rejectedByName}
                  {order.rejectedAt
                    ? ` · ${order.rejectedAt.toLocaleString("zh-CN")}`
                    : ""}
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {order.status === "MANAGEMENT_REVIEW" && (
          <Card>
            <CardContent className="flex gap-4 pt-6 text-sm">
              <span>
                车组组长：{order.teamApproved ? "已通过" : "待审核"}
              </span>
              <span>
                技术组组长：{order.techGroupApproved ? "已通过" : "待审核"}
              </span>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>基本信息</CardTitle>
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
          <CardHeader>
            <CardTitle>采购明细</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>物品名称</TableHead>
                  <TableHead>规格</TableHead>
                  <TableHead>购买链接</TableHead>
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
                      {item.purchaseLink ? (
                        <a
                          href={item.purchaseLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline"
                        >
                          查看链接
                        </a>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
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
        </main>
      </PageShell>
    </>
  );
}
