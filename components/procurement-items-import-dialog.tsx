"use client";

import { useRef, useState } from "react";
import { FileSpreadsheet, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field-error";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ImportProcurementItemsResult } from "@/lib/import-procurement-items";
import type { PurchaseItemInput } from "@/lib/validations/order";
import {
  SPREADSHEET_FILE_SIZE_LABEL,
  validateSpreadsheetFile,
} from "@/lib/spreadsheet-file";
import { createAsyncOperationGeneration } from "@/lib/async-operation-generation";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingItemCount: number;
  onConfirm: (
    items: PurchaseItemInput[],
    mode: "replace" | "append",
  ) => void;
  parseFile?: (file: File) => Promise<ImportProcurementItemsResult>;
};

export function ProcurementItemsImportDialog({
  open,
  onOpenChange,
  existingItemCount,
  onConfirm,
  parseFile,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const parseGenerationRef = useRef(createAsyncOperationGeneration());
  const [result, setResult] = useState<ImportProcurementItemsResult | null>(
    null,
  );
  const [fileName, setFileName] = useState("");
  const [parsing, setParsing] = useState(false);
  const [downloadingTemplate, setDownloadingTemplate] = useState(false);
  const [fileError, setFileError] = useState("");

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    const generation = parseGenerationRef.current.begin();
    setFileName("");
    setResult(null);
    setFileError("");
    setParsing(true);
    try {
      validateSpreadsheetFile(file);
      const importHelpers = await import("@/lib/import-procurement-items");
      const parsed = parseFile
        ? await parseFile(file)
        : await importHelpers.parseProcurementItemsFromFile(file);
      if (!parseGenerationRef.current.isCurrent(generation)) return;
      setFileName(file.name);
      setResult(parsed);
      if (parsed.items.length === 0 && parsed.errors.length === 0) {
        setFileError("未解析到有效条目");
      }
    } catch (err) {
      if (!parseGenerationRef.current.isCurrent(generation)) return;
      setFileError(err instanceof Error ? err.message : "文件解析失败");
      setResult(null);
    } finally {
      if (parseGenerationRef.current.isCurrent(generation)) {
        setParsing(false);
      }
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

    parseGenerationRef.current.cancel();
    onConfirm(result.items, mode);
    setFileName("");
    setResult(null);
    onOpenChange(false);
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      parseGenerationRef.current.cancel();
      setParsing(false);
      setFileName("");
      setResult(null);
      setFileError("");
    }
    onOpenChange(next);
  }

  async function handleDownloadTemplate() {
    setDownloadingTemplate(true);
    try {
      const { downloadProcurementItemsTemplate } = await import(
        "@/lib/import-procurement-items"
      );
      downloadProcurementItemsTemplate();
    } catch {
      toast.error("采购明细模板加载失败，请稍后重试");
    } finally {
      setDownloadingTemplate(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>从 Excel 导入采购明细</DialogTitle>
          <DialogDescription>
            支持 .xlsx / .xls，文件不超过 {SPREADSHEET_FILE_SIZE_LABEL}。加工费条目导入后仍需手动上传参考图片。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            aria-invalid={Boolean(fileError)}
            aria-describedby={fileError ? "procurement-import-file-error" : undefined}
            onChange={handleFileChange}
          />
          <Button
            type="button"
            variant="outline"
            className={fileError ? "border-destructive ring-3 ring-destructive/20" : undefined}
            aria-invalid={Boolean(fileError)}
            aria-describedby={fileError ? "procurement-import-file-error" : undefined}
            disabled={parsing}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="mr-1 h-4 w-4" />
            {parsing ? "解析中…" : "选择文件"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={downloadingTemplate}
            onClick={() => void handleDownloadTemplate()}
          >
            <FileSpreadsheet className="mr-1 h-4 w-4" />
            {downloadingTemplate ? "下载中…" : "下载模板"}
          </Button>
          </div>
          <FieldError id="procurement-import-file-error" messages={fileError} />
        </div>

        {result && (
          <div className="max-h-48 space-y-2 overflow-y-auto rounded-md border bg-muted/30 p-3 text-sm">
            <p>
              文件：<strong>{fileName}</strong>；成功解析{" "}
              <strong>{result.items.length}</strong> 条
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
              disabled={parsing || !result?.items.length}
              onClick={() => handleConfirm("append")}
            >
              追加到现有条目
            </Button>
          )}
          <Button
            type="button"
            disabled={parsing || !result?.items.length}
            onClick={() => handleConfirm("replace")}
          >
            {existingItemCount > 0 ? "覆盖现有条目" : "导入"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
