import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { statusLabels } from "@/lib/permissions";
import type { OrderStatus } from "@prisma/client";

export type SummaryRow = {
  orderId: string;
  orderNo: string;
  initiatorName: string;
  team: string;
  techGroup: string;
  status: OrderStatus;
  itemName: string;
  spec: string;
  purchaseLink: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  orderTotal: number;
  createdAt: string;
};

type Props = {
  rows: SummaryRow[];
};

export function ProcurementSummaryTable({ rows }: Props) {
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
        暂无采购记录
      </p>
    );
  }

  const grandTotal = rows.reduce((sum, row) => sum + row.lineTotal, 0);

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-xl border bg-card/80 shadow-sm">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>单号</TableHead>
              <TableHead>发起人</TableHead>
              <TableHead>车组</TableHead>
              <TableHead>技术组</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>物品</TableHead>
              <TableHead>规格</TableHead>
              <TableHead>购买链接</TableHead>
              <TableHead className="text-right">数量</TableHead>
              <TableHead className="text-right">单价</TableHead>
              <TableHead className="text-right">小计</TableHead>
              <TableHead className="text-right">订单总价</TableHead>
              <TableHead>创建时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, index) => (
              <TableRow key={`${row.orderId}-${index}`}>
                <TableCell>
                  <Link
                    href={`/orders/${row.orderId}`}
                    className="font-medium text-primary hover:underline"
                  >
                    {row.orderNo}
                  </Link>
                </TableCell>
                <TableCell>{row.initiatorName}</TableCell>
                <TableCell>{row.team}</TableCell>
                <TableCell>{row.techGroup}</TableCell>
                <TableCell>
                  <Badge variant="secondary">{statusLabels[row.status]}</Badge>
                </TableCell>
                <TableCell>{row.itemName}</TableCell>
                <TableCell className="text-muted-foreground">
                  {row.spec}
                </TableCell>
                <TableCell>
                  {row.purchaseLink ? (
                    <a
                      href={row.purchaseLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline"
                    >
                      链接
                    </a>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell className="text-right">{row.quantity}</TableCell>
                <TableCell className="text-right">
                  ¥{row.unitPrice.toFixed(2)}
                </TableCell>
                <TableCell className="text-right font-medium">
                  ¥{row.lineTotal.toFixed(2)}
                </TableCell>
                <TableCell className="text-right text-muted-foreground">
                  ¥{row.orderTotal.toFixed(2)}
                </TableCell>
                <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                  {new Date(row.createdAt).toLocaleString("zh-CN")}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="text-right text-sm font-medium text-muted-foreground">
        明细合计（按行小计）：¥{grandTotal.toFixed(2)}
      </p>
    </div>
  );
}
