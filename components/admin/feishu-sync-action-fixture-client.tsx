"use client";

import { useState, useTransition } from "react";
import { syncFeishuUsers } from "@/app/actions/syncFeishuUsers";
import { Button } from "@/components/ui/button";

export function FeishuSyncActionFixtureClient() {
  const [result, setResult] = useState("未调用");
  const [pending, startTransition] = useTransition();

  function runSync() {
    startTransition(async () => {
      const response = await syncFeishuUsers();
      if (response.status === "failed") {
        setResult(response.error.code);
        return;
      }
      setResult(response.status);
    });
  }

  return (
    <main className="space-y-4 p-6">
      <h1 className="text-lg font-semibold">飞书通讯录同步 Action 测试夹具</h1>
      <Button
        type="button"
        disabled={pending}
        onClick={runSync}
      >
        调用飞书通讯录同步
      </Button>
      <output aria-label="飞书通讯录同步调用结果">
        {result}
      </output>
    </main>
  );
}
