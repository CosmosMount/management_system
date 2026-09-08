import Link from "next/link";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { ProjectList } from "@/components/project-management/project-list";
import { ListFilterForm } from "@/components/project-management/list-filter-form";
import { buttonVariants } from "@/components/ui/button";
import { listProjects } from "@/lib/project-management/queries/project-queries";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { getProgressActorOrRedirect } from "../_auth";

const statuses = ["DRAFT", "PENDING_APPROVAL", "ACTIVE", "COMPLETED"] as const;
const labels = { DRAFT: "草稿", PENDING_APPROVAL: "立项审批中", ACTIVE: "进行中", COMPLETED: "已结束" } as const;
type SearchParams = Record<string, string | string[] | undefined>;

export default async function ProjectsPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  const actor = await getProgressActorOrRedirect();
  const params = (await searchParams) ?? {};
  const rawStatus = params.status === undefined ? "ACTIVE" : first(params.status);
  const status = statuses.includes(rawStatus as (typeof statuses)[number]) ? rawStatus as (typeof statuses)[number] : undefined;
  const mine = params.mine === undefined ? true : values(params.mine).includes("1");
  const query = first(params.q);
  const cursor = first(params.cursor) || undefined;
  const projects = await listProjects({ actor, input: { status, mine, query, limit: 50, cursor } });
  return <>
    <PageCommandBar title="项目" actions={<Link href={routes.progress.projectNew} className={cn(buttonVariants())}>提交立项</Link>} />
    <div className="mx-auto flex w-full min-w-0 max-w-[96rem] flex-col gap-4 px-4 py-6 sm:px-6 lg:px-8">
      <ListFilterForm
        action={routes.progress.projects}
        label="项目筛选"
        searchLabel="搜索项目名称或内容"
        query={query}
        filters={[
          { name: "mine", label: "项目范围", value: mine ? "1" : "0", options: [{ value: "1", label: "我参与的项目" }, { value: "0", label: "全部可见项目" }] },
          { name: "status", label: "项目状态", value: status ?? "", options: [{ value: "", label: "全部状态" }, ...statuses.map((value) => ({ value, label: labels[value] }))] },
        ]}
        className="grid min-w-0 items-center gap-3 rounded-lg border bg-card p-3 lg:grid-cols-[minmax(0,1fr)_160px_160px_auto_auto]"
      />
      <details data-testid="project-list-scope" className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">
        <summary className="w-fit cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-ring">{query ? "本次搜索" : "本页"}显示 {projects.items.length} 项 · 筛选说明</summary>
        <p className="mt-2">当前范围：{mine ? "我参与的项目" : "全部可见项目"} · {status ? labels[status] : "全部状态（含草稿与已结束）"}{query ? ` · 关键词：${query}` : ""}</p>
      </details>
      {projects.hasMoreByQuery && <p role="status" className="text-sm text-amber-700">搜索结果较多，仅显示最相关的 50 条，请继续输入关键词。</p>}
      <ProjectList projects={projects.items} />
      {!query && projects.nextCursor && <div className="flex justify-end"><Link href={projectPageHref(params, projects.nextCursor)} className={cn(buttonVariants({ variant: "outline" }))}>下一页项目</Link></div>}
    </div>
  </>;
}
function first(value: string | string[] | undefined) { return Array.isArray(value) ? value[0] ?? "" : value ?? ""; }
function values(value: string | string[] | undefined) { return Array.isArray(value) ? value : value === undefined ? [] : [value]; }
function projectPageHref(params: SearchParams, cursor: string) {
  const search = new URLSearchParams();
  const query = first(params.q);
  const status = first(params.status);
  if (query) search.set("q", query);
  if (params.status !== undefined) search.set("status", status);
  for (const mine of values(params.mine)) search.append("mine", mine);
  search.set("cursor", cursor);
  return `${routes.progress.projects}?${search.toString()}`;
}
