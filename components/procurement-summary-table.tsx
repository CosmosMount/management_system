"use client";

import { useMemo, useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import Link from "next/link";
import { Download } from "lucide-react";
import { toast } from "sonner";
import { statusLabels } from "@/lib/permissions-client";
import { routes } from "@/lib/routes";
import { PurchaseItemReferenceCell } from "@/components/purchase-item-reference-cell";
import { formatPurchaseItemKind } from "@/lib/purchase-item-kind";
import { TEAM_OPTIONS, TECH_GROUP_OPTIONS } from "@/lib/constants";
import type { TeamOption } from "@/lib/constants";
import {
  exportAllBomXlsx,
  exportTeamBomXlsx,
} from "@/lib/export-procurement-bom";
import type { SummaryRow } from "@/lib/procurement-summary-types";

export type { SummaryRow } from "@/lib/procurement-summary-types";

type Props = {
  rows: SummaryRow[];
};

const ALL_TEAMS = "全部车组";
const ALL_TECH_GROUPS = "全部技术组";

export function ProcurementSummaryTable({ rows }: Props) {
  const [teamFilter, setTeamFilter] = useState(ALL_TEAMS);
  const [techGroupFilter, setTechGroupFilter] = useState(ALL_TECH_GROUPS);

  const filteredRows = useMemo(() => {
    return rows.filter((row) => {
      if (teamFilter !== ALL_TEAMS && row.team !== teamFilter) return false;
      if (techGroupFilter !== ALL_TECH_GROUPS && row.techGroup !== techGroupFilter) {
        return false;
      }
      return true;
    });
  }, [rows, teamFilter, techGroupFilter]);

  const grandTotal = filteredRows.reduce((sum, row) => sum + row.lineTotal, 0);
  const hasActiveFilter =
    teamFilter !== ALL_TEAMS || techGroupFilter !== ALL_TECH_GROUPS;

  const canExportTeamBom =
    teamFilter !== ALL_TEAMS &&
    (TEAM_OPTIONS as readonly string[]).includes(teamFilter);

  function handleExportTeamBom() {
    if (!canExportTeamBom) {
      toast.error("请先在上方选择要导出的车组");
      return;
    }
    const teamRows = rows.filter((row) => row.team === teamFilter);
    if (teamRows.length === 0) {
      toast.error("该车组暂无采购明细");
      return;
    }
    exportTeamBomXlsx(rows, teamFilter as TeamOption);
    toast.success(`已导出 ${teamFilter} BOM`);
  }

  function handleExportAllBom() {
    if (rows.length === 0) {
      toast.error("暂无采购明细可导出");
      return;
    }
    exportAllBomXlsx(rows);
    toast.success("已导出全部 BOM");
  }

  return (
    <div className="space-y-4">
      <div className="flex w-full flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">按组别查看：</span>
        <Select
          value={teamFilter}
          onValueChange={(value) => value && setTeamFilter(value)}
        >
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="全部车组" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_TEAMS}>全部车组</SelectItem>
            {TEAM_OPTIONS.map((team) => (
              <SelectItem key={team} value={team}>
                {team}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={techGroupFilter}
          onValueChange={(value) => value && setTechGroupFilter(value)}
        >
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="全部技术组" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_TECH_GROUPS}>全部技术组</SelectItem>
            {TECH_GROUP_OPTIONS.map((group) => (
              <SelectItem key={group} value={group}>
                {group}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {hasActiveFilter && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setTeamFilter(ALL_TEAMS);
              setTechGroupFilter(ALL_TECH_GROUPS);
            }}
          >
            显示全部
          </Button>
        )}
        {hasActiveFilter && (
          <span className="text-sm text-muted-foreground">
            共 {filteredRows.length} 条
          </span>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={rows.length === 0}
            onClick={handleExportTeamBom}
          >
            <Download className="mr-1 h-4 w-4" />
            导出该车组 BOM
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={rows.length === 0}
            onClick={handleExportAllBom}
          >
            <Download className="mr-1 h-4 w-4" />
            导出全部 BOM
          </Button>
        </div>
      </div>
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
              <TableHead>种类</TableHead>
              <TableHead>加工商</TableHead>
              <TableHead>链接/图片</TableHead>
              <TableHead className="text-right">数量</TableHead>
              <TableHead className="text-right">单价</TableHead>
              <TableHead className="text-right">小计</TableHead>
              <TableHead className="text-right">订单总价</TableHead>
              <TableHead>创建时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredRows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={15}
                  className="h-24 text-center text-muted-foreground"
                >
                  {hasActiveFilter ? "当前筛选条件下暂无记录" : "暂无采购记录"}
                </TableCell>
              </TableRow>
            ) : (
              filteredRows.map((row, index) => (
                <TableRow key={`${row.orderId}-${index}`}>
                  <TableCell>
                    <Link
                      href={`${routes.procurement.detail(row.orderId)}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {row.orderNo}
                    </Link>
                  </TableCell>
                  <TableCell>{row.initiatorName}</TableCell>
                  <TableCell>{row.team}</TableCell>
                  <TableCell>{row.techGroup}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">
                      {statusLabels[row.status]}
                    </Badge>
                  </TableCell>
                  <TableCell>{row.itemName}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {row.spec}
                  </TableCell>
                  <TableCell>{formatPurchaseItemKind(row.itemKind)}</TableCell>
                  <TableCell>{row.processingVendor || "—"}</TableCell>
                  <TableCell>
                    <PurchaseItemReferenceCell
                      itemKind={row.itemKind}
                      purchaseLink={row.purchaseLink}
                      referenceImagePath={row.referenceImagePath}
                    />
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
              ))
            )}
          </TableBody>
        </Table>
      </div>
      {filteredRows.length > 0 && (
        <p className="text-right text-sm font-medium text-muted-foreground">
          明细合计（按行小计）：¥{grandTotal.toFixed(2)}
        </p>
      )}
    </div>
  );
}
