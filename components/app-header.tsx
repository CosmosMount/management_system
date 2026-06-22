import { auth, signOut } from "@/lib/auth";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export async function AppHeader() {
  const session = await auth();

  return (
    <header className="border-b bg-background">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
        <nav className="flex items-center gap-4">
          <Link href="/orders" className="font-semibold">
            采购报销系统
          </Link>
          <Link
            href="/apply"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            新建申请
          </Link>
          <Link
            href="/orders"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            订单列表
          </Link>
        </nav>
        {session?.user && (
          <div className="flex items-center gap-3">
            {session.user.image && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={session.user.image}
                alt={session.user.name ?? ""}
                className="h-8 w-8 rounded-full"
              />
            )}
            <span className="text-sm">{session.user.name}</span>
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
