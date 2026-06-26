"use client";

import { useRef, useState } from "react";
import { FileSpreadsheet, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  downloadProcurementItemsTemplate,
  filterProcessingFeeItems,
  parseProcurementItemsFromFile,
  type ImportProcurementItemsResult,
} from "@/lib/import-procurement-items";
import type { PurchaseItemInput } from "@/lib/validations/order";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingItemCount: number;
  processingFeeOnly?: boolean;
  onConfirm: (
    items: PurchaseItemInput[],
    mode: "replace" | "append",
  ) => void;
};

export function ProcurementItemsImportDialog({
  open,
  onOpenChange,
  existingItemCount,
  processingFeeOnly = false,
  onConfirm,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<ImportProcurementItemsResult | null>(
    null,
  );
  const [parsing, setParsing] = useState(false);

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setParsing(true);
    try {
      let parsed = await parseProcurementItemsFromFile(file);
      if (processingFeeOnly) {
        parsed = filterProcessingFeeItems(parsed);
      }
      setResult(parsed);
      if (parsed.items.length === 0 && parsed.errors.length === 0) {
        toast.error("未解析到有效条目");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "文件解析失败");
      setResult(null);
    } finally {
      setParsing(false);
    }
  }

  function handleConfirm(mode: "replace" | "append") {
    if (!result || result.items.length === 0) {
      toast.error("没有可导入的有效条目");
      return;
    }

    const total =
      mode === "append" ? existingItemCount + result.items.length : result.items.length;
    if (total > 50) {
      toast.error(`合并后超过 50 行上限（当前将变为 ${total} 行）`);
      return;
    }

    onConfirm(result.items, mode);
    setResult(null);
    onOpenChange(false);
  }

  function handleOpenChange(next: boolean) {
    if (!next) setResult(null);
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>从 Excel 导入采购明细</DialogTitle>
          <DialogDescription>
            支持 .xlsx / .xls。加工费条目导入后仍需手动上传参考图片。
            {processingFeeOnly ? " 本表单仅导入加工费行。" : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={handleFileChange}
          />
          <Button
            type="button"
            variant="outline"
            disabled={parsing}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="mr-1 h-4 w-4" />
            {parsing ? "解析中…" : "选择文件"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => downloadProcurementItemsTemplate()}
          >
            <FileSpreadsheet className="mr-1 h-4 w-4" />
            下载模板
          </Button>
        </div>

        {result && (
          <div className="max-h-48 space-y-2 overflow-y-auto rounded-md border bg-muted/30 p-3 text-sm">
            <p>
              成功解析 <strong>{result.items.length}</strong> 条
              {result.errors.length > 0 && (
                <>，<span className="text-destructive">{result.errors.length} 条错误</span></>
              )}
            </p>
            {result.errors.length > 0 && (
              <ul className="list-inside list-disc text-destructive">
                {result.errors.slice(0, 8).map((err) => (
                  <li key={`${err.row}-${err.message}`}>
                    {err.row > 0 ? `第 ${err.row} 行：` : ""}
                    {err.message}
                  </li>
                ))}
                {result.errors.length > 8 && (
                  <li>…另有 {result.errors.length - 8} 条错误</li>
                )}
              </ul>
            )}
            {result.items.some((item) => item.itemKind === "PROCESSING_FEE") && (
              <p className="text-amber-600 dark:text-amber-400">
                含加工费条目：导入后请为每行上传参考图片。
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            取消
          </Button>
          {existingItemCount > 0 && (
            <Button
              type="button"
              variant="secondary"
              disabled={!result?.items.length}
              onClick={() => handleConfirm("append")}
            >
              追加到现有条目
            </Button>
          )}
          <Button
            type="button"
            disabled={!result?.items.length}
            onClick={() => handleConfirm("replace")}
          >
            {existingItemCount > 0 ? "覆盖现有条目" : "导入"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
