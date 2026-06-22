import { signIn } from "@/lib/auth";
import { APP_NAME, APP_TAGLINE } from "@/lib/branding";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function LoginPage() {
  return (
    <div className="relative flex flex-1 items-center justify-center p-4">
      <div
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-primary/10 via-background to-background"
        aria-hidden
      />
      <Card className="w-full max-w-md border-border/60 bg-card/90 shadow-lg backdrop-blur-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl tracking-tight">{APP_NAME}</CardTitle>
          <CardDescription>{APP_TAGLINE}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-center text-sm text-muted-foreground">
            请使用飞书账号登录
          </p>
          <form
            action={async () => {
              "use server";
              await signIn("feishu", { redirectTo: "/" });
            }}
          >
            <Button type="submit" className="w-full">
              飞书登录
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
