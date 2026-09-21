import { auth, signOut } from "@/lib/auth";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { APP_NAME } from "@/lib/branding";
import { isSuperAdmin } from "@/lib/permissions";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { LogOut, UserRound } from "lucide-react";
import { NavigationDrawer } from "@/components/navigation-drawer";

const navLinkClass =
  "rounded-sm text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring";

export async function AppHeader() {
  const session = await auth();
  const showAdmin =
    !!session?.user?.openId && (await isSuperAdmin(session.user.openId));
  const links = [
    { href: "/", label: "首页" },
    { href: routes.procurement.root, label: "采购管理" },
    { href: routes.materials.root, label: "物资" },
    { href: routes.progress.root, label: "项目管理" },
    { href: "/profile", label: "个人中心" },
    ...(showAdmin ? [{ href: "/admin", label: "管理员面板" }] : []),
  ];

  return (
    <header className="sticky top-0 z-30 border-b border-border/60 bg-background/95 backdrop-blur-md" data-testid="app-header">
      <div className="mx-auto flex h-14 min-w-0 max-w-7xl items-center justify-between gap-2 px-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-1 lg:gap-5">
          <div className="shrink-0 lg:hidden">
            <NavigationDrawer title="系统导航" triggerLabel="打开系统导航" compact>
              <nav aria-label="系统导航" className="space-y-1 p-3">
                {links.map((link) => (
                  <Link key={link.href} href={link.href} className={cn(navLinkClass, "flex min-h-11 items-center rounded-lg px-3 hover:bg-muted")}>
                    {link.label}
                  </Link>
                ))}
                {session?.user && <Link href="/feedback?new=1" className={cn(navLinkClass, "flex min-h-11 items-center rounded-lg px-3 hover:bg-muted")}>反馈</Link>}
              </nav>
            </NavigationDrawer>
          </div>
          <Link
            href="/"
            className="min-w-0 truncate rounded-sm font-semibold tracking-tight text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            {APP_NAME}
          </Link>
          <nav aria-label="系统导航" className="hidden shrink-0 items-center gap-3 lg:flex">
            {links.map((link) => <Link key={link.href} href={link.href} className={navLinkClass}>{link.label}</Link>)}
          </nav>
        </div>
        {session?.user && (
          <div className="flex shrink-0 items-center gap-1 lg:gap-3">
            <Link
              href="/feedback?new=1"
              className={cn(buttonVariants({ variant: "outline", size: "sm" }), "hidden lg:inline-flex")}
            >
              反馈
            </Link>
            <Link
              href="/profile"
              className="flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-full transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-ring"
              title="个人中心"
              aria-label={`${session.user.name ?? "我的"} · 个人中心`}
            >
              {session.user.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={session.user.image}
                  alt=""
                  className="h-8 w-8 rounded-full ring-2 ring-primary/10"
                />
              ) : <UserRound className="size-5" aria-hidden="true" />}
              <span className="hidden max-w-28 truncate text-sm xl:inline">{session.user.name}</span>
            </Link>
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/login" });
              }}
            >
              <Button type="submit" variant="outline" size="sm" className="min-h-11 min-w-11 lg:min-h-7" aria-label="退出">
                <LogOut className="size-4 lg:hidden" aria-hidden="true" />
                <span className="sr-only lg:not-sr-only">退出</span>
              </Button>
            </form>
          </div>
        )}
      </div>
    </header>
  );
}
