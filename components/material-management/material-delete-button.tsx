"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { deleteMaterial } from "@/app/actions/materials";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { routes } from "@/lib/routes";

export function MaterialDeleteButton({ materialId, materialName, pairedMaterialName, inUse }: {
  materialId: string;
  materialName: string;
  pairedMaterialName: string | null;
  inUse: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  function confirmDelete() {
    setError("");
    startTransition(async () => {
      try {
        const result = await deleteMaterial({ materialId });
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        setOpen(false);
        toast.success("物资已删除，领用历史和审计记录已保留");
        router.push(routes.materials.root);
        router.refresh();
      } catch {
        setError("删除失败，请检查网络后重试");
      }
    });
  }

  return (
    <>
      <div className="flex min-w-0 flex-col gap-1">
        <Button variant="destructive" disabled={inUse} aria-describedby={inUse ? "material-delete-disabled" : undefined}
          onClick={() => { setError(""); setOpen(true); }}>
          删除物资
        </Button>
        {inUse && <p id="material-delete-disabled" className="text-xs text-muted-foreground">使用中，归还后可删除</p>}
      </div>
      <Dialog open={open} onOpenChange={(nextOpen) => { if (!pending) setOpen(nextOpen); }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>确认删除物资？</DialogTitle>
            <DialogDescription className="break-words [overflow-wrap:anywhere]">
              将删除“{materialName}”{pairedMaterialName ? `及配套物品“${pairedMaterialName}”` : ""}。删除后不再显示在台账中，原二维码不可再领用；领用历史和审计记录仍会保留。此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setOpen(false)}>取消</Button>
            <Button variant="destructive" disabled={pending} onClick={confirmDelete}>{pending ? "正在删除…" : "确认删除"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
