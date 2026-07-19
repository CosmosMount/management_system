import Link from "next/link";
import { ClipboardCheck, Clock3, ExternalLink } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { LiveAutoRefresh } from "@/components/live-auto-refresh";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";
import { ApprovalViewTabs } from "@/components/progress/approval-view-tabs";
import { MyApprovalSubmissionsList } from "@/components/progress/my-approval-submissions-list";
import { ProgressPageLayout } from "@/components/progress/progress-page-layout";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { auth } from "@/lib/auth";
import { getCurrentUserLiveVersion } from "@/lib/live-version-current";
import { getUserRoles } from "@/lib/permissions";
import { getProgressApprovalBoard } from "@/lib/progress-approval-board";
import { getMyProgressApprovalSubmissions } from "@/lib/progress-approval-domain";

type Props = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ProgressApprovalsPage({ searchParams }: Props) {
  const params = searchParams ? await searchParams : {};
  const activeView = params.view === "submitted" ? "submitted" : "pending";
  const session = await auth();
  const userOpenId = session?.user?.openId;
  const [liveVersion, roles] = await Promise.all([
    getCurrentUserLiveVersion("progress-approvals"),
    userOpenId ? getUserRoles(userOpenId) : Promise.resolve([]),
  ]);
  const [board, submissions] = await Promise.all([
    activeView === "pending"
      ? getProgressApprovalBoard({ roles, userOpenId })
      : Promise.resolve(null),
    activeView === "submitted" && userOpenId
      ? getMyProgressApprovalSubmissions({ userOpenId, roles })
      : Promise.resolve([]),
  ]);
  const pendingBoard = board ?? { totalCount: 0, categories: [] };
  const nonEmptyCategories = pendingBoard.categories.filter(
    (category) => category.items.length > 0,
  );

  return (
    <>
      <AppHeader />
      <LiveAutoRefresh
        scope="progress-approvals"
        initialVersion={liveVersion}
        intervalMs={10000}
      />
      <PageShell>
        <ProgressPageLayout>
          <PageTitle subtitle="审批看板" />

          <ApprovalViewTabs activeView={activeView} />

          {activeView === "submitted" ? (
            <section
              role="tabpanel"
              id="approval-submitted-panel"
              aria-labelledby="approval-submitted-tab"
              data-testid="progress-approval-submitted-panel"
            >
              <MyApprovalSubmissionsList items={submissions} />
            </section>
          ) : (
            <section
              role="tabpanel"
              id="approval-pending-panel"
              aria-labelledby="approval-pending-tab"
              data-testid="progress-approval-pending-panel"
            >

          <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardHeader className="space-y-1">
                <CardDescription>待处理总数</CardDescription>
                <CardTitle className="text-3xl">{pendingBoard.totalCount}</CardTitle>
              </CardHeader>
            </Card>
            {pendingBoard.categories.slice(0, 3).map((category) => (
              <Card key={category.key}>
                <CardHeader className="space-y-1">
                  <CardDescription>{category.label}</CardDescription>
                  <CardTitle className="text-3xl">
                    {category.items.length}
                  </CardTitle>
                </CardHeader>
              </Card>
            ))}
          </div>

          <Card className="mb-6">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ClipboardCheck className="h-5 w-5" />
                分类计数
              </CardTitle>
              <CardDescription>
                这里只展示当前账号有权限处理的进度审批。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {pendingBoard.categories.map((category) => (
                  <Badge
                    key={category.key}
                    variant={category.items.length > 0 ? "secondary" : "outline"}
                    className="px-3 py-1 text-sm"
                  >
                    {category.label} {category.items.length}
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>

          {pendingBoard.totalCount === 0 ? (
            <Card>
              <CardContent className="flex min-h-48 flex-col items-center justify-center gap-3 text-center">
                <ClipboardCheck className="h-10 w-10 text-muted-foreground" />
                <div>
                  <p className="font-medium">暂无需要你处理的项目审批</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    有新的立项、DDL、任务或验收审批时会显示在这里。
                  </p>
                </div>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-6">
              {nonEmptyCategories.map((category) => (
                <section
                  key={category.key}
                  aria-labelledby={`${category.key}-title`}
                  data-testid={`progress-approval-category-${category.key}`}
                >
                  <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
                    <div>
                      <h2
                        id={`${category.key}-title`}
                        className="text-xl font-semibold tracking-tight"
                      >
                        {category.label}
                      </h2>
                      <p className="text-sm text-muted-foreground">
                        {category.description}
                      </p>
                    </div>
                    <Badge variant="secondary">{category.items.length} 项</Badge>
                  </div>
                  <ul className="space-y-3">
                    {category.items.map((item) => (
                      <li key={item.id} data-testid="progress-approval-item">
                        <Card className="border-border/70">
                          <CardContent className="p-4">
                            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                              <div className="min-w-0 space-y-2">
                                <div className="flex flex-wrap items-center gap-2">
                                  <Badge variant="outline">{item.badge}</Badge>
                                  <p
                                    className="line-clamp-2 min-w-0 break-all font-medium"
                                    title={item.title}
                                  >
                                    {item.title}
                                  </p>
                                </div>
                                <p
                                  className="line-clamp-2 break-all text-sm text-muted-foreground"
                                  title={`${item.projectName} · ${item.subject}`}
                                >
                                  {item.projectName} · {item.subject}
                                </p>
                                <p
                                  className="line-clamp-3 break-all text-sm"
                                  title={item.detail}
                                >
                                  {item.detail}
                                </p>
                                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                                  <span className="break-words">提交人：{item.requester}</span>
                                  <span className="inline-flex items-center gap-1">
                                    <Clock3 className="h-3.5 w-3.5" />
                                    {formatDateTime(item.submittedAt)}
                                  </span>
                                </div>
                                {item.meta.length > 0 && (
                                  <div className="flex flex-wrap gap-2">
                                    {item.meta.map((meta) => (
                                      <span
                                        key={meta}
                                        className="max-w-full break-all rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
                                      >
                                        {meta}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>
                              <Link
                                href={item.href}
                                data-testid={`progress-approval-link-${item.id}`}
                                className={buttonVariants({
                                  className: "shrink-0 gap-1.5",
                                })}
                              >
                                去处理
                                <ExternalLink className="h-4 w-4" />
                              </Link>
                            </div>
                          </CardContent>
                        </Card>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
            </section>
          )}
        </ProgressPageLayout>
      </PageShell>
    </>
  );
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}
