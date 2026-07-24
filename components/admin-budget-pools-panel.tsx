"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileSpreadsheet, Upload } from "lucide-react";
import { toast } from "sonner";
import {
  importBudgetPoolsFromExcel,
  type listAdminBudgetPools,
} from "@/app/actions/adminBudgetPools";
import { BudgetPoolImportDialog } from "@/components/budget-pool-import-dialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
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
import {
  DEFAULT_BUDGET_PERIOD,
  downloadBudgetPoolTemplate,
} from "@/lib/import-procurement-budget";
import { MAX_BUDGET_POOL_IMPORT_ROWS } from "@/lib/constants";
import { getActionErrorMessage } from "@/lib/action-error-message";

export type AdminBudgetPool = Awaited<
  ReturnType<typeof listAdminBudgetPools>
>[number];

type Props = {
  pools: AdminBudgetPool[];
};

export function AdminBudgetPoolsPanel({ pools }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importErrors, setImportErrors] = useState<
    { row: number; message: string }[]
  >([]);

  function handleImport(file: File, mode: "replace" | "append") {
    const formData = new FormData();
    formData.set("file", file);
    formData.set("mode", mode);
    startTransition(async () => {
      try {
        const result = await importBudgetPoolsFromExcel(formData);
        setImportErrors(result.errors);
        toast.success(
          mode === "replace"
            ? `已覆盖导入 ${result.upserted} 条预算池`
            : `已追加/更新 ${result.upserted} 条预算池`,
        );
        router.refresh();
      } catch (err) {
        toast.error(getActionErrorMessage(err, "导入失败"));
      }
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>采购预算池</CardTitle>
          <CardDescription>
            每行一个项目（含车组、技术组与预算）。相同项目+车组+技术组+周期会合并预算；不同项目即使同组也分行展示，顺序与 Excel 一致。单次最多 {MAX_BUDGET_POOL_IMPORT_ROWS}{" "}
            行。支持追加或覆盖同周期数据。
          </CardDescription>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => downloadBudgetPoolTemplate()}
          >
            <FileSpreadsheet className="mr-1 h-4 w-4" />
            下载模板
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={pending}
            onClick={() => setImportDialogOpen(true)}
          >
            <Upload className="mr-1 h-4 w-4" />
            {pending ? "导入中…" : "导入 Excel"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {importErrors.length > 0 && (
          <ul className="list-inside list-disc text-sm text-destructive">
            {importErrors.map((err) => (
              <li key={`${err.row}-${err.message}`}>
                {err.row > 0 ? `第 ${err.row} 行：` : ""}
                {err.message}
              </li>
            ))}
          </ul>
        )}
        {pools.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            当前周期（{DEFAULT_BUDGET_PERIOD}）暂无预算池，请导入 Excel。
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>项目</TableHead>
                <TableHead>车组</TableHead>
                <TableHead>技术组</TableHead>
                <TableHead>周期</TableHead>
                <TableHead className="text-right">预算金额</TableHead>
                <TableHead className="text-right">已提醒阈值</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pools.map((pool) => (
                <TableRow key={pool.id}>
                  <TableCell className="max-w-48 truncate">
                    {pool.description || "—"}
                  </TableCell>
                  <TableCell>{pool.team}</TableCell>
                  <TableCell>{pool.techGroup}</TableCell>
                  <TableCell>{pool.period}</TableCell>
                  <TableCell className="text-right">
                    ¥{pool.budgetAmount.toLocaleString("zh-CN")}
                  </TableCell>
                  <TableCell className="text-right">
                    {pool.lastAlertThreshold > 0
                      ? `${pool.lastAlertThreshold}%`
                      : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <BudgetPoolImportDialog
        open={importDialogOpen}
        onOpenChange={setImportDialogOpen}
        existingPoolCount={pools.length}
        pending={pending}
        onConfirm={handleImport}
      />
    </Card>
  );
}
