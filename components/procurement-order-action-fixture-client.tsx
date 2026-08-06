"use client";

import { useState } from "react";
import { updateOrder } from "@/app/actions/updateOrder";
import { Button } from "@/components/ui/button";
import type { PurchaseItemInput } from "@/lib/validations/order";
import type { TeamOption, TechGroupOption } from "@/lib/constants";

type Mode = "foreign" | "own" | "stale-upload" | "two-upload";

export function ProcurementOrderActionFixtureClient({
  orderId,
  expectedUpdatedAt,
  team,
  techGroup,
  items,
  mode,
  foreignPath,
}: {
  orderId: string;
  expectedUpdatedAt: string;
  team: TeamOption;
  techGroup: TechGroupOption;
  items: PurchaseItemInput[];
  mode: Mode;
  foreignPath: string | null;
}) {
  const [result, setResult] = useState("");
  return (
    <main className="p-6">
      <Button
        type="button"
        onClick={async () => {
          const submittedItems = items.map((item, index) => ({
            ...item,
            name: index === 0 ? `${item.name}-已更新` : item.name,
            referenceImagePath:
              mode === "foreign" && index === 0
                ? foreignPath
                : item.referenceImagePath,
          }));
          const formData = new FormData();
          formData.set(
            "payload",
            JSON.stringify({
              orderId,
              expectedUpdatedAt,
              team,
              techGroup,
              items: submittedItems,
              submit: false,
            }),
          );
          if (mode === "stale-upload" || mode === "two-upload") {
            formData.set("itemImage-0", pngFile("valid.png"));
          }
          if (mode === "two-upload") {
            formData.set(
              "itemImage-1",
              new File(["not-an-image"], "invalid.png", { type: "image/png" }),
            );
          }
          try {
            await updateOrder(formData);
            setResult("成功");
          } catch (error) {
            setResult(error instanceof Error ? error.message : "失败");
          }
        }}
      >
        执行订单更新
      </Button>
      <output aria-label="执行结果">{result}</output>
    </main>
  );
}

function pngFile(name: string) {
  const binary = atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  );
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new File([bytes], name, { type: "image/png" });
}
