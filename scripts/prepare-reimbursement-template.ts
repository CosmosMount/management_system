/**
 * 在官方源模板上插入签名/日期占位符，生成生成器使用的 base 模板。
 * 表格行与照片区由 generate-reimbursement-docx.ts 按条目数动态展开。
 */
import fs from "fs";
import path from "path";
import PizZip from "pizzip";

const ROOT = path.join(process.cwd(), "templates");
const SOURCE = path.join(ROOT, "material-acceptance-list-source.docx");
const OUTPUT = path.join(ROOT, "material-acceptance-list-base.docx");

function inlineText(tag: string): string {
  return `<w:r><w:rPr><w:kern w:val="0"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr><w:t>${tag}</w:t></w:r>`;
}

/** 签名槽位：生成时按是否有图片替换为 {%tag} 或留空 */
function inlineSignatureSlot(tag: string): string {
  return inlineText(`{sig:${tag}}`);
}

function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error("缺少源模板:", SOURCE);
    process.exit(1);
  }

  const zip = new PizZip(fs.readFileSync(SOURCE));
  let xml = zip.file("word/document.xml")?.asText();
  if (!xml) throw new Error("document.xml 不存在");

  // 源模板中英文标签被拆成多个 w:r，下划线也可能跨多个 run
  xml = xml.replace(
    /(<w:t[^>]*>ed by 1\.<\/w:t><\/w:r>)((?:<w:r[\s\S]*?<w:u w:val="single"[\s\S]*?<\/w:r>)+)(<w:r[^>]*>[\s\S]*?<w:t[^>]*>\s*2\.<\/w:t>)/,
    `$1${inlineSignatureSlot("acceptor1")}$3`,
  );
  xml = xml.replace(
    /(<w:t[^>]*>\s*2\.<\/w:t><\/w:r>)((?:<w:r[\s\S]*?<w:u w:val="single"[\s\S]*?<\/w:r>)+)(<w:r[^>]*>[\s\S]*?<w:t[^>]*>验收日期<\/w:t>)/,
    `$1${inlineSignatureSlot("acceptor2")}$3`,
  );
  xml = xml.replace(
    /(<w:t>验收日期<\/w:t>[\s\S]*?<w:t>：<\/w:t><\/w:r>)((?:<w:r[\s\S]*?<w:u w:val="single"[\s\S]*?<\/w:r>)+)(<\/w:p>)/,
    `$1${inlineText("{acceptDate}")}$3`,
  );
  xml = xml.replace(
    /(<w:t>Receive<\/w:t><\/w:r><w:r[^>]*>[\s\S]*?<w:t>d by<\/w:t><\/w:r><w:r[^>]*>[\s\S]*?<w:t>：<\/w:t><\/w:r>)((?:<w:r[\s\S]*?<w:u w:val="single"[\s\S]*?<\/w:r>)+)(<w:r[^>]*>[\s\S]*?<w:t[^>]*>领用日期<\/w:t>)/,
    `$1${inlineSignatureSlot("receiver")}$3`,
  );
  xml = xml.replace(
    /(<w:t>领用日期<\/w:t>[\s\S]*?<w:t>：<\/w:t><\/w:r>)((?:<w:r[\s\S]*?<w:u w:val="single"[\s\S]*?<\/w:r>)+)(<\/w:p>)/,
    `$1${inlineText("{receiveDate}")}$3`,
  );

  zip.file("word/document.xml", xml);
  fs.writeFileSync(OUTPUT, zip.generate({ type: "nodebuffer" }));
  console.log("已生成 base 模板:", OUTPUT);
}

main();
