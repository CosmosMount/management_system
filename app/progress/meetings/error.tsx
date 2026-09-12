"use client";

import { Button } from "@/components/ui/button";

export default function MeetingsError({ reset }: { reset: () => void }) {
  return <div className="space-y-3 p-6"><p role="alert">会议加载失败，请稍后重试；如持续失败，请联系管理员检查服务及数据库迁移。</p><Button onClick={reset}>重新加载会议</Button></div>;
}
