"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { uploadUserSignature } from "@/app/actions/userSignature";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Props = {
  signaturePath: string | null;
};

export function SignatureUploadForm({ signaturePath }: Props) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = formRef.current;
    if (!form) return;

    const formData = new FormData(form);
    setLoading(true);
    try {
      await uploadUserSignature(formData);
      toast.success("电子签名已保存");
      form.reset();
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "上传失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="space-y-4">
      {signaturePath ? (
        <div className="rounded-lg border border-border bg-muted/30 p-4">
          <p className="mb-2 text-sm text-muted-foreground">当前签名</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={signaturePath}
            alt="电子签名"
            className="max-h-24 max-w-full object-contain"
          />
        </div>
      ) : (
        <p className="text-sm text-amber-600">
          尚未上传电子签名。作为验收人、领用人前请先上传透明底或白底 PNG/JPG。
        </p>
      )}

      <div className="space-y-2">
        <Label htmlFor="signature">上传新签名（PNG/JPG，≤2MB）</Label>
        <Input
          id="signature"
          name="signature"
          type="file"
          accept="image/png,image/jpeg"
          required={!signaturePath}
        />
      </div>

      <Button type="submit" disabled={loading}>
        {loading ? "保存中…" : signaturePath ? "更新签名" : "保存签名"}
      </Button>
    </form>
  );
}
