"use client";

import { useId, useState, useTransition, type ComponentProps } from "react";
import { useRouter } from "next/navigation";
import {
  archiveTag,
  createTag,
  deleteTag,
  restoreTag,
  updateTag,
} from "@/app/actions/project-management/tags";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ProjectManagementActionResult } from "@/lib/project-management/application/action-result";
import type { TagListItem } from "@/lib/project-management/queries/tag-queries";
import { cn } from "@/lib/utils";

type Notice = { kind: "success" | "error"; message: string } | null;

export function TagManagementClient({ tags }: { tags: TagListItem[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  function run(
    operation: () => Promise<ProjectManagementActionResult<unknown>>,
    success: string,
    onSuccess?: () => void,
  ) {
    setNotice(null);
    startTransition(async () => {
      let result: ProjectManagementActionResult<unknown>;
      try {
        result = await operation();
      } catch {
        setNotice({ kind: "error", message: "网络异常，输入未丢失，请重试。" });
        return;
      }
      if (!result.ok) {
        setNotice({ kind: "error", message: result.error.message });
        return;
      }
      setNotice({ kind: "success", message: success });
      setEditingId(null);
      onSuccess?.();
      router.refresh();
    });
  }

  return (
    <div className="space-y-5">
      {notice && (
        <p
          className={cn(
            "rounded-lg px-3 py-2 text-sm",
            notice.kind === "success"
              ? "bg-emerald-50 text-emerald-700"
              : "bg-destructive/10 text-destructive",
          )}
          role={notice.kind === "error" ? "alert" : "status"}
        >
          {notice.message}
        </p>
      )}
      <form
        className="grid gap-3 rounded-xl border border-border bg-card p-4 md:grid-cols-[minmax(12rem,1fr)_10rem_minmax(16rem,2fr)_auto] md:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          const formElement = event.currentTarget;
          const form = new FormData(event.currentTarget);
          run(
            () =>
              createTag({
                name: String(form.get("name") ?? ""),
                color: String(form.get("color") ?? ""),
                description: String(form.get("description") ?? ""),
            }),
            "Tag 已创建。",
            () => formElement.reset(),
          );
        }}
      >
        <Field label="Tag 名称" name="name" required maxLength={40} />
        <Field label="颜色" name="color" type="color" defaultValue="#64748b" />
        <Field label="说明" name="description" maxLength={300} />
        <Button type="submit" disabled={isPending}>创建 Tag</Button>
      </form>

      {tags.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          当前没有 Tag，可从上方创建。
        </div>
      ) : (
        <div className="grid gap-3">
          {tags.map((tag) => (
            <article key={tag.id} className="min-w-0 rounded-xl border border-border bg-card p-4">
              {editingId === tag.id ? (
                <form
                  className="grid gap-3 md:grid-cols-[minmax(12rem,1fr)_10rem_minmax(16rem,2fr)_auto] md:items-end"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = new FormData(event.currentTarget);
                    run(
                      () =>
                        updateTag({
                          tagId: tag.id,
                          expectedUpdatedAt: tag.updatedAt,
                          name: String(form.get("name") ?? ""),
                          color: String(form.get("color") ?? ""),
                          description: String(form.get("description") ?? ""),
                        }),
                      "Tag 已更新。",
                    );
                  }}
                >
                  <Field label="Tag 名称" name="name" required maxLength={40} defaultValue={tag.name} />
                  <Field label="颜色" name="color" type="color" defaultValue={tag.color || "#64748b"} />
                  <Field label="说明" name="description" maxLength={300} defaultValue={tag.description} />
                  <div className="flex gap-2">
                    <Button type="submit" disabled={isPending}>保存</Button>
                    <Button type="button" variant="outline" onClick={() => setEditingId(null)}>取消</Button>
                  </div>
                </form>
              ) : (
                <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="size-3 rounded-full border" style={{ backgroundColor: tag.color || "#64748b" }} aria-hidden="true" />
                      <h2 className="break-words font-medium">{tag.name}</h2>
                      {tag.archivedAt && <Badge variant="secondary">已归档</Badge>}
                    </div>
                    <p className="mt-1 break-words text-sm text-muted-foreground">{tag.description || "无说明"}</p>
                    <p className="mt-2 text-xs text-muted-foreground">关联 {tag.taskCount} 个 Task、{tag.segmentCount} 条投入</p>
                  </div>
                  {tag.capabilities.canUpdate && (
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <Button type="button" variant="outline" disabled={isPending} onClick={() => setEditingId(tag.id)}>编辑</Button>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={isPending}
                        onClick={() => run(
                          () => tag.archivedAt
                            ? restoreTag({ tagId: tag.id, expectedUpdatedAt: tag.updatedAt })
                            : archiveTag({ tagId: tag.id, expectedUpdatedAt: tag.updatedAt }),
                          tag.archivedAt ? "Tag 已恢复。" : "Tag 已归档。",
                        )}
                      >
                        {tag.archivedAt ? "恢复" : "归档"}
                      </Button>
                      {tag.capabilities.canDelete && (
                        <Button
                          type="button"
                          variant="destructive"
                          disabled={isPending}
                          onClick={() => {
                            if (!window.confirm(`确定删除 Tag“${tag.name}”？只会移除分类关联，不会删除 Task 或投入。`)) return;
                            run(
                              () => deleteTag({ tagId: tag.id, expectedUpdatedAt: tag.updatedAt }),
                              "Tag 及其分类关联已删除，业务对象未删除。",
                            );
                          }}
                        >删除</Button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  name,
  type = "text",
  ...props
}: ComponentProps<typeof Input> & { label: string; name: string }) {
  const generatedId = useId();
  return (
    <div className="grid min-w-0 gap-1">
      <Label htmlFor={generatedId}>{label}</Label>
      <Input id={generatedId} name={name} type={type} {...props} />
    </div>
  );
}
