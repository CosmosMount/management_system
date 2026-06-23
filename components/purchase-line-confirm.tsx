"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type PurchaseLineItem = {
  id: string;
  name: string;
  spec: string;
  quantity: number;
  unitPrice: number;
};

export type ConfirmedLineItem = {
  id: string;
  lineTotal: number;
};

type Props = {
  items: PurchaseLineItem[];
  editable?: boolean;
  showPhotoUpload?: boolean;
  onChange?: (items: ConfirmedLineItem[]) => void;
};

export function PurchaseLineConfirm({
  items,
  editable = false,
  showPhotoUpload = false,
  onChange,
}: Props) {
  const [lineTotals, setLineTotals] = useState<Record<string, number>>(() =>
    Object.fromEntries(
      items.map((item) => [
        item.id,
        Math.round(item.quantity * item.unitPrice * 100) / 100,
      ]),
    ),
  );

  useEffect(() => {
    onChange?.(
      items.map((item) => ({
        id: item.id,
        lineTotal:
          lineTotals[item.id] ??
          Math.round(item.quantity * item.unitPrice * 100) / 100,
      })),
    );
  }, [items, lineTotals, onChange]);

  const rows = useMemo(
    () =>
      items.map((item) => {
        const lineTotal = lineTotals[item.id] ?? item.quantity * item.unitPrice;
        const unitPrice =
          item.quantity > 0
            ? Math.round((lineTotal / item.quantity) * 100) / 100
            : 0;
        return { ...item, lineTotal, unitPrice };
      }),
    [items, lineTotals],
  );

  const grandTotal = rows.reduce((sum, row) => sum + row.lineTotal, 0);

  function updateLineTotal(id: string, value: number) {
    const next = { ...lineTotals, [id]: value };
    setLineTotals(next);
    onChange?.(
      items.map((item) => ({
        id: item.id,
        lineTotal: next[item.id] ?? 0,
      })),
    );
  }

  return (
    <div className="space-y-3">
      <Label>采购明细价格确认</Label>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>物品</TableHead>
              <TableHead>规格</TableHead>
              <TableHead className="text-right">数量</TableHead>
              <TableHead className="text-right">行总价</TableHead>
              <TableHead className="text-right">单价</TableHead>
              {showPhotoUpload && <TableHead>实物照片</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>{row.name}</TableCell>
                <TableCell className="text-muted-foreground">
                  {row.spec}
                </TableCell>
                <TableCell className="text-right">{row.quantity}</TableCell>
                <TableCell className="text-right">
                  {editable ? (
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      className="ml-auto h-8 w-28 text-right"
                      value={row.lineTotal}
                      onChange={(e) =>
                        updateLineTotal(row.id, Number(e.target.value))
                      }
                    />
                  ) : (
                    `¥${row.lineTotal.toFixed(2)}`
                  )}
                </TableCell>
                <TableCell className="text-right text-muted-foreground">
                  ¥{row.unitPrice.toFixed(2)}
                </TableCell>
                {showPhotoUpload && (
                  <TableCell>
                    <Input
                      name={`photo-${row.id}`}
                      type="file"
                      accept=".png,.jpg,.jpeg,.pdf"
                      className="h-8 max-w-48"
                      required
                    />
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="text-right text-sm font-medium">
        合计：¥{grandTotal.toFixed(2)}
      </p>
    </div>
  );
}

export function getConfirmedTotal(items: ConfirmedLineItem[]): number {
  return items.reduce((sum, item) => sum + item.lineTotal, 0);
}
