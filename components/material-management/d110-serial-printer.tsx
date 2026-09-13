"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Printer, RotateCcw } from "lucide-react";
import QRCode from "qrcode";
import {
  ImageEncoder,
  LabelType,
  NiimbotSerialClient,
  PageColorType,
} from "@mmote/niimbluelib";
import { Button } from "@/components/ui/button";
import {
  D110_LABEL_HEIGHT_PX,
  D110_LABEL_WIDTH_PX,
  D110_PRINT_DIRECTION,
  D110_QR_MARGIN_MODULES,
  D110_QR_SIZE_PX,
  d110BrowserAvailability,
  d110PrintErrorMessage,
  fitD110LabelLines,
  isD110PrinterModel,
  resolveD110PrintTaskName,
  runD110PrintSequence,
  type D110LabelContent,
} from "@/lib/material-management/d110-label";

type PrintState = "IDLE" | "CONNECTING" | "PRINTING" | "SUCCESS" | "ERROR";

const subscribeToBrowserEnvironment = () => () => undefined;

export function D110SerialPrinter(props: D110LabelContent) {
  const clientRef = useRef<NiimbotSerialClient | null>(null);
  const browserReady = useSyncExternalStore(
    subscribeToBrowserEnvironment,
    () => true,
    () => false,
  );
  const availability = browserReady
    ? d110BrowserAvailability({
        isSecureContext: window.isSecureContext,
        hasSerial: "serial" in navigator,
      })
    : null;
  const [state, setState] = useState<PrintState>("IDLE");
  const [message, setMessage] = useState("");

  useEffect(() => {
    return () => {
      const client = clientRef.current;
      clientRef.current = null;
      if (client?.isConnected()) void client.disconnect().catch(() => undefined);
    };
  }, []);

  async function printLabel() {
    if (!availability?.available || state === "CONNECTING" || state === "PRINTING") {
      return;
    }

    setState("CONNECTING");
    setMessage("请在浏览器窗口中选择 Type-C 连接的 D110…");
    try {
      const client = await connectD110(clientRef.current);
      clientRef.current = client;
      setState("PRINTING");
      setMessage("正在发送物资标签，请勿关闭打印机…");
      await printD110MaterialLabel(client, props);
      await client.disconnect();
      clientRef.current = null;
      setState("SUCCESS");
      setMessage("打印完成。如标签未出纸，请检查标签纸后重试。");
    } catch (error) {
      const client = clientRef.current;
      clientRef.current = null;
      if (client?.isConnected()) await client.disconnect().catch(() => undefined);
      setState("ERROR");
      setMessage(d110PrintErrorMessage(error));
    }
  }

  const busy = state === "CONNECTING" || state === "PRINTING";
  const buttonLabel =
    state === "CONNECTING"
      ? "正在连接…"
      : state === "PRINTING"
        ? "正在打印…"
        : state === "SUCCESS" || state === "ERROR"
          ? "再次连接并打印"
          : "连接 D110 系列并打印";

  return (
    <div className="mt-5 border-t pt-5" data-testid="d110-serial-printer">
      <div className="flex items-start gap-3">
        <Printer className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">Type-C 直连打印</p>
          <p className="mt-1 text-sm text-muted-foreground">
            由当前电脑的浏览器通过 Web Serial 直连 D110 或 D110_M，不经过本地打印服务。
          </p>
        </div>
      </div>
      <Button
        type="button"
        className="mt-4 w-full"
        disabled={!availability?.available || busy}
        onClick={printLabel}
      >
        {state === "SUCCESS" || state === "ERROR" ? (
          <RotateCcw aria-hidden="true" />
        ) : (
          <Printer aria-hidden="true" />
        )}
        {buttonLabel}
      </Button>
      <p
        className={`mt-3 text-sm ${state === "ERROR" || availability?.available === false ? "text-destructive" : "text-muted-foreground"}`}
        role={state === "ERROR" ? "alert" : "status"}
        aria-live="polite"
      >
        {message || availability?.message || "正在检查浏览器打印能力…"}
      </p>
    </div>
  );
}

async function connectD110(
  existingClient: NiimbotSerialClient | null,
): Promise<NiimbotSerialClient> {
  if (existingClient?.isConnected()) return existingClient;

  const client = new NiimbotSerialClient();
  await client.connect();
  const model = client.getModelMetadata()?.model;
  if (!isD110PrinterModel(model)) {
    await client.disconnect().catch(() => undefined);
    throw new Error("UNSUPPORTED_MODEL");
  }
  return client;
}

async function printD110MaterialLabel(
  client: NiimbotSerialClient,
  content: D110LabelContent,
): Promise<void> {
  const canvas = await renderD110Label(content);
  const encoded = ImageEncoder.encodeCanvas(
    canvas,
    PageColorType.SingleColor,
    D110_PRINT_DIRECTION,
  );
  const taskName = resolveD110PrintTaskName(
    client.getModelMetadata()?.model,
    client.getPrintTaskType(),
  );
  if (!taskName) throw new Error("UNSUPPORTED_PROTOCOL");
  const task = client.abstraction.newPrintTask(taskName, {
    density: 2,
    labelType: LabelType.WithGaps,
    pageColor: PageColorType.SingleColor,
    totalPages: 1,
  });

  await runD110PrintSequence(task, encoded);
}

async function renderD110Label(
  content: D110LabelContent,
): Promise<HTMLCanvasElement> {
  const canvas = document.createElement("canvas");
  canvas.width = D110_LABEL_WIDTH_PX;
  canvas.height = D110_LABEL_HEIGHT_PX;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("CANVAS_UNAVAILABLE");

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  const qrCanvas = document.createElement("canvas");
  await QRCode.toCanvas(qrCanvas, content.scanUrl, {
    errorCorrectionLevel: "M",
    margin: D110_QR_MARGIN_MODULES,
    width: D110_QR_SIZE_PX,
    color: { dark: "#000000", light: "#ffffff" },
  });
  context.imageSmoothingEnabled = false;
  context.drawImage(qrCanvas, 4, 4, D110_QR_SIZE_PX, D110_QR_SIZE_PX);

  const textX = 98;
  const textWidth = D110_LABEL_WIDTH_PX - textX - 4;
  context.fillStyle = "#000000";
  context.textBaseline = "top";
  context.font = "700 14px sans-serif";
  fitD110LabelLines(context, content.materialName, textWidth, 2).forEach(
    (line, index) => context.fillText(line, textX, 6 + index * 17),
  );
  context.font = "11px sans-serif";
  context.fillText(`组别：${content.techGroup}`, textX, 45, textWidth);
  context.font = "700 12px sans-serif";
  context.fillText(content.price, textX, 62, textWidth);
  context.font = "10px sans-serif";
  context.fillText("扫码领用 / 归还", textX, 81, textWidth);
  return canvas;
}
