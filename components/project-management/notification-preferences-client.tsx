"use client";

import { useState, useTransition } from "react";
import { updateNotificationPreference } from "@/app/actions/project-management/notifications";
import { Badge } from "@/components/ui/badge";
import { notificationCategoryLabels } from "@/lib/project-management/labels";
import type { NotificationPreferenceItem } from "@/lib/project-management/queries/notification-queries";

export function NotificationPreferencesClient({
  preferences,
}: {
  preferences: NotificationPreferenceItem[];
}) {
  const [values, setValues] = useState(() =>
    new Map(preferences.map((item) => [item.category, item.feishuEnabled])),
  );
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState("");

  return (
    <section className="rounded-xl border border-border bg-card p-4" aria-labelledby="notification-preference-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="notification-preference-title" className="font-medium">通知偏好</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            站内通知始终保留；关闭飞书后，安全、关键状态变化等强制事件仍会发送。
          </p>
        </div>
        <Badge variant="secondary">站内通知始终开启</Badge>
      </div>
      {message && <p className="mt-3 text-sm" role="status">{message}</p>}
      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {preferences.map((preference) => {
          const checked = values.get(preference.category) ?? true;
          return (
            <label key={preference.category} className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-3 text-sm">
              <span>{notificationCategoryLabels[preference.category]}</span>
              <span className="flex items-center gap-2 text-muted-foreground">
                飞书
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={isPending}
                  aria-label={`${notificationCategoryLabels[preference.category]}飞书通知`}
                  onChange={(event) => {
                    const next = event.currentTarget.checked;
                    const previous = checked;
                    setValues((current) => new Map(current).set(preference.category, next));
                    setMessage("正在保存…");
                    startTransition(async () => {
                      const result = await updateNotificationPreference({
                        category: preference.category,
                        feishuEnabled: next,
                      }).catch(() => null);
                      if (!result?.ok) {
                        setValues((current) => new Map(current).set(preference.category, previous));
                        setMessage(result ? result.error.message : "网络异常，偏好未保存。");
                        return;
                      }
                      setMessage("通知偏好已保存。强制事件不受普通关闭偏好影响。");
                    });
                  }}
                />
              </span>
            </label>
          );
        })}
      </div>
    </section>
  );
}
