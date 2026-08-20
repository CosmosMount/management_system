"use client";

import { useState, useTransition } from "react";
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
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

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
  const [confirmation, setConfirmation] = useState<{
    confirmationToken: string;
    deactivateCount: number;
    activeAccountCount: number;
  } | null>(null);

  function handleSyncFeishu(confirmationToken?: string) {
    startTransition(async () => {
      try {
        const response = await syncFeishuUsers(
          confirmationToken ? { confirmationToken } : undefined,
        );
        if (response.status === "confirmation_required") {
          setConfirmation(response);
          return;
        }
        const result = response.result;
        setConfirmation(null);
        toast.success(
          `已同步 ${result.total} 名在职成员（新增 ${result.created}，更新 ${result.updated}，恢复 ${result.reactivated}，停用 ${result.deactivated}）`,
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
            从飞书通讯录更新在职成员；已离职成员会停用并退出权限、通知和人员选择范围，历史业务记录仍会保留。
          </CardDescription>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => handleSyncFeishu()}
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
      <Dialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setConfirmation(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认停用大量成员</DialogTitle>
            <DialogDescription>
              本次快照将停用 {confirmation?.deactivateCount ?? 0} /
              {confirmation?.activeAccountCount ?? 0} 名当前在职成员。请先确认飞书应用仍授权根部门和全部成员；继续后会保留历史业务记录并写入确认审计。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose
              render={
                <Button type="button" variant="outline" disabled={pending}>
                  取消
                </Button>
              }
            />
            <Button
              type="button"
              variant="destructive"
              disabled={pending || !confirmation}
              onClick={() => {
                if (confirmation) {
                  handleSyncFeishu(confirmation.confirmationToken);
                }
              }}
            >
              确认授权完整并继续
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
