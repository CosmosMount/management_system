import Link from "next/link";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { ProjectList } from "@/components/project-management/project-list";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
    <PageCommandBar title="项目" description="项目是任务的文件夹与立项对象。" actions={<Link href={routes.progress.projectNew} className={cn(buttonVariants())}>提交立项</Link>} />
    <div className="mx-auto flex w-full min-w-0 max-w-[96rem] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <form className="grid gap-3 rounded-xl border bg-card p-4 md:grid-cols-[1fr_180px_auto_auto]">
        <Input name="q" defaultValue={query} placeholder="搜索项目名称或内容" aria-label="搜索项目名称或内容" />
        <select name="status" defaultValue={rawStatus} aria-label="项目状态" className="h-8 rounded-lg border border-input bg-background px-2 text-sm"><option value="">全部状态</option>{statuses.map((value) => <option key={value} value={value}>{labels[value]}</option>)}</select>
        <label className="flex h-8 items-center gap-2 text-sm text-muted-foreground"><input type="hidden" name="mine" value="0" /><input type="checkbox" name="mine" value="1" defaultChecked={mine} />只看我参与</label>
        <Button type="submit">筛选</Button>
      </form>
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
