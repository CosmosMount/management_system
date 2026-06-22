import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { AppHeader } from "@/components/app-header";
import { OrderActions } from "@/components/order-actions";
import { ReimbursementDialog } from "@/components/reimbursement-dialog";
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
import {
  canUploadReimbursement,
  getUserRole,
  statusLabels,
} from "@/lib/permissions";

type Props = {
  params: Promise<{ id: string }>;
};

export default async function OrderDetailPage({ params }: Props) {
  const { id } = await params;
  const session = await auth();
  const userRole = session?.user?.openId
    ? await getUserRole(session.user.openId)
    : null;

  const order = await prisma.purchaseOrder.findUnique({
    where: { id },
    include: { items: true },
  });

  if (!order) {
    notFound();
  }

  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-4xl flex-1 space-y-6 p-4 py-8">
        <div className="flex items-center justify-between">
          <div>
            <Link
              href="/orders"
              className="text-sm text-muted-foreground hover:underline"
            >
              ← 返回列表
            </Link>
            <h1 className="mt-2 text-2xl font-bold">{order.orderNo}</h1>
          </div>
          <div className="flex items-center gap-2">
            <Badge>{statusLabels[order.status]}</Badge>
            <OrderActions
              orderId={order.id}
              status={order.status}
              userRole={userRole}
            />
            <ReimbursementDialog
              orderId={order.id}
              totalPrice={order.totalPrice}
              canOperate={canUploadReimbursement(order.status, userRole)}
            />
          </div>
        </div>

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

        {(order.invoicePath || order.screenshotPath) && (
          <Card>
            <CardHeader>
              <CardTitle>报销凭证</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {order.invoicePath && (
                <p>
                  <span className="text-muted-foreground">发票：</span>
                  <a
                    href={order.invoicePath}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary hover:underline"
                  >
                    查看文件
                  </a>
                </p>
              )}
              {order.screenshotPath && (
                <p>
                  <span className="text-muted-foreground">系统截图：</span>
                  <a
                    href={order.screenshotPath}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary hover:underline"
                  >
                    查看文件
                  </a>
                </p>
              )}
            </CardContent>
          </Card>
        )}
      </main>
    </>
  );
}
