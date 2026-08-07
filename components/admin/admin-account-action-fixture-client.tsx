"use client";

import { useState, useTransition } from "react";
import {
  resolveAdminAccountOptionsByIds,
  searchAdminAccountOptions,
} from "@/app/actions/adminAccounts";
import { updateTeacherEmail } from "@/app/actions/adminTeacherEmail";
import { Button } from "@/components/ui/button";

export function AdminAccountActionFixtureClient({
  accountId,
  email,
}: {
  accountId: string;
  email: string;
}) {
  const [searchResult, setSearchResult] = useState("未调用");
  const [resolveResult, setResolveResult] = useState("未调用");
  const [teacherEmailResult, setTeacherEmailResult] = useState("未调用");
  const [pending, startTransition] = useTransition();

  function run(action: () => Promise<void>) {
    startTransition(async () => {
      await action();
    });
  }

  return (
    <main className="space-y-4 p-6">
      <h1 className="text-lg font-semibold">管理员账号 Action 测试夹具</h1>
      <div className="flex flex-wrap gap-3">
        <Button
          type="button"
          disabled={pending}
          onClick={() =>
            run(async () => {
              try {
                const result = await searchAdminAccountOptions({
                  purpose: "ALL",
                  query: "Playwright",
                  limit: 10,
                });
                setSearchResult(`成功：${result.items.length}`);
              } catch (error) {
                setSearchResult(
                  error instanceof Error ? error.message : "未知错误",
                );
              }
            })
          }
        >
          调用账号搜索
        </Button>
        <Button
          type="button"
          disabled={pending}
          onClick={() =>
            run(async () => {
              try {
                const result = await resolveAdminAccountOptionsByIds({
                  purpose: "ALL",
                  ids: [accountId],
                });
                setResolveResult(`成功：${result.length}`);
              } catch (error) {
                setResolveResult(
                  error instanceof Error ? error.message : "未知错误",
                );
              }
            })
          }
        >
          调用账号解析
        </Button>
        <Button
          type="button"
          disabled={pending}
          onClick={() =>
            run(async () => {
              try {
                const result = await updateTeacherEmail({ accountId, email });
                setTeacherEmailResult(`成功：${result.email || "空邮箱"}`);
              } catch (error) {
                setTeacherEmailResult(
                  error instanceof Error ? error.message : "未知错误",
                );
              }
            })
          }
        >
          调用指导老师邮箱更新
        </Button>
      </div>
      <output aria-label="账号搜索调用结果">{searchResult}</output>
      <output aria-label="账号解析调用结果">{resolveResult}</output>
      <output aria-label="指导老师邮箱调用结果">{teacherEmailResult}</output>
    </main>
  );
}
