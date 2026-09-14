"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createMaterial } from "@/app/actions/materials";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldError } from "@/components/ui/field-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TECH_GROUP_OPTIONS } from "@/lib/constants";
import { createClientUuid } from "@/lib/material-management/client-uuid";
import { routes } from "@/lib/routes";

export function MaterialForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [price, setPrice] = useState("");
  const [techGroup, setTechGroup] = useState("");
  const [paired, setPaired] = useState(false);
  const [companionName, setCompanionName] = useState("");
  const [companionPrice, setCompanionPrice] = useState("");
  const [companionTechGroup, setCompanionTechGroup] = useState("");
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [idempotencyKey] = useState(createClientUuid);
  const dirty = Boolean(
    name || price || techGroup || quantity !== "1" || paired ||
    companionName || companionPrice || companionTechGroup,
  );

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty && !pending) event.preventDefault();
    };
    const interceptLink = (event: MouseEvent) => {
      if (!dirty || pending || event.defaultPrevented || event.button !== 0) {
        return;
      }
      const anchor = (event.target as Element | null)?.closest(
        "a[href]",
      ) as HTMLAnchorElement | null;
      if (
        !anchor ||
        anchor.target === "_blank" ||
        new URL(anchor.href, window.location.href).origin !==
          window.location.origin
      ) {
        return;
      }
      if (!window.confirm("表单还有未保存的修改，确认离开？")) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", interceptLink, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", interceptLink, true);
    };
  }, [dirty, pending]);

  function clearFieldError(key: string) {
    setFieldErrors((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  async function submit() {
    setError("");
    const nextErrors: Record<string, string[]> = {};
    if (!name.trim()) nextErrors.name = ["请输入物资名称"];
    const parsedQuantity = Number(quantity);
    if (!Number.isInteger(parsedQuantity) || parsedQuantity < 1 || parsedQuantity > 100) {
      nextErrors.quantity = ["数量须为 1 至 100 的整数"];
    }
    if ((parsedQuantity > 1 ? `${name.trim()}-${parsedQuantity}` : name.trim()).length > 200) {
      nextErrors.name = ["物资名称加编号后不能超过 200 个字符"];
    }
    if (
      !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(price.trim())
    ) {
      nextErrors.price = [
        "价格应为 0 至 9999999999.99，最多保留两位小数",
      ];
    }
    if (
      !TECH_GROUP_OPTIONS.includes(
        techGroup as (typeof TECH_GROUP_OPTIONS)[number],
      )
    ) {
      nextErrors.techGroup = ["请选择所属技术组"];
    }
    if (paired) {
      if (!companionName.trim()) {
        nextErrors.companionName = ["请输入配套物品名称"];
      } else if (companionName.trim() === name.trim()) {
        nextErrors.companionName = ["两种配套物品名称不能相同"];
      } else if (
        (parsedQuantity > 1
          ? `${companionName.trim()}-${parsedQuantity}`
          : companionName.trim()).length > 200
      ) {
        nextErrors.companionName = ["配套物品名称加编号后不能超过 200 个字符"];
      }
      if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(companionPrice.trim())) {
        nextErrors.companionPrice = ["价格应为 0 至 9999999999.99，最多保留两位小数"];
      }
      if (!TECH_GROUP_OPTIONS.includes(companionTechGroup as (typeof TECH_GROUP_OPTIONS)[number])) {
        nextErrors.companionTechGroup = ["请选择配套物品所属技术组"];
      }
    }
    if (Object.keys(nextErrors).length > 0) {
      setFieldErrors(nextErrors);
      requestAnimationFrame(() => {
        const firstKey = ["name", "quantity", "price", "techGroup", "companionName", "companionPrice", "companionTechGroup"]
          .find((key) => nextErrors[key]?.length);
        const firstId = fieldId(firstKey);
        document.getElementById(firstId)?.focus();
      });
      return;
    }

    const result = await createMaterial({
      name,
      quantity: parsedQuantity,
      paired,
      ...(paired ? { companionName, companionPrice, companionTechGroup } : {}),
      price,
      techGroup,
      idempotencyKey,
    });
    if (!result.ok) {
      const supported = new Set([
        "name", "quantity", "price", "techGroup",
        "companionName", "companionPrice", "companionTechGroup",
      ]);
      const nextFieldErrors = Object.fromEntries(
        Object.entries(result.error.fieldErrors ?? {}).filter(([key]) =>
          supported.has(key),
        ),
      );
      setFieldErrors(nextFieldErrors);
      setError(
        Object.keys(nextFieldErrors).length > 0 ? "" : result.error.message,
      );
      requestAnimationFrame(() => {
        const firstKey = ["name", "quantity", "price", "techGroup", "companionName", "companionPrice", "companionTechGroup"].find(
          (key) => nextFieldErrors[key]?.length,
        );
        document
          .getElementById(fieldId(firstKey))
          ?.focus();
      });
      return;
    }
    router.push(
      parsedQuantity > 1 || paired
        ? routes.materials.root
        : routes.materials.detail(result.data.materialId),
    );
    router.refresh();
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl px-4 py-6 sm:px-6">
      <Card>
        <CardHeader>
          <CardTitle>基本信息</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="material-name">物资名称</Label>
            <Input
              id="material-name"
              value={name}
              maxLength={200}
              required
              aria-invalid={Boolean(fieldErrors.name)}
              aria-describedby={
                fieldErrors.name ? "material-name-error" : undefined
              }
              onChange={(event) => {
                setName(event.target.value);
                if (event.target.value.trim()) clearFieldError("name");
              }}
            />
            <FieldError
              id="material-name-error"
              messages={fieldErrors.name}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="material-quantity">数量</Label>
            <Input
              id="material-quantity"
              type="number"
              min={1}
              max={100}
              step={1}
              required
              value={quantity}
              aria-invalid={Boolean(fieldErrors.quantity)}
              aria-describedby="material-quantity-help material-quantity-error"
              onChange={(event) => {
                setQuantity(event.target.value);
                clearFieldError("quantity");
              }}
            />
            <p id="material-quantity-help" className="break-words text-sm text-muted-foreground">
              单次可登记 1–100 件。1 件保留原名，多件按“物资名称-1、物资名称-2…”命名，每件独立生成二维码；价格为单件价格。
            </p>
            <FieldError id="material-quantity-error" messages={fieldErrors.quantity} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="material-price">价格（元）</Label>
            <Input
              id="material-price"
              value={price}
              inputMode="decimal"
              placeholder="0.00"
              required
              aria-invalid={Boolean(fieldErrors.price)}
              aria-describedby={
                fieldErrors.price ? "material-price-error" : undefined
              }
              onChange={(event) => {
                setPrice(event.target.value);
                clearFieldError("price");
              }}
            />
            <FieldError
              id="material-price-error"
              messages={fieldErrors.price}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="material-tech-group">所属技术组</Label>
            <select
              id="material-tech-group"
              value={techGroup}
              required
              aria-invalid={Boolean(fieldErrors.techGroup)}
              aria-describedby={
                fieldErrors.techGroup
                  ? "material-tech-group-error"
                  : undefined
              }
              className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              onChange={(event) => {
                setTechGroup(event.target.value);
                if (event.target.value) clearFieldError("techGroup");
              }}
            >
              <option value="">请选择技术组</option>
              {TECH_GROUP_OPTIONS.map((group) => (
                <option key={group} value={group}>
                  {group}
                </option>
              ))}
            </select>
            <FieldError
              id="material-tech-group-error"
              messages={fieldErrors.techGroup}
            />
          </div>
          <label className="flex items-start gap-3 rounded-lg border p-4">
            <input
              type="checkbox"
              aria-label="登记配套物品"
              className="mt-1 size-4"
              checked={paired}
              onChange={(event) => setPaired(event.target.checked)}
            />
            <span className="min-w-0">
              <span className="block font-medium">登记配套物品</span>
              <span className="block text-sm text-muted-foreground">
                两种物品按相同序号组成一套，扫描任一件都会整套领用或归还。
              </span>
            </span>
          </label>
          {paired && (
            <div className="space-y-5 rounded-xl border bg-muted/30 p-4">
              <h2 className="font-semibold">配套物品信息</h2>
              <div className="space-y-2">
                <Label htmlFor="material-companion-name">配套物品名称</Label>
                <Input id="material-companion-name" value={companionName} maxLength={200} required
                  aria-invalid={Boolean(fieldErrors.companionName)}
                  aria-describedby={fieldErrors.companionName ? "material-companion-name-error" : undefined}
                  onChange={(event) => { setCompanionName(event.target.value); clearFieldError("companionName"); }} />
                <FieldError id="material-companion-name-error" messages={fieldErrors.companionName} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="material-companion-price">配套物品价格（元）</Label>
                <Input id="material-companion-price" value={companionPrice} inputMode="decimal" placeholder="0.00" required
                  aria-invalid={Boolean(fieldErrors.companionPrice)}
                  aria-describedby={fieldErrors.companionPrice ? "material-companion-price-error" : undefined}
                  onChange={(event) => { setCompanionPrice(event.target.value); clearFieldError("companionPrice"); }} />
                <FieldError id="material-companion-price-error" messages={fieldErrors.companionPrice} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="material-companion-tech-group">配套物品所属技术组</Label>
                <select id="material-companion-tech-group" value={companionTechGroup} required
                  aria-invalid={Boolean(fieldErrors.companionTechGroup)}
                  aria-describedby={fieldErrors.companionTechGroup ? "material-companion-tech-group-error" : undefined}
                  className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
                  onChange={(event) => { setCompanionTechGroup(event.target.value); clearFieldError("companionTechGroup"); }}>
                  <option value="">请选择技术组</option>
                  {TECH_GROUP_OPTIONS.map((group) => <option key={group} value={group}>{group}</option>)}
                </select>
                <FieldError id="material-companion-tech-group-error" messages={fieldErrors.companionTechGroup} />
              </div>
            </div>
          )}
          <p className="text-sm text-muted-foreground">
            登记后系统会生成长期唯一的二维码；二维码标识不会随领用、归还或信息展示变化。
          </p>
          {error && (
            <p
              role="alert"
              className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
            >
              {error}
            </p>
          )}
          <div className="flex justify-end">
            <Button
              type="button"
              size="lg"
              disabled={pending}
              onClick={() => startTransition(submit)}
            >
              {pending ? "正在登记…" : "登记并生成二维码"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function fieldId(key?: string) {
  return {
    name: "material-name",
    quantity: "material-quantity",
    price: "material-price",
    techGroup: "material-tech-group",
    companionName: "material-companion-name",
    companionPrice: "material-companion-price",
    companionTechGroup: "material-companion-tech-group",
  }[key ?? ""] ?? "material-name";
}
