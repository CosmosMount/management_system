"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { CheckCheck, Printer, RotateCcw, X } from "lucide-react";
import type { NiimbotSerialClient } from "@mmote/niimbluelib";
import {
  connectD110,
  printD110MaterialLabels,
} from "@/components/material-management/d110-serial-printer";
import { Button } from "@/components/ui/button";
import {
  d110BrowserAvailability,
  d110PrintErrorMessage,
  runD110BatchPrintSession,
  type D110LabelContent,
} from "@/lib/material-management/d110-label";

export type MaterialBatchPrintItem = D110LabelContent & { id: string };

type BatchPrintState = "IDLE" | "CONNECTING" | "PRINTING" | "SUCCESS" | "ERROR";

const subscribeToBrowserEnvironment = () => () => undefined;

const MaterialBatchPrintSelectionContext = createContext<{
  disabled: boolean;
  selectedIds: ReadonlySet<string>;
  setSelected(id: string, selected: boolean): void;
} | null>(null);

export function MaterialBatchPrinter({
  items,
  children,
}: {
  items: MaterialBatchPrintItem[];
  children: ReactNode;
}) {
  const clientRef = useRef<NiimbotSerialClient | null>(null);
  const printRunRef = useRef(0);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [state, setState] = useState<BatchPrintState>("IDLE");
  const [message, setMessage] = useState("");
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
  const selectedItems = useMemo(() => {
    const selected = new Set(selectedIds);
    return items.filter((item) => selected.has(item.id));
  }, [items, selectedIds]);
  const busy = state === "CONNECTING" || state === "PRINTING";

  useEffect(() => {
    return () => {
      printRunRef.current += 1;
      const client = clientRef.current;
      clientRef.current = null;
      if (client?.isConnected()) void client.disconnect().catch(() => undefined);
    };
  }, []);

  const resetFeedback = useCallback(() => {
    setState("IDLE");
    setMessage("");
  }, []);

  const setSelected = useCallback((id: string, selected: boolean) => {
    setSelectedIds((current) =>
      selected
        ? [...new Set([...current, id])]
        : current.filter((selectedId) => selectedId !== id),
    );
    resetFeedback();
  }, [resetFeedback]);

  const selection = useMemo(
    () => ({ disabled: busy, selectedIds: new Set(selectedIds), setSelected }),
    [busy, selectedIds, setSelected],
  );

  async function printSelected() {
    if (!availability?.available || busy || selectedItems.length === 0) return;
    const printRun = ++printRunRef.current;
    const isCurrentRun = () => printRunRef.current === printRun;
    setState("CONNECTING");
    setMessage("请在浏览器窗口中选择 Type-C 连接的 D110…");
    try {
      const result = await runD110BatchPrintSession({
        items: [selectedItems],
        connect: () => connectD110(clientRef.current),
        onConnected: (client) => {
          clientRef.current = client;
          if (isCurrentRun()) {
            setState("PRINTING");
            setMessage(`正在准备 ${selectedItems.length} 张物资标签…`);
          }
        },
        disconnect: async (client) => {
          if (clientRef.current === client) clientRef.current = null;
          if (client.isConnected()) {
            await client.disconnect().catch(() => undefined);
          }
        },
        printItem: async (client, labels) => {
          await printD110MaterialLabels(
            client,
            labels,
            (completed, total, item) => {
              setMessage(
                `正在打印 ${completed}/${total}：${item.materialName}`,
              );
            },
            isCurrentRun,
          );
        },
        isActive: isCurrentRun,
      });
      if (result === "CANCELLED" || !isCurrentRun()) return;
      setState("SUCCESS");
      setMessage(`已完成 ${selectedItems.length} 张物资标签打印。`);
    } catch (error) {
      const client = clientRef.current;
      clientRef.current = null;
      if (client?.isConnected()) await client.disconnect().catch(() => undefined);
      if (!isCurrentRun()) return;
      setState("ERROR");
      setMessage(d110PrintErrorMessage(error));
    }
  }

  return (
    <MaterialBatchPrintSelectionContext.Provider value={selection}>
      <div>
        <section
          aria-label="批量打印物资标签"
          className="mb-3 flex flex-col gap-3 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="min-w-0">
            <p className="font-medium">批量打印二维码标签</p>
            <p className="mt-1 text-sm text-muted-foreground">
              已选择 {selectedItems.length} 件；连接一次 D110 后按台账顺序逐张打印。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setSelectedIds(items.map((item) => item.id));
                resetFeedback();
              }}
              disabled={busy || selectedItems.length === items.length}
            >
              <CheckCheck aria-hidden="true" />
              全选当前结果
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setSelectedIds([]);
                resetFeedback();
              }}
              disabled={busy || selectedItems.length === 0}
            >
              <X aria-hidden="true" />
              清空选择
            </Button>
            <Button
              type="button"
              onClick={printSelected}
              disabled={
                !availability?.available || busy || selectedItems.length === 0
              }
            >
              {state === "SUCCESS" || state === "ERROR" ? (
                <RotateCcw aria-hidden="true" />
              ) : (
                <Printer aria-hidden="true" />
              )}
              {state === "CONNECTING"
                ? "正在连接…"
                : state === "PRINTING"
                  ? "正在批量打印…"
                  : `打印所选（${selectedItems.length}）`}
            </Button>
          </div>
        </section>
        <p
          className={`mb-3 text-sm ${state === "ERROR" || availability?.available === false ? "text-destructive" : "text-muted-foreground"}`}
          role={state === "ERROR" ? "alert" : "status"}
          aria-live="polite"
        >
          {message || availability?.message || "正在检查浏览器打印能力…"}
        </p>
        {children}
      </div>
    </MaterialBatchPrintSelectionContext.Provider>
  );
}

export function MaterialBatchPrintCheckbox({
  id,
  materialName,
}: {
  id: string;
  materialName: string;
}) {
  const selection = useContext(MaterialBatchPrintSelectionContext);
  if (!selection) {
    throw new Error(
      "MaterialBatchPrintCheckbox must be used inside MaterialBatchPrinter",
    );
  }

  return (
    <div className="flex shrink-0 items-center">
      <input
        type="checkbox"
        name="batchMaterialId"
        value={id}
        aria-label={`选择打印 ${materialName}`}
        checked={selection.selectedIds.has(id)}
        disabled={selection.disabled}
        onChange={(event) => selection.setSelected(id, event.target.checked)}
        className="size-4 accent-primary"
      />
    </div>
  );
}
