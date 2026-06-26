"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Send } from "lucide-react";
import type { NotificationOutboxStatus, ProgressReminderKind } from "@prisma/client";
import { toast } from "sonner";
import {
  retryProgressReminderOutbox,
  runProgressReminderScanNow,
  updateProgressReminderRules,
} from "@/app/actions/progress/reminders";
import type {
  AdminProgressReminderRule,
  AdminReminderOutbox,
} from "@/components/admin/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export function RemindersPanel({
  progressReminderRules,
  progressReminderOutbox,
}: {
  progressReminderRules: AdminProgressReminderRule[];
  progressReminderOutbox: AdminReminderOutbox[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [reminderDrafts, setReminderDrafts] = useState(progressReminderRules);
  const reminderRuleMetaByKind = new Map(
    progressReminderRules.map((rule) => [rule.kind, rule]),
  );

  function updateReminderDraft(
    kind: ProgressReminderKind,
    updater: (rule: AdminProgressReminderRule) => AdminProgressReminderRule,
  ) {
    setReminderDrafts((drafts) =>
      drafts.map((rule) => (rule.kind === kind ? updater(rule) : rule)),
    );
  }

  function handleSaveReminderRules() {
    startTransition(async () => {
      try {
        await updateProgressReminderRules({
          rules: reminderDrafts.map((rule) => ({
            kind: rule.kind,
            enabled: rule.enabled,
            scheduleTime: rule.scheduleTime,
            params: rule.params,
          })),
        });
        toast.success("进度提醒规则已保存");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "保存失败");
      }
    });
  }

  function handleRunReminderScan() {
    startTransition(async () => {
      try {
        const result = await runProgressReminderScanNow();
        toast.success(
          `已执行 ${result.rulesRun} 条规则，入队 ${result.queued} 条提醒`,
        );
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "扫描失败");
      }
    });
  }

  function handleRetryReminderOutbox(id: string) {
    startTransition(async () => {
      try {
        await retryProgressReminderOutbox(id);
        toast.success("已重新入队");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "重试失败");
      }
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>进度提醒</CardTitle>
          <CardDescription>
            配置项目/任务自动提醒；手动催促入口在项目详情和任务详情页。
          </CardDescription>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={handleRunReminderScan}
          >
            <Send className="h-4 w-4" />
            立即扫描一次
          </Button>
          <Button
            type="button"
            disabled={pending}
            onClick={handleSaveReminderRules}
          >
            保存规则
          </Button>
        </div>
      </CardHeader>
      <CardContent className="min-w-0 space-y-6">
        <div className="space-y-3">
          {reminderDrafts.map((rule) => {
            const ruleMeta = reminderRuleMetaByKind.get(rule.kind);
            const lastRunAt = ruleMeta?.lastRunAt ?? rule.lastRunAt;
            return (
              <div key={rule.kind} className="rounded-lg border p-3">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium">{rule.label}</p>
                      <Badge variant={rule.enabled ? "default" : "secondary"}>
                        {rule.enabled ? "已启用" : "已停用"}
                      </Badge>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {rule.description}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      上次扫描：
                      {lastRunAt
                        ? new Date(lastRunAt).toLocaleString("zh-CN")
                        : "尚未执行"}
                    </p>
                  </div>
                  <div className="grid min-w-0 gap-2 sm:grid-cols-[7rem_8rem]">
                    <Select
                      value={rule.enabled ? "true" : "false"}
                      onValueChange={(value) =>
                        updateReminderDraft(rule.kind, (draft) => ({
                          ...draft,
                          enabled: value === "true",
                        }))
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue>
                          {(value) => (value === "true" ? "启用" : "停用")}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="true">启用</SelectItem>
                        <SelectItem value="false">停用</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input
                      type="time"
                      value={rule.scheduleTime}
                      onChange={(event) =>
                        updateReminderDraft(rule.kind, (draft) => ({
                          ...draft,
                          scheduleTime: event.target.value,
                        }))
                      }
                    />
                  </div>
                </div>

                <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {rule.paramDefinitions.map((param) => (
                    <label key={param.key} className="space-y-1 text-sm">
                      <span className="text-muted-foreground">
                        {param.label}（{param.unit}）
                      </span>
                      <Input
                        type="number"
                        min={param.min}
                        max={param.max}
                        value={rule.params[param.key] ?? param.min}
                        onChange={(event) =>
                          updateReminderDraft(rule.kind, (draft) => ({
                            ...draft,
                            params: {
                              ...draft.params,
                              [param.key]: Number(event.target.value),
                            },
                          }))
                        }
                      />
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        <div className="space-y-3">
          <div>
            <p className="font-medium">最近提醒通知</p>
            <p className="text-sm text-muted-foreground">
              展示 progress reminder outbox 的最近记录，失败记录可手动重试。
            </p>
          </div>
          {progressReminderOutbox.length === 0 ? (
            <p className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
              暂无提醒通知记录。
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>创建时间</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>尝试</TableHead>
                  <TableHead>错误</TableHead>
                  <TableHead className="w-20">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {progressReminderOutbox.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-nowrap">
                      {new Date(row.createdAt).toLocaleString("zh-CN")}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={row.status === "SENT" ? "default" : "secondary"}
                      >
                        {formatOutboxStatus(row.status)}
                      </Badge>
                    </TableCell>
                    <TableCell>{row.attempts}</TableCell>
                    <TableCell className="max-w-[20rem] truncate">
                      {row.lastError || "无"}
                    </TableCell>
                    <TableCell>
                      {row.status === "FAILED" ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={pending}
                          onClick={() => handleRetryReminderOutbox(row.id)}
                        >
                          重试
                        </Button>
                      ) : (
                        <span className="text-sm text-muted-foreground">-</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function formatOutboxStatus(status: NotificationOutboxStatus): string {
  const labels: Record<NotificationOutboxStatus, string> = {
    PENDING: "待发送",
    PROCESSING: "发送中",
    SENT: "已发送",
    FAILED: "失败",
  };
  return labels[status];
}
