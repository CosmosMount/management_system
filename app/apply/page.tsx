import { ApplyForm } from "@/components/apply-form";
import { AppHeader } from "@/components/app-header";

export default function ApplyPage() {
  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-4xl flex-1 p-4 py-8">
        <h1 className="mb-6 text-2xl font-bold">采购申请</h1>
        <ApplyForm />
      </main>
    </>
  );
}
