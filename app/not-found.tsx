import { Home } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { NotFoundRedirect } from "@/components/not-found-redirect";
import { PageShell } from "@/components/page-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function NotFound() {
  return (
    <>
      <AppHeader />
      <PageShell>
        <main className="mx-auto flex w-full max-w-3xl flex-1 items-center px-6 py-16">
          <Card className="w-full">
            <CardHeader>
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <Home className="h-6 w-6" />
              </div>
              <CardTitle>页面不存在或无权访问</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm leading-6 text-muted-foreground">
                你访问的页面不存在、已被移动，或当前账号没有查看权限。可以返回首页重新进入对应模块。
              </p>
              <NotFoundRedirect />
            </CardContent>
          </Card>
        </main>
      </PageShell>
    </>
  );
}
