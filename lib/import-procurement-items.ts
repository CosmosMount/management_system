import * as XLSX from "xlsx";
import { MAX_REIMBURSEMENT_LIST_ROWS } from "@/lib/constants";
import {
  purchaseItemKindLabels,
  type PurchaseItemKind,
} from "@/lib/purchase-item-kind";
import {
  purchaseItemSchema,
  type PurchaseItemInput,
} from "@/lib/validations/order";

export type ImportRowError = {
  row: number;
  message: string;
};

export type ImportProcurementItemsResult = {
  items: PurchaseItemInput[];
  errors: ImportRowError[];
};

const HEADER_ALIASES: Record<string, keyof RawRow> = {
  物品名称: "name",
  名称: "name",
  规格: "spec",
  种类: "itemKind",
  物品种类: "itemKind",
  采购链接: "purchaseLink",
  链接: "purchaseLink",
  "链接/图片": "purchaseLink",
  加工商: "processingVendor",
  数量: "quantity",
  行总价: "lineTotal",
  总价: "lineTotal",
  小计: "lineTotal",
};

const KIND_LABEL_TO_VALUE: Record<string, PurchaseItemKind> = {
  ...Object.fromEntries(
    Object.entries(purchaseItemKindLabels).map(([value, label]) => [
      label,
      value as PurchaseItemKind,
    ]),
  ),
  COMPONENT: "COMPONENT",
  STANDARD_PART: "STANDARD_PART",
  PROCESSING_FEE: "PROCESSING_FEE",
  元器件: "COMPONENT",
  标准件: "STANDARD_PART",
  加工费: "PROCESSING_FEE",
};

type RawRow = {
  name?: string;
  spec?: string;
  itemKind?: string;
  purchaseLink?: string;
  processingVendor?: string;
  quantity?: string | number;
  lineTotal?: string | number;
};

function normalizeHeader(value: unknown): string {
  return String(value ?? "").trim();
}

function resolveHeaderKey(header: string): keyof RawRow | null {
  const trimmed = header.trim();
  if (HEADER_ALIASES[trimmed]) return HEADER_ALIASES[trimmed];
  const lower = trimmed.toLowerCase();
  for (const [alias, key] of Object.entries(HEADER_ALIASES)) {
    if (alias.toLowerCase() === lower) return key;
  }
  return null;
}

function parseItemKind(value: unknown): PurchaseItemKind | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  return KIND_LABEL_TO_VALUE[raw] ?? KIND_LABEL_TO_VALUE[raw.toUpperCase()] ?? null;
}

function parsePositiveNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const num = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(num) || num < 0) return null;
  return num;
}

function parseQuantity(value: unknown): number | null {
  const num = parsePositiveNumber(value);
  if (num === null) return null;
  const int = Math.floor(num);
  return int >= 1 ? int : null;
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

  const hasName = columnKeys.includes("name");
  const hasSpec = columnKeys.includes("spec");
  if (!hasName || !hasSpec) {
    throw new Error("Excel 缺少必填列：物品名称、规格");
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
      if (key === "quantity" || key === "lineTotal") {
        raw[key] = cell as string | number;
      } else {
        raw[key] = text;
      }
    });

    if (hasContent) rows.push(raw);
  }

  return rows;
}

function rawToItemInput(raw: RawRow): PurchaseItemInput | null {
  const itemKind = parseItemKind(raw.itemKind) ?? "COMPONENT";
  const quantity = parseQuantity(raw.quantity);
  const lineTotal = parsePositiveNumber(raw.lineTotal);

  if (!raw.name?.trim() || !raw.spec?.trim() || quantity === null || lineTotal === null) {
    return null;
  }

  return {
    name: raw.name.trim(),
    spec: raw.spec.trim(),
    itemKind,
    purchaseLink: raw.purchaseLink?.trim() ?? "",
    referenceImagePath: null,
    processingVendor: raw.processingVendor?.trim() ?? "",
    quantity,
    lineTotal,
  };
}

export function parseProcurementItemsFromWorkbook(
  workbook: XLSX.WorkBook,
): ImportProcurementItemsResult {
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    return { items: [], errors: [{ row: 0, message: "Excel 文件为空" }] };
  }

  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    return { items: [], errors: [{ row: 0, message: "无法读取工作表" }] };
  }

  let rawRows: RawRow[];
  try {
    rawRows = sheetRowsToRawRows(sheet);
  } catch (err) {
    return {
      items: [],
      errors: [
        {
          row: 0,
          message: err instanceof Error ? err.message : "表头解析失败",
        },
      ],
    };
  }

  if (rawRows.length === 0) {
    return { items: [], errors: [{ row: 0, message: "未找到有效数据行" }] };
  }

  if (rawRows.length > MAX_REIMBURSEMENT_LIST_ROWS) {
    return {
      items: [],
      errors: [
        {
          row: 0,
          message: `导入行数超过上限 ${MAX_REIMBURSEMENT_LIST_ROWS} 行`,
        },
      ],
    };
  }

  const items: PurchaseItemInput[] = [];
  const errors: ImportRowError[] = [];

  rawRows.forEach((raw, index) => {
    const rowNum = index + 2;
    const candidate = rawToItemInput(raw);
    if (!candidate) {
      errors.push({ row: rowNum, message: "缺少必填字段或数量/行总价格式无效" });
      return;
    }

    const parsed = purchaseItemSchema.safeParse(candidate);
    if (!parsed.success) {
      const message =
        parsed.error.issues[0]?.message ?? "校验失败";
      errors.push({ row: rowNum, message });
      return;
    }

    items.push(parsed.data);
  });

  return { items, errors };
}

export async function parseProcurementItemsFromFile(
  file: File,
): Promise<ImportProcurementItemsResult> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  return parseProcurementItemsFromWorkbook(workbook);
}

export function downloadProcurementItemsTemplate() {
  const rows = [
    {
      物品名称: "示例电阻",
      规格: "10kΩ 0603",
      种类: "元器件",
      采购链接: "https://example.com/item",
      加工商: "",
      数量: 100,
      行总价: 12.5,
    },
    {
      物品名称: "示例铝板加工",
      规格: "200×100×3mm",
      种类: "加工费",
      采购链接: "",
      加工商: "某加工厂",
      数量: 1,
      行总价: 80,
    },
  ];
  const sheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "采购明细");
  XLSX.writeFile(workbook, "采购明细导入模板.xlsx");
}

export function filterProcessingFeeItems(
  result: ImportProcurementItemsResult,
): ImportProcurementItemsResult {
  const nonFeeCount = result.items.filter(
    (item) => item.itemKind !== "PROCESSING_FEE",
  ).length;
  const items = result.items.filter((item) => item.itemKind === "PROCESSING_FEE");
  const errors = [...result.errors];
  if (items.length === 0 && nonFeeCount > 0 && errors.length === 0) {
    errors.push({ row: 0, message: "未找到加工费条目（已跳过非加工费行）" });
  }
  return { items, errors };
}
