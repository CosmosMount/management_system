import { auth, signOut } from "@/lib/auth";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { APP_NAME } from "@/lib/branding";
import { isSuperAdmin } from "@/lib/permissions";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

const navLinkClass =
  "text-sm text-muted-foreground transition-colors hover:text-foreground";

export async function AppHeader() {
  const session = await auth();
  const showAdmin =
    !!session?.user?.openId && (await isSuperAdmin(session.user.openId));

  return (
    <header className="sticky top-0 z-50 border-b border-border/60 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4">
        <nav className="flex items-center gap-1 sm:gap-4">
          <Link
            href="/"
            className="mr-2 font-semibold tracking-tight text-foreground"
          >
            {APP_NAME}
          </Link>
          <Link href="/" className={cn(navLinkClass, "hidden sm:inline")}>
            首页
          </Link>
          <Link href={routes.procurement.root} className={navLinkClass}>
            采购管理
          </Link>
          <Link href={routes.progress.root} className={navLinkClass}>
            进度管理
          </Link>
          <Link href="/profile" className={cn(navLinkClass, "hidden sm:inline")}>
            个人中心
          </Link>
          {showAdmin && (
            <Link href="/admin" className={navLinkClass}>
              权限管理
            </Link>
          )}
        </nav>
        {session?.user && (
          <div className="flex items-center gap-3">
            <Link
              href="/feedback?new=1"
              className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
            >
              反馈
            </Link>
            <Link
              href="/profile"
              className="flex items-center gap-2 rounded-full transition-opacity hover:opacity-80"
              title="个人中心"
            >
              {session.user.image && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={session.user.image}
                  alt={session.user.name ?? ""}
                  className="h-8 w-8 rounded-full ring-2 ring-primary/10"
                />
              )}
              <span className="hidden text-sm sm:inline">{session.user.name}</span>
            </Link>
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/login" });
              }}
            >
              <Button type="submit" variant="outline" size="sm">
                退出
              </Button>
            </form>
          </div>
        )}
      </div>
    </header>
  );
}
