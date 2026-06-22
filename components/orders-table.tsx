"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight } from "lucide-react";
import { OrderActions } from "@/components/order-actions";
import { ReimbursementDialog } from "@/components/reimbursement-dialog";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { OrderStatus, UserRoleType } from "@prisma/client";
import {
  canUploadReimbursement,
  statusLabels,
} from "@/lib/permissions-client";

export type OrderRow = {
  id: string;
  orderNo: string;
  initiatorName: string;
  team: string;
  techGroup: string;
  totalPrice: number;
  status: OrderStatus;
  createdAt: string;
  items: {
    id: string;
    name: string;
    spec: string;
    quantity: number;
    unitPrice: number;
  }[];
};

type Props = {
  orders: OrderRow[];
  userRole: UserRoleType | null;
};

export function OrdersTable({ orders, userRole }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (orders.length === 0) {
    return (
      <p className="py-8 text-center text-muted-foreground">暂无订单</p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-8" />
          <TableHead>单号</TableHead>
          <TableHead>发起人</TableHead>
          <TableHead>车组</TableHead>
          <TableHead>技术组</TableHead>
          <TableHead>总价</TableHead>
          <TableHead>状态</TableHead>
          <TableHead>创建时间</TableHead>
          <TableHead>操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {orders.map((order) => (
          <Fragment key={order.id}>
            <TableRow>
              <TableCell>
                <button
                  type="button"
                  onClick={() =>
                    setExpanded(expanded === order.id ? null : order.id)
                  }
                  className="text-muted-foreground hover:text-foreground"
                >
                  {expanded === order.id ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                </button>
              </TableCell>
              <TableCell>
                <Link
                  href={`/orders/${order.id}`}
                  className="font-medium hover:underline"
                >
                  {order.orderNo}
                </Link>
              </TableCell>
              <TableCell>{order.initiatorName}</TableCell>
              <TableCell>{order.team}</TableCell>
              <TableCell>{order.techGroup}</TableCell>
              <TableCell>¥{order.totalPrice.toFixed(2)}</TableCell>
              <TableCell>
                <Badge variant="outline">{statusLabels[order.status]}</Badge>
              </TableCell>
              <TableCell>
                {new Date(order.createdAt).toLocaleString("zh-CN")}
              </TableCell>
              <TableCell className="space-x-2">
                <OrderActions
                  orderId={order.id}
                  status={order.status}
                  userRole={userRole}
                />
                <ReimbursementDialog
                  orderId={order.id}
                  totalPrice={order.totalPrice}
                  canOperate={canUploadReimbursement(
                    order.status,
                    userRole,
                  )}
                />
              </TableCell>
            </TableRow>
            {expanded === order.id && (
              <TableRow>
                <TableCell colSpan={9} className="bg-muted/30">
                  <div className="space-y-2 p-2">
                    <p className="text-sm font-medium">明细条目</p>
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
                              ¥
                              {(item.quantity * item.unitPrice).toFixed(2)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </TableCell>
              </TableRow>
            )}
          </Fragment>
        ))}
      </TableBody>
    </Table>
  );
}
