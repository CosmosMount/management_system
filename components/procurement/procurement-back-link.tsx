import { BackLink } from "@/components/back-link";
import { routes } from "@/lib/routes";

export function ProcurementBackLink() {
  return <BackLink href={routes.procurement.root} label="返回采购管理" />;
}

export function OrdersBackLink() {
  return <BackLink href={routes.procurement.list} label="返回订单列表" />;
}
