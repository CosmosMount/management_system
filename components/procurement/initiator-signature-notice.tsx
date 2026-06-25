import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function InitiatorSignatureNotice() {
  return (
    <Card className="border-amber-200 bg-amber-50/80 dark:border-amber-900 dark:bg-amber-950/30">
      <CardHeader>
        <CardTitle>请先上传电子签名</CardTitle>
        <CardDescription className="text-left">
          发起采购申请前，须先在个人中心上传电子签名。您的签名将自动填入《物品验收及领用清单》领用人处。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button type="button" render={<Link href="/profile" />}>
          前往个人中心上传
        </Button>
      </CardContent>
    </Card>
  );
}
