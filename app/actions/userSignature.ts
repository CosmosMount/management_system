"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { saveUserSignature } from "@/lib/file-upload";
import { prisma } from "@/lib/prisma";
import {
  lockActiveProcurementUserTx,
  requireActiveProcurementUser,
} from "@/lib/active-account";

export async function uploadUserSignature(formData: FormData) {
  const session = await auth();
  if (!session?.user?.openId) {
    throw new Error("未登录");
  }
  await requireActiveProcurementUser(session.user.openId);

  const file = formData.get("signature");
  if (!(file instanceof File) || file.size === 0) {
    throw new Error("请选择签名图片");
  }

  const signaturePath = await prisma.$transaction(async (tx) => {
    await lockActiveProcurementUserTx(tx, session.user.openId);
    const savedPath = await saveUserSignature(session.user.openId, file);
    await tx.user.update({
      where: { openId: session.user.openId },
      data: { signaturePath: savedPath },
    });
    return savedPath;
  });

  revalidatePath("/profile");
  return { signaturePath };
}
