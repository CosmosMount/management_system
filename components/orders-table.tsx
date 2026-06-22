"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight } from "lucide-react";
import { OrderActions } from "@/components/order-actions";
import { OrderReimbursementActions } from "@/components/order-reimbursement-actions";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { OrderStatus } from "@prisma/client";
import { groupOrderAttachments } from "@/lib/order-attachments";
import {
  canViewReimbursementAttachments,
  statusLabels,
  type UserRoleRecord,
} from "@/lib/permissions-client";

export type OrderRow = {
  id: string;
  orderNo: string;
  initiatorName: string;
  initiatorOpenId: string;
  team: string;
  techGroup: string;
  totalPrice: number;
  status: OrderStatus;
  teamApproved: boolean;
  techGroupApproved: boolean;
  invoicePaths: string;
  invoicePath: string | null;
  listDocPath: string | null;
  screenshotPath: string | null;
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
  userRoles: UserRoleRecord[];
  userOpenId?: string;
};

export function OrdersTable({ orders, userRoles, userOpenId }: Props) {
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
        {orders.map((order) => {
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
            userOpenId,
            order.initiatorOpenId,
          );

          return (
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
                    order={orderScope}
                    userRoles={userRoles}
                    managementState={managementState}
                  />
                  <OrderReimbursementActions
                    orderId={order.id}
                    totalPrice={order.totalPrice}
                    status={order.status}
                    orderScope={orderScope}
                    userRoles={userRoles}
                    userOpenId={userOpenId}
                    initiatorOpenId={order.initiatorOpenId}
                    attachments={attachments}
                    canViewAttachments={canViewAttachments}
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
          );
        })}
      </TableBody>
    </Table>
  );
}
