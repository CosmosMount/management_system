"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Bell, CheckCheck } from "lucide-react";
import {
  markAllInAppNotificationsRead,
  markInAppNotificationRead,
} from "@/app/actions/project-management/notifications";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import type { ProjectManagementActionResult } from "@/lib/project-management/application/action-result";
import {
  formatDateTime,
  notificationCategoryLabels,
} from "@/lib/project-management/labels";
import type { InAppNotificationListItem } from "@/lib/project-management/queries/notification-queries";
import { cn } from "@/lib/utils";

type NotificationCenterClientProps = {
  notifications: InAppNotificationListItem[];
  unreadCount: number;
};

type MutationState = {
  kind: "idle" | "success" | "error";
  message: string;
};

export function NotificationCenterClient({
  notifications,
  unreadCount,
}: NotificationCenterClientProps) {
  const [isPending, startTransition] = useTransition();
  const [state, setState] = useState<MutationState>({
    kind: "idle",
    message: "",
  });

  function runMutation(
    action: () => Promise<ProjectManagementActionResult<unknown>>,
    successMessage: string,
  ) {
    setState({ kind: "idle", message: "" });
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        setState({ kind: "success", message: successMessage });
        return;
      }
      setState({ kind: "error", message: result.error.message });
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Bell className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h2 className="font-medium">未读通知 {unreadCount} 条</h2>
            <p className="text-sm text-muted-foreground">
              已读不会删除，业务对象打开时会重新校验权限。
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={isPending || unreadCount === 0}
          onClick={() =>
            runMutation(
              () => markAllInAppNotificationsRead({}),
              "已标记全部通知为已读",
            )
          }
        >
          <CheckCheck className="h-4 w-4" aria-hidden="true" />
          全部已读
        </Button>
      </div>

      {state.kind !== "idle" && (
        <p
          className={cn(
            "rounded-lg px-3 py-2 text-sm",
            state.kind === "success"
              ? "bg-emerald-50 text-emerald-700"
              : "bg-destructive/10 text-destructive",
          )}
          role={state.kind === "error" ? "alert" : "status"}
        >
          {state.message}
        </p>
      )}

      {notifications.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          当前没有站内通知。
        </div>
      ) : (
        <div className="space-y-3">
          {notifications.map((notification) => (
            <article
              key={notification.id}
              className={cn(
                "rounded-lg border border-border bg-card p-4",
                !notification.readAt && "border-primary/40",
              )}
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="truncate font-medium">{notification.title}</h2>
                    <Badge variant="secondary">
                      {notificationCategoryLabels[notification.category]}
                    </Badge>
                    {!notification.readAt && <Badge>未读</Badge>}
                  </div>
                  {notification.summary && (
                    <p className="mt-2 text-sm text-muted-foreground">
                      {notification.summary}
                    </p>
                  )}
                  <p className="mt-2 text-xs text-muted-foreground">
                    {formatDateTime(notification.createdAt)}
                    {notification.taskTitle ? ` · ${notification.taskTitle}` : ""}
                  </p>
                  {!notification.entityAvailable && (
                    <p className="mt-2 text-sm text-destructive">
                      对象不可用或当前无权访问。
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {notification.linkPath && notification.entityAvailable && (
                    <Link
                      href={notification.linkPath}
                      className={buttonVariants({ variant: "outline", size: "sm" })}
                    >
                      打开对象
                    </Link>
                  )}
                  {!notification.readAt && (
                    <Button
                      type="button"
                      size="sm"
                      disabled={isPending}
                      onClick={() =>
                        runMutation(
                          () =>
                            markInAppNotificationRead({
                              notificationId: notification.id,
                            }),
                          "已标记通知为已读",
                        )
                      }
                    >
                      标记已读
                    </Button>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
