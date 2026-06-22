import { redirect } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";
import { SignatureUploadForm } from "@/components/signature-upload-form";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export default async function ProfilePage() {
  const session = await auth();
  if (!session?.user?.openId) {
    redirect("/login");
  }

  const user = await prisma.user.findUnique({
    where: { openId: session.user.openId },
    select: { name: true, signaturePath: true },
  });
  if (!user) {
    redirect("/login");
  }

  return (
    <>
      <AppHeader />
      <PageShell>
        <main className="mx-auto max-w-lg flex-1 p-4 py-8">
          <PageTitle subtitle={`${user.name} · 个人设置`} />
          <section className="rounded-xl border border-border bg-card p-6 shadow-sm">
            <h2 className="mb-1 text-lg font-medium">电子签名</h2>
            <p className="mb-6 text-sm text-muted-foreground">
              验收清单中的验收人、领用人签名将使用此处上传的图片。车组组长、技术组组长及采购人提交凭证前均需完成上传。
            </p>
            <SignatureUploadForm signaturePath={user.signaturePath} />
          </section>
        </main>
      </PageShell>
    </>
  );
}
