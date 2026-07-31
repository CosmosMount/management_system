import Link from "next/link";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { TagManagementClient } from "@/components/project-management/tag-management-client";
import { buttonVariants } from "@/components/ui/button";
import { listTags } from "@/lib/project-management/queries/tag-queries";
import { cn } from "@/lib/utils";
import { getProgressActorOrRedirect } from "../_auth";

export default async function ProgressTagsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await getProgressActorOrRedirect();
  const params = (await searchParams) ?? {};
  const rawCursor = Array.isArray(params.cursor)
    ? params.cursor[0]
    : params.cursor;
  const cursor =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      rawCursor ?? "",
    )
      ? rawCursor
      : undefined;
  const page = await listTags({
    actor,
    input: { includeArchived: true, limit: 100, cursor },
  });
  return (
    <>
      <PageCommandBar
        title="Tag 管理"
        description="创建、编辑、归档或删除分类。删除 Tag 只移除关联，不删除 Task 或投入记录。"
      />
      <div className="mx-auto w-full min-w-0 max-w-[96rem] px-4 py-6 sm:px-6 lg:px-8">
        <TagManagementClient tags={page.items} />
        {page.nextCursor && (
          <div className="mt-5 flex justify-end">
            <Link
              href={`/progress/tags?cursor=${encodeURIComponent(page.nextCursor)}`}
              className={cn(buttonVariants({ variant: "outline" }))}
            >
              加载更多 Tag
            </Link>
          </div>
        )}
      </div>
    </>
  );
}
