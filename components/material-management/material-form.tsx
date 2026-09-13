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
  const [price, setPrice] = useState("");
  const [techGroup, setTechGroup] = useState("");
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [idempotencyKey] = useState(createClientUuid);
  const dirty = Boolean(name || price || techGroup);

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
    if (Object.keys(nextErrors).length > 0) {
      setFieldErrors(nextErrors);
      requestAnimationFrame(() => {
        const firstId = nextErrors.name
          ? "material-name"
          : nextErrors.price
            ? "material-price"
            : "material-tech-group";
        document.getElementById(firstId)?.focus();
      });
      return;
    }

    const result = await createMaterial({
      name,
      price,
      techGroup,
      idempotencyKey,
    });
    if (!result.ok) {
      const supported = new Set(["name", "price", "techGroup"]);
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
        const firstKey = ["name", "price", "techGroup"].find(
          (key) => nextFieldErrors[key]?.length,
        );
        document
          .getElementById(
            firstKey === "name"
              ? "material-name"
              : firstKey === "price"
                ? "material-price"
                : "material-tech-group",
          )
          ?.focus();
      });
      return;
    }
    router.push(routes.materials.detail(result.data.materialId));
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
