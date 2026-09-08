import Link from "next/link";
import { getManagementOverview } from "@/lib/project-management/queries/management-overview-queries";
import { getActionInbox } from "@/lib/project-management/queries/action-inbox-queries";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { formatDateTime } from "@/lib/project-management/labels";
import { PageCommandBar } from "./shell/page-command-bar";
import { WorkspaceViewNavigation } from "./workspace-view-navigation";
import { ActionInbox } from "./action-inbox";
import { logger } from "@/lib/logger";

export async function ManagementOverview({ actor, cursor }: { actor: ProjectManagementActor; cursor?: string }) {
  const data = await Promise.all([getManagementOverview(actor, cursor), getActionInbox({ actor, input: { limit: 8 } })]).catch((error: unknown) => {
    logger.error("pm.management_overview.load_failed", { error, actorAccountId: actor.accountId });
    return null;
  });
  if (!data) return <>
    <PageCommandBar title="管理概览" />
    <div className="mx-auto w-full min-w-0 max-w-[96rem] space-y-5 px-4 py-6 sm:px-6 lg:px-8">
      <WorkspaceViewNavigation management />
      <section role="alert" className="rounded-xl border border-destructive/30 bg-card p-6">
        <h2 className="font-semibold">管理概览暂时无法加载</h2>
        <p className="mt-2 text-sm text-muted-foreground">项目统计或待办读取失败，请重试。没有更改任何业务数据。</p>
        <a href={`/progress?view=management${cursor ? `&riskCursor=${encodeURIComponent(cursor)}` : ""}`} className="mt-4 inline-flex rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground focus-visible:outline-2 focus-visible:outline-ring">重新加载管理概览</a>
      </section>
    </div>
  </>;
  const [overview, inbox] = data;
  return <>
    <PageCommandBar title="管理概览" actions={<Link href="/progress/resources" className="rounded-lg border px-3 py-2 text-sm hover:bg-muted">查看团队排期</Link>} />
    <div className="mx-auto flex w-full min-w-0 max-w-[96rem] flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
      <WorkspaceViewNavigation management />
      <section aria-label="管理概览指标" data-testid="management-overview-summary" className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border bg-card px-4 py-3">
        {[{ label: "进行中项目", count: overview.activeProjectCount, href: "/progress/projects?mine=0&status=ACTIVE" }, { label: "进行中任务", count: overview.activeTaskCount, href: "/progress/tasks?mine=0&status=ACTIVE" }, { label: "未解决风险记录", count: overview.riskCount, href: "#overview-risks" }, { label: "我的紧急待办", count: inbox.criticalCount, href: "/progress/approvals" }].map((item) => <Link key={item.label} href={item.href} className="flex min-w-0 items-center gap-2 rounded hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"><span className="text-sm text-muted-foreground">{item.label}</span><strong className="text-lg tabular-nums">{item.count}</strong></Link>)}
      </section>
      <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <section className="min-w-0 rounded-xl border bg-card p-4" aria-labelledby="overview-actions-title">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2"><h2 id="overview-actions-title" className="font-semibold">需要我处理</h2><Link href="/progress/approvals" className="text-sm text-primary hover:underline">查看全部待办与审批</Link></div>
        <ActionInbox initialPage={inbox} compact />
      </section>
      <section id="overview-risks" aria-labelledby="overview-risks-title" className="min-w-0 scroll-mt-20 rounded-xl border bg-card p-4">
        <h2 id="overview-risks-title" className="font-semibold">需要关注的风险</h2>
        {overview.cursorInvalid && <p role="status" className="mt-3 text-sm text-amber-800">风险列表已变化，已返回第一页。</p>}
        <ul className="mt-4 divide-y">
          {overview.risks.map((risk) => <li key={risk.id} className="min-w-0 py-3 [overflow-wrap:anywhere]">
            <Link href={risk.project ? `/progress/projects/${risk.project.id}?section=collaboration#risks` : `/progress/tasks/${risk.task!.id}?section=collaboration#risks`} className="block truncate font-medium text-primary hover:underline">{risk.project ? `项目：${risk.project.name}` : `任务：${risk.task!.title}`}</Link>
            <details className="group mt-2">
              <summary className="cursor-pointer rounded text-sm focus-visible:outline-2 focus-visible:outline-ring"><span className="line-clamp-2 whitespace-pre-wrap group-open:line-clamp-none">{risk.content}</span><span className="text-xs text-primary group-open:hidden">展开风险详情</span></summary>
              <p className="mt-2 text-xs text-muted-foreground">{risk.project ? `项目：${risk.project.name}` : `任务：${risk.task!.title}`} · {risk.createdByName} · {formatDateTime(risk.createdAt.toISOString())}</p>
            </details>
          </li>)}
        </ul>
        {overview.risks.length === 0 && <p className="py-6 text-sm text-muted-foreground">当前可读对象没有未解决风险。</p>}
        <div className="mt-3 flex flex-wrap gap-4 text-sm text-primary">
          {cursor && <Link href="/progress?view=management#overview-risks">返回第一页</Link>}
          {overview.nextCursor && <Link href={`/progress?view=management&riskCursor=${overview.nextCursor}#overview-risks`}>下一页风险</Link>}
        </div>
      </section>
      </div>
      <details className="text-xs text-muted-foreground">
        <summary className="w-fit cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-ring">统计口径与查看说明</summary>
        <div className="mt-2 space-y-2">
          <p>项目、任务与风险为当前可读、未删除对象的全量计数，不由本页预览推算。风险按记录计数，终态对象的遗留风险仍保留；紧急待办沿用当前账号行动队列的既有判定。</p>
          <p>风险按提出时间由新到旧，每页最多 12 条。进入对象查看完整风险及处理权限；可见不代表具有处理权限。</p>
        </div>
      </details>
    </div>
  </>;
}
