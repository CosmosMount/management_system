import { redirect } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import {
  FeedbackCenter,
  type FeedbackView,
} from "@/components/feedback/feedback-center";
import { LiveAutoRefresh } from "@/components/live-auto-refresh";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";
import { auth } from "@/lib/auth";
import { getCurrentUserLiveVersion } from "@/lib/live-version-current";
import { isSuperAdmin } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";

function serializeFeedback(
  feedback: Awaited<ReturnType<typeof getFeedbacks>>[number],
): FeedbackView {
  return {
    id: feedback.id,
    submitterOpenId: feedback.submitterOpenId,
    submitterName: feedback.submitterName,
    status: feedback.status,
    lastMessageAt: feedback.lastMessageAt.toISOString(),
    closedAt: feedback.closedAt?.toISOString() ?? null,
    createdAt: feedback.createdAt.toISOString(),
    messages: feedback.messages.map((message) => ({
      id: message.id,
      authorOpenId: message.authorOpenId,
      authorName: message.authorName,
      body: message.body,
      createdAt: message.createdAt.toISOString(),
      attachments: message.attachments.map((attachment) => ({
        id: attachment.id,
        path: attachment.path,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        size: attachment.size,
        sortOrder: attachment.sortOrder,
      })),
    })),
  };
}

async function getFeedbacks(openId: string, admin: boolean) {
  return prisma.feedback.findMany({
    where: admin ? undefined : { submitterOpenId: openId },
    include: {
      messages: {
        orderBy: { createdAt: "asc" },
        include: {
          attachments: { orderBy: { sortOrder: "asc" } },
        },
      },
    },
    orderBy: { lastMessageAt: "desc" },
  });
}

export default async function FeedbackPage() {
  const liveVersion = await getCurrentUserLiveVersion("feedback");
  const session = await auth();
  if (!session?.user?.openId) {
    redirect("/login");
  }

  const admin = await isSuperAdmin(session.user.openId);
  const feedbacks = await getFeedbacks(session.user.openId, admin);
  const openIds = new Set<string>();
  for (const feedback of feedbacks) {
    openIds.add(feedback.submitterOpenId);
    for (const message of feedback.messages) {
      openIds.add(message.authorOpenId);
    }
  }

  const users =
    openIds.size > 0
      ? await prisma.user.findMany({
          where: { openId: { in: [...openIds] } },
          select: { openId: true, avatar: true },
        })
      : [];
  const avatarByOpenId = Object.fromEntries(
    users.map((user) => [user.openId, user.avatar]),
  );

  return (
    <>
      <AppHeader />
      <LiveAutoRefresh
        scope="feedback"
        initialVersion={liveVersion}
        intervalMs={5000}
      />
      <PageShell>
        <main
          className="mx-auto flex min-h-0 w-full max-w-7xl shrink-0 flex-col overflow-hidden p-4 py-6"
          style={{
            height: "calc(100dvh - 3.5rem - 1px)",
            minHeight: 0,
          }}
        >
          <PageTitle subtitle="反馈中心" />
          <FeedbackCenter
            feedbacks={feedbacks.map(serializeFeedback)}
            avatarByOpenId={avatarByOpenId}
            currentUserOpenId={session.user.openId}
            isSuperAdmin={admin}
          />
        </main>
      </PageShell>
    </>
  );
}
