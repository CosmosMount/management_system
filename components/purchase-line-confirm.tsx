"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { IMAGE_UPLOAD_ACCEPT } from "@/lib/upload-accept";
import { AttachmentFileLink } from "@/components/attachment-file-link";
import { MAX_REIMBURSEMENT_LIST_ROWS } from "@/lib/constants";

export type PurchaseLineItem = {
  id: string;
  name: string;
  spec: string;
  quantity: number;
  unitPrice: number;
  photoPath?: string | null;
};

export type ConfirmedLineItem = {
  id: string;
  name: string;
  spec: string;
  quantity: number;
  lineTotal: number;
};

type EditableLine = {
  id: string;
  name: string;
  spec: string;
  quantity: number;
  lineTotal: number;
  photoPath?: string | null;
  isNew?: boolean;
};

type Props = {
  items: PurchaseLineItem[];
  editable?: boolean;
  showPhotoUpload?: boolean;
  /** 允许增删整行（上传/修改凭证） */
  allowRowEdit?: boolean;
  onChange?: (items: ConfirmedLineItem[]) => void;
};

export function isNewPurchaseLineId(id: string): boolean {
  return id.startsWith("new_");
}

function createClientLineId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return `new_${crypto.randomUUID()}`;
  }
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.getRandomValues === "function"
  ) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return `new_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  }
  return `new_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function createNewLine(): EditableLine {
  return {
    id: createClientLineId(),
    name: "",
    spec: "",
    quantity: 1,
    lineTotal: 0,
    photoPath: null,
    isNew: true,
  };
}

function toEditableLines(items: PurchaseLineItem[]): EditableLine[] {
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    spec: item.spec,
    quantity: item.quantity,
    lineTotal: Math.round(item.quantity * item.unitPrice * 100) / 100,
    photoPath: item.photoPath,
    isNew: false,
  }));
}

function toConfirmed(lines: EditableLine[]): ConfirmedLineItem[] {
  return lines.map((line) => ({
    id: line.id,
    name: line.name,
    spec: line.spec,
    quantity: line.quantity,
    lineTotal: line.lineTotal,
  }));
}

export function PurchaseLineConfirm({
  items,
  editable = false,
  showPhotoUpload = false,
  allowRowEdit = false,
  onChange,
}: Props) {
  const [lines, setLines] = useState<EditableLine[]>(() =>
    toEditableLines(items),
  );

  useEffect(() => {
    setLines(toEditableLines(items));
  }, [items]);

  useEffect(() => {
    onChange?.(toConfirmed(lines));
  }, [lines, onChange]);

  const rows = useMemo(
    () =>
      lines.map((line) => ({
        ...line,
        unitPrice:
          line.quantity > 0
            ? Math.round((line.lineTotal / line.quantity) * 100) / 100
            : 0,
      })),
    [lines],
  );

  const grandTotal = rows.reduce((sum, row) => sum + row.lineTotal, 0);
  const canAdd =
    allowRowEdit && editable && lines.length < MAX_REIMBURSEMENT_LIST_ROWS;
  const canRemove = allowRowEdit && editable && lines.length > 1;

  function patchLine(id: string, patch: Partial<EditableLine>) {
    setLines((prev) =>
      prev.map((line) => (line.id === id ? { ...line, ...patch } : line)),
    );
  }

  function addLine() {
    if (!canAdd) return;
    setLines((prev) => [...prev, createNewLine()]);
  }

  function removeLine(id: string) {
    if (!canRemove) return;
    setLines((prev) => prev.filter((line) => line.id !== id));
  }

  return (
    <div className={showPhotoUpload ? "w-fit max-w-full space-y-3" : "space-y-3"}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label>{editable ? "采购明细" : "采购明细价格确认"}</Label>
        {allowRowEdit && editable ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canAdd}
            onClick={addLine}
          >
            <Plus className="mr-1 h-4 w-4" />
            添加一行
          </Button>
        ) : null}
      </div>
      <div
        className={
          showPhotoUpload
            ? "w-fit max-w-full rounded-lg border"
            : "overflow-x-auto rounded-lg border"
        }
      >
        <Table fitContent={showPhotoUpload}>
          <TableHeader>
            <TableRow>
              <TableHead>物品</TableHead>
              <TableHead>规格</TableHead>
              <TableHead className="text-right">数量</TableHead>
              <TableHead className="text-right">行总价</TableHead>
              <TableHead className="text-right">单价</TableHead>
              {showPhotoUpload && <TableHead>实物照片（每项一张）</TableHead>}
              {allowRowEdit && editable ? <TableHead className="w-12" /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  {editable ? (
                    <Input
                      className="h-8 min-w-[8rem]"
                      value={row.name}
                      placeholder="物品名称"
                      onChange={(e) =>
                        patchLine(row.id, { name: e.target.value })
                      }
                    />
                  ) : (
                    row.name
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {editable ? (
                    <Input
                      className="h-8 min-w-[6rem]"
                      value={row.spec}
                      placeholder="规格"
                      onChange={(e) =>
                        patchLine(row.id, { spec: e.target.value })
                      }
                    />
                  ) : (
                    row.spec
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {editable ? (
                    <Input
                      type="number"
                      min={1}
                      step={1}
                      className="ml-auto h-8 w-20 text-right"
                      value={row.quantity}
                      onChange={(e) =>
                        patchLine(row.id, {
                          quantity: Math.max(
                            1,
                            Math.floor(Number(e.target.value) || 1),
                          ),
                        })
                      }
                    />
                  ) : (
                    row.quantity
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {editable ? (
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      className="ml-auto h-8 w-28 text-right"
                      value={row.lineTotal}
                      onChange={(e) =>
                        patchLine(row.id, {
                          lineTotal: Number(e.target.value),
                        })
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
                    <div className="space-y-1">
                      {row.photoPath ? (
                        <div className="space-y-1">
                          <p className="text-xs text-muted-foreground">
                            当前照片（每项仅一张，选择新文件将替换）
                          </p>
                          <AttachmentFileLink
                            filePath={row.photoPath}
                            previewClassName="max-h-24 rounded-md border object-contain"
                          />
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          尚未上传，请选择一张实物照片
                        </p>
                      )}
                      <Input
                        name={`photo-${row.id}`}
                        type="file"
                        accept={IMAGE_UPLOAD_ACCEPT}
                        className="h-8 w-auto min-w-[14rem]"
                        required={!row.photoPath}
                        aria-label={
                          row.photoPath
                            ? `更换「${row.name || "新物品"}」实物照片`
                            : `上传「${row.name || "新物品"}」实物照片`
                        }
                      />
                    </div>
                  </TableCell>
                )}
                {allowRowEdit && editable ? (
                  <TableCell>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={!canRemove}
                      onClick={() => removeLine(row.id)}
                      aria-label={`删除「${row.name || "该行"}」`}
                    >
                      <Trash2 className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  </TableCell>
                ) : null}
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
