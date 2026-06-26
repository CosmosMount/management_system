"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { syncFeishuUsers } from "@/app/actions/syncFeishuUsers";
import { SystemStat } from "@/components/admin/admin-metric";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function SystemSyncPanel({
  userCount,
  roleCount,
  assignedUserCount,
}: {
  userCount: number;
  roleCount: number;
  assignedUserCount: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function handleSyncFeishu() {
    startTransition(async () => {
      try {
        const result = await syncFeishuUsers();
        toast.success(
          `已同步 ${result.total} 人（新增 ${result.created}，更新 ${result.updated}）`,
        );
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "同步失败");
      }
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>系统同步</CardTitle>
          <CardDescription>
            从飞书通讯录更新用户资料，后续角色分配和负责人选择会使用这里的用户数据。
          </CardDescription>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={handleSyncFeishu}
        >
          <RefreshCw className="mr-1 h-4 w-4" />
          同步飞书通讯录
        </Button>
      </CardHeader>
      <CardContent className="grid min-w-0 gap-3 sm:grid-cols-3">
        <SystemStat label="当前用户" value={`${userCount} 人`} />
        <SystemStat label="角色记录" value={`${roleCount} 条`} />
        <SystemStat
          label="未配置角色"
          value={`${Math.max(userCount - assignedUserCount, 0)} 人`}
        />
      </CardContent>
    </Card>
  );
}
