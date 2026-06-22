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
        </CardContent>
      </Card>
    </div>
  );
}
