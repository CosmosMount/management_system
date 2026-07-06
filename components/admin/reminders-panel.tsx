"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Send } from "lucide-react";
import type { NotificationOutboxStatus, ProgressReminderKind } from "@prisma/client";
import { toast } from "sonner";
import {
  retryProgressReminderOutbox,
  runProgressReminderScanNow,
  sendProgressDailySummaryTest,
  updateProgressDailySummarySetting,
  updateProgressReminderRules,
} from "@/app/actions/progress/reminders";
import type {
  AdminDailySummaryUserOption,
  AdminProgressDailySummarySetting,
  AdminProgressReminderRule,
  AdminReminderOutbox,
} from "@/components/admin/types";
import { UserSearchSelect } from "@/components/user-search-select";
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
  progressDailySummarySetting,
  progressDailySummaryOutbox,
  users,
}: {
  progressReminderRules: AdminProgressReminderRule[];
  progressReminderOutbox: AdminReminderOutbox[];
  progressDailySummarySetting: AdminProgressDailySummarySetting;
  progressDailySummaryOutbox: AdminReminderOutbox[];
  users: AdminDailySummaryUserOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [activeTab, setActiveTab] = useState<"rules" | "daily">("rules");
  const [reminderDrafts, setReminderDrafts] = useState(progressReminderRules);
  const [dailyDraft, setDailyDraft] = useState(progressDailySummarySetting);
  const [selectedDailyUserOpenId, setSelectedDailyUserOpenId] = useState(
    users[0]?.openId ?? "",
  );
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

  function handleSaveDailySummarySetting() {
    startTransition(async () => {
      try {
        const saved = await updateProgressDailySummarySetting({
          enabled: dailyDraft.enabled,
          scheduleTime: dailyDraft.scheduleTime,
        });
        setDailyDraft(saved);
        toast.success("每日卡片设置已保存");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "保存失败");
      }
    });
  }

  function handleSendDailySummaryTest() {
    if (!selectedDailyUserOpenId) {
      toast.error("请选择测试收件人");
      return;
    }
    startTransition(async () => {
      try {
        const result = await sendProgressDailySummaryTest({
          openId: selectedDailyUserOpenId,
        });
        toast.success(`测试卡片已入队：${result.summaryDate}`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "测试发送失败");
      }
    });
  }

  return (
    <div className="space-y-4">
      <div
        role="tablist"
        aria-label="进度提醒设置分类"
        className="grid min-w-0 gap-2 sm:grid-cols-2"
      >
        <Button
          type="button"
          variant={activeTab === "rules" ? "default" : "outline"}
          className="h-10"
          onClick={() => setActiveTab("rules")}
          data-testid="admin-reminder-rules-tab"
        >
          规则提醒
        </Button>
        <Button
          type="button"
          variant={activeTab === "daily" ? "default" : "outline"}
          className="h-10"
          onClick={() => setActiveTab("daily")}
          data-testid="admin-daily-summary-tab"
        >
          每日卡片
        </Button>
      </div>

      {activeTab === "rules" ? (
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
                      value={rule.enabled ? "启用" : "停用"}
                      onValueChange={(value) =>
                        updateReminderDraft(rule.kind, (draft) => ({
                          ...draft,
                          enabled: value === "启用",
                        }))
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="启用">启用</SelectItem>
                        <SelectItem value="停用">停用</SelectItem>
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
      ) : (
        <Card data-testid="admin-daily-summary-panel">
          <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle>每日卡片</CardTitle>
              <CardDescription>
                配置每天发送给个人的进度摘要；测试发送只给选中的单个用户入队。
              </CardDescription>
            </div>
            <Button
              type="button"
              disabled={pending}
              onClick={handleSaveDailySummarySetting}
              data-testid="admin-daily-summary-save"
            >
              保存设置
            </Button>
          </CardHeader>
          <CardContent className="min-w-0 space-y-6">
            <div className="grid gap-3 md:grid-cols-[10rem_12rem_1fr]">
              <label className="space-y-1 text-sm">
                <span className="text-muted-foreground">发送状态</span>
                <Select
                  value={dailyDraft.enabled ? "启用" : "停用"}
                  onValueChange={(value) =>
                    setDailyDraft((draft) => ({
                      ...draft,
                      enabled: value === "启用",
                    }))
                  }
                >
                  <SelectTrigger
                    className="w-full"
                    data-testid="admin-daily-summary-enabled"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="启用">启用</SelectItem>
                    <SelectItem value="停用">停用</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-muted-foreground">发送时间</span>
                <Input
                  type="time"
                  value={dailyDraft.scheduleTime}
                  onChange={(event) =>
                    setDailyDraft((draft) => ({
                      ...draft,
                      scheduleTime: event.target.value,
                    }))
                  }
                  data-testid="admin-daily-summary-time"
                />
              </label>
              <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
                <p className="font-medium">运行状态</p>
                <p className="mt-1 text-muted-foreground">
                  上次正式发送：
                  {dailyDraft.lastRunAt
                    ? new Date(dailyDraft.lastRunAt).toLocaleString("zh-CN")
                    : "尚未执行"}
                </p>
                <p className="mt-1 text-muted-foreground">
                  设置更新时间：
                  {dailyDraft.updatedAt
                    ? new Date(dailyDraft.updatedAt).toLocaleString("zh-CN")
                    : "尚未保存"}
                </p>
              </div>
            </div>

            <div className="rounded-lg border p-3">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="font-medium">测试发送给单个用户</p>
                  <p className="text-sm text-muted-foreground">
                    使用真实每日卡片内容生成一条测试 outbox；无待办用户也会收到“暂无待跟进事项”的测试卡。
                  </p>
                  <div
                    className="mt-2 w-full lg:max-w-md"
                    data-testid="admin-daily-summary-test-user"
                  >
                    <UserSearchSelect
                      users={users.map((user) => ({
                        openId: user.openId,
                        name: user.name || user.openId,
                        avatar: user.avatar,
                      }))}
                      value={selectedDailyUserOpenId}
                      onChange={setSelectedDailyUserOpenId}
                      placeholder="搜索测试收件人"
                      disabled={users.length === 0}
                    />
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending || !selectedDailyUserOpenId}
                  onClick={handleSendDailySummaryTest}
                  data-testid="admin-daily-summary-test-send"
                >
                  <Send className="h-4 w-4" />
                  发送测试卡片
                </Button>
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <p className="font-medium">最近每日卡片</p>
                <p className="text-sm text-muted-foreground">
                  展示最近的每日卡片通知队列，包含正式发送和测试发送。
                </p>
              </div>
              {progressDailySummaryOutbox.length === 0 ? (
                <p className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
                  暂无每日卡片通知记录。
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>创建时间</TableHead>
                      <TableHead>类型</TableHead>
                      <TableHead>收件人</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>尝试</TableHead>
                      <TableHead>错误</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {progressDailySummaryOutbox.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="whitespace-nowrap">
                          {new Date(row.createdAt).toLocaleString("zh-CN")}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          {row.sourceLabel ?? "每日卡片"}
                        </TableCell>
                        <TableCell className="max-w-[14rem] truncate">
                          {row.recipientSummary ?? "未记录收件人"}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              row.status === "SENT" ? "default" : "secondary"
                            }
                          >
                            {formatOutboxStatus(row.status)}
                          </Badge>
                        </TableCell>
                        <TableCell>{row.attempts}</TableCell>
                        <TableCell className="max-w-[20rem] truncate">
                          {row.lastError || "无"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
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
