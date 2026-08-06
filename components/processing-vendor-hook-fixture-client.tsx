"use client";

import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useProcessingVendors } from "@/components/use-processing-vendors";

export function ProcessingVendorHookFixtureClient() {
  const resolveListRef = useRef<
    ((items: Array<{ id: string; name: string }>) => void) | null
  >(null);
  const [adding, setAdding] = useState(false);
  const actions = useMemo(
    () => ({
      list: () =>
        new Promise<Array<{ id: string; name: string }>>((resolve) => {
          resolveListRef.current = resolve;
        }),
      create: async (name: string) => ({ id: "new-vendor", name }),
    }),
    [],
  );
  const vendors = useProcessingVendors(actions);
  return (
    <main className="space-y-3 p-6">
      <div aria-label="加工商列表">
        {vendors.vendors.map((vendor) => (
          <div key={vendor.id}>{vendor.name}</div>
        ))}
      </div>
      <Button
        type="button"
        disabled={adding}
        onClick={async () => {
          setAdding(true);
          try {
            await vendors.addVendor("新增加工商");
          } finally {
            setAdding(false);
          }
        }}
      >
        新增加工商
      </Button>
      <Button
        type="button"
        onClick={() =>
          resolveListRef.current?.([{ id: "old-vendor", name: "原加工商" }])
        }
      >
        返回旧列表
      </Button>
    </main>
  );
}
