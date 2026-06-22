import { prisma } from "@/lib/prisma";

export async function generateOrderNo(): Promise<string> {
  const today = new Date();
  const datePart = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0"),
  ].join("");

  const prefix = `PO-${datePart}-`;
  const latest = await prisma.purchaseOrder.findFirst({
    where: { orderNo: { startsWith: prefix } },
    orderBy: { orderNo: "desc" },
    select: { orderNo: true },
  });

  let seq = 1;
  if (latest) {
    const lastSeq = Number.parseInt(latest.orderNo.slice(prefix.length), 10);
    if (!Number.isNaN(lastSeq)) {
      seq = lastSeq + 1;
    }
  }

  return `${prefix}${String(seq).padStart(4, "0")}`;
}
