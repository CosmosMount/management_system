import {
  ClipboardList,
  FilePlus2,
  FileText,
  Hammer,
  LayoutDashboard,
  ShoppingCart,
} from "lucide-react";
import { ProcurementPageHeader } from "@/components/procurement/procurement-page-header";
import { routes } from "@/lib/routes";

export function ProcurementHomeHeader() {
  return (
    <ProcurementPageHeader
      href="/"
      backLabel="返回首页"
      title="采购管理"
      description="新建申请、查看订单与采购统计"
      icon={ShoppingCart}
      className="mb-8"
    />
  );
}

export function ProcurementListHeader() {
  return (
    <ProcurementPageHeader
      href={routes.procurement.root}
      backLabel="返回采购管理"
      title="订单列表"
      description="查看与管理全部采购订单"
      icon={ClipboardList}
    />
  );
}

export function ProcurementDashboardHeader() {
  return (
    <ProcurementPageHeader
      href={routes.procurement.root}
      backLabel="返回采购管理"
      title="采购看板"
      description="采购统计图表与明细汇总"
      icon={LayoutDashboard}
    />
  );
}

export function ProcurementNewHeader() {
  return (
    <ProcurementPageHeader
      href={routes.procurement.root}
      backLabel="返回采购管理"
      title="采购申请"
      description="填写采购明细并提交审批"
      icon={FilePlus2}
    />
  );
}

export function WorkshopFeeHeader() {
  return (
    <ProcurementPageHeader
      href={routes.procurement.root}
      backLabel="返回采购管理"
      title="工坊加工费"
      description="录入加工费并上传图片，直接计入采购汇总"
      icon={Hammer}
    />
  );
}

export function OrdersBackHeader({
  title,
  description,
  className,
}: {
  title: string;
  description?: string;
  className?: string;
}) {
  return (
    <ProcurementPageHeader
      href={routes.procurement.list}
      backLabel="返回订单列表"
      title={title}
      description={description}
      icon={FileText}
      className={className}
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
