import "dotenv/config";
import { prisma } from "../lib/prisma";
import { uploadFeishuMessageImage } from "../lib/feishu-im-upload";

async function main() {
  const order = await prisma.purchaseOrder.findFirst({
    where: { status: "PENDING_APPLICANT_CONFIRM", screenshotPath: { not: null } },
    select: { id: true, orderNo: true, screenshotPath: true },
  });
  console.log("order", order);
  if (!order?.screenshotPath) return;

  const key = await uploadFeishuMessageImage(order.screenshotPath, "approval");
  console.log("image_key", key);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
