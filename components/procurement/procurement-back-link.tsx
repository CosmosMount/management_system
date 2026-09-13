import type { ReactNode } from "react";
import { ProcurementPageHeader } from "@/components/procurement/procurement-page-header";

export function ProcurementListHeader() {
  return (
    <ProcurementPageHeader
      title="订单列表"
      description="查看与管理全部采购订单"
    />
  );
}

export function ProcurementDashboardHeader() {
  return (
    <ProcurementPageHeader
      title="采购看板"
      description="采购统计图表"
    />
  );
}

export function ProcurementSummaryHeader() {
  return (
    <ProcurementPageHeader
      title="明细汇总"
      description="查看采购明细并导出 BOM"
    />
  );
}

export function ProcurementNewHeader() {
  return (
    <ProcurementPageHeader
      title="采购申请"
      description="填写采购明细并提交审批"
    />
  );
}

export function OrdersBackHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <ProcurementPageHeader
      title={title}
      description={description}
      actions={actions}
    />
  );
}

export function EditDraftHeader({ orderNo }: { orderNo: string }) {
  return (
    <OrdersBackHeader
      title={`编辑采购清单 ${orderNo}`}
      description="老师审核通过前可修改明细，保存或重新提交申请"
    />
  );
}
