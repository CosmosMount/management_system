import { BackLink } from "@/components/back-link";
import { routes } from "@/lib/routes";

export function ProgressBackLink() {
  return <BackLink href={routes.progress.root} label="返回进度管理" />;
}
