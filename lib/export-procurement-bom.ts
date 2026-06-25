import * as XLSX from "xlsx";
import type { TeamOption } from "@/lib/constants";
import { TEAM_OPTIONS } from "@/lib/constants";
import { formatPurchaseItemKind } from "@/lib/purchase-item-kind";
import type { SummaryRow } from "@/lib/procurement-summary-types";

const teamOrder = new Map<string, number>(
  TEAM_OPTIONS.map((team, index) => [team, index]),
);

function formatReference(row: SummaryRow): string {
  if (row.purchaseLink) {
    return row.purchaseLink;
  }
  return row.referenceImagePath || "";
}

function toSheetRow(row: SummaryRow) {
  return {
    车组: row.team,
    技术组: row.techGroup,
    单号: row.orderNo,
    发起人: row.initiatorName,
    物品名称: row.itemName,
    规格: row.spec,
    种类: formatPurchaseItemKind(row.itemKind),
    "链接/图片": formatReference(row),
    数量: row.quantity,
    单价: row.unitPrice,
    小计: row.lineTotal,
    订单总价: row.orderTotal,
    创建时间: new Date(row.createdAt).toLocaleString("zh-CN"),
  };
}

export function sortBomRowsByTeam(rows: SummaryRow[]): SummaryRow[] {
  return [...rows].sort((a, b) => {
    const teamDiff =
      (teamOrder.get(a.team) ?? Number.MAX_SAFE_INTEGER) -
      (teamOrder.get(b.team) ?? Number.MAX_SAFE_INTEGER);
    if (teamDiff !== 0) return teamDiff;

    const techDiff = a.techGroup.localeCompare(b.techGroup, "zh-CN");
    if (techDiff !== 0) return techDiff;

    const orderDiff = a.orderNo.localeCompare(b.orderNo, "zh-CN");
    if (orderDiff !== 0) return orderDiff;

    return a.itemName.localeCompare(b.itemName, "zh-CN");
  });
}

export function filterBomRowsByTeam(
  rows: SummaryRow[],
  team: TeamOption,
): SummaryRow[] {
  return rows.filter((row) => row.team === team);
}

function downloadRowsAsXlsx(rows: SummaryRow[], filename: string) {
  const sheet = XLSX.utils.json_to_sheet(rows.map(toSheetRow));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "BOM");
  XLSX.writeFile(workbook, filename);
}

function formatExportDate(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

export function exportTeamBomXlsx(rows: SummaryRow[], team: TeamOption) {
  const teamRows = sortBomRowsByTeam(filterBomRowsByTeam(rows, team));
  downloadRowsAsXlsx(teamRows, `BOM-${team}-${formatExportDate()}.xlsx`);
}

export function exportAllBomXlsx(rows: SummaryRow[]) {
  const sorted = sortBomRowsByTeam(rows);
  downloadRowsAsXlsx(sorted, `BOM-全部-${formatExportDate()}.xlsx`);
}
