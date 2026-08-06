export const MAX_SPREADSHEET_FILE_SIZE = 10 * 1024 * 1024;
export const SPREADSHEET_FILE_SIZE_LABEL = "10 MB";

const spreadsheetMimeTypes = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/octet-stream",
  "",
]);

export function validateSpreadsheetFile(file: {
  name: string;
  size: number;
  type: string;
}) {
  const extension = file.name.toLowerCase().split(".").pop() ?? "";
  if (!new Set(["xlsx", "xls"]).has(extension)) {
    throw new Error("仅支持 .xlsx 或 .xls 文件");
  }
  if (!spreadsheetMimeTypes.has(file.type.toLowerCase())) {
    throw new Error("Excel 文件类型不正确");
  }
  if (file.size <= 0) throw new Error("Excel 文件不能为空");
  if (file.size > MAX_SPREADSHEET_FILE_SIZE) {
    throw new Error(`Excel 文件不能超过 ${SPREADSHEET_FILE_SIZE_LABEL}`);
  }
}
