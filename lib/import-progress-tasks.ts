import * as XLSX from "xlsx";
import {
  MAX_TASK_IMPORT_ROWS,
  normalizeTechGroupName,
  TECH_GROUP_OPTIONS,
} from "@/lib/constants";
import type { Importance, Urgency } from "@prisma/client";

export type TaskImportUserOption = {
  openId: string;
  name: string;
};

export type ImportedTaskWarning = {
  field: string;
  message: string;
};

export type ParsedImportedTask = {
  importId: string;
  rowNumber: number;
  title: string;
  goal: string;
  taskTechGroups: string[];
  assigneeOpenIds: string[];
  assigneeNames: string[];
  metrics: string;
  dueAt: string;
  needsWeeklyReport: boolean;
  urgency: Urgency;
  importance: Importance;
  warnings: ImportedTaskWarning[];
  ignored?: boolean;
};

export type TaskImportPreviewResult = {
  tasks: ParsedImportedTask[];
  errors: ImportedTaskWarning[];
};

type RawRow = {
  rowNumber: number;
  values: Map<ImportColumnKey, string>;
  rawValues: Map<ImportColumnKey, unknown>;
  extraGoalLines: string[];
};

type ImportColumnKey =
  | "title"
  | "taskTechGroups"
  | "assignees"
  | "metrics"
  | "needsWeeklyReport"
  | "urgency"
  | "importance"
  | "dueAt";

const HEADER_ALIASES: Record<string, ImportColumnKey> = {
  "测试/验收内容": "title",
  测试内容: "title",
  验收内容: "title",
  任务目标: "title",
  负责组别: "taskTechGroups",
  组别: "taskTechGroups",
  任务技术组: "taskTechGroups",
  负责人: "assignees",
  对应任务中的负责人: "assignees",
  "参考/要求": "metrics",
  指标: "metrics",
  "定量/定性指标": "metrics",
  是否需要定期周报: "needsWeeklyReport",
  定期周报: "needsWeeklyReport",
  紧急程度: "urgency",
  重要程度: "importance",
  最晚完成时间: "dueAt",
  DDL: "dueAt",
  截止时间: "dueAt",
};

const REQUIRED_COLUMNS: Array<{ key: ImportColumnKey; label: string }> = [
  { key: "title", label: "测试/验收内容" },
  { key: "assignees", label: "负责人" },
  { key: "metrics", label: "参考/要求" },
  { key: "dueAt", label: "最晚完成时间" },
];

const URGENCY_VALUES: Record<string, Urgency> = {
  高: "HIGH",
  中: "MEDIUM",
  低: "LOW",
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  LOW: "LOW",
};

const IMPORTANCE_VALUES: Record<string, Importance> = {
  高: "HIGH",
  中: "MEDIUM",
  低: "LOW",
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  LOW: "LOW",
};

const TRUE_VALUES = new Set(["是", "需要", "true", "yes", "y", "1"]);
const FALSE_VALUES = new Set(["否", "不需要", "false", "no", "n", "0"]);

function normalizeHeader(value: unknown): string {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .trim()
    .replace(/\s+/g, "");
}

function normalizeCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/^\uFEFF/, "").trim();
}

function resolveHeaderKey(header: string): ImportColumnKey | null {
  const normalized = normalizeHeader(header);
  if (!normalized) return null;
  return HEADER_ALIASES[normalized] ?? null;
}

function splitList(value: string): string[] {
  return value
    .split(/[,\uFF0C\u3001/;；\n\r]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeDateTimeLocal(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function parseDateToLocalInput(raw: unknown): string | null {
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return null;
    return normalizeDateTimeLocal(raw.toISOString());
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const parsed = XLSX.SSF.parse_date_code(raw);
    if (!parsed) return null;
    const date = new Date(
      parsed.y,
      parsed.m - 1,
      parsed.d,
      parsed.H || 18,
      parsed.M || 0,
      Math.floor(parsed.S || 0),
      0,
    );
    return normalizeDateTimeLocal(date.toISOString());
  }

  const value = String(raw ?? "").trim();
  if (!value) return null;

  const dateOnly = value.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    const date = new Date(Number(year), Number(month) - 1, Number(day), 18, 0, 0, 0);
    return normalizeDateTimeLocal(date.toISOString());
  }

  const shortDate = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (shortDate) {
    const [, month, day, rawYear] = shortDate;
    const yearNumber = Number(rawYear);
    const year = rawYear.length === 2 ? 2000 + yearNumber : yearNumber;
    const date = new Date(year, Number(month) - 1, Number(day), 18, 0, 0, 0);
    if (
      date.getFullYear() === year &&
      date.getMonth() === Number(month) - 1 &&
      date.getDate() === Number(day)
    ) {
      return normalizeDateTimeLocal(date.toISOString());
    }
    return null;
  }

  const normalized = value.replace(/\//g, "-");
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return null;
  return normalizeDateTimeLocal(date.toISOString());
}

function parseBoolean(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  if (!value) return false;
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  return false;
}

function parseLevel<T extends Urgency | Importance>(
  raw: string,
  values: Record<string, T>,
): { value: T; warning?: string } {
  const text = raw.trim();
  if (!text) return { value: values.中 };
  const normalized = text.toUpperCase();
  const value = values[text] ?? values[normalized];
  if (value) return { value };
  return { value: values.中, warning: `无法识别“${raw}”，已按“中”处理` };
}

function parseTechGroups(raw: string): {
  groups: string[];
  warnings: ImportedTaskWarning[];
} {
  const warnings: ImportedTaskWarning[] = [];
  const parts = splitList(raw);
  if (parts.length === 0) return { groups: ["通用"], warnings };

  const groups: string[] = [];
  for (const part of parts) {
    const normalized = normalizeTechGroupName(part);
    if ((TECH_GROUP_OPTIONS as readonly string[]).includes(normalized)) {
      groups.push(normalized);
    } else {
      warnings.push({
        field: "taskTechGroups",
        message: `无法识别技术组“${part}”，已跳过`,
      });
    }
  }

  return {
    groups: [...new Set(groups.length > 0 ? groups : ["通用"])],
    warnings,
  };
}

function parseAssignees(
  raw: string,
  users: TaskImportUserOption[],
): {
  openIds: string[];
  names: string[];
  warnings: ImportedTaskWarning[];
} {
  const warnings: ImportedTaskWarning[] = [];
  const openIds: string[] = [];
  const names: string[] = [];
  for (const name of splitList(raw)) {
    const matches = users.filter((user) => user.name.trim() === name);
    if (matches.length === 1) {
      openIds.push(matches[0].openId);
      names.push(matches[0].name);
    } else if (matches.length > 1) {
      warnings.push({
        field: "assigneeOpenIds",
        message: `负责人“${name}”存在重名，请手动选择`,
      });
    } else {
      warnings.push({
        field: "assigneeOpenIds",
        message: `未找到负责人“${name}”，请手动选择`,
      });
    }
  }
  return {
    openIds: [...new Set(openIds)],
    names: [...new Set(names)],
    warnings,
  };
}

function workbookToRawRows(workbook: XLSX.WorkBook): RawRow[] {
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("文件为空，未找到工作表");
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error("无法读取工作表");

  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: "",
    raw: true,
  }) as unknown[][];
  if (matrix.length < 2) throw new Error("未找到有效数据行");

  const headerRow = matrix[0] ?? [];
  const columnKeys = headerRow.map((cell) => resolveHeaderKey(normalizeHeader(cell)));
  const missingColumns = REQUIRED_COLUMNS.filter(
    (column) => !columnKeys.includes(column.key),
  );
  if (missingColumns.length > 0) {
    throw new Error(
      `文件缺少必填列：${missingColumns.map((column) => column.label).join("、")}`,
    );
  }

  const rows: RawRow[] = [];
  for (let index = 1; index < matrix.length; index++) {
    const line = matrix[index] ?? [];
    const titleCell = normalizeCell(line[columnKeys.indexOf("title")]);
    const hasContent = line.some((cell) => normalizeCell(cell));
    if (!hasContent) continue;
    if (titleCell.startsWith("使用方式")) continue;

    const values = new Map<ImportColumnKey, string>();
    const rawValues = new Map<ImportColumnKey, unknown>();
    const extraGoalLines: string[] = [];
    headerRow.forEach((header, colIndex) => {
      const cell = normalizeCell(line[colIndex]);
      if (!cell) return;
      const key = columnKeys[colIndex];
      if (key) {
        values.set(key, cell);
        rawValues.set(key, line[colIndex]);
        return;
      }
      const headerText = normalizeCell(header);
      if (headerText) extraGoalLines.push(`${headerText}：${cell}`);
    });

    rows.push({ rowNumber: index + 1, values, rawValues, extraGoalLines });
  }

  if (rows.length === 0) throw new Error("未找到有效数据行");
  if (rows.length > MAX_TASK_IMPORT_ROWS) {
    throw new Error(`导入行数超过上限 ${MAX_TASK_IMPORT_ROWS} 行`);
  }
  return rows;
}

export function parseProgressTasksFromWorkbook(
  workbook: XLSX.WorkBook,
  users: TaskImportUserOption[],
): TaskImportPreviewResult {
  let rawRows: RawRow[];
  try {
    rawRows = workbookToRawRows(workbook);
  } catch (error) {
    return {
      tasks: [],
      errors: [
        {
          field: "file",
          message: error instanceof Error ? error.message : "文件解析失败",
        },
      ],
    };
  }

  const tasks = rawRows.map((row) => {
    const warnings: ImportedTaskWarning[] = [];
    const title = row.values.get("title")?.trim() ?? "";
    const metrics = row.values.get("metrics")?.trim() ?? "";
    const { groups, warnings: groupWarnings } = parseTechGroups(
      row.values.get("taskTechGroups") ?? "",
    );
    warnings.push(...groupWarnings);

    const { openIds, names, warnings: assigneeWarnings } = parseAssignees(
      row.values.get("assignees") ?? "",
      users,
    );
    warnings.push(...assigneeWarnings);

    const dueAt = parseDateToLocalInput(
      row.rawValues.has("dueAt")
        ? row.rawValues.get("dueAt")
        : (row.values.get("dueAt") ?? ""),
    );
    if (!dueAt) {
      warnings.push({
        field: "dueAt",
        message: row.values.get("dueAt")
          ? `无法识别最晚完成时间“${row.values.get("dueAt") ?? ""}”`
          : "缺少最晚完成时间，请补充",
      });
    }

    const urgency = parseLevel(row.values.get("urgency") ?? "", URGENCY_VALUES);
    if (urgency.warning) warnings.push({ field: "urgency", message: urgency.warning });
    const importance = parseLevel(
      row.values.get("importance") ?? "",
      IMPORTANCE_VALUES,
    );
    if (importance.warning) {
      warnings.push({ field: "importance", message: importance.warning });
    }

    return {
      importId: `row-${row.rowNumber}`,
      rowNumber: row.rowNumber,
      title,
      goal: row.extraGoalLines.join("\n"),
      taskTechGroups: groups,
      assigneeOpenIds: openIds,
      assigneeNames: names,
      metrics,
      dueAt: dueAt ?? "",
      needsWeeklyReport: parseBoolean(row.values.get("needsWeeklyReport") ?? ""),
      urgency: urgency.value,
      importance: importance.value,
      warnings,
    };
  });

  return { tasks, errors: [] };
}

export async function parseProgressTasksFromFile(
  file: File,
  users: TaskImportUserOption[],
): Promise<TaskImportPreviewResult> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  return parseProgressTasksFromWorkbook(workbook, users);
}

export function buildProgressTaskImportTemplateWorkbook(): XLSX.WorkBook {
  const rows = [
    {
      "测试/验收内容": "裁判系统安装--装甲板安装",
      负责组别: "机械",
      负责人: "李棋轩",
      "参考/要求": "根据规则手册完成安装并通过检查",
      是否需要定期周报: "否",
      分类: "规则相关",
      备注: "可按实际验收口径补充",
      紧急程度: "低",
      重要程度: "高",
      最晚完成时间: "2026/06/29",
    },
    {
      "测试/验收内容": "机械臂重复存取矿测试",
      负责组别: "机械, 电控",
      负责人: "李棋轩",
      "参考/要求": "连续 25 组稳定成功",
      是否需要定期周报: "是",
      分类: "功能测试, 压力测试",
      备注: "无",
      紧急程度: "高",
      重要程度: "高",
      最晚完成时间: "2026/06/29",
    },
  ];
  const sheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "验收标准");
  return workbook;
}

export function downloadProgressTaskImportTemplate() {
  XLSX.writeFile(
    buildProgressTaskImportTemplateWorkbook(),
    "验收标准任务导入模板.xlsx",
  );
}
