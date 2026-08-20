import type { ReactNode } from "react";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";

type Props = {
  title: string;
  description?: string;
  actions?: ReactNode;
};

/** 与项目管理一致的采购模块顶部命令栏。 */
export function ProcurementPageHeader({
  title,
  description,
  actions,
}: Props) {
  return (
    <PageCommandBar
      title={title}
      description={description}
      actions={actions}
      sectionLabel="采购管理"
      testId="procurement-command-bar"
    />
  );
}
