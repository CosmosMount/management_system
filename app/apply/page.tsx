import { ApplyForm } from "@/components/apply-form";
import { AppHeader } from "@/components/app-header";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";

export default function ApplyPage() {
  return (
    <>
      <AppHeader />
      <PageShell>
        <main className="mx-auto max-w-4xl flex-1 p-4 py-8">
          <PageTitle subtitle="采购申请" />
          <ApplyForm />
        </main>
      </PageShell>
    </>
  );
}
