import * as XLSX from "xlsx";
import {
  MAX_BUDGET_POOL_IMPORT_ROWS,
  TEAM_OPTIONS,
  TECH_GROUP_OPTIONS,
} from "@/lib/constants";

export const DEFAULT_BUDGET_PERIOD = "2026";

export type BudgetPoolImportRow = {
  description: string;
  team: string;
  techGroup: string;
  budgetAmount: number;
  period: string;
};

export type BudgetPoolImportError = {
  row: number;
  message: string;
};

export type BudgetPoolImportResult = {
  rows: BudgetPoolImportRow[];
  errors: BudgetPoolImportError[];
};

const HEADER_ALIASES: Record<string, keyof RawRow> = {
  描述: "description",
  说明: "description",
  备注: "description",
  车组: "team",
  技术组: "techGroup",
  预算: "budgetAmount",
  预算金额: "budgetAmount",
  金额: "budgetAmount",
  周期: "period",
  年度: "period",
};

type RawRow = {
  description?: string;
  team?: string;
  techGroup?: string;
  budgetAmount?: string | number;
  period?: string;
};

export function currentBudgetPeriod(): string {
  return DEFAULT_BUDGET_PERIOD;
}

function normalizeHeader(value: unknown): string {
  return String(value ?? "").trim();
}

function resolveHeaderKey(header: string): keyof RawRow | null {
  const trimmed = header.trim();
  if (HEADER_ALIASES[trimmed]) return HEADER_ALIASES[trimmed];
  return null;
}

function parseBudgetAmount(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const num = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(num) || num <= 0) return null;
  return num;
}

function sheetRowsToRawRows(sheet: XLSX.WorkSheet): RawRow[] {
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: "",
    raw: false,
  }) as unknown[][];

  if (matrix.length < 2) return [];

  const headerRow = matrix[0] ?? [];
  const columnKeys: (keyof RawRow | null)[] = headerRow.map((cell) =>
    resolveHeaderKey(normalizeHeader(cell)),
  );

  const hasTeam = columnKeys.includes("team");
  const hasTechGroup = columnKeys.includes("techGroup");
  const hasBudget = columnKeys.includes("budgetAmount");
  if (!hasTeam || !hasTechGroup || !hasBudget) {
    throw new Error("Excel 缺少必填列：车组、技术组、预算");
  }

  const rows: RawRow[] = [];
  for (let i = 1; i < matrix.length; i++) {
    const line = matrix[i] ?? [];
    const raw: RawRow = {};
    let hasContent = false;

    columnKeys.forEach((key, colIndex) => {
      if (!key) return;
      const cell = line[colIndex];
      const text = String(cell ?? "").trim();
      if (text) hasContent = true;
      if (key === "budgetAmount") {
        raw[key] = cell as string | number;
      } else {
        raw[key] = text;
      }
    });

    if (hasContent) rows.push(raw);
  }

  return rows;
}

function parseRawRow(
  raw: RawRow,
  rowNum: number,
  errors: BudgetPoolImportError[],
): BudgetPoolImportRow | null {
  const team = raw.team?.trim() ?? "";
  const techGroup = raw.techGroup?.trim() ?? "";
  const description = raw.description?.trim() ?? "";
  const period = raw.period?.trim() || DEFAULT_BUDGET_PERIOD;
  const budgetAmount = parseBudgetAmount(raw.budgetAmount);

  if (!team) {
    errors.push({ row: rowNum, message: "车组不能为空" });
    return null;
  }
  if (!techGroup) {
    errors.push({ row: rowNum, message: "技术组不能为空" });
    return null;
  }
  if (!(TEAM_OPTIONS as readonly string[]).includes(team)) {
    errors.push({ row: rowNum, message: `无效车组：${team}` });
    return null;
  }
  if (!(TECH_GROUP_OPTIONS as readonly string[]).includes(techGroup)) {
    errors.push({ row: rowNum, message: `无效技术组：${techGroup}` });
    return null;
  }
  if (budgetAmount === null) {
    errors.push({ row: rowNum, message: "预算金额无效" });
    return null;
  }

  return { description, team, techGroup, budgetAmount, period };
}

function poolMergeKey(row: Pick<BudgetPoolImportRow, "team" | "techGroup" | "period">): string {
  return `${row.team}\0${row.techGroup}\0${row.period}`;
}

/** 相同车组+技术组+周期合并：预算求和，描述去重后用「；」拼接 */
export function mergeBudgetPoolImportRows(
  rows: BudgetPoolImportRow[],
): BudgetPoolImportRow[] {
  const merged = new Map<string, BudgetPoolImportRow>();

  for (const row of rows) {
    const key = poolMergeKey(row);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...row });
      continue;
    }

    existing.budgetAmount += row.budgetAmount;
    const descriptions = new Set<string>();
    for (const part of existing.description.split("；")) {
      const text = part.trim();
      if (text) descriptions.add(text);
    }
    if (row.description) descriptions.add(row.description);
    existing.description = [...descriptions].join("；");
  }

  return [...merged.values()];
}

export function parseBudgetPoolsFromWorkbook(
  workbook: XLSX.WorkBook,
): BudgetPoolImportResult {
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    return { rows: [], errors: [{ row: 0, message: "Excel 文件为空" }] };
  }

  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    return { rows: [], errors: [{ row: 0, message: "无法读取工作表" }] };
  }

  let rawRows: RawRow[];
  try {
    rawRows = sheetRowsToRawRows(sheet);
  } catch (err) {
    return {
      rows: [],
      errors: [
        {
          row: 0,
          message: err instanceof Error ? err.message : "表头解析失败",
        },
      ],
    };
  }

  if (rawRows.length === 0) {
    return { rows: [], errors: [{ row: 0, message: "未找到有效数据行" }] };
  }

  if (rawRows.length > MAX_BUDGET_POOL_IMPORT_ROWS) {
    return {
      rows: [],
      errors: [
        {
          row: 0,
          message: `导入行数超过上限 ${MAX_BUDGET_POOL_IMPORT_ROWS} 行`,
        },
      ],
    };
  }

  const parsedRows: BudgetPoolImportRow[] = [];
  const errors: BudgetPoolImportError[] = [];

  rawRows.forEach((raw, index) => {
    const rowNum = index + 2;
    const parsed = parseRawRow(raw, rowNum, errors);
    if (parsed) parsedRows.push(parsed);
  });

  const rows = mergeBudgetPoolImportRows(parsedRows);

  return { rows, errors };
}

export function parseBudgetPoolsFromBuffer(
  buffer: ArrayBuffer,
): BudgetPoolImportResult {
  const workbook = XLSX.read(buffer, { type: "array" });
  return parseBudgetPoolsFromWorkbook(workbook);
}

export async function parseBudgetPoolsFromFile(
  file: File,
): Promise<BudgetPoolImportResult> {
  const buffer = await file.arrayBuffer();
  return parseBudgetPoolsFromBuffer(buffer);
}

export function formatBudgetPoolLabel(team: string, techGroup: string): string {
  return `${team} · ${techGroup}`;
}

export function downloadBudgetPoolTemplate() {
  const rows = [
    {
      描述: "英雄队机械方向",
      车组: "英雄",
      技术组: "机械",
      预算: 20000,
      周期: DEFAULT_BUDGET_PERIOD,
    },
    {
      描述: "英雄队电控方向",
      车组: "英雄",
      技术组: "电控",
      预算: 15000,
      周期: DEFAULT_BUDGET_PERIOD,
    },
    {
      描述: "步兵队硬件方向",
      车组: "步兵",
      技术组: "硬件",
      预算: 30000,
      周期: DEFAULT_BUDGET_PERIOD,
    },
  ];
  const sheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "预算池");
  XLSX.writeFile(workbook, "采购预算池导入模板.xlsx");
}
