import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { ProjectFormClient } from "@/components/project-management/project-form-client";
import { getProgressActorOrRedirect } from "../../_auth";

export default async function NewProjectPage() {
  await getProgressActorOrRedirect();
  return <><PageCommandBar title="提交项目立项" description="填写完整信息后提交给全局管理员审批。" /><ProjectFormClient mode="create" /></>;
}
