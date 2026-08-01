import Link from "next/link";
import { redirect } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { PageShell } from "@/components/page-shell";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { getAccountAuthorizationContextForOpenId } from "@/lib/account-authorization";
import { auth } from "@/lib/auth";

export default async function ProjectAccessDisabledPage() {
  const session = await auth();
  if (!session?.user?.openId) redirect("/login");
  const authorization = await getAccountAuthorizationContextForOpenId(
    session.user.openId,
  );
  if (authorization?.projectAccessStatus !== "DISABLED") redirect("/progress");

  return (
    <>
      <AppHeader />
      <PageShell>
        <main className="mx-auto flex w-full max-w-2xl flex-1 items-start p-4 py-12">
          <Card className="w-full">
            <CardHeader>
              <h1 className="font-heading text-base font-medium leading-snug">
                项目管理访问已禁用
              </h1>
            </CardHeader>
            <CardContent className="space-y-4 text-sm text-muted-foreground">
              <p>
                当前账号暂时不能进入项目管理。登录和报销功能不受影响，如有疑问请联系超级管理员。
              </p>
              <div className="flex flex-wrap gap-4">
                <Link
                  className="font-medium text-primary underline-offset-4 hover:underline"
                  href="/procurement"
                >
                  进入采购与报销
                </Link>
                <Link
                  className="font-medium text-primary underline-offset-4 hover:underline"
                  href="/"
                >
                  返回首页
                </Link>
              </div>
            </CardContent>
          </Card>
        </main>
      </PageShell>
    </>
  );
}
