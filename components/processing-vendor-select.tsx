"use client";

import { useId, useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import type { ProcessingVendorOption } from "@/components/use-processing-vendors";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const ADD_VENDOR = "__add_vendor__";

type Props = {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  vendors: ProcessingVendorOption[];
  loading: boolean;
  onAddVendor: (name: string) => Promise<ProcessingVendorOption>;
};

export function ProcessingVendorSelect({
  id,
  value,
  onChange,
  error,
  vendors,
  loading,
  onAddVendor,
}: Props) {
  const generatedId = useId();
  const triggerId = id ?? `${generatedId}-trigger`;
  const errorId = `${triggerId}-error`;
  const newVendorInputId = "processing-vendor-name";
  const [addOpen, setAddOpen] = useState(false);
  const [newVendorName, setNewVendorName] = useState("");
  const [pending, startTransition] = useTransition();

  function handleSelectChange(next: string | null) {
    if (!next) return;
    if (next === ADD_VENDOR) {
      setAddOpen(true);
      return;
    }
    onChange(next);
  }

  function handleAddVendor() {
    const trimmed = newVendorName.trim();
    if (!trimmed) {
      toast.error("请输入加工商名称");
      return;
    }

    startTransition(async () => {
      try {
        const vendor = await onAddVendor(trimmed);
        onChange(vendor.name);
        setNewVendorName("");
        setAddOpen(false);
        toast.success("加工商已添加");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "添加失败");
      }
    });
  }

  return (
    <>
      <Select value={value || ""} onValueChange={handleSelectChange}>
        <SelectTrigger
          id={triggerId}
          className="w-full"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
        >
          <SelectValue placeholder={loading ? "加载中…" : "请选择加工商"} />
        </SelectTrigger>
        <SelectContent>
          {vendors.map((vendor) => (
            <SelectItem key={vendor.id} value={vendor.name}>
              {vendor.name}
            </SelectItem>
          ))}
          <SelectItem value={ADD_VENDOR}>
            <span className="inline-flex items-center gap-1">
              <Plus className="h-4 w-4" />
              添加加工商
            </span>
          </SelectItem>
        </SelectContent>
      </Select>
      {error && (
        <p id={errorId} className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加加工商</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={newVendorInputId}>加工商名称</Label>
            <Input
              id={newVendorInputId}
              value={newVendorName}
              onChange={(event) => setNewVendorName(event.target.value)}
              placeholder="例如：某某工坊"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleAddVendor();
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setAddOpen(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              disabled={pending}
              onClick={handleAddVendor}
            >
              {pending ? "添加中…" : "添加"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
