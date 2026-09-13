"use client";

import { useEffect, useState } from "react";
import { Check, Copy, Download, QrCode } from "lucide-react";
import QRCode from "qrcode";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function MaterialQrCode({
  materialName,
  scanUrl,
}: {
  materialName: string;
  scanUrl: string;
}) {
  const [dataUrl, setDataUrl] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    QRCode.toDataURL(scanUrl, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 360,
      color: { dark: "#171717", light: "#ffffff" },
    })
      .then((value) => {
        if (active) setDataUrl(value);
      })
      .catch(() => {
        if (active) setError("二维码生成失败，请刷新页面重试");
      });
    return () => {
      active = false;
    };
  }, [scanUrl]);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(scanUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setError("复制失败，请长按下方链接复制");
    }
  }

  return (
    <div className="flex flex-col items-center gap-4">
      {dataUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={dataUrl}
          alt={`${materialName}的领用归还二维码`}
          className="aspect-square w-full max-w-[22.5rem] rounded-xl border bg-white"
        />
      ) : error ? (
        <div className="flex aspect-square w-full max-w-[22.5rem] items-center justify-center rounded-xl border border-dashed p-6 text-center text-sm text-destructive">
          {error}
        </div>
      ) : (
        <div
          className="flex aspect-square w-full max-w-[22.5rem] animate-pulse items-center justify-center rounded-xl border bg-muted"
          aria-label="正在生成二维码"
        >
          <QrCode className="size-12 text-muted-foreground" aria-hidden="true" />
        </div>
      )}
      <div className="flex flex-wrap justify-center gap-2">
        <Button type="button" variant="outline" onClick={copyLink}>
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? "已复制" : "复制扫码链接"}
        </Button>
        {dataUrl && (
          <a
            href={dataUrl}
            download={`${safeFileName(materialName)}-二维码.png`}
            className={cn(buttonVariants())}
          >
            <Download aria-hidden="true" />
            下载二维码
          </a>
        )}
      </div>
      <p className="max-w-full break-all text-center text-xs text-muted-foreground">
        {scanUrl}
      </p>
    </div>
  );
}

function safeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) || "物资";
}
