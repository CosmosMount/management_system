import type { PurchaseItemKind } from "@/lib/purchase-item-kind";
import type { CreateOrderInput } from "@/lib/validations/order";

export type ApplyFormValues = Omit<CreateOrderInput, "team" | "techGroup"> & {
  team: CreateOrderInput["team"] | "";
  techGroup: CreateOrderInput["techGroup"] | "";
};

export type OrderFormPayload = CreateOrderInput & {
  orderId?: string;
  expectedUpdatedAt?: string;
};

export type ItemImageFiles = Record<number, File | undefined>;
export type ItemImageErrors = Record<number, string>;

export const defaultPurchaseItem = {
  name: "",
  spec: "",
  itemKind: "COMPONENT" as PurchaseItemKind,
  purchaseLink: "",
  referenceImagePath: null as string | null,
  processingVendor: "",
  quantity: 1,
  lineTotal: 0,
};

export function buildOrderFormData(
  data: OrderFormPayload,
  itemImageFiles: ItemImageFiles,
): FormData {
  const formData = new FormData();
  formData.set("payload", JSON.stringify(data));
  for (const [index, file] of Object.entries(itemImageFiles)) {
    if (file) formData.set(`itemImage-${index}`, file);
  }
  return formData;
}

export function removeIndexedEntry<T>(
  values: Record<number, T>,
  removedIndex: number,
): Record<number, T> {
  const next: Record<number, T> = {};
  for (const [key, value] of Object.entries(values)) {
    const index = Number(key);
    if (index < removedIndex) next[index] = value;
    if (index > removedIndex) next[index - 1] = value;
  }
  return next;
}
