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
  DEFAULT_BUDGET_PERIOD,
  formatBudgetPoolLabel,
} from "@/lib/procurement-budget-period";
import type { BudgetPoolImportResult } from "@/lib/import-procurement-budget";
import { MAX_BUDGET_POOL_IMPORT_ROWS } from "@/lib/constants";
import {
  SPREADSHEET_FILE_SIZE_LABEL,
  validateSpreadsheetFile,
} from "@/lib/spreadsheet-file";
import { createAsyncOperationGeneration } from "@/lib/async-operation-generation";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingPoolCount: number;
  onConfirm: (file: File, mode: "replace" | "append") => void;
  pending?: boolean;
  parseFile?: (file: File) => Promise<BudgetPoolImportResult>;
};

export function BudgetPoolImportDialog({
  open,
  onOpenChange,
  existingPoolCount,
  onConfirm,
  pending = false,
  parseFile,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const parseGenerationRef = useRef(createAsyncOperationGeneration());
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<BudgetPoolImportResult | null>(null);
  const [parsing, setParsing] = useState(false);
  const [downloadingTemplate, setDownloadingTemplate] = useState(false);

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0];
    event.target.value = "";
    if (!selected) return;

    const generation = parseGenerationRef.current.begin();
    setFile(null);
    setResult(null);
    setParsing(true);
    try {
      validateSpreadsheetFile(selected);
      const parsed = parseFile
        ? await parseFile(selected)
        : await import("@/lib/import-procurement-budget").then((module) =>
            module.parseBudgetPoolsFromFile(selected),
          );
      if (!parseGenerationRef.current.isCurrent(generation)) return;
      setFile(selected);
      setResult(parsed);
      if (parsed.rows.length === 0 && parsed.errors.length === 0) {
        toast.error("未解析到有效预算池");
      }
    } catch (err) {
      if (!parseGenerationRef.current.isCurrent(generation)) return;
      toast.error(err instanceof Error ? err.message : "文件解析失败");
      setFile(null);
      setResult(null);
    } finally {
      if (parseGenerationRef.current.isCurrent(generation)) {
        setParsing(false);
      }
    }
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      parseGenerationRef.current.cancel();
      setParsing(false);
      setFile(null);
      setResult(null);
    }
    onOpenChange(next);
  }

  function handleConfirm(mode: "replace" | "append") {
    if (!file || !result?.rows.length) {
      toast.error("没有可导入的有效预算池");
      return;
    }
    parseGenerationRef.current.cancel();
    onConfirm(file, mode);
    setFile(null);
    setResult(null);
    onOpenChange(false);
  }

  async function handleDownloadTemplate() {
    setDownloadingTemplate(true);
    try {
      const { downloadBudgetPoolTemplate } = await import(
        "@/lib/import-procurement-budget"
      );
      downloadBudgetPoolTemplate();
    } catch {
      toast.error("预算模板加载失败，请稍后重试");
    } finally {
      setDownloadingTemplate(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>导入采购预算池</DialogTitle>
          <DialogDescription>
            每行对应一条「车组 + 技术组」预算；相同组合将合并求和。周期默认{" "}
            {DEFAULT_BUDGET_PERIOD}，单次最多 {MAX_BUDGET_POOL_IMPORT_ROWS} 行，文件不超过 {SPREADSHEET_FILE_SIZE_LABEL}。
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
            disabled={parsing || pending}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="mr-1 h-4 w-4" />
            {parsing ? "解析中…" : file ? "重新选择" : "选择文件"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={downloadingTemplate || pending}
            onClick={() => void handleDownloadTemplate()}
          >
            <FileSpreadsheet className="mr-1 h-4 w-4" />
            {downloadingTemplate ? "下载中…" : "下载模板"}
          </Button>
        </div>

        {result && (
          <div className="max-h-52 space-y-2 overflow-y-auto rounded-md border bg-muted/30 p-3 text-sm">
            <p>
              文件：<strong>{file?.name}</strong>；将导入{" "}
              <strong>{result.rows.length}</strong> 条预算池
              {result.errors.length > 0 && (
                <>
                  ，
                  <span className="text-destructive">
                    {result.errors.length} 条错误
                  </span>
                </>
              )}
            </p>
            {result.errors.length > 0 && (
              <ul className="list-inside list-disc text-destructive">
                {result.errors.slice(0, 6).map((err) => (
                  <li key={`${err.row}-${err.message}`}>
                    {err.row > 0 ? `第 ${err.row} 行：` : ""}
                    {err.message}
                  </li>
                ))}
              </ul>
            )}
            {result.rows.length > 0 && (
              <ul className="space-y-1 text-muted-foreground">
                {result.rows.slice(0, 6).map((row) => (
                  <li key={`${row.description}-${row.team}-${row.techGroup}-${row.period}`}>
                    {row.description ? `${row.description} · ` : ""}
                    {formatBudgetPoolLabel(row.team, row.techGroup)} · ¥
                    {row.budgetAmount.toLocaleString("zh-CN")} · {row.period}
                  </li>
                ))}
                {result.rows.length > 6 && (
                  <li>…另有 {result.rows.length - 6} 条</li>
                )}
              </ul>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => handleOpenChange(false)}
          >
            取消
          </Button>
          {existingPoolCount > 0 && (
            <Button
              type="button"
              variant="secondary"
              disabled={parsing || !result?.rows.length || pending}
              onClick={() => handleConfirm("append")}
            >
              追加
            </Button>
          )}
          <Button
            type="button"
            disabled={parsing || !result?.rows.length || pending}
            onClick={() => handleConfirm("replace")}
          >
            {existingPoolCount > 0 ? "覆盖同周期" : "导入"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
