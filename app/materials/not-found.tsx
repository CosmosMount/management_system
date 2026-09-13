import Link from "next/link";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { buttonVariants } from "@/components/ui/button";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

export default function MaterialsNotFound() {
  return (
    <>
      <PageCommandBar
        title="二维码无效或物资不存在"
        description="请确认扫描的是系统生成的物资二维码。"
        sectionLabel="物资管理"
        testId="material-management-command-bar"
      />
      <div className="mx-auto w-full max-w-3xl px-4 py-12 text-center sm:px-6">
        <p className="text-sm text-muted-foreground">
          为保护业务信息，此页面不会提供更多内部标识。
        </p>
        <Link
          href={routes.materials.root}
          className={cn(buttonVariants(), "mt-5")}
        >
          返回物资台账
        </Link>
      </div>
    </>
  );
}
