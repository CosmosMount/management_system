"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  createProcessingVendor,
  listProcessingVendors,
} from "@/app/actions/processingVendors";

export type ProcessingVendorOption = {
  id: string;
  name: string;
};

type ProcessingVendorActions = {
  list: () => Promise<ProcessingVendorOption[]>;
  create: (name: string) => Promise<ProcessingVendorOption>;
};

const defaultActions: ProcessingVendorActions = {
  list: listProcessingVendors,
  create: createProcessingVendor,
};

export function useProcessingVendors(
  actions: ProcessingVendorActions = defaultActions,
) {
  const [vendors, setVendors] = useState<ProcessingVendorOption[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    actions.list()
      .then((items) => {
        if (!cancelled) {
          setVendors((current) => mergeVendorOptions(current, items));
        }
      })
      .catch(() => {
        if (!cancelled) toast.error("加载加工商列表失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [actions]);

  const addVendor = useCallback(async (name: string) => {
    const vendor = await actions.create(name);
    setVendors((current) => mergeVendorOptions(current, [vendor]));
    return vendor;
  }, [actions]);

  return { vendors, loading, addVendor };
}

function mergeVendorOptions(
  current: ProcessingVendorOption[],
  incoming: ProcessingVendorOption[],
) {
  const byName = new Map(current.map((item) => [item.name, item]));
  for (const item of incoming) byName.set(item.name, item);
  return [...byName.values()].sort((a, b) =>
    a.name.localeCompare(b.name, "zh-CN"),
  );
}
