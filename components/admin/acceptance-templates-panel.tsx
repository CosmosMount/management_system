"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { toast } from "sonner";
import {
  createAcceptanceChecklistTemplate,
  deleteAcceptanceChecklistTemplate,
} from "@/app/actions/adminAcceptanceChecklistTemplates";
import type { AdminAcceptanceChecklistTemplate } from "@/components/admin/types";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export function AcceptanceTemplatesPanel({
  templates,
}: {
  templates: AdminAcceptanceChecklistTemplate[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [templateContent, setTemplateContent] = useState("");

  function handleCreateAcceptanceTemplate() {
    const content = templateContent.trim();
    if (!content) {
      toast.error("请输入验收条例");
      return;
    }

    startTransition(async () => {
      try {
        await createAcceptanceChecklistTemplate(content);
        toast.success("验收条例已添加");
        setTemplateContent("");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "添加失败");
      }
    });
  }

  function handleDeleteAcceptanceTemplate(id: string) {
    startTransition(async () => {
      try {
        await deleteAcceptanceChecklistTemplate(id);
        toast.success("验收条例已删除");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "删除失败");
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>常用验收条例</CardTitle>
        <CardDescription>
          任务创建/编辑时可快捷加入这些条例；删除模板不会影响已有任务。
        </CardDescription>
      </CardHeader>
      <CardContent className="min-w-0 space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={templateContent}
            onChange={(event) => setTemplateContent(event.target.value)}
            placeholder="例如：已确认关键数据/材料链接可访问"
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                handleCreateAcceptanceTemplate();
              }
            }}
          />
          <Button
            type="button"
            className="sm:w-24"
            disabled={pending}
            onClick={handleCreateAcceptanceTemplate}
          >
            添加
          </Button>
        </div>

        {templates.length === 0 ? (
          <p className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
            暂无常用验收条例，可先运行 seed 脚本或手动添加。
          </p>
        ) : (
          <div className="space-y-2">
            {templates.map((template) => (
              <div
                key={template.id}
                className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
              >
                <span className="min-w-0 break-words text-sm">
                  {template.content}
                </span>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="outline"
                  aria-label="删除验收条例"
                  disabled={pending}
                  onClick={() => handleDeleteAcceptanceTemplate(template.id)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
