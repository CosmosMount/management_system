import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { MaterialForm } from "@/components/material-management/material-form";
import { getMaterialActorOrRedirect } from "../_auth";

export default async function NewMaterialPage() {
  const actor = await getMaterialActorOrRedirect("/materials/new");
  return (
    <>
      <PageCommandBar
        title="登记物资"
        description="填写物资信息后生成长期唯一二维码。"
        sectionLabel="物资管理"
        testId="material-management-command-bar"
      />
      {actor.isActive ? (
        <MaterialForm />
      ) : (
        <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
          <p
            role="alert"
            className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
          >
            当前账号已停用，不能登记物资。
          </p>
        </div>
      )}
    </>
  );
}
