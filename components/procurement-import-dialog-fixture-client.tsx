"use client";

import { useCallback, useState } from "react";
import { BudgetPoolImportDialog } from "@/components/budget-pool-import-dialog";
import { ProcurementItemsImportDialog } from "@/components/procurement-items-import-dialog";
import { Button } from "@/components/ui/button";
import type { BudgetPoolImportResult } from "@/lib/import-procurement-budget";
import type { ImportProcurementItemsResult } from "@/lib/import-procurement-items";

export function ProcurementImportDialogFixtureClient() {
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [itemsOpen, setItemsOpen] = useState(false);
  const [parseEvents, setParseEvents] = useState<string[]>([]);
  const trackParse = useCallback(
    async <T,>(file: File, parse: (value: File) => Promise<T>): Promise<T> => {
      setParseEvents((current) => [...current, `started:${file.name}`]);
      try {
        return await parse(file);
      } finally {
        setParseEvents((current) => [...current, `settled:${file.name}`]);
      }
    },
    [],
  );
  const parseBudgetFile = useCallback(
    (file: File) => trackParse(file, parseBudgetFixture),
    [trackParse],
  );
  const parseItemsFile = useCallback(
    (file: File) => trackParse(file, parseItemsFixture),
    [trackParse],
  );

  return (
    <main className="mx-auto max-w-2xl space-y-4 p-6">
      <h1 className="text-2xl font-semibold">采购导入弹窗受控验收夹具</h1>
      <div className="flex flex-wrap gap-3">
        <Button type="button" onClick={() => setBudgetOpen(true)}>
          打开预算导入
        </Button>
        <Button type="button" onClick={() => setItemsOpen(true)}>
          打开明细导入
        </Button>
      </div>
      <output className="sr-only" data-testid="import-dialog-parse-events">
        {parseEvents.join("|")}
      </output>
      <BudgetPoolImportDialog
        open={budgetOpen}
        onOpenChange={setBudgetOpen}
        existingPoolCount={1}
        onConfirm={() => {}}
        parseFile={parseBudgetFile}
      />
      <ProcurementItemsImportDialog
        open={itemsOpen}
        onOpenChange={setItemsOpen}
        existingItemCount={1}
        onConfirm={() => {}}
        parseFile={parseItemsFile}
      />
    </main>
  );
}

async function parseBudgetFixture(file: File): Promise<BudgetPoolImportResult> {
  await delayForFixture(file.name);
  return {
    rows: [
      {
        description: file.name,
        team: "英雄",
        techGroup: "机械",
        budgetAmount: 100,
        period: "2026",
      },
    ],
    errors: [],
  };
}

async function parseItemsFixture(file: File): Promise<ImportProcurementItemsResult> {
  await delayForFixture(file.name);
  return {
    items: [
      {
        name: file.name,
        spec: "测试规格",
        itemKind: "COMPONENT",
        purchaseLink: "https://example.com",
        processingVendor: "",
        quantity: 1,
        lineTotal: 1,
      },
    ],
    errors: [],
  };
}

function delayForFixture(fileName: string) {
  const delay = fileName.includes("slow") ? 350 : 60;
  return new Promise<void>((resolve) => setTimeout(resolve, delay));
}
