import { NotificationCenterClient } from "@/components/project-management/notification-center-client";
import { NotificationPreferencesClient } from "@/components/project-management/notification-preferences-client";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { Button, buttonVariants } from "@/components/ui/button";
import { notificationCategoryLabels } from "@/lib/project-management/labels";
import { toProjectManagementServiceError } from "@/lib/project-management/application/errors";
import {
  getNotificationPreferences,
  listInAppNotifications,
} from "@/lib/project-management/queries/notification-queries";
import {
  getProgressActorOrRedirect,
  getProgressUnreadNotificationCount,
} from "../_auth";
import Link from "next/link";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { redirect } from "next/navigation";

type SearchParams = Record<string, string | string[] | undefined>;

const categories = [
  "TASK",
  "MILESTONE",
  "REVIEW",
  "REVISION",
  "WORK_SEGMENT",
  "ACCOUNT_SECURITY",
] as const;

export default async function ProgressNotificationsPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const actor = await getProgressActorOrRedirect();
  const params = (await searchParams) ?? {};
  const category = firstParam(params.category);
  const unreadOnly = firstParam(params.unread) === "1";
  const cursor = firstParam(params.cursor) || undefined;
  const normalizedCategory = categories.includes(
    category as (typeof categories)[number],
  )
    ? category
    : undefined;
  let notifications;
  try {
    notifications = await listInAppNotifications({
      actor,
      input: {
        unreadOnly,
        category: normalizedCategory,
        limit: 50,
        cursor,
      },
    });
  } catch (error) {
    const mapped = toProjectManagementServiceError(error);
    if (
      cursor &&
      mapped.code === "VALIDATION_ERROR" &&
      mapped.message === "通知分页游标无效"
    ) {
      redirect(notificationRecoveryHref(params));
    }
    throw error;
  }
  const [unreadCount, preferences] = await Promise.all([
    getProgressUnreadNotificationCount(),
    getNotificationPreferences(actor),
  ]);

  return (
    <>
      <PageCommandBar
        title="站内通知"
        description="查看项目管理业务通知，标记已读并跳转到仍可访问的业务对象。"
      />
      <div className="mx-auto flex w-full min-w-0 max-w-[96rem] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
          {firstParam(params.cursorError) === "1" && (
            <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              通知列表已变化，已为你返回第一页。
            </p>
          )}
          <form className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-4">
            <select
              name="category"
              defaultValue={category}
              aria-label="通知类型"
              className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
            >
              <option value="">全部类型</option>
              {categories.map((value) => (
                <option key={value} value={value}>
                  {notificationCategoryLabels[value]}
                </option>
              ))}
            </select>
            <label className="flex h-8 items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                name="unread"
                value="1"
                defaultChecked={unreadOnly}
              />
              只看未读
            </label>
            <Button type="submit">筛选</Button>
          </form>
          <NotificationCenterClient
            notifications={notifications.items}
            unreadCount={unreadCount}
          />
          {notifications.nextCursor && (
            <div className="flex justify-end">
              <Link
                href={notificationPageHref(params, notifications.nextCursor)}
                className={cn(buttonVariants({ variant: "outline" }))}
              >
                下一页通知
              </Link>
            </div>
          )}
          <NotificationPreferencesClient
            preferences={preferences}
            readOnly={actor.isActive === false}
          />
      </div>
    </>
  );
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function notificationPageHref(params: SearchParams, cursor: string) {
  const search = new URLSearchParams();
  const category = firstParam(params.category);
  if (category) search.set("category", category);
  if (firstParam(params.unread) === "1") search.set("unread", "1");
  search.set("cursor", cursor);
  return `${routes.progress.notifications}?${search.toString()}`;
}

function notificationRecoveryHref(params: SearchParams) {
  const search = new URLSearchParams();
  const category = firstParam(params.category);
  if (category) search.set("category", category);
  if (firstParam(params.unread) === "1") search.set("unread", "1");
  search.set("cursorError", "1");
  return `${routes.progress.notifications}?${search.toString()}`;
}
