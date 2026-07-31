import Link from "next/link";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { buttonVariants } from "@/components/ui/button";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

export default function ProgressNotFound() {
  return (
    <>
      <PageCommandBar
        title="页面不存在或无权访问"
        description="你访问的项目管理页面不存在、已被移动，或当前账号没有查看权限。"
      />
      <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col px-4 py-12 sm:px-6 lg:px-8">
        <div className="rounded-xl border border-border bg-card p-6">
          <p className="text-sm leading-6 text-muted-foreground">
            为保护业务信息，此页面不会确认目标对象是否存在。请从项目管理首页重新进入仍可访问的内容。
          </p>
          <Link
            href={routes.progress.root}
            className={cn(buttonVariants(), "mt-6 w-fit")}
          >
            返回我的工作
          </Link>
        </div>
      </div>
    </>
  );
}
