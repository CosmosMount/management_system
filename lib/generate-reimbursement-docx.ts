import fs from "fs";
import path from "path";
import Docxtemplater from "docxtemplater";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ImageModule = require("docxtemplater-image-module-free");
import PizZip from "pizzip";
import { MAX_REIMBURSEMENT_LIST_ROWS } from "@/lib/constants";

const BASE_TEMPLATE_PATH = path.join(
  process.cwd(),
  "templates",
  "material-acceptance-list-base.docx",
);

const SOURCE_TEMPLATE_PATH = path.join(
  process.cwd(),
  "templates",
  "material-acceptance-list-source.docx",
);

export type ReimbursementDocItem = {
  name: string;
  spec: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  photoAbsolutePath?: string | null;
};

export type ReimbursementDocMeta = {
  acceptor1Path?: string | null;
  acceptor2Path?: string | null;
  receiverPath?: string | null;
  acceptDate?: string;
  receiveDate?: string;
};

const SIGNATURE_SLOTS = [
  { marker: "{sig:acceptor1}", tag: "acceptor1" },
  { marker: "{sig:acceptor2}", tag: "acceptor2" },
  { marker: "{sig:receiver}", tag: "receiver" },
] as const;

function resolveExistingPath(filePath?: string | null): string | null {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return filePath;
}

function injectSignatureTags(
  xml: string,
  paths: Pick<ReimbursementDocMeta, "acceptor1Path" | "acceptor2Path" | "receiverPath">,
): string {
  const pathByTag: Record<string, string | null | undefined> = {
    acceptor1: paths.acceptor1Path,
    acceptor2: paths.acceptor2Path,
    receiver: paths.receiverPath,
  };

  let result = xml;
  for (const { marker, tag } of SIGNATURE_SLOTS) {
    const filePath = resolveExistingPath(pathByTag[tag]);
    result = result.split(marker).join(filePath ? `{%${tag}}` : "");
  }
  return result;
}

function isSignatureTag(tagName: string): boolean {
  return tagName === "acceptor1" || tagName === "acceptor2" || tagName === "receiver";
}

function readImagePixelSize(buffer: Buffer): [number, number] | null {
  if (buffer.length >= 24 && buffer[0] === 0x89 && buffer[1] === 0x50) {
    return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buffer.length) {
      if (buffer[i] !== 0xff) break;
      const marker = buffer[i + 1];
      if (marker === 0xc0 || marker === 0xc2) {
        return [buffer.readUInt16BE(i + 7), buffer.readUInt16BE(i + 5)];
      }
      const len = buffer.readUInt16BE(i + 2);
      if (len < 2) break;
      i += 2 + len;
    }
  }
  return null;
}

function fitImageSize(
  img: Buffer,
  maxWidth: number,
  maxHeight: number,
  fallback: [number, number],
): [number, number] {
  const dims = readImagePixelSize(img);
  if (!dims) return fallback;
  const [width, height] = dims;
  if (width <= 0 || height <= 0) return fallback;
  const scale = Math.min(maxWidth / width, maxHeight / height, 1);
  return [
    Math.max(1, Math.round(width * scale)),
    Math.max(1, Math.round(height * scale)),
  ];
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatMoney(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}

function formatDocDate(date = new Date()): string {
  return date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function textParagraph(text: string, center = true): string {
  const jc = center ? '<w:jc w:val="center"/>' : "";
  const safe = escapeXml(text);
  return `<w:p><w:pPr><w:widowControl/>${jc}<w:rPr><w:kern w:val="0"/><w:szCs w:val="21"/></w:rPr></w:pPr><w:r><w:rPr><w:kern w:val="0"/><w:szCs w:val="21"/></w:rPr><w:t>${safe}</w:t></w:r></w:p>`;
}

function boldTextParagraph(text: string): string {
  const safe = escapeXml(text);
  return `<w:p><w:pPr><w:widowControl/><w:rPr><w:b/><w:bCs/><w:kern w:val="0"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:pPr><w:r><w:rPr><w:b/><w:bCs/><w:kern w:val="0"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr><w:t>${safe}</w:t></w:r></w:p>`;
}

function imageTagParagraph(tag: string): string {
  return `<w:p><w:pPr><w:jc w:val="center"/><w:rPr><w:rFonts w:eastAsia="仿宋_GB2312"/><w:kern w:val="0"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:eastAsia="仿宋_GB2312"/><w:kern w:val="0"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr><w:t>${tag}</w:t></w:r></w:p>`;
}

function replaceCellContent(
  rowXml: string,
  cellIndex: number,
  newInner: string,
): string {
  const cellRegex = /<w:tc[\s\S]*?<\/w:tc>/g;
  let match: RegExpExecArray | null;
  let i = 0;
  let result = "";
  let lastIndex = 0;
  let replaced = false;
  while ((match = cellRegex.exec(rowXml)) !== null) {
    if (i === cellIndex) {
      const cell = match[0];
      const openEnd = cell.indexOf(">") + 1;
      const closeStart = cell.lastIndexOf("</w:tc>");
      const nextCell =
        cell.slice(0, openEnd) + newInner + cell.slice(closeStart);
      result += rowXml.slice(lastIndex, match.index) + nextCell;
      lastIndex = match.index + match[0].length;
      replaced = true;
    }
    i++;
  }
  if (!replaced) {
    throw new Error(`表格行缺少第 ${cellIndex + 1} 列，无法写入合计`);
  }
  return result + rowXml.slice(lastIndex);
}

/** 定位「总计」行中应填入合计金额的单元格（模板中为占位 0） */
function findTotalValueCellIndex(totalRowXml: string): number {
  const cells = [...totalRowXml.matchAll(/<w:tc[\s\S]*?<\/w:tc>/g)];
  for (let i = 0; i < cells.length; i++) {
    const text = [...cells[i][0].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)]
      .map((m) => m[1])
      .join("")
      .trim();
    if (text === "0" || text === "0.0" || text === "0.00") {
      return i;
    }
  }
  if (cells.length >= 3) return 2;
  throw new Error("未找到总计金额单元格");
}

function buildDataRow(templateRow: string, item: ReimbursementDocItem, index: number): string {
  let row = templateRow;
  row = replaceCellContent(row, 0, textParagraph(String(index)));
  row = replaceCellContent(row, 1, textParagraph(item.name));
  row = replaceCellContent(row, 2, textParagraph(item.spec));
  row = replaceCellContent(row, 3, textParagraph(formatMoney(item.unitPrice)));
  row = replaceCellContent(row, 4, textParagraph(String(item.quantity)));
  row = replaceCellContent(row, 5, textParagraph(formatMoney(item.lineTotal)));
  row = replaceCellContent(row, 6, textParagraph(""));
  return row;
}

function itemHasPhoto(item: ReimbursementDocItem): boolean {
  const photoPath = item.photoAbsolutePath;
  return Boolean(photoPath && fs.existsSync(photoPath));
}

function buildPhotoBlock(index: number, hasPhoto: boolean): string {
  const caption = `图 Figure ${index} 第${index}行`;
  const imagePart = hasPhoto
    ? imageTagParagraph(`{%%photo${index}}`)
    : textParagraph("（无照片）");
  return (
    imageTagParagraph(caption) +
    imagePart +
    `<w:p><w:pPr><w:jc w:val="center"/></w:pPr></w:p>`
  );
}

function resolveTemplatePath(): string {
  if (fs.existsSync(BASE_TEMPLATE_PATH)) return BASE_TEMPLATE_PATH;
  if (fs.existsSync(SOURCE_TEMPLATE_PATH)) return SOURCE_TEMPLATE_PATH;
  throw new Error(
    "验收清单模板不存在，请运行 npm run prepare:template",
  );
}

function expandDocumentXml(
  xml: string,
  items: ReimbursementDocItem[],
): string {
  const tblStart = xml.indexOf("<w:tbl>");
  const tblEnd = xml.indexOf("</w:tbl>", tblStart) + "</w:tbl>".length;
  if (tblStart < 0) throw new Error("未找到主表格");

  const tableXml = xml.slice(tblStart, tblEnd);
  const rowRegex = /<w:tr[\s\S]*?<\/w:tr>/g;
  const rows: string[] = [];
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRegex.exec(tableXml)) !== null) {
    rows.push(rowMatch[0]);
  }
  if (rows.length < 10) throw new Error(`表格行数异常: ${rows.length}`);

  const headerRow = rows[0];
  const dataTemplate = rows[1];
  const totalRowTemplate = rows[rows.length - 1];
  const sumTotal = items.reduce((s, it) => s + it.lineTotal, 0);
  const dataRows = items.map((item, i) => buildDataRow(dataTemplate, item, i + 1));
  const totalRow = replaceCellContent(
    totalRowTemplate,
    findTotalValueCellIndex(totalRowTemplate),
    boldTextParagraph(formatMoney(sumTotal)),
  );

  const newTable =
    tableXml.slice(0, tableXml.indexOf(rows[0])) +
    headerRow +
    dataRows.join("") +
    totalRow +
    "</w:tbl>";

  let result = xml.slice(0, tblStart) + newTable + xml.slice(tblEnd);

  const photoTitle = "附货物到货照片";
  const photoIdx = result.indexOf(photoTitle);
  if (photoIdx >= 0) {
    const afterTitlePara =
      result.indexOf("</w:p>", photoIdx) + "</w:p>".length;
    const sectStart = result.indexOf("<w:sectPr", afterTitlePara);
    const photoBlocks = items
      .map((item, i) => buildPhotoBlock(i + 1, itemHasPhoto(item)))
      .join("");
    result =
      result.slice(0, afterTitlePara) +
      photoBlocks +
      (sectStart >= 0 ? result.slice(sectStart) : "");
  }

  return result;
}

/** 基于官方模板生成《物品验收及领用清单》 */
export function generateReimbursementListDocx(
  items: ReimbursementDocItem[],
  meta?: Partial<ReimbursementDocMeta>,
): Buffer {
  if (items.length === 0) {
    throw new Error("至少一条明细才能生成验收清单");
  }
  if (items.length > MAX_REIMBURSEMENT_LIST_ROWS) {
    throw new Error(`验收清单最多支持 ${MAX_REIMBURSEMENT_LIST_ROWS} 行明细`);
  }

  const templatePath = resolveTemplatePath();
  const zip = new PizZip(fs.readFileSync(templatePath));
  const documentFile = zip.file("word/document.xml");
  if (!documentFile) throw new Error("document.xml 不存在");

  let xml = documentFile.asText();
  xml = expandDocumentXml(xml, items);
  xml = injectSignatureTags(xml, {
    acceptor1Path: meta?.acceptor1Path,
    acceptor2Path: meta?.acceptor2Path,
    receiverPath: meta?.receiverPath,
  });
  zip.file("word/document.xml", xml);

  const renderData: Record<string, string> = {
    acceptDate: meta?.acceptDate ?? formatDocDate(),
    receiveDate: meta?.receiveDate ?? formatDocDate(),
  };

  const signaturePaths = [
    ["acceptor1", meta?.acceptor1Path],
    ["acceptor2", meta?.acceptor2Path],
    ["receiver", meta?.receiverPath],
  ] as const;
  for (const [tag, filePath] of signaturePaths) {
    const resolved = resolveExistingPath(filePath);
    if (resolved) renderData[tag] = resolved;
  }

  const hasAnyPhoto = items.some(itemHasPhoto);
  for (let i = 0; i < items.length; i++) {
    const photoPath = items[i].photoAbsolutePath;
    if (photoPath && fs.existsSync(photoPath)) {
      renderData[`photo${i + 1}`] = photoPath;
    }
  }

  const hasAnyImage =
    hasAnyPhoto || signaturePaths.some(([, p]) => resolveExistingPath(p));

  const modules = hasAnyImage
    ? [
        new ImageModule({
          // 签名需行内嵌入（centered:true 会把整段 w:p 替换成居中图片块）
          centered: false,
          getImage: (tagValue: string) => fs.readFileSync(tagValue),
          getSize: (img: Buffer, _tagValue: string, tagName: string) => {
            void _tagValue;
            if (isSignatureTag(tagName)) {
              return fitImageSize(img, 90, 32, [90, 32]);
            }
            return fitImageSize(img, 420, 315, [420, 315]);
          },
        }),
      ]
    : [];

  const doc = new Docxtemplater(zip, {
    modules,
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: () => "",
  });

  doc.render(renderData);
  return doc.getZip().generate({ type: "nodebuffer" }) as Buffer;
}

export function publicPathToAbsolute(publicPath: string): string {
  return path.join(process.cwd(), "public", publicPath.replace(/^\//, ""));
}

export async function saveGeneratedListDoc(
  orderId: string,
  buffer: Buffer,
): Promise<string> {
  const dir = path.join(process.cwd(), "public", "uploads", orderId);
  await fs.promises.mkdir(dir, { recursive: true });
  const filename = `list-generated-${Date.now()}.docx`;
  const fullPath = path.join(dir, filename);
  await fs.promises.writeFile(fullPath, buffer);
  return `/uploads/${orderId}/${filename}`;
}

export { formatDocDate };
