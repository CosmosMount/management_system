export const D110_LABEL_WIDTH_PX = 240;
export const D110_LABEL_HEIGHT_PX = 96;
export const D110_QR_SIZE_PX = 88;
export const D110_QR_MARGIN_MODULES = 4;
export const D110_PRINT_DIRECTION = "left" as const;

export type D110LabelContent = {
  materialName: string;
  price: string;
  scanUrl: string;
  techGroup: string;
};

export function d110BrowserAvailability(input: {
  isSecureContext: boolean;
  hasSerial: boolean;
}): { available: boolean; message: string } {
  if (!input.isSecureContext) {
    return {
      available: false,
      message: "当前地址不是安全来源，请通过 HTTPS 打开系统后使用 Type-C 打印。",
    };
  }
  if (!input.hasSerial) {
    return {
      available: false,
      message: "当前浏览器不支持 Web Serial，请使用桌面版 Chrome 或 Edge。",
    };
  }
  return {
    available: true,
    message: "打印机将连接到当前浏览器所在电脑的 Type-C 接口。",
  };
}

export type D110PrintTaskName = "D110" | "B1" | "D110M_V4";

export function isD110PrinterModel(model: string | undefined): boolean {
  return model === "D110" || model === "D110_M";
}

export function resolveD110PrintTaskName(
  model: string | undefined,
  detectedTask: string | undefined,
): D110PrintTaskName | null {
  if (model === "D110" && detectedTask === "D110") return detectedTask;
  if (
    model === "D110_M" &&
    (detectedTask === "B1" || detectedTask === "D110M_V4")
  ) {
    return detectedTask;
  }
  return null;
}

export function d110PrintErrorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "NotFoundError") {
    return "未选择串口设备。请确认 D110 已开机并通过数据线连接当前电脑。";
  }
  if (error instanceof Error && error.name === "SecurityError") {
    return "浏览器拒绝访问串口，请通过 HTTPS 打开系统并重新授权。";
  }
  if (error instanceof Error && error.message === "UNSUPPORTED_MODEL") {
    return "所选设备不是 D110 或 D110_M，本页面仅支持这两个型号。";
  }
  if (error instanceof Error && error.message === "UNSUPPORTED_PROTOCOL") {
    return "无法识别这台 D110 系列打印机的协议版本，请重新连接或升级打印机固件。";
  }
  if (error instanceof Error && error.message === "PRINT_END_REJECTED") {
    return "打印机未能正常结束任务，请检查标签是否完整并重新打印。";
  }
  return "D110 连接或打印失败，请检查数据线、打印机电量和标签纸后重试。";
}

export function fitD110LabelLines(
  context: Pick<CanvasRenderingContext2D, "measureText">,
  value: string,
  maxWidth: number,
  maxLines = 2,
): string[] {
  const normalized = value.trim() || "未命名物资";
  const lines: string[] = [];
  let current = "";
  for (const character of normalized) {
    const candidate = `${current}${character}`;
    if (current && context.measureText(candidate).width > maxWidth) {
      lines.push(current);
      current = character;
      if (lines.length === maxLines) break;
    } else {
      current = candidate;
    }
  }
  if (lines.length < maxLines && current) lines.push(current);
  const consumed = lines.join("").length;
  if (consumed < normalized.length && lines.length > 0) {
    let last = lines.at(-1) ?? "";
    while (last && context.measureText(`${last}…`).width > maxWidth) {
      last = last.slice(0, -1);
    }
    lines[lines.length - 1] = `${last}…`;
  }
  return lines;
}

export async function runD110PrintSequence<T>(
  task: {
    printInit(): Promise<void>;
    printPage(image: T, quantity?: number): Promise<void>;
    waitForFinished(): Promise<void>;
    printEnd(): Promise<boolean>;
  },
  image: T,
): Promise<void> {
  let primaryError: unknown;
  try {
    await task.printInit();
    await task.printPage(image, 1);
    await task.waitForFinished();
  } catch (error) {
    primaryError = error;
  }

  let ended = false;
  try {
    ended = await task.printEnd();
  } catch (error) {
    if (primaryError === undefined) primaryError = error;
  }
  if (primaryError !== undefined) throw primaryError;
  if (!ended) throw new Error("PRINT_END_REJECTED");
}
