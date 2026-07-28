import { Construction } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";
import { Card, CardContent } from "@/components/ui/card";

export default function ProgressPage() {
  return (
    <>
      <AppHeader />
      <PageShell>
        <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
          <PageTitle subtitle="项目管理（重构中）" />
          <Card>
            <CardContent className="flex flex-col items-center gap-4 px-6 py-12 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Construction className="h-6 w-6" aria-hidden="true" />
              </div>
              <div className="space-y-2">
                <h2 className="text-xl font-semibold">项目管理正在重构</h2>
                <p className="max-w-xl text-sm leading-6 text-muted-foreground">
                  旧版项目、阶段和任务功能已下线。新版项目管理完成后将在此开放。
                </p>
              </div>
            </CardContent>
          </Card>
        </main>
      </PageShell>
    </>
  );
}
