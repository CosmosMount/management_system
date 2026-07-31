import { NotificationCenterClient } from "@/components/project-management/notification-center-client";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { Button } from "@/components/ui/button";
import {
  notificationCategoryLabels,
} from "@/lib/project-management/labels";
import {
  listInAppNotifications,
} from "@/lib/project-management/queries/notification-queries";
import {
  getProgressActorOrRedirect,
  getProgressUnreadNotificationCount,
} from "../_auth";

type SearchParams = Record<string, string | string[] | undefined>;

const categories = [
  "TASK",
  "MILESTONE",
  "REVIEW",
  "REVISION",
  "WORK_SEGMENT",
  "RESOURCE_CONFLICT",
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
  const [notifications, unreadCount] = await Promise.all([
    listInAppNotifications({
      actor,
      input: {
        unreadOnly,
        category: categories.includes(category as (typeof categories)[number])
          ? category
          : undefined,
        limit: 50,
      },
    }),
    getProgressUnreadNotificationCount(),
  ]);

  return (
    <>
      <PageCommandBar
        title="站内通知"
        description="查看项目管理业务通知，标记已读并跳转到仍可访问的业务对象。"
      />
      <div className="mx-auto flex w-full min-w-0 max-w-[96rem] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
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
      </div>
    </>
  );
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}
