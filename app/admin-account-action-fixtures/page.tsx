import { notFound } from "next/navigation";
import { AdminAccountActionFixtureClient } from "@/components/admin/admin-account-action-fixture-client";
import { auth } from "@/lib/auth";
import { isControlledPlaywrightServer } from "@/lib/playwright-fixture-guard";
import { prisma } from "@/lib/prisma";

export default async function AdminAccountActionFixturesPage() {
  if (!isControlledPlaywrightServer()) notFound();
  const session = await auth();
  if (!session?.user?.openId) notFound();
  const identity = await prisma.accountIdentity.findFirst({
    where: {
      provider: "FEISHU",
      tenantId: "default",
      openId: session.user.openId,
    },
    select: { accountId: true },
  });
  if (!identity) notFound();
  const reimbursementUser = await prisma.user.findUnique({
    where: { openId: session.user.openId },
    select: { email: true },
  });
  if (!reimbursementUser) notFound();
  return (
    <AdminAccountActionFixtureClient
      accountId={identity.accountId}
      email={reimbursementUser.email ?? ""}
    />
  );
}
