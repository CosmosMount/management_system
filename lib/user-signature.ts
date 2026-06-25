import { prisma } from "@/lib/prisma";

export async function userHasSignature(openId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { openId },
    select: { signaturePath: true },
  });
  return !!user?.signaturePath;
}

export async function requireApproverSignature(openId: string): Promise<void> {
  if (!(await userHasSignature(openId))) {
    throw new Error(
      "请先在个人中心上传电子签名后再审批。您的签名将自动填入《物品验收及领用清单》。",
    );
  }
}

export async function requireInitiatorSignature(openId: string): Promise<void> {
  if (!(await userHasSignature(openId))) {
    throw new Error(
      "请先在个人中心上传电子签名后再发起采购申请。您的签名将自动填入《物品验收及领用清单》领用人处。",
    );
  }
}
