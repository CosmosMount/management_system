import { redirect } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { LiveAutoRefresh } from "@/components/live-auto-refresh";
import {
  ProfileOrderList,
  ProfileProjectList,
  ProfileTaskList,
} from "@/components/profile/profile-record-lists";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";
import { SignatureUploadForm } from "@/components/signature-upload-form";
import { auth } from "@/lib/auth";
import { getCurrentUserLiveVersion } from "@/lib/live-version-current";
import { getUserProfileRecords } from "@/lib/profile-records";
import { prisma } from "@/lib/prisma";

export default async function ProfilePage() {
  const liveVersion = await getCurrentUserLiveVersion("profile");
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

  const records = await getUserProfileRecords(session.user.openId);

  return (
    <>
      <AppHeader />
      <LiveAutoRefresh
        scope="profile"
        initialVersion={liveVersion}
        intervalMs={10000}
      />
      <PageShell>
        <main className="mx-auto max-w-3xl flex-1 space-y-8 p-4 py-8">
          <PageTitle subtitle={`${user.name} · 个人中心`} />

          <section className="rounded-xl border border-border bg-card p-6 shadow-sm">
            <h2 className="mb-1 text-lg font-medium">电子签名</h2>
            <p className="mb-6 text-sm text-muted-foreground">
              验收清单中的签名将自动填入：验收人 1（车组组长）、验收人 2（技术组组长）、领用人（采购发起人）。车组组长、技术组组长须在管理审核前上传；采购发起人须在上传报销凭证前上传。
            </p>
            <SignatureUploadForm signaturePath={user.signaturePath} />
          </section>

          <section className="rounded-xl border border-border bg-card p-6 shadow-sm">
            <h2 className="mb-1 text-lg font-medium">我的采购申请</h2>
            <p className="mb-4 text-sm text-muted-foreground">
              由您发起的全部采购订单，进行中的条目排在前面。
            </p>
            <ProfileOrderList orders={records.orders} />
          </section>

          <section className="rounded-xl border border-border bg-card p-6 shadow-sm">
            <h2 className="mb-1 text-lg font-medium">我的进度项目</h2>
            <p className="mb-4 text-sm text-muted-foreground">
              您作为负责人的项目，进行中的条目排在前面。
            </p>
            <ProfileProjectList projects={records.projects} />
          </section>

          <section className="rounded-xl border border-border bg-card p-6 shadow-sm">
            <h2 className="mb-1 text-lg font-medium">我的任务</h2>
            <p className="mb-4 text-sm text-muted-foreground">
              分配给您的全部任务，进行中的条目排在前面。
            </p>
            <ProfileTaskList tasks={records.tasks} />
          </section>
        </main>
      </PageShell>
    </>
  );
}
