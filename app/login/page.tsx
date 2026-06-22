import { signIn } from "@/lib/auth";
import { getFeishuRedirectUri } from "@/lib/feishu-oauth";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function LoginPage() {
  const redirectUri = getFeishuRedirectUri();

  return (
    <div className="flex flex-1 items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>采购报销系统</CardTitle>
          <CardDescription>请使用飞书账号登录</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form
            action={async () => {
              "use server";
              await signIn("feishu", { redirectTo: "/orders" });
            }}
          >
            <Button type="submit" className="w-full">
              飞书登录
            </Button>
          </form>
          <p className="text-xs text-muted-foreground leading-relaxed">
            若飞书报 20029，请在开放平台 → 该应用 →{" "}
            <strong>开发配置 → 安全设置 → 重定向 URL</strong>{" "}
            中添加（须完全一致）：
            <br />
            <code className="mt-1 block break-all rounded bg-muted px-2 py-1 text-[11px]">
              {redirectUri}
            </code>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
