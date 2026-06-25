"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  purpose?: "approval" | "initiate";
};

export function SignatureRequiredDialog({
  open,
  onOpenChange,
  purpose = "approval",
}: Props) {
  const isInitiate = purpose === "initiate";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>请先上传电子签名</DialogTitle>
          <DialogDescription className="space-y-2 text-left">
            <span className="block">
              {isInitiate
                ? "发起采购申请前，须先在个人中心上传电子签名。"
                : "车组组长、技术组组长在通过管理审核前，须先在个人中心上传电子签名。"}
            </span>
            <span className="block text-muted-foreground">
              {isInitiate
                ? "您的签名将自动填入《物品验收及领用清单》领用人处。"
                : "验收清单共三处签名：验收人 1（车组组长）、验收人 2（技术组组长）、领用人（采购发起人）。审批通过后，您的签名会自动填入对应位置。"}
            </span>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            稍后再说
          </Button>
          <Button
            type="button"
            render={<Link href="/profile" onClick={() => onOpenChange(false)} />}
          >
            前往个人中心
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
